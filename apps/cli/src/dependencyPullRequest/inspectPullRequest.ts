import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { InspectionError, type ModelRequestSandboxInspectionReport } from "health-code"
import { z } from "zod"
import { checkRepository } from "../checkRepository.ts"
import { openPullRequest } from "../openPullRequest.ts"
import { readGithubToken } from "../readEnvironmentSettings.ts"
import { UserError } from "../userError.ts"
import { createGithubClient } from "./githubClient.ts"
import { claimMark, readMark, readWeekSpend, writeMark } from "./inspectionMarks.ts"
import {
	type InspectDecision,
	type PullRequestSettings,
	readDecision,
	readPullRequestSettings,
} from "./pullRequestSettings.ts"
import { setStatus, toOutputFolder, toRunUrl } from "./pullRequestWrites.ts"

// the file that records how far the inspect step got
export const stateFilename = "dependency-pull-request.json"

// how far an inspection got: stopped before a claim, started, finished or failed
export const inspectStateSchema = z.object({
	phase: z.enum(["blocked", "capped", "lost", "started", "inspected", "failed"]),
	startedAt: z.string().optional(),
	rejection: z.string().max(600).optional(),
})
export type InspectState = z.infer<typeof inspectStateSchema>

type InspectOptions = {
	environment: NodeJS.ProcessEnv
	signal: AbortSignal
	request?: typeof fetch

	// the check to run, how a tested patch becomes a pull request, how progress is printed and the time
	check?: typeof checkRepository
	openPatchPullRequest?: typeof openPullRequest
	log?: (line: string) => void
	now?: number
}

// the minutes the job keeps for the report step after the inspection stops
const reportMinutes = 10

/**
 * Claims the mark, sets the pending status and runs the check for the upgrade the select step chose.
 */
export async function inspectPullRequest({
	environment,
	signal,
	request,
	check = checkRepository,
	openPatchPullRequest = openPullRequest,
	log = console.log,
	now = Date.now(),
}: InspectOptions): Promise<{ isComplete: boolean }> {
	const decision = readDecision(environment)
	if (decision.outcome !== "inspect") {
		return { isComplete: true }
	}

	// prepare the output folder
	const settings = readPullRequestSettings(environment)
	const output = toOutputFolder(environment)
	await mkdir(output, { recursive: true })
	const writeState = (state: InspectState): Promise<void> =>
		writeFile(join(output, stateFilename), `${JSON.stringify(state)}\n`)

	// stop before any claim when the account token is missing
	if (!environment.RUNTA_TOKEN?.trim()) {
		await writeState({ phase: "blocked" })
		throw new UserError(
			"RUNTA_TOKEN is empty. Add it as an Actions secret. When Dependabot opens the pull request, also add RUNTA_TOKEN as a Dependabot secret with the same name.",
		)
	}
	const token = readGithubToken(environment)
	const client = createGithubClient({ repository: environment.GITHUB_REPOSITORY ?? "", token, request, signal })

	// check the week's cap again. another inspection may have ended after the select step
	if ((await readWeekSpend(client, now)) >= settings.weeklyCapUsd) {
		await writeState({ phase: "capped" })
		log("The week's spending cap is reached. No inspection started.")
		return { isComplete: true }
	}

	// claim the dependency and version, or replace the mark when a person asked
	const { upgrade, baseCommit, headCommit, pullRequest, startPath } = decision
	const startedAt = new Date(now).toISOString()
	const runId = environment.GITHUB_RUN_ID
	const mark = { dependency: upgrade.dependency, to: upgrade.to, pullRequest, startedAt, ...(runId && { runId }) }
	if (startPath === "asked") {
		await writeMark(client, { mark, baseCommit })
	}

	// take over an unfinished mark this same workflow run left, so a re-run can end what it started
	const isClaimed = startPath === "asked" || (await claimMark(client, { mark, baseCommit }))
	const heldMark = isClaimed ? undefined : await readMark(client, mark)
	const isOwnRerun = Boolean(runId) && heldMark?.runId === runId && !heldMark?.status

	// leave the inspection to the run that holds the mark
	if (!isClaimed && !isOwnRerun) {
		await writeState({ phase: "lost" })
		log(`Another run already inspects ${upgrade.dependency} ${upgrade.to}. No inspection started.`)
		return { isComplete: true }
	}

	// report the start on the pull request's head before any sandbox exists
	await writeState({ phase: "started", startedAt })
	const pendingStatus = { state: "pending" as const, description: "The health inspector is trying this upgrade" }
	await setStatus(client, { commit: headCommit, status: pendingStatus, targetUrl: toRunUrl(environment) })
	const checkOptions = { check, openPatchPullRequest, environment, signal, request, log }
	return runCheck({ decision, settings, output, startedAt, writeState, ...checkOptions })
}

type RunCheckOptions = Required<
	Pick<InspectOptions, "environment" | "signal" | "check" | "openPatchPullRequest" | "log">
> & {
	decision: InspectDecision
	settings: PullRequestSettings
	output: string
	startedAt: string

	// how the outcome is saved and how GitHub and the registry are reached
	writeState: (state: InspectState) => Promise<void>
	request?: typeof fetch
}

async function runCheck({
	decision,
	settings,
	output,
	startedAt,
	writeState,
	check,
	openPatchPullRequest,
	environment,
	signal,
	request,
	log,
}: RunCheckOptions): Promise<{ isComplete: boolean }> {
	// test the upgrade only on the automatic paths unless the caller asked for feature patches
	const { upgrade, baseCommit, startPath } = decision
	const isUpgradeOnly = startPath !== "asked" && !settings.hasFeaturePatches
	const repositoryUrl = `https://github.com/${environment.GITHUB_REPOSITORY}`
	const target = ["--dependency", upgrade.dependency, "--to", upgrade.to, "--revision", baseCommit]
	const flags = ["--output", output, ...(isUpgradeOnly ? ["--upgrade-only"] : [])]

	// stop the inspection before the job's own limit
	const { timeoutMinutes } = settings
	const limitMinutes = timeoutMinutes > 2 * reportMinutes ? timeoutMinutes - reportMinutes : timeoutMinutes / 2
	const limitMs = Math.min(Math.floor(limitMinutes * 60_000), 2 ** 31 - 1)
	try {
		const timeLimit = AbortSignal.timeout(limitMs)
		const { isComplete } = await check([repositoryUrl, ...target, ...flags], {
			environment,
			signal: AbortSignal.any([signal, timeLimit]),
			request,
			log,
		})
		await writeState({ phase: "inspected", startedAt })
		await openRepairPullRequests({ output, openPatchPullRequest, log })
		return { isComplete }
	} catch (error) {
		// keep the library's sentence for a version it rejected before any sandbox
		const isRejected = error instanceof InspectionError && error.code === "invalid-upgrade"
		const state = await readFile(join(output, stateFilename), "utf8").catch(() => "")
		if (!state.includes('"inspected"')) {
			await writeState({ phase: "failed", startedAt, ...(isRejected && { rejection: error.message.slice(0, 600) }) })
		}
		throw error
	}
}

// open a pull request for each tested patch that changes more than the version. an upgrade that passes as is
// would only repeat the pull request it came from
async function openRepairPullRequests({
	output,
	openPatchPullRequest,
	log,
}: {
	output: string
	openPatchPullRequest: typeof openPullRequest
	log: (line: string) => void
}): Promise<void> {
	// read the report the check just wrote
	const text = await readFile(join(output, "inspection-report.json"), "utf8").catch(() => undefined)
	const report = text ? (JSON.parse(text) as ModelRequestSandboxInspectionReport) : undefined

	// open one pull request for each upgrade whose patch holds a repair
	for (const upgrade of report?.upgrades ?? []) {
		if (upgrade.patches.length && upgrade.verdict !== "Passes as is") {
			const branch = await openPatchPullRequest({ upgrade, output, packageManager: report?.packageManager })
			log(`Pull request ready from ${branch}`)
		}
	}
}
