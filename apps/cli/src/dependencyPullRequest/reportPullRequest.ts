import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { isPackageName, type PullRequestTarget, readPullRequestTarget } from "health-code"
import { z } from "zod"
import { toPatchBranch } from "../openPullRequest.ts"
import { parseJson } from "../parseJson.ts"
import { readGithubToken } from "../readEnvironmentSettings.ts"
import { createGithubClient, type GithubClient, readProperty } from "./githubClient.ts"
import { addWeekSpend, type MarkStatus, readMark, writeMark } from "./inspectionMarks.ts"
import { type InspectState, inspectStateSchema, stateFilename } from "./inspectPullRequest.ts"
import {
	type InspectDecision,
	type PullRequestSettings,
	type ReportDecision,
	readDecision,
	readPullRequestSettings,
} from "./pullRequestSettings.ts"
import { removeLabel, replaceComment, setStatus, toOutputFolder, toRunUrl } from "./pullRequestWrites.ts"
import {
	type InspectedUpgrade,
	type NotInspected,
	toInspectedComment,
	toNotInspectedComment,
	toUsd,
	type Verdict,
	verdicts,
} from "./toPullRequestComment.ts"

type ReportOptions = { environment: NodeJS.ProcessEnv; request?: typeof fetch; signal?: AbortSignal; now?: number }

// what every write of one report needs
type ReportContext = {
	client: GithubClient
	settings: PullRequestSettings
	environment: NodeJS.ProcessEnv
	now: number

	// read the upgrade the pull request holds at its current head
	readTarget: () => Promise<PullRequestTarget>
}

// the fields of a saved Inspection Report that the comment, the status and the week's spend read
const checkSchema = z.object({ status: z.enum(["passed", "failed", "untested"]) })
const reportSchema = z.object({
	limits: z.object({ maxCostUsd: z.number() }).optional(),
	runtimeUsage: z
		.object({ modelCostUsd: z.number(), runtimes: z.array(z.object({ upperBoundUsd: z.number() })) })
		.optional(),
	upgrades: z.array(
		z.object({
			dependency: z.string(),
			to: z.string(),
			verdict: z.enum(verdicts),
			install: checkSchema,
			typecheck: checkSchema,
			tests: checkSchema,
			patches: z.array(z.unknown()),
			newDependencies: z.array(z.object({ name: z.string() })).default([]),
		}),
	),
})
type SavedReport = z.infer<typeof reportSchema>
type SavedUpgrade = SavedReport["upgrades"][number]

// the cost an inspection counts when its report holds no measured cost: the library's default inspection limit
const unmeasuredCostUsd = 15

const commitStateByVerdict: Record<Verdict, MarkStatus["state"]> = {
	"Passes as is": "success",
	Fixed: "success",
	"Fixed with test changes": "success",
	"Can't fix": "failure",
	Untested: "error",
}

/**
 * Ends the select step's decision on the pull request: the status, the comment, the mark and the week's spend.
 */
export async function reportPullRequest({
	environment,
	request,
	signal,
	now = Date.now(),
}: ReportOptions): Promise<void> {
	const decision = readDecision(environment)
	if (decision.outcome === "none") {
		return
	}

	// reach the repository with the workflow's token
	const token = readGithubToken(environment)
	const client = createGithubClient({ repository: environment.GITHUB_REPOSITORY ?? "", token, request, signal })
	const settings = readPullRequestSettings(environment)
	const context = { client, settings, environment, now, readTarget: () => readTarget(decision.pullRequest) }
	const readTarget = (pullRequest: number): Promise<PullRequestTarget> =>
		readPullRequestTarget({
			repositoryUrl: `https://github.com/${client.repository}`,
			pullRequest,
			githubToken: token,
			request,
			signal,
		})
	try {
		await (decision.outcome === "report"
			? reportWithoutInspection(context, decision)
			: reportInspection(context, decision))
	} finally {
		// let the label ask again, whether or not the report went through
		if (decision.startPath === "asked") {
			await removeLabel(client, { pullRequest: decision.pullRequest, label: settings.label })
		}
	}
}

// answer a pull request that starts no inspection: copy an earlier result, or say why
async function reportWithoutInspection(context: ReportContext, decision: ReportDecision): Promise<void> {
	const { client, settings } = context
	const { note, pullRequest, headCommit, upgrade } = decision
	if (note === "cap") {
		await reportCap(context, { pullRequest, headCommit })
		return
	}

	// give a person who asked the reason there is no single upgrade
	if (note !== "status-copy") {
		const comment = toNotInspectedComment({ kind: "no-target", reason: note }, settings.label)
		await replaceComment(client, { pullRequest, body: comment })
		return
	}

	// copy the result of the marked inspection to the new head
	const mark = upgrade && (await readMark(client, { dependency: upgrade.dependency, to: upgrade.to }))
	if (mark?.status && mark.pullRequest === pullRequest && headCommit) {
		await setStatus(client, { commit: headCommit, status: mark.status, targetUrl: toRunUrl(context.environment) })
	}
}

async function reportCap(
	{ client, settings, environment }: ReportContext,
	{ pullRequest, headCommit }: { pullRequest: number; headCommit?: string },
): Promise<void> {
	// end the wait of a job that reads the status
	const description = `Not inspected: this week's cap of ${toUsd(settings.weeklyCapUsd)} is reached`
	if (headCommit) {
		const status = { state: "error" as const, description }
		await setStatus(client, { commit: headCommit, status, targetUrl: toRunUrl(environment) })
	}

	// comment once unless the caller asked for the status only
	if (settings.atCap === "comment") {
		const comment = toNotInspectedComment({ kind: "cap", weeklyCapUsd: settings.weeklyCapUsd }, settings.label)
		await replaceComment(client, { pullRequest, body: comment })
	}
}

// end an inspection the inspect step started, whether it finished or not
async function reportInspection(context: ReportContext, decision: InspectDecision): Promise<void> {
	const { client, environment } = context
	const { pullRequest, headCommit, baseCommit, upgrade } = decision
	const output = toOutputFolder(environment)
	const state = await readState(output)
	if (state.phase === "lost") {
		return
	}

	// answer a cap that was reached between the two steps
	if (state.phase === "capped") {
		await reportCap(context, { pullRequest, headCommit })
		return
	}

	// say that an inspection which never started could not start
	const targetUrl = toRunUrl(environment)
	if (state.phase === "blocked") {
		const status = { state: "error" as const, description: "The inspection could not start. See the workflow run" }
		await setStatus(client, { commit: headCommit, status, targetUrl })
		return
	}

	// read the result and name the status it gives
	const report = await readReport(output)
	const savedUpgrade = report?.upgrades.find((item) => item.dependency === upgrade.dependency && item.to === upgrade.to)
	const status = toStatus(savedUpgrade, state)
	const startedAt = state.startedAt ?? new Date(context.now).toISOString()
	const mark = { dependency: upgrade.dependency, to: upgrade.to, pullRequest, startedAt, status }

	// attempt every write, so one that fails leaves no pending status, uncounted cost or unfinished mark
	const writeComment = async (): Promise<void> => {
		const comment = await toComment({ context, decision, state, report, savedUpgrade })
		await replaceComment(client, { pullRequest, body: comment })
	}
	const writes = await Promise.allSettled([
		setStatus(client, { commit: headCommit, status, targetUrl }),
		setStatusOnNewHead(context, { decision, status }),
		addSpend({ context, baseCommit, state, report, hasResult: Boolean(savedUpgrade) }),
		writeMark(client, { mark, baseCommit }),
		writeComment(),
	])
	const failedWrite = writes.find((write) => write.status === "rejected")
	if (failedWrite) {
		throw failedWrite.reason
	}
}

// give a head the pull request moved to during the inspection the same status, when it holds the same upgrade
async function setStatusOnNewHead(
	{ client, environment, readTarget }: ReportContext,
	{ decision, status }: { decision: InspectDecision; status: MarkStatus },
): Promise<void> {
	const target = await readTarget()
	if (!("upgrade" in target) || target.headCommit === decision.headCommit) {
		return
	}

	// a new head with another version or another base has not been inspected
	const { dependency, to } = decision.upgrade
	const isSameUpgrade = target.upgrade.dependency === dependency && target.upgrade.to === to
	if (isSameUpgrade && target.baseCommit === decision.baseCommit) {
		await setStatus(client, { commit: target.headCommit, status, targetUrl: toRunUrl(environment) })
	}
}

// treat a missing or unreadable state file as an inspection that never started
async function readState(output: string): Promise<InspectState> {
	const text = await readFile(join(output, stateFilename), "utf8").catch(() => "")
	const state = inspectStateSchema.safeParse(parseJson(text))
	return state.success ? state.data : { phase: "blocked" }
}

async function readReport(output: string): Promise<SavedReport | undefined> {
	const text = await readFile(join(output, "inspection-report.json"), "utf8").catch(() => "")
	return reportSchema.safeParse(parseJson(text)).data
}

function toStatus(savedUpgrade: SavedUpgrade | undefined, state: InspectState): MarkStatus {
	if (savedUpgrade) {
		const { verdict } = savedUpgrade
		return { state: commitStateByVerdict[verdict], description: `Verdict: ${verdict}` }
	}

	// tell a rejected version from an inspection that ended early
	const description = state.rejection
		? "The version was rejected before any sandbox started"
		: "The inspection did not finish"
	return { state: "error", description }
}

async function toComment({
	context,
	decision,
	state,
	report,
	savedUpgrade,
}: {
	context: ReportContext
	decision: InspectDecision
	state: InspectState
	report?: SavedReport
	savedUpgrade?: SavedUpgrade
}): Promise<string> {
	// say that an inspection without a result was rejected or did not finish
	const { settings, environment, client } = context
	const { upgrade, baseCommit, movedWith } = decision
	if (!savedUpgrade) {
		const notInspected: NotInspected = state.rejection
			? { kind: "rejected", rejection: state.rejection }
			: { kind: "did-not-finish", dependency: upgrade.dependency, to: upgrade.to, runUrl: toRunUrl(environment) }
		return toNotInspectedComment(notInspected, settings.label)
	}

	// compare the packages the patch moves with the packages the bot's pull request moves
	const patchDependencies = savedUpgrade.newDependencies.map((item) => item.name).filter(isPackageName)
	const pullRequestDependencies = movedWith.map((item) => item.dependency)
	const patchPullRequestUrl = savedUpgrade.patches.length
		? await readPatchPullRequestUrl(client, upgrade).catch(() => undefined)
		: undefined

	// show only values the report or the target sets
	const inspectedUpgrade: InspectedUpgrade = {
		dependency: upgrade.dependency,
		to: upgrade.to,
		baseCommit,
		verdict: savedUpgrade.verdict,
		checks: {
			install: savedUpgrade.install.status,
			typecheck: savedUpgrade.typecheck.status,
			tests: savedUpgrade.tests.status,
		},
		hasPatch: savedUpgrade.patches.length > 0,
		patchPullRequestUrl,
		patchOnlyDependencies: patchDependencies.filter((name) => !pullRequestDependencies.includes(name)),
		pullRequestOnlyDependencies: pullRequestDependencies.filter((name) => !patchDependencies.includes(name)),
		...toCosts(report),
		reportUrl: toReportUrl(environment),
	}
	return toInspectedComment(inspectedUpgrade)
}

// find the open pull request of the upgrade's patch branch and build its address from its number
async function readPatchPullRequestUrl(
	client: GithubClient,
	upgrade: { dependency: string; to: string },
): Promise<string | undefined> {
	const [owner] = client.repository.split("/")
	const head = encodeURIComponent(`${owner}:${toPatchBranch(upgrade)}`)
	const answer = await client.get(`/pulls?state=open&head=${head}`)
	const number = readProperty(answer.body, 0, "number")
	return typeof number === "number" ? `https://github.com/${client.repository}/pull/${number}` : undefined
}

function toCosts(report: SavedReport | undefined): { modelCostUsd?: number; sandboxCostUsd?: number } {
	const usage = report?.runtimeUsage
	if (!usage) {
		return {}
	}
	const sandboxCostUsd = usage.runtimes.reduce((sum, runtime) => sum + runtime.upperBoundUsd, 0)
	return { modelCostUsd: usage.modelCostUsd, sandboxCostUsd }
}

// link the saved report's artifact, or the workflow run that holds it
function toReportUrl(environment: NodeJS.ProcessEnv): string | undefined {
	const artifactUrl = environment.HEALTH_CODE_ARTIFACT_URL?.trim() ?? ""
	const isArtifact = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+\/artifacts\/\d+$/.test(artifactUrl)
	return isArtifact ? artifactUrl : toRunUrl(environment)
}

// add the inspection's cost to the week. a rejected version started no sandbox and costs nothing
async function addSpend({
	context,
	baseCommit,
	state,
	report,
	hasResult,
}: {
	context: ReportContext
	baseCommit: string
	state: InspectState
	report?: SavedReport
	hasResult: boolean
}): Promise<void> {
	// skip a version that was rejected before any sandbox started
	if (!hasResult && state.rejection) {
		return
	}

	// count the measured cost, or the inspection's cost limit when none was measured
	const { modelCostUsd, sandboxCostUsd } = toCosts(report)
	const measuredUsd =
		modelCostUsd === undefined || sandboxCostUsd === undefined ? undefined : modelCostUsd + sandboxCostUsd
	const usd = measuredUsd ?? report?.limits?.maxCostUsd ?? unmeasuredCostUsd
	await addWeekSpend(context.client, { usd, baseCommit, now: context.now })
}
