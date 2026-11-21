import type {
	CheckResult,
	InspectionEvent,
	ModelRequestSandboxEvent,
	Patch,
	ReportCard,
	UpgradeReport,
	Verdict,
} from "health-code"

export const replayRepositoryUrl = "https://github.com/example/project"
type StoredSandboxEvent = Omit<Extract<ModelRequestSandboxEvent, { type: "sandbox.event" }>, "action"> & {
	action: "model-relay-started"
}
export type SiteEvent = InspectionEvent | ModelRequestSandboxEvent | StoredSandboxEvent
export type Citation = { label: string; url?: string }
// carry the tested revisions with the published patch link
export type PatchLink = Pick<Patch, "role" | "digest" | "base" | "prompt" | "prerequisite"> & {
	testedTip?: string
	checks?: UpgradeCard["checks"]
}
// summarize check outcomes and verdict evidence for one upgrade
export type UpgradeCard = Pick<UpgradeReport, "dependency" | "from" | "to" | "observation"> & {
	testFileErrors?: { file: string; reason: string }[]
	checks: Record<"install" | "typecheck" | "tests", string>
	verdict?: Verdict
	reason?: string
	testChanges?: string[]
	summary?: string
	// cite the release and repository locations supporting each match
	matches: (Citation & {
		replacement?: "direct" | "inferred"
		quotation?: string
		source?: string
		location?: Citation
		callSites?: Citation[]
		adoptionOutcome?: string
	})[]
	// associate new dependencies with the commits that introduced them
	addedDependencies?: { name: string; version: string; reason: string; commit: string; patch?: string }[]
	usage?: { modelCost?: number; reserved?: number; outputTokens?: number; partialTokens?: boolean }
	diagnostics: Citation[]
	sizeBytes?: number
	patches: PatchLink[]
}
// combine baseline and upgrade evidence for the public report
export type PublishedCard = {
	usageAsOf?: string

	version: 1
	repository: ReportCard["repository"]
	baseline: UpgradeCard["checks"]
	baselineTestFileErrors?: UpgradeCard["testFileErrors"]
	turnLimits?: { repair: number; featureAdoption: number }
	detection?: string
	// retain the publication license alongside the measured upgrade results
	license: string | null
	upgrades: UpgradeCard[]
	featureCount: number
}
type InspectionState = "queued" | "running" | "interrupted" | "failed" | "complete"
// combine persisted state with the events and report visible to visitors
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
	// include failing test names when the check identifies them
	if (check.status === "failed" && check.failingTests.length) {
		return `failed · ${check.failingTests.map((test) => test.name ?? test.file).join(", ")}`
	}
	return check.status
}

export function toSummary(card: PublishedCard): string {
	const count = card.upgrades.length
	// count blocked installation connections across upgrades
	const blocked = card.upgrades
		.flatMap((upgrade) => upgrade.observation.findings)
		.filter((finding) => finding.kind === "connection" && finding.outcome === "blocked").length
	return `${count} upgrade${count === 1 ? "" : "s"} inspected, ${card.featureCount} feature patch${card.featureCount === 1 ? "" : "es"}, ${blocked} connection${blocked === 1 ? "" : "s"} blocked during install`
}
