import { type PullRequestTargetReason, pullRequestTargetMessages } from "health-code"

// the hidden first line that finds the comment again
export const commentMarker = "<!-- health-code:dependency-pull-request -->"

export const verdicts = ["Passes as is", "Fixed", "Fixed with test changes", "Can't fix", "Untested"] as const
export type Verdict = (typeof verdicts)[number]
type CheckResultStatus = "passed" | "failed" | "untested"

// one inspected upgrade as the comment shows it. every value comes from the report or the target
export type InspectedUpgrade = {
	dependency: string
	to: string
	baseCommit: string
	verdict: Verdict
	checks: { install: CheckResultStatus; typecheck: CheckResultStatus; tests: CheckResultStatus }

	// the tested patch, its pull request and the packages each side moves alone
	hasPatch: boolean
	patchPullRequestUrl?: string
	patchOnlyDependencies: string[]
	pullRequestOnlyDependencies: string[]

	// the measured costs and where the saved report is
	modelCostUsd?: number
	sandboxCostUsd?: number
	reportUrl?: string
}

// why a pull request got no inspection result
export type NotInspected =
	| { kind: "cap"; weeklyCapUsd: number }
	| { kind: "did-not-finish"; dependency: string; to: string; runUrl?: string }
	| { kind: "rejected"; rejection: string }
	| { kind: "no-target"; reason: PullRequestTargetReason }

const homeLink = "[Health Code](https://runhealthcode.dev)"
const settingAdvice =
	"Turn on **Allow GitHub Actions to create and approve pull requests** under Settings, Actions, General."

/**
 * Writes the comment for an inspected upgrade from fixed copy and checked values.
 */
export function toInspectedComment(upgrade: InspectedUpgrade): string {
	const { dependency, to, baseCommit, verdict, checks } = upgrade
	const commit = baseCommit.slice(0, 7)
	const lines = [
		commentMarker,
		`${homeLink} tried \`${dependency}\` ${to} at \`${commit}\` in a [Runta](https://runta.com) sandbox.`,
		"",
		`- Verdict: ${verdict}`,
		`- Install: ${checks.install}`,
		`- Typecheck: ${checks.typecheck}`,
		`- Tests: ${checks.tests}`,
		`- ${toPatchLine(upgrade)}`,
		...toCostLine(upgrade),
		...(upgrade.reportUrl ? [`- [Inspection Report](${upgrade.reportUrl})`] : []),
		...toDifferenceLines(upgrade),
	]
	return lines.join("\n")
}

/**
 * Writes the comment for a pull request that got no inspection result.
 */
export function toNotInspectedComment(notInspected: NotInspected, label: string): string {
	const retryAdvice = `Add the \`${label.replaceAll("`", "")}\` label to try again.`
	return [commentMarker, toNotInspectedSentence(notInspected, retryAdvice)].join("\n")
}

function toNotInspectedSentence(notInspected: NotInspected, retryAdvice: string): string {
	if (notInspected.kind === "cap") {
		const cap = toUsd(notInspected.weeklyCapUsd)
		return `${homeLink} did not try this upgrade. This week's spending cap of ${cap} is reached. An inspection can start again next week.`
	}

	// show the library's sentence as plain text, so a scoped package name mentions nobody
	if (notInspected.kind === "rejected") {
		const rejection = notInspected.rejection.replaceAll("`", "")
		return `${homeLink} started no sandbox for this upgrade.\n\n\`\`\`text\n${rejection}\n\`\`\``
	}

	// say that the inspection ended early and where its log is
	if (notInspected.kind === "did-not-finish") {
		const { dependency, to, runUrl } = notInspected
		const runLink = runUrl ? ` See the [workflow run](${runUrl}).` : ""
		return `${homeLink} did not finish its inspection of \`${dependency}\` ${to}.${runLink} ${retryAdvice}`
	}
	return `${homeLink} tries one upgrade at a time. ${pullRequestTargetMessages[notInspected.reason]}`
}

// link the tested patch's pull request, or say why there is none
function toPatchLine({ hasPatch, patchPullRequestUrl, verdict, checks }: InspectedUpgrade): string {
	if (patchPullRequestUrl) {
		return `Tested patch: ${patchPullRequestUrl}`
	}

	// an upgrade that passes as is gets no second pull request
	if (verdict === "Passes as is") {
		return "Tested patch: none needed. The upgrade passed as is."
	}
	if (hasPatch) {
		return `Tested patch: saved in the Inspection Report. Its pull request could not be opened. ${settingAdvice}`
	}

	// name the first check that did not pass for an upgrade that was not tested
	const untestedCheck = (["install", "typecheck", "tests"] as const).find((check) => checks[check] !== "passed")
	if (verdict === "Untested" && untestedCheck) {
		return `No tested patch: the ${untestedCheck} check did not pass.`
	}
	return verdict === "Can't fix"
		? "No tested patch: the repair did not pass the checks."
		: "No tested patch is available."
}

function toCostLine({ modelCostUsd, sandboxCostUsd }: InspectedUpgrade): string[] {
	if (modelCostUsd === undefined || sandboxCostUsd === undefined) {
		return []
	}
	return [`- Cost: ${toUsd(modelCostUsd)} model and ${toUsd(sandboxCostUsd)} sandbox`]
}

// name each package that only one of the two pull requests moves
function toDifferenceLines({ patchOnlyDependencies, pullRequestOnlyDependencies }: InspectedUpgrade): string[] {
	const format = new Intl.ListFormat("en-GB")
	const toNames = (dependencies: string[]): string => format.format(dependencies.map((name) => `\`${name}\``))
	const patchLine = `The patch also moves ${toNames(patchOnlyDependencies)}, which this pull request does not.`
	const pullRequestLine = `This pull request also moves ${toNames(pullRequestOnlyDependencies)}, which the patch does not.`

	// keep only the sentences that have a package to name, after one empty line
	const sentences = [
		...(patchOnlyDependencies.length ? [patchLine] : []),
		...(pullRequestOnlyDependencies.length ? [pullRequestLine] : []),
	]
	return sentences.length ? ["", ...sentences] : []
}

/**
 * Formats a cost in dollars and cents.
 */
export function toUsd(amount: number): string {
	return `$${amount.toFixed(2)}`
}
