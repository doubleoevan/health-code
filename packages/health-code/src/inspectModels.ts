import { generateText } from "ai"
import { z } from "zod"
import type { AgentRole, InspectionEventV2, InspectionOptionsV2, UpgradeReportV2 } from "./agentContracts.ts"
import { buildPrompt, parseAnswer } from "./buildPrompt.ts"
import type { NodeAdapter } from "./checkProject.ts"
import { cleanupAllowance, type InspectionContext, redactEvidence, rethrowInspectionFailure } from "./collectEvents.ts"
import {
	InspectionError,
	type InspectionEvent,
	type InspectionOptions,
	type Observation,
	type ReportCard,
	type Sandbox,
	type UpgradeReport,
} from "./contracts.ts"
import { agentLimits, cap, type Ledger, paidRequest, reserveCost } from "./modelBudget.ts"
import { validateModels } from "./modelOptions.ts"
import {
	callerOutputTokens,
	ModelRequestSandboxAllocation,
	type ModelRequestSandboxEvent,
	type ModelRequestSandboxOptions,
	type ModelRequestSandboxReportCard,
} from "./modelRequestSandbox.ts"
import { matchSchema, selectFeatureMatches, verifyMatch } from "./rankFeatureMatches.ts"
import { readReleases } from "./readReleases.ts"
import { diagnostics, locateDiagnostics, sizeBytes, type UsageEvidence, usageEvidence } from "./readUpgradeEvidence.ts"
import { RuntimeMeter } from "./runtimeUsage.ts"
import { credentialTarget } from "./sandbox/setCredentialBinding.ts"
import { type PatchEvidence, workspace } from "./verifyCandidate.ts"
import { evaluatePatch } from "./verifyPatch.ts"

const summarySchema = z.object({ text: z.string().max(8000), sources: z.array(z.string()) })
type Candidate = { report: UpgradeReportV2; evidence: PatchEvidence }
export class ModelInspection {
	// accumulate the version two timeline, reports and adoption candidates
	readonly timeline: ModelRequestSandboxEvent[] = []
	readonly upgrades: UpgradeReportV2[] = []
	readonly candidates: Candidate[] = []
	readonly limits: NonNullable<InspectionOptions["limits"]> & { maxDurationMs: number; maxCostUsd: number }
	readonly ledger: Ledger
	readonly matchLimit: number
	attempt?: { attemptId: string; role: AgentRole }
	// keep pinned usage separate from observations after each installation
	private readonly installedEvidence = new Map<string, { changelog: string; bytes?: number }>()
	private readonly pinnedUsage = new Map<string, UsageEvidence>()
	baseSize?: number
	baseInstall?: Observation
	baseTests?: Observation
	baseIntegrity?: PatchEvidence["baselineIntegrity"]
	// clamp inspection limits before constructing the model budget
	readonly meter = new RuntimeMeter()
	readonly modelRequestSandbox?: ModelRequestSandboxAllocation
	constructor(readonly options: InspectionOptionsV2 | ModelRequestSandboxOptions) {
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
		this.ledger = {
			remainingMicros: Math.max(0, Math.floor((this.limits.maxCostUsd - reserve) * 1e6)),
			end: Date.now() + this.limits.maxDurationMs,
			usage: [],
		}
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
	async requestHostModel(
		role: "releaseSummary" | "featureMatch",
		evidence: unknown,
		context: InspectionContext,
	): Promise<unknown> {
		const configured = this.options.models[role]
		const { pricing } = configured
		// build a bounded prompt for the selected host role
		const prompt = await buildPrompt(role, evidence, context.prompts)
		const output = callerOutputTokens
		const reserve = reserveCost({ pricing, prompt, output })
		if (this.modelRequestSandbox && "credential" in configured) {
			const modelRequestSandbox = this.modelRequestSandbox
			await modelRequestSandbox.ready({
				context,
				ledger: this.ledger,
				requestMicros: reserve,
				start: async (name) => {
					const options = this.options
					if (options.callerModelExecution !== "modelRequestSandbox") {
						throw new InspectionError("model-request-sandbox", "Invalid model request sandbox configuration")
					}
					const event: ModelRequestSandboxEvent = {
						version: 2,
						type: "sandbox.event",
						action: "model-request-sandbox-started",
						sandboxId: name,
						inspectionId: context.id,
						sequence: this.timeline.length + 1,
						timestamp: new Date().toISOString(),
						detail:
							"Model request sandbox started. The sandbox provider supplies the model key. This machine doesn’t need it.",
					}
					this.timeline.push(event)
					await context.deliver(() => options.onEvent?.(structuredClone(event)))
				},
				route: configured,
				allocated: (name, reservedUsd) =>
					this.meter.start(
						"modelRequestSandbox",
						name,
						(ms) => modelRequestSandbox.provider.estimateMaxCost(ms),
						reservedUsd,
					),
			})
		}
		const text = await context.step("setup", role, (operation) =>
			paidRequest({
				ledger: this.ledger,
				context,
				execution: this.modelRequestSandbox ? "modelRequestSandbox" : undefined,
				role,
				step: role,
				pricing,
				modelId: "model" in configured ? configured.model.modelId : configured.modelId,
				prompt,
				output,
				signal: operation.signal,
				send: async (budget, telemetry) => {
					if ("credential" in configured && this.modelRequestSandbox) {
						return this.modelRequestSandbox.send({ role, route: configured, prompt, output }, budget)
					}
					if (!("model" in configured)) {
						throw new InspectionError("invalid-model", "Missing caller model")
					}
					// Dispatch local handles through the caller’s model client.
					const { model } = configured
					const reply = await generateText({
						model,
						prompt,
						maxRetries: 0,
						maxOutputTokens: 1024,
						abortSignal: budget.signal,
						telemetry,
					})
					return {
						text: reply.text,
						modelId: model.modelId,
						inputTokens: reply.usage.inputTokens,
						outputTokens: reply.usage.outputTokens,
						requestId: reply.response.id,
					}
				},
			}),
		)
		return parseAnswer(text)
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
		this.installedEvidence.set(upgradeKey(upgrade), { changelog, bytes: after })
	}
	async inspect(
		context: InspectionContext,
		adapter: NodeAdapter,
		sandbox: Sandbox,
		card: ReportCard,
		upgrade: UpgradeReport,
	): Promise<void> {
		// attribute subsequent model requests to this upgrade
		const offset = this.ledger.usage.length
		const report = toUpgradeReport(upgrade)
		this.upgrades.push(report)
		const usage = this.pinnedUsage.get(upgrade.dependency) ?? { usage: [], unresolved: [], changelog: "" }
		const measured = this.installedEvidence.get(upgradeKey(upgrade))
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
		await this.matchFeatures({ context, report, usage, evidence, repository: card.repository })
		report.releaseSummary.gaps = evidence.gaps
		const patchEvidence: PatchEvidence = {
			context,
			adapter,
			sandbox,
			card,
			report,
			usage,
			releaseNotes: evidence.notes,
			baselineIntegrity: this.baseIntegrity,
			baseInstall: this.baseInstall,
			baseTests: this.baseTests,
		}
		// verify diagnostic locations against the pinned source
		await locateDiagnostics({
			repository: card.repository,
			locators: report.locators,
			read: (file) => workspace(patchEvidence, { kind: "read", revision: card.repository.commit, file }),
		})
		try {
			await evaluatePatch(this, patchEvidence)
		} finally {
			// keep the model usage even when patch evaluation fails
			report.modelUsage = this.ledger.usage.slice(offset)
		}
		this.candidates.push({ report, evidence: patchEvidence })
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
		repository: ReportCard["repository"]
	}): Promise<void> {
		// require a release source before asking for a summary
		const sources = evidence.notes.map((note) => note.source)
		if (!sources.length) {
			return
		}
		try {
			// accept only sources present in the collected evidence
			const summary = summarySchema.parse(await this.requestHostModel("releaseSummary", evidence, context))
			if (summary.sources.length && summary.sources.every((source) => sources.includes(source))) {
				report.releaseSummary = summary
			}
			if (usage.usage.length) {
				// request feature matches against observed source usage
				const matches = matchSchema.parse(
					await this.requestHostModel(
						"featureMatch",
						{ notes: evidence.notes, summary: report.releaseSummary, usage: usage.usage },
						context,
					),
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
	async adopt(): Promise<void> {
		// evaluate the highest-ranked eligible match for each upgrade
		for (const { candidate, match } of selectFeatureMatches(this.candidates, this.matchLimit)) {
			const offset = this.ledger.usage.length
			candidate.evidence.context.upgradeId = `${candidate.report.dependency}@${candidate.report.to}`
			await evaluatePatch(this, candidate.evidence, match)
			candidate.report.modelUsage.push(...this.ledger.usage.slice(offset))
		}
	}
	// assemble the version two report from the measured upgrades
	card(card: ReportCard): ModelRequestSandboxReportCard {
		const reports = new Map(this.upgrades.map((upgrade) => [upgradeKey(upgrade), upgrade]))
		return {
			...card,
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
				card.upgrades.map((upgrade) => reports.get(upgradeKey(upgrade)) ?? toUpgradeReport(upgrade)),
			),
			timeline: this.timeline,
			runtimeUsage: this.meter.snapshot(this.ledger.usage),
		}
	}
}

function upgradeKey(upgrade: Pick<UpgradeReport, "dependency" | "to">): string {
	return `${upgrade.dependency}@${upgrade.to}`
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
