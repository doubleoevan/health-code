import type { InspectionOptionsV2, PreviousInspectionOptions, ReportCardV2 } from "./agentContracts.ts"
import { NodeAdapter, ProjectEvidenceError, pending, skippedUpgrade } from "./checkProject.ts"
import { bounded, InspectionContext, redactEvidence } from "./collectEvents.ts"
import { confirm, untested } from "./confirmCheck.ts"
import {
	type Baseline,
	type CheckResult,
	type EcosystemAdapter,
	InspectionError,
	type InspectionOptions,
	type Observation,
	type ReportCard,
	type Sandbox,
	type UpgradeReport,
} from "./contracts.ts"
import { hasModels, ModelInspection, toModelOptions } from "./inspectModels.ts"
import { registryHosts } from "./networkPolicy.ts"
import { sizeBytes } from "./readUpgradeEvidence.ts"
import { toRepositoryUrl } from "./toRepositoryUrl.ts"
import { readIntegrity } from "./verifyCandidate.ts"

/** Inspects a pinned repository and releases its sandbox before returning the card. */
export function inspectRepository(options: InspectionOptionsV2 | PreviousInspectionOptions): Promise<ReportCardV2>
export function inspectRepository(options: InspectionOptions): Promise<ReportCard>
export async function inspectRepository(
	input: InspectionOptions | InspectionOptionsV2 | PreviousInspectionOptions,
): Promise<ReportCard | ReportCardV2> {
	// select the model-backed inspection contract and validate the repository
	const engine = hasModels(input) ? new ModelInspection(toModelOptions(input)) : undefined
	const options = toCheckOptions(input, engine)
	const repositoryUrl = toRepositoryUrl(options.repositoryUrl)
	const context = new InspectionContext(options, engine && ((event) => engine.forward(event)))
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
			const created = await provider.createSandbox(allocation.id, config)
			allocation = created
			return created
		})
		// publish the sandbox lifecycle events before checkout
		for (const action of ["created", "credentials-withheld"] as const) {
			await context.emit({ type: "sandbox.event", sandboxId: sandbox.id, action })
		}
		const commit = await context.step("setup", "Prepare pinned checkout", (config) =>
			provider.prepareRepository(sandbox, repositoryUrl, config),
		)
		if (!/^[0-9a-f]{40}$/.test(commit)) {
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
		if (allocation) {
			failure = await release(context, allocation, failure)
		}
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
		failed.timeline = engine?.timeline ?? context.timeline
		throw failed
	}
	return engine ? engine.card(redactEvidence(card)) : redactEvidence(card)
}
async function failInspection(
	context: InspectionContext,
	failure?: InspectionError,
	engine?: ModelInspection,
): Promise<never> {
	// publish the terminal failure with redacted diagnostic details
	const error = failure ?? new InspectionError("inspection-failed", "Inspection did not return a report")
	try {
		await context.emit({
			type: "inspection.failed",
			code: error.code,
			message: redactEvidence(error.message),
			...(error.cleanupId ? { cleanupId: error.cleanupId } : {}),
		})
	} catch {
		// Preserve the inspection error when terminal delivery also fails.
	}
	error.message = redactEvidence(error.message)
	error.timeline = engine?.timeline ?? context.timeline
	throw error
}
function toCheckOptions(
	input: InspectionOptions | InspectionOptionsV2 | PreviousInspectionOptions,
	engine?: ModelInspection,
): InspectionOptions {
	return engine
		? {
				repositoryUrl: input.repositoryUrl,
				sandboxProvider: input.sandboxProvider,
				signal: input.signal,
				upgrade: input.upgrade,
				applicationEnvironment: input.applicationEnvironment,
				includeTestInventory: true,
				limits: engine.limits,
			}
		: (input as InspectionOptions)
}
async function release(
	context: InspectionContext,
	allocation: Sandbox,
	failure?: InspectionError,
): Promise<InspectionError | undefined> {
	const provider = context.options.sandboxProvider
	try {
		// Give cleanup its reserved window if the host resumed after the inspection deadline.
		// give teardown its reserved timeout window
		const timeoutMs = context.cleanupWindow()
		await bounded((signal) => provider.destroySandbox(allocation, { timeoutMs, signal }), { timeoutMs })
	} catch {
		failure ??= new InspectionError("cleanup-failed", "Sandbox deletion could not be confirmed")
		failure.cleanupId = allocation.id
	}
	// emit deletion only when teardown has succeeded
	if (!failure?.cleanupId) {
		try {
			await context.emit({ type: "sandbox.event", sandboxId: allocation.id, action: "deleted" })
		} catch (error) {
			failure ??= asFailure(error)
		}
	}

	return failure
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

function installationReason(observation: Observation): string | undefined {
	if (observation.findings.length) {
		return "installation-finding"
	}
	return observation.complete ? undefined : "incomplete-observation"
}

async function inspectUpgrade({
	adapter,
	report,
	baseline,
	afterInstall,
}: {
	adapter: EcosystemAdapter
	report: UpgradeReport
	baseline: Baseline
	afterInstall?: () => Promise<void>
}): Promise<void> {
	// start each installation check from the pinned project
	await adapter.resetProject()
	const first = await adapter.bumpDependency(report)
	report.install = first.check
	report.observation = first.observation
	if (!installationReason(report.observation)) {
		report.install = await confirm(first.check, baseline.install, async () => {
			// recreate the upgrade to confirm a failing install
			await adapter.resetProject()
			const second = await adapter.bumpDependency(report)
			report.observation = second.observation
			return second.check
		})
	}
	// stop further checks when installation evidence is incomplete
	const reason = installationReason(report.observation)
	if (reason || report.install.status !== "passed") {
		report.result = reason ? untested(reason, report.install.evidence) : report.install
		report.tests = report.typecheck = untested(reason ?? "install-failed")
		return
	}
	// capture installed evidence before comparing test and typecheck results
	await afterInstall?.()
	if (!(await checkStages(adapter, report, baseline))) {
		return
	}
	const applicable = [
		report.install,
		...(adapter.project?.typecheck === "none" ? [] : [report.typecheck]),
		report.tests,
	]
	report.result = applicable.find((r) => r.status === "failed") ??
		applicable.find((r) => r.status === "untested") ?? {
			status: "passed",
			evidence: applicable.flatMap((r) => r.evidence),
		}
}

async function checkStages(adapter: EcosystemAdapter, report: UpgradeReport, baseline: Baseline): Promise<boolean> {
	for (const stage of ["typecheck", "tests"] as const) {
		// run and confirm each applicable check against the baseline
		const firstCheck = stage === "tests" ? await adapter.test() : await adapter.typecheck()
		report[stage] = await confirm(firstCheck, baseline[stage], () => repeatCheck(adapter, report, stage))
		const checked = report[stage]
		const interrupted =
			checked.status === "untested" &&
			["inspection-deadline", "confirmation-install-unavailable"].includes(checked.reason)
		// retain the observation or deadline reason that stopped the stage
		const reason = installationReason(report.observation) ?? (interrupted ? checked.reason : undefined)
		if (reason) {
			report.result = untested(reason, checked.evidence)
			if (stage === "typecheck") {
				report.tests = untested(reason)
			}
			// stop before running another stage after a blocking finding
			return false
		}
	}
	return true
}

async function repeatCheck(
	adapter: EcosystemAdapter,
	report: UpgradeReport,
	stage: "typecheck" | "tests",
): Promise<CheckResult> {
	// reinstall the upgrade on a freshly restored project
	await adapter.resetProject()
	const install = await adapter.bumpDependency(report)
	report.observation = install.observation
	report.install.evidence = [...report.install.evidence, ...install.check.evidence]
	if (install.check.status !== "passed" || installationReason(install.observation)) {
		return untested("confirmation-install-unavailable", install.check.evidence)
	}
	// rerun the failed stage with its build prerequisites
	if (stage === "typecheck") {
		return adapter.typecheck()
	}
	if (adapter.project?.typecheck !== "none") {
		const typecheck = await adapter.typecheck()
		// preserve a missing confirmation build as untested
		if (typecheck.status !== "passed") {
			return untested("confirmation-build-unavailable", typecheck.evidence)
		}
	}
	return adapter.test()
}
