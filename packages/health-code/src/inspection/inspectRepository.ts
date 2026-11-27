import type { InspectionOptionsV2, InspectionReportV2, PreviousInspectionOptions } from "../agentContracts.ts"
import { retainMeasuredStages } from "../checks/preservePartialReport.ts"
import { bounded, InspectionContext, redactEvidence } from "../collectEvents.ts"
import {
	InspectionError,
	type InspectionOptions,
	type InspectionReport,
	type Sandbox,
	SandboxUnavailableError,
	type WithSandboxProvider,
} from "../contracts.ts"
import type { ModelRequestSandboxInspectionReport, ModelRequestSandboxOptions } from "../models/modelRequestSandbox.ts"
import { isApplicationVariable } from "../sandbox/buildGuestArguments.ts"
import { createSandboxProvider } from "../sandbox/createSandboxProvider.ts"
import { toInspectionMode } from "../toInspectionMode.ts"
import { toRepositoryUrl } from "../toRepositoryUrl.ts"
import { ModelInspection } from "./inspectModels.ts"
import { inspectProject } from "./inspectProject.ts"
import { hasModels, toModelOptions } from "./modelOptions.ts"
import { RepositoryRuntime } from "./openRepositoryRuntime.ts"

/**
 * Inspects a repository at one commit and releases its sandbox before returning the Inspection Report.
 */
export function inspectRepository(options: ModelRequestSandboxOptions): Promise<ModelRequestSandboxInspectionReport>
export function inspectRepository(options: InspectionOptionsV2 | PreviousInspectionOptions): Promise<InspectionReportV2>
export function inspectRepository(
	options: ModelRequestSandboxOptions | InspectionOptionsV2,
): Promise<ModelRequestSandboxInspectionReport>
export function inspectRepository(options: InspectionOptions): Promise<InspectionReport>
export async function inspectRepository(
	request: InspectionOptions | InspectionOptionsV2 | PreviousInspectionOptions | ModelRequestSandboxOptions,
): Promise<InspectionReport | ModelRequestSandboxInspectionReport> {
	// use the caller's Runta account unless the request supplies a provider
	const input = { ...request, sandboxProvider: request.sandboxProvider ?? createSandboxProvider() }

	// select the model-backed inspection contract and validate the repository
	const engine = createEngine(input)
	const options = { ...toCheckOptions(input, engine), mode: toInspectionMode(input) }
	const repositoryUrl = toRepositoryUrl(options.repositoryUrl)

	// Validate the requested revision before allocating either runtime.
	if (input.revision !== undefined && !/^[0-9a-f]{40}$/.test(input.revision)) {
		throw new InspectionError("invalid-revision", "Expected a full commit SHA")
	}
	requireApplicationVariables(options.applicationEnvironment)
	const context = new InspectionContext(
		options,
		engine && ((event) => engine.forward(event)),
		Boolean(engine?.modelRequestSandbox),
	)
	if (engine) {
		engine.ledger.end = context.end - context.cleanupMs
	}

	// retain the allocation identity for cleanup on all exit paths
	const provider = options.sandboxProvider
	const runtime = new RepositoryRuntime(context, repositoryUrl, engine)
	let inspectionReport: InspectionReport | undefined
	let failure: InspectionError | undefined
	try {
		// announce the inspection before contacting the provider
		await context.emit({ type: "inspection.started", repositoryUrl })
		await context.step("setup", "Check sandbox availability", (config) =>
			provider.checkAvailability({ ...config, timeoutMs: Math.min(10000, config.timeoutMs) }),
		)
		inspectionReport = await inspectWithRecovery({ runtime, context, engine, revision: input.revision })
	} catch (error) {
		failure = asFailure(error)
	} finally {
		context.cleaningUp = true

		// release allocated resources even if setup failed
		failure = await releaseAllocations({ context, allocation: runtime.allocation, engine, failure })
	}
	if (failure || !inspectionReport) {
		return failInspection(context, failure, engine)
	}

	// emit completion after teardown succeeds
	try {
		await context.emit({
			type: "inspection.finished",
			inspected: inspectionReport.upgrades.filter(
				(upgrade) => !upgrade.coverage && !("reusedFromInspectionId" in upgrade),
			).length,
			durationMs: Date.now() - context.started,
		})
	} catch (error) {
		// preserve delivery failure evidence on the inspection error
		const failed = asFailure(error)
		recordFailureEvidence({ error: failed, context, engine })
		throw failed
	}

	// Include every prompt dispatched before cleanup completed.
	inspectionReport.promptVersions = context.prompts.references
	return engine ? engine.buildInspectionReport(redactEvidence(inspectionReport)) : redactEvidence(inspectionReport)
}

// reject names that would override the trusted sandbox controls
function requireApplicationVariables(setting: InspectionOptions["applicationEnvironment"]): void {
	for (const [name, value] of Object.entries(typeof setting === "object" ? setting : {})) {
		if (!isApplicationVariable(name) || typeof value !== "string" || value.includes("\0") || value.length > 4096) {
			throw new InspectionError("invalid-environment", `Unsupported application variable: ${name}`)
		}
	}
}

async function inspectWithRecovery({
	runtime,
	context,
	engine,
	revision,
}: {
	runtime: RepositoryRuntime
	context: InspectionContext
	engine?: ModelInspection
	revision?: string
}): Promise<InspectionReport> {
	// Establish the first inspected checkout under the registry network policy.
	const checkout = await runtime.open(revision)
	const first = await inspectProject({ context, ...checkout, engine })
	if (!first.sandboxUnavailable) {
		return first
	}

	// Retain the first report if a second checkout cannot run inside the original limits.
	try {
		if (!(await runtime.replace())) {
			first.stoppedReason += " A replacement sandbox could not start within the remaining time and spend limits."
			return first
		}

		// Keep the replacement on the original commit and repeat its baseline.
		const replacement = await runtime.open(first.repository.commit, "Create replacement sandbox")
		engine?.resume(first)
		const retried = await inspectProject({ context, ...replacement, engine, previous: first })

		// Select the report using the replacement's own installation evidence.
		const install = retried.baseline.install
		if (install.status === "untested" && ["not-run", "interrupted"].includes(install.reason)) {
			first.stoppedReason += ` Replacement checkout: ${retried.stoppedReason ?? "Baseline installation was interrupted."}`
			return first
		}

		// Retain earlier baseline evidence only after the replacement installed the same checkout.
		if (install.status === "passed") {
			retainMeasuredStages(retried.baseline, first.baseline)
		}
		if (retried.sandboxUnavailable) {
			retried.stoppedReason += " The replacement sandbox also became unavailable."
		}
		return retried
	} catch (error) {
		// Keep infrastructure interruptions separate from credential and integrity failures.
		if (error instanceof SandboxUnavailableError && error.reason === "unavailable") {
			first.stoppedReason += " The replacement checkout could not be established."
			return first
		}

		// Preserve earlier evidence when the shared deadline expires.
		if (error instanceof InspectionError && error.code === "deadline") {
			first.stoppedReason += " The retry reached the time limit."
			return first
		}
		throw error
	}
}

function createEngine(
	input: (InspectionOptions | InspectionOptionsV2 | PreviousInspectionOptions | ModelRequestSandboxOptions) &
		WithSandboxProvider,
): ModelInspection | undefined {
	if (
		"callerModelExecution" in input &&
		![undefined, "modelRequestSandbox", "local"].includes(input.callerModelExecution)
	) {
		throw new InspectionError("invalid-model", "Unknown caller model execution mode")
	}

	// Preserve the legacy overload when the caller omits structured models.
	if ("callerModelExecution" in input && input.callerModelExecution === "modelRequestSandbox") {
		return new ModelInspection(input)
	}
	return hasModels(input) ? new ModelInspection(toModelOptions(input)) : undefined
}

async function releaseAllocations({
	context,
	allocation,
	engine,
	failure,
}: {
	context: InspectionContext
	allocation?: Sandbox
	engine?: ModelInspection
	failure?: InspectionError
}): Promise<InspectionError | undefined> {
	const provider = context.options.sandboxProvider

	// Track independent cleanup obligations for the repository and its sibling.
	const releases: { id: string; close: (op: import("../contracts.ts").Operation) => Promise<void> }[] = []
	if (allocation) {
		const sandbox = allocation
		releases.push({ id: sandbox.id, close: (op) => provider.destroySandbox(sandbox, op) })
	}

	// Include a model request sandbox whose creation reply may have been lost.
	if (engine?.modelRequestSandbox?.name) {
		const { name, provider } = engine.modelRequestSandbox
		releases.push({ id: name, close: (op) => provider.close(name, op) })
	}

	// Attempt both deletions even if one transport or event callback fails.
	const results = await Promise.all(
		releases.map(async ({ id, close }) => {
			const timeoutMs = context.cleanupWindow()
			try {
				await bounded((signal) => close({ timeoutMs, signal }), { timeoutMs })

				// Stop billing time only after acknowledgement.
				engine?.meter.deleted(id)
				return true
			} catch {
				return false
			}
		}),
	)
	const unresolved = releases.filter((_, index) => !results[index]).map((item) => item.id)
	if (unresolved.length) {
		failure ??= new InspectionError("cleanup-failed", "Runtime deletion could not be confirmed")
		failure.cleanupId = unresolved[0]
		failure.cleanupIds = unresolved
	}

	// Publish acknowledged deletions before the terminal event.
	for (const [index, { id }] of releases.entries()) {
		if (results[index]) {
			try {
				await context.emit({ type: "sandbox.event", sandboxId: id, action: "deleted" })
			} catch (error) {
				// Keep the first failure when final event delivery also fails.
				failure ??= asFailure(error)
			}
		}
	}
	return failure
}

function recordFailureEvidence({
	error,
	context,
	engine,
}: {
	error: InspectionError
	context: InspectionContext
	engine?: ModelInspection
}): void {
	// Preserve the accounting cutoff even when no Inspection Report can be returned.
	if (engine) {
		error.runtimeUsage = engine.meter.snapshot(engine.ledger.usage)
	}
	error.promptVersions = context.prompts.references
	error.timeline = engine?.timeline ?? context.timeline
}

async function failInspection(
	context: InspectionContext,
	failure?: InspectionError,
	engine?: ModelInspection,
): Promise<never> {
	// Publish the terminal failure with redacted diagnostic details.
	const error = failure ?? new InspectionError("inspection-failed", "Inspection did not return a report")
	recordFailureEvidence({ error, context, engine })
	try {
		await context.emit({
			type: "inspection.failed",
			code: error.code,
			message: redactEvidence(error.message),
			...(error.cleanupId ? { cleanupId: error.cleanupId } : {}),
			...(engine && error.cleanupIds ? { cleanupIds: error.cleanupIds } : {}),
			...(error.runtimeUsage ? { runtimeUsage: error.runtimeUsage } : {}),
		})
	} catch {
		// Preserve the inspection error when terminal delivery also fails.
	}
	error.message = redactEvidence(error.message)
	throw error
}

function toCheckOptions(
	input: (InspectionOptions | InspectionOptionsV2 | PreviousInspectionOptions | ModelRequestSandboxOptions) &
		WithSandboxProvider,
	engine?: ModelInspection,
): InspectionOptions & WithSandboxProvider {
	return engine
		? {
				repositoryUrl: input.repositoryUrl,
				sandboxProvider: input.sandboxProvider,
				signal: input.signal,
				prompts: input.prompts,
				telemetry: input.telemetry,
				upgrade: input.upgrade,
				applicationEnvironment: input.applicationEnvironment,
				includeTestInventory: true,
				limits: engine.limits,
			}
		: (input as InspectionOptions & WithSandboxProvider)
}

function asFailure(error: unknown): InspectionError {
	return error instanceof InspectionError
		? error
		: new InspectionError("inspection-failed", "Inspection could not complete")
}
