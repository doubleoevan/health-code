import type {
	CheckResult,
	InspectionEvent,
	InspectionEventV2,
	Patch,
	ReportCard,
	UpgradeReport,
	Verdict,
} from "health-code"

export const replayRepositoryUrl = "https://github.com/example/project"
export type SiteEvent = InspectionEvent | InspectionEventV2
export type Citation = { label: string; url?: string }
export type PatchLink = Pick<Patch, "role" | "digest" | "base" | "prompt" | "prerequisite"> & {
	testedTip?: string
	checks?: UpgradeCard["checks"]
}
export type UpgradeCard = Pick<UpgradeReport, "dependency" | "from" | "to" | "observation"> & {
	testFileErrors?: { file: string; reason: string }[]
	checks: Record<"install" | "typecheck" | "tests", string>
	verdict?: Verdict
	reason?: string
	testChanges?: string[]
	summary?: string
	matches: (Citation & {
		replacement?: "direct" | "inferred"
		quotation?: string
		source?: string
		location?: Citation
		callSites?: Citation[]
		adoptionOutcome?: string
	})[]
	addedDependencies?: { name: string; version: string; reason: string; commit: string; patch?: string }[]
	usage?: { modelCost?: number; reserved?: number; outputTokens?: number; partialTokens?: boolean }
	diagnostics: Citation[]
	sizeBytes?: number
	patches: PatchLink[]
}
export type PublishedCard = {
	version: 1
	repository: ReportCard["repository"]
	baseline: UpgradeCard["checks"]
	baselineTestFileErrors?: UpgradeCard["testFileErrors"]
	turnLimits?: { repair: number; featureAdoption: number }
	detection?: string
	license: string | null
	upgrades: UpgradeCard[]
	featureCount: number
}
type InspectionState = "queued" | "running" | "interrupted" | "failed" | "complete"
export type Snapshot = {
	id: string
	repositoryUrl: string
	state: InspectionState
	message: string | null
	events: SiteEvent[]
	card: PublishedCard | null
}

export function toCheckText(check: CheckResult): string {
	if (check.status === "untested") {
		return check.detail ?? check.reason
	}
	if (check.status === "failed" && check.failingTests.length) {
		return `failed · ${check.failingTests.map((test) => test.name ?? test.file).join(", ")}`
	}
	return check.status
}

export function toSummary(card: PublishedCard): string {
	const count = card.upgrades.length
	const blocked = card.upgrades
		.flatMap((upgrade) => upgrade.observation.findings)
		.filter((finding) => finding.kind === "connection" && finding.outcome === "blocked").length
	return `${count} upgrade${count === 1 ? "" : "s"} inspected, ${card.featureCount} feature patch${card.featureCount === 1 ? "" : "es"}, ${blocked} connection${blocked === 1 ? "" : "s"} blocked during install`
}
