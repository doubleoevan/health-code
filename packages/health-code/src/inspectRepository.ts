import type { InspectionOptionsV2, PreviousInspectionOptions, ReportCardV2 } from "./agentContracts.ts"
import { NodeAdapter, ProjectEvidenceError, pending, RegistryDeadlineError, skippedUpgrade } from "./checkProject.ts"
import { bounded, InspectionContext, redactEvidence } from "./collectEvents.ts"
import { InspectionError, type InspectionOptions, type ReportCard, type Sandbox } from "./contracts.ts"
import { ModelInspection } from "./inspectModels.ts"
import { inspectUpgrade } from "./inspectUpgrade.ts"
import { hasModels, toModelOptions } from "./modelOptions.ts"
import type { ModelRequestSandboxOptions, ModelRequestSandboxReportCard } from "./modelRequestSandbox.ts"
import { registryHosts } from "./networkPolicy.ts"
import { sizeBytes } from "./readUpgradeEvidence.ts"
import { toRepositoryUrl } from "./toRepositoryUrl.ts"
import { readIntegrity } from "./verifyCandidate.ts"

/**
 * Inspects a pinned repository and releases its sandbox before returning the card.
 */
export function inspectRepository(options: ModelRequestSandboxOptions): Promise<ModelRequestSandboxReportCard>
export function inspectRepository(options: InspectionOptionsV2 | PreviousInspectionOptions): Promise<ReportCardV2>
export function inspectRepository(options: InspectionOptions): Promise<ReportCard>
export async function inspectRepository(
	input: InspectionOptions | InspectionOptionsV2 | PreviousInspectionOptions | ModelRequestSandboxOptions,
): Promise<ReportCard | ModelRequestSandboxReportCard> {
	// select the model-backed inspection contract and validate the repository
	const engine = createEngine(input)
	const options = toCheckOptions(input, engine)
	const repositoryUrl = toRepositoryUrl(options.repositoryUrl)

	// Validate the requested pin before allocating either runtime.
	if (input.revision !== undefined && !/^[0-9a-f]{40}$/.test(input.revision)) {
		throw new InspectionError("invalid-revision", "Expected a full commit SHA")
	}
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
	let allocation: Sandbox | undefined
	let card: ReportCard | undefined
	let failure: InspectionError | undefined
	try {
		// announce the inspection before contacting the provider
		await context.emit({ type: "inspection.started", repositoryUrl })
		await context.step("setup", "Check sandbox availability", (config) =>
			provider.checkAvailability({ ...config, timeoutMs: Math.min(10000, config.timeoutMs) }),
		)
		const sandbox = await context.step("setup", "Create sandbox", async (config) => {
			// reserve the sandbox identity before awaiting allocation
			allocation = { id: `health-code-${context.id}` }
			const lifetime = engine?.meter.start(
				"repository",
				allocation.id,
				(ms) => provider.estimateMaxCost(ms),
				provider.estimateMaxCost(context.end - context.started + (engine?.modelRequestSandbox ? context.cleanupMs : 0)),
			)
			const created = await provider.createSandbox(allocation.id, config)

			// Some providers return an opaque ID after confirming the named allocation.
			if (lifetime) {
				lifetime.id = created.id
			}
			allocation = created
			return created
		})

		// publish the sandbox lifecycle events before checkout
		for (const action of ["created", "credentials-withheld"] as const) {
			await context.emit({ type: "sandbox.event", sandboxId: sandbox.id, action })
		}
		const commit = await context.step("setup", "Prepare pinned checkout", (config) =>
			provider.prepareRepository(sandbox, repositoryUrl, { ...config, revision: input.revision }),
		)
		if (!/^[0-9a-f]{40}$/.test(commit) || (input.revision && input.revision !== commit)) {
			throw new InspectionError("repository-unavailable", "Unable to verify pinned repository")
		}
		await context.step("setup", "Lock network to registries", (config) =>
			provider.setNetworkPolicy(sandbox, registryHosts, { ...config, timeoutMs: Math.min(10000, config.timeoutMs) }),
		)
		await context.emit({ type: "sandbox.event", sandboxId: sandbox.id, action: "network-locked" })

		// inspect the pinned project under the registry policy
		context.setupComplete = true
		card = await inspectProject(context, sandbox, { url: repositoryUrl, commit }, engine)
	} catch (error) {
		failure = asFailure(error)
	} finally {
		context.cleaningUp = true

		// release allocated resources even if setup failed
		failure = await releaseAllocations({ context, allocation, engine, failure })
	}
	if (failure || !card) {
		return failInspection(context, failure, engine)
	}

	// emit completion after teardown succeeds
	try {
		await context.emit({
			type: "inspection.finished",
			inspected: card.upgrades.length,
			durationMs: Date.now() - context.started,
		})
	} catch (error) {
		// preserve delivery failure evidence on the inspection error
		const failed = asFailure(error)
		recordFailureEvidence({ error: failed, context, engine })
		throw failed
	}

	// Include every prompt dispatched before cleanup completed.
	card.promptVersions = context.prompts.references
	return engine ? engine.card(redactEvidence(card)) : redactEvidence(card)
}

function createEngine(
	input: InspectionOptions | InspectionOptionsV2 | PreviousInspectionOptions | ModelRequestSandboxOptions,
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
	const releases: { id: string; close: (op: import("./contracts.ts").Operation) => Promise<void> }[] = []
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
	// Preserve the accounting cutoff even when no Report Card can be returned.
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
	input: InspectionOptions | InspectionOptionsV2 | PreviousInspectionOptions | ModelRequestSandboxOptions,
	engine?: ModelInspection,
): InspectionOptions {
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
		: (input as InspectionOptions)
}

function asFailure(error: unknown): InspectionError {
	return error instanceof InspectionError
		? error
		: new InspectionError("inspection-failed", "Inspection could not complete")
}

async function inspectProject(
	context: InspectionContext,
	sandbox: Sandbox,
	repository: ReportCard["repository"],
	engine?: ModelInspection,
): Promise<ReportCard> {
	const adapter = new NodeAdapter(context, sandbox)
	adapter.watchChecks = !!engine
	const card: ReportCard = {
		version: 1,
		inspectionId: context.id,
		repository,
		packageManager: { reason: "project-not-detected" },
		baseline: pending("baseline-unavailable"),
		selection: { limit: context.maximum, selected: [], eligible: [], omitted: [], skipped: [] },
		upgrades: [],
		timeline: context.timeline,
	}
	try {
		// restore the pinned tree before detecting the project
		await adapter.resetProject()
		const project = await adapter.detectProject()
		card.packageManager = { name: project.manager, version: project.version }
		Object.assign(card.selection, await adapter.listUpgrades(project, context.maximum))
		await engine?.captureUsage(
			adapter,
			card.selection.selected.map((upgrade) => upgrade.dependency),
		)
		card.baseline.install = await adapter.install()

		// capture installation evidence for baseline comparisons
		if (engine) {
			engine.baseInstall = adapter.lastObservation
			engine.baseSize = await sizeBytes(adapter).catch(() => undefined)
		}
		if (card.baseline.install.status === "passed") {
			card.baseline.typecheck = await adapter.typecheck()
			card.baseline.tests = await adapter.test()

			// retain baseline test coverage for independent patch checks
			if (engine) {
				engine.baseTests = adapter.lastObservation
				engine.baseIntegrity = await readIntegrity(adapter).catch(() => undefined)
			}
		}

		// check the selected upgrades before ranking feature adoption
		await inspectSelected(context, adapter, card, sandbox, engine)
		await engine?.adopt()
	} catch (error) {
		let reason: string

		// distinguish missing project evidence from fatal inspection failures
		if (error instanceof ProjectEvidenceError) {
			reason = error.message
		} else if (error instanceof InspectionError && error.code === "deadline") {
			reason = "inspection-deadline"
		} else {
			throw error
		}

		// preserve the reason that detection or inspection stopped
		if ("reason" in card.packageManager) {
			card.packageManager = { reason }
		}

		// Surface a busy registry command in the partial Report Card.
		if (error instanceof RegistryDeadlineError) {
			card.selection.registryLookupIssue = reason
		}
		card.selection.skipped.push(reason)
		card.upgrades.push(...card.selection.selected.slice(card.upgrades.length).map((u) => skippedUpgrade(u, reason)))
	} finally {
		// clear the upgrade identity before returning the partial card
		context.upgradeId = undefined
	}
	return card
}

async function inspectSelected(
	context: InspectionContext,
	adapter: NodeAdapter,
	card: ReportCard,
	sandbox: Sandbox,
	engine?: ModelInspection,
): Promise<void> {
	for (const upgrade of card.selection.selected) {
		context.upgradeId = `${upgrade.dependency}@${upgrade.to}`

		// identify upgrades blocked by an unavailable baseline or deadline
		const blocked =
			card.baseline.install.status !== "passed" ||
			(adapter.project?.typecheck !== "none" && card.baseline.typecheck.status !== "passed")
		const report = skippedUpgrade(upgrade, blocked ? "baseline-unavailable" : "inspection-deadline")
		card.upgrades.push(report)

		// run checks only for upgrades with a usable baseline
		if (!blocked) {
			await inspectUpgrade({
				adapter,
				report,
				baseline: card.baseline,
				afterInstall: engine ? () => engine.captureInstallation(adapter, report) : undefined,
			})
		}
		await engine?.inspect(context, adapter, sandbox, card, report)
	}
}
