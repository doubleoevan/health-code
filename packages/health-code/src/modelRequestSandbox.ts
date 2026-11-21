import type {
	InspectionEventV2,
	InspectionModels,
	InspectionOptionsV2,
	ModelReply,
	ModelRoute,
	Pricing,
	ReportCardV2,
} from "./agentContracts.ts"
import { bounded, checkOperation, type InspectionContext } from "./collectEvents.ts"
import { InspectionError, type Operation } from "./contracts.ts"
import type { Ledger } from "./modelBudget.ts"

type CallerModelRole = "releaseSummary" | "featureMatch"
export type SandboxModelRoutes = Record<keyof InspectionModels, ModelRoute & { pricing: Pricing }>
export type ModelRequestSandboxEvent =
	| InspectionEventV2
	| (Omit<Extract<InspectionEventV2, { type: "sandbox.event" }>, "action"> & {
			action: "model-request-sandbox-started"
	  })

// Opt-in callbacks may receive the Model Request Sandbox startup event.
export type ModelRequestSandboxOptions = Omit<InspectionOptionsV2, "models" | "onEvent" | "callerModelExecution"> & {
	callerModelExecution: "modelRequestSandbox"
	models: SandboxModelRoutes
	onEvent?: (event: ModelRequestSandboxEvent) => void | Promise<void>
}

export type ModelRequestSandboxReportCard = Omit<ReportCardV2, "timeline"> & { timeline: ModelRequestSandboxEvent[] }
export type SandboxModelRequest = { role: CallerModelRole; route: ModelRoute; prompt: string; output: number }

// Providers own the credential binding and one isolated runtime per name.
export interface ModelRequestSandbox {
	estimateMaxCost(durationMs: number): number
	open(name: string, route: ModelRoute, operation: Operation): Promise<void>
	send(name: string, request: SandboxModelRequest, operation: Operation): Promise<ModelReply>
	close(name: string, operation: Operation & { creationPending?: boolean }): Promise<void>
}

export const callerOutputTokens = 1024
export const sandboxModelCallTimeoutMs = 120000

/**
 * Names the model request sandbox sibling of a repository sandbox.
 */
export function toModelRequestSandboxName(inspectionId: string): string {
	return `health-code-${inspectionId}-relay`
}

/**
 * Recognizes an exact personal model request sandbox name before lookup or cleanup.
 */
export function isModelRequestSandboxName(name: string): boolean {
	return /^health-code-[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}-relay$/.test(name)
}

/**
 * Validates public provider input and freezes its route selection at admission.
 */
export function snapshotSandboxModelRequest(request: SandboxModelRequest): SandboxModelRequest {
	if (
		!["releaseSummary", "featureMatch"].includes(request.role) ||
		typeof request.prompt !== "string" ||
		Buffer.byteLength(request.prompt) > 96 * 1024 ||
		// Provider callers share the engine’s paid output ceiling.
		!Number.isSafeInteger(request.output) ||
		request.output < 1 ||
		request.output > callerOutputTokens
	) {
		throw new InspectionError("invalid-sandbox-model-request", "Invalid sandbox model request")
	}

	// Keep the verified route independent of later caller mutations.
	return { role: request.role, route: structuredClone(request.route), prompt: request.prompt, output: request.output }
}

export type RuntimeCharge = {
	resource: "repository" | "modelRequestSandbox"
	id: string
	durationMs: number

	// Price elapsed time using the provider’s independent rounding policy.
	upperBoundUsd: number
	reservedUpperBoundUsd?: number
	deleted: boolean
}

export type RuntimeUsage = {
	runtimes: RuntimeCharge[]
	modelCostUsd: number
	modelReservedUsd: number
	totalUpperBoundUsd?: number
	usageAsOf: string
}

export class ModelRequestSandboxAllocation {
	name?: string
	private opening?: Promise<void>
	private queue = Promise.resolve()
	constructor(readonly provider: ModelRequestSandbox) {}

	// Check the first request’s budget before reserving the runtime.
	async ready({
		context,
		ledger,
		requestMicros,
		start,
		route,
		allocated,
	}: {
		context: InspectionContext
		ledger: Ledger
		requestMicros: number

		// Publish startup only after verifying the first route.
		start: (name: string) => Promise<void>
		route: ModelRoute
		allocated: (name: string, reservedUsd: number) => void
	}): Promise<void> {
		if (!this.opening) {
			const operation = context.operation("setup")
			const lifetime = context.end - Date.now() + context.cleanupMs

			// Admit the first model request and the sibling runtime together.
			const reserve = Math.ceil(this.provider.estimateMaxCost(lifetime) * 1e6)
			if (
				operation.timeoutMs <= 0 ||
				!Number.isSafeInteger(reserve) ||
				reserve < 0 ||
				// Retain sufficient credit for the request that triggered allocation.
				reserve + requestMicros > ledger.remainingMicros
			) {
				throw new InspectionError("model-budget", "Model Request Sandbox exceeds the Inspection budget")
			}

			// Retain the cleanup identity even when the create response is lost.
			checkOperation(operation.signal)
			ledger.remainingMicros -= reserve
			const name = toModelRequestSandboxName(context.id)
			this.name = name
			allocated(name, reserve / 1e6)
			const timeoutMs = Math.min(operation.timeoutMs, 60000)

			// Share a single cold start with concurrent first requests.
			this.opening = bounded((signal) => this.provider.open(name, route, { timeoutMs, signal }), {
				...operation,
				timeoutMs,
			}).then(() => {
				checkOperation(operation.signal)
				return start(name)
			})
		}
		try {
			await this.opening
		} catch (error) {
			// Preserve cancellation and delivery failures when startup also fails.
			context.assertActive()
			if (error instanceof InspectionError && ["cancelled", "event-delivery"].includes(error.code)) {
				throw error
			}
			throw new InspectionError("model-request-sandbox-startup", "Model Request Sandbox startup could not be verified")
		}
	}

	// Serialize role changes, even if callers start both roles concurrently.
	send(request: SandboxModelRequest, operation: Operation): Promise<ModelReply> {
		const result = this.queue.then(() => {
			checkOperation(operation.signal)
			if (!this.name) {
				throw new InspectionError("model-request-sandbox", "Model Request Sandbox unavailable")
			}
			return this.provider.send(this.name, request, operation)
		})

		// Release the queue after either outcome.
		this.queue = result.then(
			() => {},
			() => {},
		)
		return result
	}
}
