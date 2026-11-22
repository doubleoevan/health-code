import type {
	CheckResult,
	InspectionEvent,
	InspectionReport,
	ModelRequestSandboxEvent,
	Patch,
	UpgradeMenuTarget,
	UpgradeReport,
	Verdict,
} from "health-code"

export const mcpSetupUrl = "https://github.com/doubleoevan/health-code#mcp-setup"
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
export type UpgradeCard = Pick<UpgradeReport, "coverage" | "dependency" | "from" | "to" | "observation"> & {
	reusedFromInspectionId?: string
	testFileErrors?: { file: string; reason: string }[]
	checks: Record<"install" | "typecheck" | "tests", string>
	verdict?: Verdict
	reason?: string

	// Explain the evidence behind an inconclusive upgrade.
	untestedReason?: string
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
export type PublishedReport = {
	upgradeMenu?: UpgradeMenuTarget[]
	stoppedReason?: string
	omitted?: string[]
	promptVersions?: InspectionReport["promptVersions"]
	usageAsOf?: string

	version: 1
	repository: InspectionReport["repository"]
	baseline: UpgradeCard["checks"]
	baselineTestFileErrors?: UpgradeCard["testFileErrors"]
	turnLimits?: { repair: number; featureAdoption: number }
	detection?: string
	registryLookupIssue?: string

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
	position?: number | null
	state: InspectionState
	message: string | null

	// Resume the stream after the last event in this snapshot.
	events: SiteEvent[]
	card: PublishedReport | null
}

export function readPublishedReport(json: string): PublishedReport {
	const report: PublishedReport & { menu?: PublishedReport["upgradeMenu"] } = JSON.parse(json)
	if (report.menu) {
		report.upgradeMenu ??= report.menu
		delete report.menu
	}

	// Preserve source links in reports published with the original field name.
	for (const upgrade of report.upgrades) {
		if ("reusedFrom" in upgrade && typeof upgrade.reusedFrom === "string") {
			upgrade.reusedFromInspectionId ??= upgrade.reusedFrom
			delete upgrade.reusedFrom
		}
	}
	return report
}

export function toCheckText(check: CheckResult): string {
	if (check.status === "untested") {
		return check.detail ?? check.reason
	}

	let text: string = check.status
	if (check.inventory) {
		const { passed, failed, skipped, todo } = check.inventory.counts
		text += ` · ${passed} passed, ${failed} failed, ${skipped} skipped, ${todo} todo`
	}

	// Include failing test names alongside measured totals.
	if (check.status === "failed" && check.failingTests.length) {
		text += ` · ${check.failingTests.map((test) => test.name ?? test.file).join(", ")}`
	}
	return text
}

export function toSummary(report: PublishedReport): string {
	if (report.upgradeMenu) {
		return "Choose a dependency upgrade"
	}
	const count = report.upgrades.length
	if (!count && report.registryLookupIssue) {
		return report.registryLookupIssue
	}

	// Count the work actually reached before an interruption.
	const partial = report.upgrades.filter((upgrade) => upgrade.coverage === "partial").length
	const skipped = report.upgrades.filter((upgrade) => upgrade.coverage === "skipped").length
	if (report.stoppedReason || partial || skipped) {
		return `Partial inspection · ${count - partial - skipped} upgrades completed, ${partial} partial, ${skipped} skipped`
	}

	// count blocked installation connections across upgrades
	const blocked = report.upgrades
		.flatMap((upgrade) => upgrade.observation.findings)
		.filter((finding) => finding.kind === "connection" && finding.outcome === "blocked").length
	return `${count} upgrade${count === 1 ? "" : "s"} inspected, ${report.featureCount} feature patch${report.featureCount === 1 ? "" : "es"}, ${blocked} connection${blocked === 1 ? "" : "s"} blocked during install`
}
