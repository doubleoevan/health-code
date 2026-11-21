import { generateText } from "ai"
import { z } from "zod"
import type {
	AgentRole,
	InspectionEventV2,
	InspectionOptionsV2,
	PreviousInspectionOptions,
	ReportCardV2,
	UpgradeReportV2,
} from "./agentContracts.ts"
import { buildPrompt, parseAnswer } from "./buildPrompt.ts"
import type { NodeAdapter } from "./checkProject.ts"
import { type InspectionContext, redactEvidence, rethrowInspectionFailure } from "./collectEvents.ts"
import {
	InspectionError,
	type InspectionEvent,
	type InspectionOptions,
	type Observation,
	type ReportCard,
	type Sandbox,
	type UpgradeReport,
} from "./contracts.ts"
import { agentLimits, cap, type Ledger, paidRequest } from "./modelBudget.ts"
import { matchSchema, selectFeatureMatches, verifyMatch } from "./rankFeatureMatches.ts"
import { readReleases } from "./readReleases.ts"
import { diagnostics, locateDiagnostics, sizeBytes, type UsageEvidence, usageEvidence } from "./readUpgradeEvidence.ts"
import { credentialTarget } from "./sandbox/setCredentialBinding.ts"
import { type PatchEvidence, workspace } from "./verifyCandidate.ts"
import { evaluatePatch } from "./verifyPatch.ts"

const summarySchema = z.object({ text: z.string().max(8000), sources: z.array(z.string()) })
type Candidate = { report: UpgradeReportV2; evidence: PatchEvidence }
export class ModelInspection {
	readonly timeline: InspectionEventV2[] = []
	readonly upgrades: UpgradeReportV2[] = []
	readonly candidates: Candidate[] = []
	readonly limits: NonNullable<InspectionOptions["limits"]> & { maxDurationMs: number; maxCostUsd: number }
	readonly ledger: Ledger
	readonly matchLimit: number
	attempt?: { attemptId: string; role: AgentRole }
	private readonly installedEvidence = new Map<string, { changelog: string; bytes?: number }>()
	private readonly pinnedUsage = new Map<string, UsageEvidence>()
	baseSize?: number
	baseInstall?: Observation
	baseTests?: Observation
	baseIntegrity?: PatchEvidence["baselineIntegrity"]
	constructor(readonly options: InspectionOptionsV2) {
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
		for (const role of ["repair", "featureAdoption"] as const) {
			if (!options.models[role]?.credential) {
				throw new InspectionError("invalid-model-route", "Missing guest model route")
			}
			credentialTarget(options.models[role])
			agentLimits(role, options.limits)
		}
		validateModels(options.models)
		const reserve = options.sandboxProvider.estimateMaxCost(this.limits.maxDurationMs)
		if (!Number.isFinite(reserve) || reserve < 0) {
			throw new InspectionError("pricing", "Sandbox price bound unavailable")
		}
		this.ledger = {
			remainingMicros: Math.max(0, Math.floor((this.limits.maxCostUsd - reserve) * 1e6)),
			end: Date.now() + this.limits.maxDurationMs,
			usage: [],
		}
	}
	forward(event: InspectionEvent): () => Promise<void> {
		const next = { ...event, version: 2 as const, sequence: this.timeline.length + 1, ...this.attempt }
		this.timeline.push(next)
		return async () => this.options.onEvent?.(structuredClone(next))
	}
	async emitAgentStarted(context: InspectionContext, sandbox: Sandbox): Promise<void> {
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
		const { model, pricing } = this.options.models[role]
		const prompt = await buildPrompt(role, evidence)
		const text = await context.step("setup", role, (operation) =>
			paidRequest({
				ledger: this.ledger,
				role,
				step: role,
				pricing,
				modelId: model.modelId,
				prompt,
				output: 1024,
				signal: operation.signal,
				send: async (budget) => {
					const reply = await generateText({
						model,
						prompt,
						maxRetries: 0,
						maxOutputTokens: 1024,
						abortSignal: budget.signal,
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
	async captureUsage(adapter: NodeAdapter, selected: UpgradeReport["dependency"][]): Promise<void> {
		for (const dependency of new Set(selected)) {
			const usage = await adapter
				.data(["usage", dependency])
				.then((value) => usageEvidence.parse(value))
				.catch(() => ({ usage: [], unresolved: ["Source inventory unavailable"], changelog: "" }))
			this.pinnedUsage.set(dependency, usage)
		}
	}
	async captureInstallation(adapter: NodeAdapter, upgrade: UpgradeReport): Promise<void> {
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
		const offset = this.ledger.usage.length
		const report = toUpgradeReport(upgrade)
		this.upgrades.push(report)
		const usage = this.pinnedUsage.get(upgrade.dependency) ?? { usage: [], unresolved: [], changelog: "" }
		const measured = this.installedEvidence.get(upgradeKey(upgrade))
		const changelog = measured?.changelog ?? ""
		const after = measured?.bytes
		report.usageLimitations = usage.unresolved

		if (this.baseSize !== undefined && after !== undefined) {
			report.installSize = {
				before: this.baseSize,
				after,
				delta: after - this.baseSize,
				method: "Installed regular-file bytes, deduplicated by device and inode",
			}
		}
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
		await locateDiagnostics({
			repository: card.repository,
			locators: report.locators,
			read: (file) => workspace(patchEvidence, { kind: "read", revision: card.repository.commit, file }),
		})
		try {
			await evaluatePatch(this, patchEvidence)
		} finally {
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
		const sources = evidence.notes.map((note) => note.source)
		if (!sources.length) {
			return
		}
		try {
			const summary = summarySchema.parse(await this.requestHostModel("releaseSummary", evidence, context))
			if (summary.sources.length && summary.sources.every((source) => sources.includes(source))) {
				report.releaseSummary = summary
			}
			if (usage.usage.length) {
				const matches = matchSchema.parse(
					await this.requestHostModel(
						"featureMatch",
						{ notes: evidence.notes, summary: report.releaseSummary, usage: usage.usage },
						context,
					),
				)
				for (const match of matches) {
					const verified = verifyMatch({ match, usage, notes: evidence.notes, repository })
					if (verified) {
						report.featureMatches.push(verified)
					}
				}
			}
		} catch (error) {
			rethrowInspectionFailure(error, context)
			report.releaseSummary.text += " (model evidence incomplete)"
		}
	}
	async adopt(): Promise<void> {
		for (const { candidate, match } of selectFeatureMatches(this.candidates, this.matchLimit)) {
			const offset = this.ledger.usage.length
			candidate.evidence.context.upgradeId = `${candidate.report.dependency}@${candidate.report.to}`
			await evaluatePatch(this, candidate.evidence, match)
			candidate.report.modelUsage.push(...this.ledger.usage.slice(offset))
		}
	}
	card(card: ReportCard): ReportCardV2 {
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
		}
	}
}
function validateModels(models: InspectionOptionsV2["models"]): void {
	for (const role of ["releaseSummary", "featureMatch", "repair", "featureAdoption"] as const) {
		const model = models[role]
		if (
			!model?.pricing ||
			!Number.isSafeInteger(model.pricing.maxInputTokens) ||
			model.pricing.maxInputTokens < 1 ||
			![model.pricing.inputUsdPerMillion, model.pricing.outputUsdPerMillion, model.pricing.fixedUsd ?? 0].every(
				(rate) => Number.isFinite(rate) && rate >= 0,
			)
		) {
			throw new InspectionError("pricing", "Four model roles require explicit price bounds")
		}
		if (
			(role === "releaseSummary" || role === "featureMatch") &&
			(!("model" in model) ||
				!model.model ||
				typeof model.model !== "object" ||
				typeof model.model.doGenerate !== "function")
		) {
			throw new InspectionError("invalid-model", "Expected a configured host model")
		}
	}
}
export function hasModels(
	options: InspectionOptions | InspectionOptionsV2 | PreviousInspectionOptions,
): options is InspectionOptionsV2 | PreviousInspectionOptions {
	const models = options.models
	if (models === undefined) {
		return false
	}
	if (models === null || typeof models !== "object" || Array.isArray(models)) {
		throw new InspectionError("invalid-model", "Expected a dictionary of model roles")
	}
	return Object.values(models).some((value) => typeof value !== "string")
}
export function toModelOptions(options: InspectionOptionsV2 | PreviousInspectionOptions): InspectionOptionsV2 {
	const { models, limits } = options
	const agent: NonNullable<PreviousInspectionOptions["limits"]>["agent"] = limits?.agent
	return {
		...options,
		models: {
			releaseSummary: models.releaseSummary,
			featureMatch: models.featureMatch,
			repair: "repair" in models ? models.repair : models.fix,
			featureAdoption: "featureAdoption" in models ? models.featureAdoption : models.adoption,
		},
		limits: {
			...limits,
			agent: {
				repair: toTurnLimits(agent?.repair, agent?.fix),
				featureAdoption: toTurnLimits(agent?.featureAdoption, agent?.adoption),
			},
		},
	}
}

type CurrentLimits = NonNullable<NonNullable<InspectionOptionsV2["limits"]>["agent"]>["repair"]
type PreviousLimits = NonNullable<NonNullable<PreviousInspectionOptions["limits"]>["agent"]>["fix"]
function toTurnLimits(current: PreviousLimits, previous: PreviousLimits): CurrentLimits {
	if (!current && !previous) {
		return undefined
	}
	return {
		maxTurns: lowestLimit(current?.maxTurns, current?.maxIterations, previous?.maxTurns, previous?.maxIterations),
		maxDurationMs: lowestLimit(current?.maxDurationMs, previous?.maxDurationMs),
		maxCostUsd: lowestLimit(current?.maxCostUsd, previous?.maxCostUsd),
	}
}
function lowestLimit(...values: (number | undefined)[]): number | undefined {
	const specified = values.filter((value) => value !== undefined)
	return specified.length ? Math.min(...specified) : undefined
}
function upgradeKey(upgrade: Pick<UpgradeReport, "dependency" | "to">): string {
	return `${upgrade.dependency}@${upgrade.to}`
}
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
