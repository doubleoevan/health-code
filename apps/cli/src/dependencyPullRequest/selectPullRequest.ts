import { appendFile } from "node:fs/promises"
import {
	isAccountLogin,
	isGitObjectId,
	type PullRequestTarget,
	pullRequestTargetMessages,
	readPullRequestTarget,
} from "health-code"
import { readGithubToken } from "../readEnvironmentSettings.ts"
import { UserError } from "../userError.ts"
import { createGithubClient, type GithubClient, readProperty } from "./githubClient.ts"
import { readMark, readWeekSpend } from "./inspectionMarks.ts"
import {
	type Decision,
	decisionSchema,
	type InspectDecision,
	type PullRequestSettings,
	type ReportDecision,
	readPullRequestSettings,
	readWorkflowEvent,
	type WorkflowEvent,
} from "./pullRequestSettings.ts"

type SelectOptions = { environment: NodeJS.ProcessEnv; request?: typeof fetch; signal?: AbortSignal; now?: number }

// the pull request an event points at and what selected it
type Candidate = { pullRequest: number; trigger: "opened" | "red" | "asked" }

// the fixed sentence the run summary shows for each reason nothing started
const noneReasons = {
	event: "This event starts no inspection.",
	label: "The label is not the one that asks for an inspection.",
	permission: "The person who added the label has no write access.",
	green: "The workflow run did not finish with a failure.",
	"fork-run": "The workflow run belongs to a fork.",
	"no-pull-request": "The failed run has no open pull request from this repository.",
	versions: "The pull request's versions are not plain release versions.",
	marked: "This dependency and version was already inspected. Add the label to inspect it again.",
	"not-major": "The upgrade is not a major upgrade. An inspection starts if the repository's CI fails on it.",
	"major-off": "The Major path is off.",
	"red-off": "The Red path is off.",
	"no-failure": "No listed check failed on the pull request.",
	"base-fails": "Every failed check also fails on the base commit.",
	"no-base-result": "No check on the base commit matched the failed check. Run CI on pushes to the base branch too.",
} as const
type NoneReason = keyof typeof noneReasons

/**
 * Decides whether an event starts an inspection, reports without one or starts nothing.
 */
export async function selectPullRequest({
	environment,
	request,
	signal,
	now = Date.now(),
}: SelectOptions): Promise<Decision> {
	// read the settings, the event and the repository the run belongs to
	const settings = readPullRequestSettings(environment)
	const event = await readWorkflowEvent(environment)
	const token = readGithubToken(environment)
	const client = createGithubClient({ repository: environment.GITHUB_REPOSITORY ?? "", token, request, signal })

	// find the pull request the event points at
	const candidate = await readCandidate({ event, settings, client })
	if (typeof candidate === "string") {
		return toNone(candidate)
	}
	const target = await readPullRequestTarget({
		repositoryUrl: `https://github.com/${client.repository}`,
		pullRequest: candidate.pullRequest,
		githubToken: token,
		request,
		signal,
	})
	const decision = await decide({ candidate, target, settings, client, now })

	// start nothing for a decision the later steps would reject, such as a prerelease version
	return decisionSchema.safeParse(decision).success ? decision : toNone("versions")
}

/**
 * Writes a decision to the job's outputs and its reason to the run summary.
 */
export async function writeDecision(decision: Decision, environment: NodeJS.ProcessEnv): Promise<void> {
	const { GITHUB_OUTPUT: outputPath, GITHUB_STEP_SUMMARY: summaryPath } = environment
	if (!outputPath) {
		throw new UserError("Run this step in GitHub Actions. GITHUB_OUTPUT is not set.")
	}

	// write one line per output. a decision holds no line break
	const decisionLine = JSON.stringify(decision)
	await appendFile(outputPath, `outcome=${decision.outcome}\ndecision=${decisionLine}\n`)
	if (summaryPath) {
		await appendFile(summaryPath, `Health Code: ${toSummary(decision)}\n`)
	}
}

// say what was decided in fixed copy with checked names and versions only
function toSummary(decision: Decision): string {
	if (decision.outcome === "none") {
		return decision.reason
	}
	if (decision.outcome === "report") {
		return `No inspection for pull request ${decision.pullRequest}. ${toNoteSentence(decision.note)}`
	}

	// name the upgrade and the path that started it
	const { dependency, to } = decision.upgrade
	return `Inspecting ${dependency} ${to} for pull request ${decision.pullRequest} on the ${decision.startPath} path.`
}

function toNoteSentence(note: ReportDecision["note"]): string {
	if (note === "cap") {
		return "This week's spending cap is reached."
	}
	return note === "status-copy"
		? "Its upgrade was already inspected, so the new head gets the earlier status."
		: pullRequestTargetMessages[note]
}

function toNone(reason: NoneReason | string): Decision {
	return { outcome: "none", reason: Object.hasOwn(noneReasons, reason) ? noneReasons[reason as NoneReason] : reason }
}

async function readCandidate({
	event,
	settings,
	client,
}: {
	event: WorkflowEvent
	settings: PullRequestSettings
	client: GithubClient
}): Promise<Candidate | NoneReason> {
	if (event.name === "workflow_run") {
		return readFailedRunCandidate(event.payload, client)
	}

	// read the pull request's number from its own event
	const action = readProperty(event.payload, "action")
	const pullRequest = readProperty(event.payload, "pull_request", "number")
	if (event.name !== "pull_request_target" || typeof pullRequest !== "number") {
		return "event"
	}

	// select a pull request whose head is new or moved
	if (action === "opened" || action === "reopened" || action === "synchronize") {
		return { pullRequest, trigger: "opened" }
	}
	if (action !== "labeled") {
		return "event"
	}

	// accept the label only when it is the configured one and a person with write access added it
	if (readProperty(event.payload, "label", "name") !== settings.label) {
		return "label"
	}
	const hasWriteAccess = await canWrite(client, readProperty(event.payload, "sender", "login"))
	return hasWriteAccess ? { pullRequest, trigger: "asked" } : "permission"
}

// find the open pull request of this repository whose head a failed workflow run tested
async function readFailedRunCandidate(payload: unknown, client: GithubClient): Promise<Candidate | NoneReason> {
	const conclusion = readProperty(payload, "workflow_run", "conclusion")
	const headCommit = readProperty(payload, "workflow_run", "head_sha")
	const isFailed = conclusion === "failure" || conclusion === "timed_out"
	if (readProperty(payload, "action") !== "completed" || !isFailed || !isGitObjectId(headCommit)) {
		return "green"
	}

	// leave a run from a fork before any request
	const headRepository = readProperty(payload, "workflow_run", "head_repository", "full_name")
	if (typeof headRepository !== "string" || headRepository.toLowerCase() !== client.repository.toLowerCase()) {
		return "fork-run"
	}

	// match the head commit and the repository of each pull request github lists for the commit
	const answer = await client.get(`/commits/${headCommit}/pulls?per_page=100`)
	const pullRequests = Array.isArray(answer.body) ? answer.body : []
	const pullRequest = pullRequests.find((item) => {
		// keep an open pull request of this repository
		const isOpenHead = readProperty(item, "state") === "open" && readProperty(item, "head", "sha") === headCommit
		const repository = readProperty(item, "head", "repo", "full_name")
		return isOpenHead && typeof repository === "string" && repository.toLowerCase() === client.repository.toLowerCase()
	})
	const number = readProperty(pullRequest, "number")
	return typeof number === "number" ? { pullRequest: number, trigger: "red" } : "no-pull-request"
}

async function decide({
	candidate,
	target,
	settings,
	client,
	now,
}: {
	candidate: Candidate
	target: PullRequestTarget
	settings: PullRequestSettings
	client: GithubClient
	now: number
}): Promise<Decision> {
	// name the start path after what selected the pull request
	const { pullRequest, trigger } = candidate
	const startPath: InspectDecision["startPath"] = trigger === "opened" ? "major" : trigger

	// answer a pull request with no single upgrade only when a person asked
	if ("reason" in target) {
		return trigger === "asked"
			? { outcome: "report", note: target.reason, startPath, pullRequest }
			: toNone(target.message)
	}
	const { headCommit, baseCommit, movedWith } = target
	const { dependency, from, to } = target.upgrade
	const selectedUpgrade = { startPath, pullRequest, headCommit, baseCommit, upgrade: { dependency, from, to } }

	// leave a marked version alone unless a person asked, and copy its result to a new head
	const mark = trigger === "asked" ? undefined : await readMark(client, { dependency, to })
	if (mark) {
		const shouldCopyStatus = trigger === "opened" && mark.status !== undefined && mark.pullRequest === pullRequest
		return shouldCopyStatus ? { outcome: "report", note: "status-copy", ...selectedUpgrade } : toNone("marked")
	}

	// apply the path's own rule
	const pathReason = await toPathReason({ trigger, target, settings, client })
	if (pathReason) {
		return toNone(pathReason)
	}

	// stop at the week's cap
	if ((await readWeekSpend(client, now)) >= settings.weeklyCapUsd) {
		return { outcome: "report", note: "cap", ...selectedUpgrade }
	}
	return { outcome: "inspect", ...selectedUpgrade, movedWith }
}

// name why the start path starts nothing, or nothing when it starts
async function toPathReason({
	trigger,
	target,
	settings,
	client,
}: {
	trigger: Candidate["trigger"]
	target: Extract<PullRequestTarget, { upgrade: unknown }>
	settings: PullRequestSettings
	client: GithubClient
}): Promise<NoneReason | undefined> {
	// start on any upgrade for a person's label
	if (trigger === "asked") {
		return undefined
	}

	// start only a major on a new head, and a failed run when a check counts as red
	if (trigger === "opened") {
		return !target.isMajor ? "not-major" : settings.isMajorPathOn ? undefined : "major-off"
	}
	return settings.isRedPathOn ? readRedReason({ client, target, redChecks: settings.redChecks }) : "red-off"
}

// a failed check counts when the same check succeeded on the base commit
async function readRedReason({
	client,
	target,
	redChecks,
}: {
	client: GithubClient
	target: { headCommit: string; baseCommit: string }
	redChecks: string[]
}): Promise<NoneReason | undefined> {
	// list the failed checks on the head that the caller's list allows
	const headChecks = await readChecks(client, target.headCommit)
	const failedNames = [...headChecks]
		.filter(([name, conclusion]) => isFailure(conclusion) && (!redChecks.length || redChecks.includes(name)))
		.map(([name]) => name)
	if (!failedNames.length) {
		return "no-failure"
	}

	// compare each failed check with the result of the same name on the base commit
	const baseChecks = await readChecks(client, target.baseCommit)
	if (failedNames.some((name) => baseChecks.get(name) === "success")) {
		return undefined
	}
	return failedNames.some((name) => baseChecks.has(name)) ? "base-fails" : "no-base-result"
}

// ponytail: read the first 100 check runs of a commit. page through them if a repository has more
async function readChecks(client: GithubClient, commit: string): Promise<Map<string, string>> {
	const answer = await client.get(`/commits/${commit}/check-runs?per_page=100&filter=latest`)
	const checkRuns = readProperty(answer.body, "check_runs")
	if (answer.status !== 200 || !Array.isArray(checkRuns)) {
		throw new UserError(`GitHub answered ${answer.status} to the checks of a commit. Run the job again.`)
	}

	const checks = new Map<string, string>()
	for (const checkRun of checkRuns) {
		// keep each completed check's conclusion by its name
		const name = readProperty(checkRun, "name")
		const conclusion = readProperty(checkRun, "conclusion")
		if (typeof name === "string" && typeof conclusion === "string") {
			checks.set(name, conclusion)
		}
	}
	return checks
}

function isFailure(conclusion: string): boolean {
	return conclusion === "failure" || conclusion === "timed_out"
}

// ask github for the permission of the account that added the label
async function canWrite(client: GithubClient, login: unknown): Promise<boolean> {
	if (!isAccountLogin(login)) {
		return false
	}

	// accept write and admin. github reports the maintain role as write
	const answer = await client.get(`/collaborators/${encodeURIComponent(login)}/permission`)
	const permission = readProperty(answer.body, "permission")
	return answer.status === 200 && (permission === "admin" || permission === "write")
}
