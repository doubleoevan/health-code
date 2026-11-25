import type {
	CheckResult,
	InspectionEvent,
	InspectionOptionsV2,
	InspectionReport,
	ModelRequestSandboxEvent,
	Patch,
	UpgradeMenuTarget,
	UpgradeReport,
	Verdict,
} from "health-code"

// link the project pages and the recorded example
export const readmeUrl = "https://github.com/doubleoevan/health-code#readme"
export const ciSetupUrl = "https://github.com/doubleoevan/health-code#ci-setup"
export const runtaSignupUrl = "https://dashboard.runta.com/"
export const replayRepositoryUrl = "https://github.com/example/project"

// include events saved under the previous action name
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
	addedDependencies?: {
		name: string
		version: string
		reason: string
		commit: string
		patch?: string

		// list the earlier versions of a dependency upgraded with the target
		from?: Record<string, string>
	}[]
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

	version: 1
	repository: InspectionReport["repository"]
	baseline: UpgradeCard["checks"]
	baselineTestFileErrors?: UpgradeCard["testFileErrors"]
	detection?: string
	registryLookupIssue?: string

	// retain the publication license alongside the measured upgrade results
	license: string | null
	upgrades: UpgradeCard[]
}

type InspectionState = "queued" | "running" | "interrupted" | "stopped" | "failed" | "complete"

// combine persisted state with the events and report visible to visitors
export type Snapshot = {
	id: string
	repositoryUrl: string

	// Restore the requested work and its downstream handoff on reload.
	investigationPrompt?: string
	mode?: InspectionOptionsV2["mode"]
	selectedDependencyUpgrade?: InspectionOptionsV2["upgrade"]
	position?: number | null
	state: InspectionState
	message: string | null

	// whether this visitor can stop the inspection
	canStop?: boolean

	// the repository's newest upgrade menu
	upgradeMenuId?: string

	// Resume the stream after the last event in this snapshot.
	events: SiteEvent[]
	card: PublishedReport | null
}

export function toVersionChange({ from, to }: NonNullable<Snapshot["selectedDependencyUpgrade"]>): string {
	const versions = typeof from === "string" ? from : [...new Set(Object.values(from))].join(", ")
	return `${versions} → ${to}`
}

export function toCheckText(check: CheckResult): string {
	if (check.status === "untested") {
		return check.detail ?? check.reason
	}

	let text: string = check.status
	if (check.installScriptsSkipped) {
		text += " · Install scripts were skipped because the locked network blocked a download."
	}
	if (check.inventory) {
		const { passed, failed, skipped, todo } = check.inventory.counts
		text += ` · ${passed} passed, ${failed} failed, ${skipped} skipped, ${todo} todo`
	}

	// Include failing test names alongside measured totals.
	if (check.status === "failed" && check.failingTests.length) {
		text += ` · ${check.failingTests.map((test) => test.name ?? test.file).join("\n")}`
	}
	return text
}

export function toSummary(report: PublishedReport): string {
	if (report.upgradeMenu) {
		return "Try an upgrade"
	}
	const count = report.upgrades.length
	if (!count && report.registryLookupIssue) {
		return report.registryLookupIssue
	}

	// count blocked installation connections across upgrades
	const blocked = report.upgrades
		.flatMap((upgrade) => upgrade.observation.findings)
		.filter((finding) => finding.kind === "connection" && finding.outcome === "blocked").length
	const blockedText = blocked ? ` ${blocked} connection${blocked === 1 ? "" : "s"} blocked during install.` : ""
	return toOutcome(report) + blockedText
}

export function toReportHeading({ upgrades }: PublishedReport): string {
	if (upgrades.length && upgrades.every((upgrade) => upgrade.coverage === "skipped")) {
		return upgrades.length === 1 ? "Upgrade not tested" : "Upgrades not tested"
	}
	return "Inspection complete"
}

function toOutcome(report: PublishedReport): string {
	const { upgrades } = report
	const patchCount = upgrades.flatMap((upgrade) => upgrade.patches).length
	if (!patchCount) {
		return upgrades.length ? toMissingPatchReason(report) : "No patch. No upgrades were tested."
	}

	// Count the upgrades that still lack a patch.
	const missingCount = upgrades.filter((upgrade) => !upgrade.patches.length).length
	const patchedUpgrade = upgrades.find((upgrade) => upgrade.patches.length)
	const ready =
		patchCount === 1
			? `Your tested ${patchedUpgrade?.dependency} patch is ready.`
			: `Your ${patchCount} tested patches are ready.`
	return missingCount ? `${ready} No patch for ${missingCount} of ${upgrades.length} upgrades.` : ready
}

function toMissingPatchReason({ upgrades, license, baseline, stoppedReason }: PublishedReport): string {
	const isSingle = upgrades.length === 1
	const target = isSingle ? "this upgrade" : "these upgrades"
	const verdicts = upgrades.map((upgrade) => upgrade.verdict)

	// Distinguish a withheld patch from an upgrade without one.
	const successes: (Verdict | undefined)[] = ["Passes as is", "Fixed", "Fixed with test changes"]
	if (!license && verdicts.some((verdict) => successes.includes(verdict))) {
		return "A tested patch works but can’t be shown here because GitHub found no confirmed open-source license. Run the library in CI to get the patch."
	}

	// Explain the check that kept the upgrades from a tested patch.
	if (baseline.install.startsWith("failed")) {
		return `No patch. Your project’s dependencies failed to install so the health inspector couldn’t test ${target}.`
	}
	if (verdicts.every((verdict) => verdict === "Can't fix")) {
		return isSingle
			? "No patch. The upgrade broke your checks and the health inspector couldn’t fix it."
			: "No patch. The upgrades broke your checks and the health inspector couldn’t fix them."
	}

	// Recognize older reports recorded without verdicts or patches.
	if (!stoppedReason && verdicts.every((verdict) => !verdict)) {
		return `${upgrades.length} upgrade${isSingle ? "" : "s"} inspected.`
	}
	return `No patch. The health inspector couldn’t finish testing ${target}.`
}

export function toPatchPath(digest: string): string {
	return `/patches/${digest}.patch`
}
export function toOrderedPatches(patches: PatchLink[]): PatchLink[] {
	return patches.toSorted((a, b) => Number(a.role === "feature") - Number(b.role === "feature"))
}
