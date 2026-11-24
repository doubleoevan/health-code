import type { AgentRole, InspectionOptionsV2, ModelReply, ModelRole, ModelUsage, Pricing } from "./agentContracts.ts"
import { bounded, checkOperation, type InspectionContext } from "./collectEvents.ts"
import { InspectionError, type Operation } from "./contracts.ts"

import { sandboxModelCallTimeoutMs } from "./modelRequestSandbox.ts"

import { type GenerationTelemetry, traceGeneration } from "./traceGeneration.ts"

export const agentOutputTokens = 8192

// reserve room for the protocol around each prompt
export const requestOverheadBytes = 512
const defaults = {
	repair: { maxTurns: 40, maxDurationMs: 1_200_000, maxCostUsd: 4 },
	featureAdoption: { maxTurns: 25, maxDurationMs: 600_000, maxCostUsd: 2 },
}

export function cap(value: number | undefined, maximum: number): number {
	// reject non-finite and negative model limits
	if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
		throw new InspectionError("invalid-limits", "Invalid model limit")
	}
	return Math.min(value ?? maximum, maximum)
}

// clamp each role's requested limits to its default ceilings
export function agentLimits(role: AgentRole, limits: InspectionOptionsV2["limits"]): typeof defaults.repair {
	const overrides = limits?.agent?.[role]
	const ceiling = defaults[role]
	return {
		maxTurns: Math.floor(cap(overrides?.maxTurns, ceiling.maxTurns)),
		maxCostUsd: cap(overrides?.maxCostUsd, ceiling.maxCostUsd),
		maxDurationMs: cap(overrides?.maxDurationMs, ceiling.maxDurationMs),
	}
}

// convert role limits into a deadline and remaining microdollars
export function attemptBudget(role: AgentRole, limits: InspectionOptionsV2["limits"]): AttemptBudget {
	const { maxTurns, maxDurationMs, maxCostUsd } = agentLimits(role, limits)
	return { turns: maxTurns, end: Date.now() + maxDurationMs, remainingMicros: Math.floor(maxCostUsd * 1e6) }
}

type AttemptBudget = { turns: number; remainingMicros: number; end: number }
export type Ledger = { remainingMicros: number; end: number; usage: ModelUsage[] }

// describe a priced request and its applicable budgets
type Request = {
	ledger: Ledger
	context?: InspectionContext
	execution?: "modelRequestSandbox"
	verification?: boolean
	toolBytes?: number

	// Share the inspection ceiling with an optional Agent Attempt.
	attempt?: AttemptBudget
	role: ModelRole
	step: string
	modelId: string

	// bound the model's input and requested output
	pricing: Pricing
	prompt: string
	output: number
	signal?: AbortSignal
	send: (operation: Operation, telemetry?: GenerationTelemetry) => Promise<ModelReply>
}

export async function paidRequest(request: Request): Promise<string> {
	// check cancellation before reserving the request cost
	checkOperation(request.signal)
	const { ledger, attempt } = request
	const reserve = reserveCost(request)
	const started = Date.now()
	const ceiling = request.execution === "modelRequestSandbox" ? sandboxModelCallTimeoutMs : 45000
	const duration = Math.min(ledger.end, attempt?.end ?? Infinity, attempt ? Infinity : started + ceiling) - started

	// require sufficient time, money and turns before dispatch
	if (
		duration <= 0 ||
		(attempt && attempt.turns <= 0) ||
		!Number.isSafeInteger(reserve) ||
		reserve > Math.min(ledger.remainingMicros, attempt?.remainingMicros ?? Infinity)
	) {
		throw new InspectionError("model-budget", "Model ceiling reached")
	}

	// charge the reservation before invoking the model
	ledger.remainingMicros -= reserve
	if (attempt) {
		attempt.remainingMicros -= reserve
		if (!request.verification) {
			attempt.turns--
		}
	}

	// retain the reservation until actual usage is known
	const receipt: ModelUsage = {
		role: request.role,
		...(request.execution ? { execution: request.execution } : {}),
		step: request.step,
		modelId: request.modelId,
		durationMs: 0,
		reservedUsd: reserve / 1e6,
	}
	ledger.usage.push(receipt)
	try {
		const reply = await dispatchRequest(request, duration)
		settle({ request, reply, reserve, receipt })
		return reply.text
	} catch (error) {
		// Preserve the reservation until the transport proves the call was refused.
		reconcileFailedRequest({ request, error, reserve, receipt })
		throw error
	} finally {
		receipt.durationMs = Date.now() - started
	}
}

function reconcileFailedRequest({
	request,
	error,
	reserve,
	receipt,
}: {
	request: Request
	error: unknown
	reserve: number
	receipt: ModelUsage
}): void {
	const { ledger, attempt } = request

	// Return only money known to be unspent.
	if (refusedBeforeDispatch(request, error)) {
		ledger.remainingMicros += reserve
		ledger.usage.splice(ledger.usage.indexOf(receipt), 1)
	}

	// Stop the attempt when charging cannot be confirmed.
	if (attempt) {
		attempt.turns = 0
	}
}

function refusedBeforeDispatch(request: Request, error: unknown): boolean {
	return (
		request.execution === "modelRequestSandbox" &&
		error instanceof InspectionError &&
		error.code === "credential-binding"
	)
}

async function dispatchRequest(request: Request, duration: number): Promise<ModelReply> {
	// Attribute only calls admitted by the budget.
	const name = request.verification ? "verifyCredential" : request.role
	const prompts = request.context?.prompts
	const tracer = request.context?.options.telemetry
	const trace =
		prompts && tracer
			? traceGeneration({ tracer, role: request.role, prompt: prompts.template(name).reference })
			: undefined

	// A timeout after dispatch can leave a billable request without a receipt.
	let dispatched = false
	try {
		// send the request under the tightest applicable deadline
		const reply = await bounded(
			(signal) => {
				dispatched = true
				trace?.start()
				const telemetry = trace && {
					isEnabled: true,
					recordInputs: false,
					recordOutputs: false,
					integrations: trace.integration,
				}
				return request.send(
					{ signal, timeoutMs: duration, ...(trace && { modelCallId: trace.modelCallId }) },
					telemetry,
				)
			},
			{
				timeoutMs: duration,
				signal: request.signal,
			},
		)
		trace?.finish("complete", reply)
		return reply
	} catch (error) {
		// Discard a request rejected during remote route verification.
		if (refusedBeforeDispatch(request, error)) {
			dispatched = false
		}
		trace?.finish(
			request.signal?.aborted ||
				(error instanceof InspectionError && ["deadline", "cancelled", "timeout"].includes(error.code))
				? "cancelled"
				: "failed",
		)
		throw error
	} finally {
		// Include failed calls whose provider may still have charged for dispatch.
		if (dispatched) {
			prompts?.record(name)
		}
	}
}

// calculate the worst-case charge from the route bounds
export function reserveCost(request: Pick<Request, "pricing" | "prompt" | "toolBytes" | "output">): number {
	const { pricing } = request
	const inputs = [
		pricing.maxInputTokens,
		pricing.inputUsdPerMillion,
		pricing.outputUsdPerMillion,
		pricing.fixedUsd ?? 0,
	]
	if (
		!inputs.every((n) => Number.isFinite(n) && n >= 0) ||
		!Number.isSafeInteger(pricing.maxInputTokens) ||
		pricing.maxInputTokens < 1
	) {
		throw new InspectionError("pricing", "Missing route price bounds")
	}

	// Reserve the caller's bound for the entire encoded request, including protocol overhead.
	// reject prompts that exceed the configured input ceiling
	if (Buffer.byteLength(request.prompt) + requestOverheadBytes + (request.toolBytes ?? 0) > pricing.maxInputTokens) {
		throw new InspectionError("input-limit", "Model input exceeds the route bound")
	}
	return Math.ceil(
		pricing.maxInputTokens * pricing.inputUsdPerMillion +
			request.output * pricing.outputUsdPerMillion +
			(pricing.fixedUsd ?? 0) * 1e6,
	)
}

function settle({
	request,
	reply,
	reserve,
	receipt,
}: {
	request: Request
	reply: ModelReply
	reserve: number
	receipt: ModelUsage
}): void {
	// require usable token counts before settling the reservation
	const { ledger, attempt, pricing } = request
	if (
		reply.inputTokens === undefined ||
		reply.outputTokens === undefined ||
		![reply.inputTokens, reply.outputTokens].every((n) => Number.isSafeInteger(n) && n >= 0)
	) {
		throw new InspectionError("unknown-usage", "Model usage unavailable")
	}

	// compute the actual charge in microdollars
	const cost = Math.ceil(
		reply.inputTokens * pricing.inputUsdPerMillion +
			reply.outputTokens * pricing.outputUsdPerMillion +
			(pricing.fixedUsd ?? 0) * 1e6,
	)

	// retain the model receipt before checking the declared ceilings
	receipt.inputTokens = reply.inputTokens
	receipt.outputTokens = reply.outputTokens
	receipt.requestId = reply.requestId
	receipt.costUsd = cost / 1e6
	delete receipt.reservedUsd

	// exhaust the ledger when actual usage exceeds its reservation
	if (cost > reserve || reply.outputTokens > request.output || reply.inputTokens > pricing.maxInputTokens) {
		ledger.remainingMicros = 0
		throw new InspectionError("pricing", "Model usage exceeded the caller's bound")
	}

	// restore the unused portion to each budget
	ledger.remainingMicros += reserve - cost
	if (attempt) {
		attempt.remainingMicros += reserve - cost
	}
}
