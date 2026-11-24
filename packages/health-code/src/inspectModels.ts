import { isDeepStrictEqual } from "node:util"
import { z } from "zod"
import type { AgentRole, InspectionEventV2, InspectionOptionsV2, UpgradeReportV2 } from "./agentContracts.ts"
import type { NodeAdapter } from "./checkProject.ts"
import { cleanupAllowance, type InspectionContext, redactEvidence, rethrowInspectionFailure } from "./collectEvents.ts"
import {
	InspectionError,
	type InspectionEvent,
	type InspectionOptions,
	type InspectionReport,
	type Observation,
	type Sandbox,
	type UpgradeReport,
	type WithSandboxProvider,
} from "./contracts.ts"
import { agentLimits, cap, type Ledger } from "./modelBudget.ts"
import { validateModels } from "./modelOptions.ts"
import {
	ModelRequestSandboxAllocation,
	type ModelRequestSandboxEvent,
	type ModelRequestSandboxInspectionReport,
	type ModelRequestSandboxOptions,
} from "./modelRequestSandbox.ts"
import { matchSchema, selectFeatureMatches, verifyMatch } from "./rankFeatureMatches.ts"
import { readReleases } from "./readReleases.ts"
import { diagnostics, locateDiagnostics, sizeBytes, type UsageEvidence, usageEvidence } from "./readUpgradeEvidence.ts"
import { requestHostModel } from "./requestHostModel.ts"
import { RuntimeMeter } from "./runtimeUsage.ts"
import { credentialTarget } from "./sandbox/setCredentialBinding.ts"
import { toUpgradeKey } from "./selectUpgrades.ts"
import { type PatchEvidence, workspace } from "./verifyCandidate.ts"
import { evaluatePatch } from "./verifyPatch.ts"

const summarySchema = z.object({ text: z.string().max(8000), sources: z.array(z.string()) })
type Candidate = { report: UpgradeReportV2; evidence: PatchEvidence }
export class ModelInspection {
	// Accumulate evidence in inspection order.
	readonly timeline: ModelRequestSandboxEvent[] = []
	readonly upgrades: UpgradeReportV2[] = []
	readonly reused = new Map<string, UpgradeReportV2>()
	private adoptionsStarted = 0
	readonly limits: NonNullable<InspectionOptions["limits"]> & { maxDurationMs: number; maxCostUsd: number }

	// Track the initial hold until the first repository runtime is deleted.
	readonly repositoryReservationMicros: number
	readonly ledger: Ledger
	readonly matchLimit: number
	attempt?: { attemptId: string; role: AgentRole }

	// keep pinned usage separate from observations after each installation
	private readonly installedEvidence = new Map<string, { changelog: string; bytes?: number }>()
	private readonly pinnedUsage = new Map<string, UsageEvidence>()
	baseSize?: number
	baseInstall?: Observation
	baseTests?: Observation
	baselinePatchVerificationInputs?: PatchEvidence["baselinePatchVerificationInputs"]

	// clamp inspection limits before constructing the model budget
	readonly meter = new RuntimeMeter()
	readonly modelRequestSandbox?: ModelRequestSandboxAllocation
	constructor(readonly options: (InspectionOptionsV2 | ModelRequestSandboxOptions) & WithSandboxProvider) {
		this.limits = {
			...options.limits,
			maxCostUsd: cap(options.limits?.maxCostUsd, 15),
			maxUpgrades: cap(options.limits?.maxUpgrades, 6),
			maxDurationMs: cap(options.limits?.maxDurationMs, 3600000),
		}
		this.matchLimit = options.limits?.maxFeatureMatches ?? 3
		if (!Number.isSafeInteger(this.matchLimit) || this.matchLimit < 0) {
			throw new InspectionError("invalid-limits", "Invalid feature match limit")
		}

		// validate both guest routes before allocating sandbox time
		for (const role of ["repair", "featureAdoption"] as const) {
			if (!options.models?.[role]?.credential) {
				throw new InspectionError("invalid-model-route", "Missing guest model route")
			}
			credentialTarget(options.models[role])
			agentLimits(role, options.limits)
		}

		// reserve the sandbox cost before permitting model requests
		validateModels(options)
		if (options.callerModelExecution === "modelRequestSandbox") {
			if (!options.sandboxProvider.modelRequestSandbox) {
				throw new InspectionError("model-request-sandbox", "Sandbox Provider has no Model Request Sandbox capability")
			}
			this.modelRequestSandbox = new ModelRequestSandboxAllocation(options.sandboxProvider.modelRequestSandbox)
		}

		// Reserve the repository runtime before admitting any inference.
		const duration = this.limits.maxDurationMs
		const reserve = options.sandboxProvider.estimateMaxCost(
			duration + (this.modelRequestSandbox ? cleanupAllowance(duration) : 0),
		)
		if (!Number.isFinite(reserve) || reserve < 0) {
			throw new InspectionError("pricing", "Sandbox price bound unavailable")
		}
		this.repositoryReservationMicros = Math.min(Math.floor(this.limits.maxCostUsd * 1e6), Math.ceil(reserve * 1e6))
		this.ledger = {
			remainingMicros: Math.max(0, Math.floor((this.limits.maxCostUsd - reserve) * 1e6)),
			end: Date.now() + this.limits.maxDurationMs,
			usage: [],
		}
	}

	get storedModelKeyCount(): number {
		const { repair, featureAdoption, releaseSummary, featureMatch } = this.options.models

		// Count a stored credential once across roles without exposing its name.
		const keys = [repair, featureAdoption, releaseSummary, featureMatch].flatMap((route) =>
			"credential" in route ? [route.credential.name] : [],
		)
		return new Set(keys).size
	}

	// forward version two events using the shared sequence
	forward(event: InspectionEvent): () => Promise<void> {
		const next = { ...event, version: 2 as const, sequence: this.timeline.length + 1, ...this.attempt }
		this.timeline.push(next)
		return async () => this.options.onEvent?.(structuredClone(next))
	}
	async emitAgentStarted(context: InspectionContext, sandbox: Sandbox): Promise<void> {
		// require an active attempt before announcing agent startup
		if (!this.attempt) {
			throw new Error("Missing attempt identity")
		}
		const event: InspectionEventV2 = {
			type: "sandbox.event",
			version: 2,
			inspectionId: context.id,
			sequence: this.timeline.length + 1,
			timestamp: new Date().toISOString(),
			sandboxId: sandbox.id,
			action: "agent-started",
			upgradeId: context.upgradeId,
			...this.attempt,
		}
		this.timeline.push(event)
		await context.deliver(() => this.options.onEvent?.(structuredClone(event)))
	}

	// Replace sandbox-local evidence while retaining completed upgrades and the inspection ledger.
	resume(report: InspectionReport): void {
		const completed = this.buildInspectionReport(report).upgrades.filter((upgrade) => !upgrade.coverage)
		for (const upgrade of completed) {
			this.reused.set(toUpgradeKey(upgrade), upgrade)
		}

		// Measure the replacement baseline before comparing outstanding targets.
		this.installedEvidence.clear()
		this.baseInstall = undefined
		this.baseTests = undefined
		this.baselinePatchVerificationInputs = undefined
		this.baseSize = undefined
	}

	// Match cached results against freshly selected dependency targets.
	restoreUpgrades(report: InspectionReport): void {
		for (const upgrade of report.selection.selected) {
			if (this.reused.has(toUpgradeKey(upgrade))) {
				continue
			}

			// Check the external cache for targets still outstanding.
			const cached = this.options.reuseUpgrade?.(report.repository, upgrade)
			const reusedFromInspectionId = cached?.reusedFromInspectionId ?? cached?.reusedFrom
			if (!cached || !reusedFromInspectionId || cached.coverage || cached.verdict === "Untested") {
				continue
			}

			// Verify the workspace pins before attaching a prior verdict.
			const key = toUpgradeKey(upgrade)
			if (toUpgradeKey(cached) === key && isDeepStrictEqual(cached.from, upgrade.from)) {
				this.reused.set(key, { ...cached, reusedFromInspectionId })
			}
		}
	}

	// capture pinned usage before dependency installation changes the tree
	async captureUsage(adapter: NodeAdapter, selected: UpgradeReport["dependency"][]): Promise<void> {
		for (const dependency of new Set(selected)) {
			const usage = await adapter
				.data(["usage", dependency])
				.then((value) => usageEvidence.parse(value))
				.catch(() => ({ usage: [], unresolved: ["Source inventory unavailable"], changelog: "" }))

			// cache missing evidence as an explicit usage limitation
			this.pinnedUsage.set(dependency, usage)
		}
	}
	async captureInstallation(adapter: NodeAdapter, upgrade: UpgradeReport): Promise<void> {
		// read the changelog and installed size from the upgraded tree
		const changelog = await adapter
			.data(["changelog", upgrade.dependency])
			.then((value) => z.string().parse(value))
			.catch(() => "")
		const after = await sizeBytes(adapter).catch(() => undefined)
		this.installedEvidence.set(toUpgradeKey(upgrade), { changelog, bytes: after })
	}
	async inspect(
		context: InspectionContext,
		adapter: NodeAdapter,
		sandbox: Sandbox,
		inspectionReport: InspectionReport,
		upgrade: UpgradeReport,
	): Promise<void> {
		// attribute subsequent model requests to this upgrade
		const offset = this.ledger.usage.length
		const report = toUpgradeReport(upgrade)
		this.upgrades.push(report)
		const usage = this.pinnedUsage.get(upgrade.dependency) ?? { usage: [], unresolved: [], changelog: "" }
		const measured = this.installedEvidence.get(toUpgradeKey(upgrade))
		const changelog = measured?.changelog ?? ""
		const after = measured?.bytes
		report.usageLimitations = usage.unresolved

		// compare sizes only when both installations were measured
		if (this.baseSize !== undefined && after !== undefined) {
			report.installSize = {
				before: this.baseSize,
				after,
				delta: after - this.baseSize,
				method: "Installed regular-file bytes, deduplicated by device and inode",
			}
		}

		// gather release evidence before requesting feature matches
		const evidence = await context.step("setup", "Read release notes", (op) =>
			readReleases({ upgrade, githubToken: this.options.githubToken, changelog, signal: op.signal }),
		)
		try {
			await this.matchFeatures({ context, report, usage, evidence, repository: inspectionReport.repository })
			report.releaseSummary.gaps = evidence.gaps
			const patchEvidence: PatchEvidence = {
				context,
				adapter,
				sandbox,
				inspectionReport,
				report,
				usage,
				releaseNotes: evidence.notes,
				baselinePatchVerificationInputs: this.baselinePatchVerificationInputs,
				baseInstall: this.baseInstall,
				baseTests: this.baseTests,
			}

			// verify diagnostic locations against the pinned source
			await locateDiagnostics({
				repository: inspectionReport.repository,
				locators: report.locators,
				read: (file) => workspace(patchEvidence, { kind: "read", revision: inspectionReport.repository.commit, file }),
			})
			if (report.coverage === "partial") {
				return
			}

			await evaluatePatch(this, patchEvidence)
			await this.adopt({ report, evidence: patchEvidence })
		} finally {
			// Retain all receipts, including model work completed before an interruption.
			report.modelUsage = this.ledger.usage.slice(offset)
		}
	}
	private async matchFeatures({
		context,
		report,
		usage,
		evidence,
		repository,
	}: {
		context: InspectionContext
		report: UpgradeReportV2
		usage: UsageEvidence
		evidence: Awaited<ReturnType<typeof readReleases>>
		repository: InspectionReport["repository"]
	}): Promise<void> {
		// require a release source before asking for a summary
		const sources = evidence.notes.map((note) => note.source)
		if (!sources.length) {
			return
		}
		try {
			// accept only sources present in the collected evidence
			const summary = summarySchema.parse(
				await requestHostModel({ engine: this, role: "releaseSummary", evidence, context }),
			)
			if (summary.sources.length && summary.sources.every((source) => sources.includes(source))) {
				report.releaseSummary = summary
			}
			if (usage.usage.length) {
				// request feature matches against observed source usage
				const matches = matchSchema.parse(
					await requestHostModel({
						engine: this,
						role: "featureMatch",
						evidence: { notes: evidence.notes, summary: report.releaseSummary, usage: usage.usage },
						context,
					}),
				)
				for (const match of matches) {
					// retain matches that cite verified source locations
					const verified = verifyMatch({ match, usage, notes: evidence.notes, repository })
					if (verified) {
						report.featureMatches.push(verified)
					}
				}
			}
		} catch (error) {
			// preserve cancellation and delivery failures from model calls
			rethrowInspectionFailure(error, context)
			if (error instanceof InspectionError && error.code === "model-request-sandbox-startup") {
				throw error
			}
			recordEvidenceError(report, error, Boolean(this.modelRequestSandbox))
		}
	}
	private async adopt(target: Candidate): Promise<void> {
		// evaluate the highest-ranked eligible match for each upgrade
		for (const { candidate, match } of selectFeatureMatches([target], this.matchLimit - this.adoptionsStarted)) {
			this.adoptionsStarted++
			candidate.evidence.context.upgradeId = `${candidate.report.dependency}@${candidate.report.to}`

			await evaluatePatch(this, candidate.evidence, match)
		}
	}

	// assemble the version two report from the measured upgrades
	buildInspectionReport(inspectionReport: InspectionReport): ModelRequestSandboxInspectionReport {
		const reports = collectUpgradeAttempts(this.upgrades)
		return {
			...inspectionReport,
			version: 2,
			limits: {
				maxDurationMs: this.limits.maxDurationMs,
				maxCostUsd: this.limits.maxCostUsd,
				agent: {
					repair: agentLimits("repair", this.options.limits),
					featureAdoption: agentLimits("featureAdoption", this.options.limits),
				},
			},
			upgrades: redactEvidence(
				inspectionReport.upgrades.map((upgrade) => {
					const key = toUpgradeKey(upgrade)
					const previous = this.reused.get(key)
					if (previous) {
						return previous
					}

					// Retain the last completed checks on an interrupted upgrade.
					const result = reports.get(key) ?? toUpgradeReport(upgrade)
					return toMeasuredUpgrade(result, upgrade, inspectionReport.stoppedReason)
				}),
			),
			timeline: this.timeline,
			runtimeUsage: this.meter.snapshot(this.ledger.usage),
		}
	}
}

// initialize unmeasured upgrade evidence with an explicit verdict
function toUpgradeReport(upgrade: UpgradeReport): UpgradeReportV2 {
	return {
		...upgrade,
		releaseSummary: { text: "Release evidence unavailable", sources: [] },
		featureMatches: [],
		locators: diagnostics([upgrade.install, upgrade.typecheck, upgrade.tests]),
		installSize: { reason: "Size measurement unavailable" },
		verdict: "Untested",
		patches: [],
		newDependencies: [],
		modelUsage: [],
	}
}

function recordEvidenceError(report: UpgradeReportV2, error: unknown, modelRequestSandbox: boolean): void {
	if (modelRequestSandbox && error instanceof InspectionError && error.code === "credential-binding") {
		throw error
	}

	// Record incomplete evidence on the affected Upgrade.
	report.releaseSummary.text +=
		error instanceof InspectionError && error.code === "model-budget"
			? " (model budget reached)"
			: " (model evidence incomplete)"
}

function toMeasuredUpgrade(result: UpgradeReportV2, upgrade: UpgradeReport, stoppedReason?: string): UpgradeReportV2 {
	if (upgrade.coverage) {
		return { ...result, coverage: upgrade.coverage }
	}

	// Identify feature adoption work left pending when the sandbox stopped.
	if (stoppedReason && result.featureMatches.some((match) => match.disposition === "ranked")) {
		return { ...result, coverage: "partial" }
	}
	return result
}

function collectUpgradeAttempts(attempts: UpgradeReportV2[]): Map<string, UpgradeReportV2> {
	const reports = new Map<string, UpgradeReportV2>()
	for (const attempt of attempts) {
		const key = toUpgradeKey(attempt)

		// Attribute model receipts from both attempts to their dependency target.
		const first = reports.get(key)
		if (!first) {
			reports.set(key, attempt)
			continue
		}

		// Keep a verified mailbox if the replacement stopped before verifying another.
		const result =
			first.patches.length && !attempt.patches.length ? { ...first, coverage: "partial" as const } : attempt
		reports.set(key, { ...result, modelUsage: [...first.modelUsage, ...attempt.modelUsage] })
	}
	return reports
}
