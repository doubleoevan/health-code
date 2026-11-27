import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { createFakeSandboxProvider, InspectionError } from "health-code"
import { checkRepository } from "../checkRepository.ts"
import {
	baseCommit,
	createFakeRepositoryApi,
	type FakeRepositoryApi,
	fakeRepository,
	toHeadCommit,
} from "../fixtures/fakeRepositoryApi.ts"
import { inspectionFixtureUrl, modelSettings } from "../fixtures/inspectionSettings.ts"
import { modelRequestSandboxFixture } from "../fixtures/modelRequestSandboxInspection.ts"
import { createPublicProject } from "../fixtures/publicProject.ts"
import { UserError } from "../userError.ts"
import { createGithubClient } from "./githubClient.ts"
import { addWeekSpend, claimMark, readMark, readWeekSpend } from "./inspectionMarks.ts"
import { inspectPullRequest, stateFilename } from "./inspectPullRequest.ts"
import type { Decision } from "./pullRequestSettings.ts"
import { reportPullRequest } from "./reportPullRequest.ts"
import { commentMarker } from "./toPullRequestComment.ts"

const now = Date.parse("2026-11-27T12:00:00Z")
const headCommit = toHeadCommit(7)
const upgrade = { dependency: "widget", from: "1.2.0", to: "2.0.0" }
const selected = { pullRequest: 7, headCommit, baseCommit, upgrade }
const inspectDecision = { outcome: "inspect" as const, startPath: "red" as const, ...selected, movedWith: [] }
type Check = typeof checkRepository

// one saved upgrade result as the inspection report holds it
function toSavedReport(result: object = {}, report: object = {}): object {
	const passed = { status: "passed" }
	const saved = {
		dependency: "widget",
		to: "2.0.0",
		verdict: "Fixed",
		install: passed,
		typecheck: passed,
		tests: passed,
	}
	const runtimeUsage = { modelCostUsd: 1.5, runtimes: [{ upperBoundUsd: 0.25 }, { upperBoundUsd: 0.05 }] }
	return { runtimeUsage, upgrades: [{ ...saved, patches: [{}], newDependencies: [], ...result }], ...report }
}

type Run = {
	api: FakeRepositoryApi
	environment: NodeJS.ProcessEnv
	output: string

	// the arguments of each check and the upgrade of each pull request the inspect step opened
	checkArguments: string[][]
	openedPullRequests: string[]
}

// run the inspect step and the report step for one decision in a temporary output folder
async function run(
	decision: Decision,
	{
		api = createFakeRepositoryApi({ 7: { to: "2.0.0" } }),
		settings = {},
		check,
	}: { api?: FakeRepositoryApi; settings?: Record<string, string>; check?: Check | "skip" } = {},
): Promise<Run> {
	const output = await mkdtemp(join(tmpdir(), "health-code-report-"))
	const environment = {
		...modelSettings,
		RUNTA_TOKEN: "runta-token",
		GITHUB_REPOSITORY: fakeRepository,
		GITHUB_SERVER_URL: "https://github.com",
		GITHUB_RUN_ID: "42",
		HEALTH_CODE_OUTPUT: output,
		HEALTH_CODE_DECISION: JSON.stringify(decision),
		...settings,
	}

	// write a saved report in place of a real check unless the test supplies one
	const checkArguments: string[][] = []
	const defaultCheck: Check = async (args) => {
		checkArguments.push(args)
		await writeFile(join(output, "inspection-report.json"), JSON.stringify(toSavedReport()))
		return { isComplete: true }
	}

	// record each pull request the inspect step opens in place of running git and gh
	const openedPullRequests: string[] = []
	const openPatchPullRequest = async ({
		upgrade,
	}: {
		upgrade: { dependency: string; to: string }
	}): Promise<string> => {
		openedPullRequests.push(`${upgrade.dependency} ${upgrade.to}`)
		return "health-code/branch"
	}

	// run the inspect step unless the decision is a report without one
	const signal = new AbortController().signal
	if (check !== "skip") {
		const inspection = inspectPullRequest({
			environment,
			signal,
			request: api.request,
			check: check ?? defaultCheck,
			openPatchPullRequest,
			now,
			log: () => undefined,
		})
		await inspection.catch(() => undefined)
	}
	await reportPullRequest({ environment, request: api.request, now })
	return { api, environment, output, checkArguments, openedPullRequests }
}

function readComments(api: FakeRepositoryApi): string[] {
	return (api.comments.get(7) ?? []).map((comment) => comment.body)
}

function readStatuses(api: FakeRepositoryApi): string[] {
	return (api.statuses.get(headCommit) ?? []).map((status) => `${status.state}: ${status.description}`)
}

function client(api: FakeRepositoryApi): ReturnType<typeof createGithubClient> {
	return createGithubClient({ repository: fakeRepository, request: api.request })
}

test("an inspection ends with one status, one comment, one mark and its cost in the week", async () => {
	const { api, output, checkArguments } = await run(inspectDecision)
	try {
		// test the upgrade only at the base commit and open the pull request
		const repositoryUrl = `https://github.com/${fakeRepository}`
		const target = ["--dependency", "widget", "--to", "2.0.0", "--revision", baseCommit]
		assert.deepEqual(checkArguments, [[repositoryUrl, ...target, "--output", output, "--upgrade-only"]])
		assert.deepEqual(readStatuses(api), [
			"success: Verdict: Fixed",
			"pending: The health inspector is trying this upgrade",
		])

		// build the comment from fixed copy and the report's values
		const runUrl = `https://github.com/${fakeRepository}/actions/runs/42`
		assert.deepEqual(readComments(api), [
			[
				commentMarker,
				"[Health Code](https://runhealthcode.dev) tried `widget` 2.0.0 at `bbbbbbb` in a [Runta](https://runta.com) sandbox.",
				"",
				"- Verdict: Fixed",
				"- Install: passed",
				"- Typecheck: passed",
				"- Tests: passed",
				"- Tested patch: saved in the Inspection Report. Its pull request could not be opened. Turn on **Allow GitHub Actions to create and approve pull requests** under Settings, Actions, General.",
				"- Cost: $1.50 model and $0.30 sandbox",
				`- [Inspection Report](${runUrl})`,
			].join("\n"),
		])

		// record the result and the cost
		const mark = await readMark(client(api), { dependency: "widget", to: "2.0.0" })
		assert.deepEqual(mark?.status, { state: "success", description: "Verdict: Fixed" })
		assert.equal(await readWeekSpend(client(api), now), 1.8)
	} finally {
		await rm(output, { recursive: true, force: true })
	}
})

test("the comment links the patch's pull request and the saved report's artifact", async () => {
	const api = createFakeRepositoryApi({ 7: { to: "2.0.0" } })
	api.patchPullRequests.set("health-code/widget-2.0.0", 12)
	const artifactUrl = `https://github.com/${fakeRepository}/actions/runs/42/artifacts/9`
	const { output } = await run(inspectDecision, { api, settings: { HEALTH_CODE_ARTIFACT_URL: artifactUrl } })
	await rm(output, { recursive: true, force: true })

	// find both links in the one comment
	const [comment = ""] = readComments(api)
	assert.ok(comment.includes(`- Tested patch: https://github.com/${fakeRepository}/pull/12`))
	assert.ok(comment.includes(`- [Inspection Report](${artifactUrl})`))
})

test("a repair opens a pull request, and an upgrade without a patch opens none", async () => {
	const repaired = await run(inspectDecision)
	assert.deepEqual(repaired.openedPullRequests, ["widget 2.0.0"])

	// save a report whose upgrade has no patch
	const check: Check = async (args) => {
		const output = args[args.indexOf("--output") + 1] ?? ""
		const report = toSavedReport({ verdict: "Can't fix", patches: [] })
		await writeFile(join(output, "inspection-report.json"), JSON.stringify(report))
		return { isComplete: true }
	}

	// open nothing for it
	const unrepaired = await run(inspectDecision, { check })
	assert.deepEqual(unrepaired.openedPullRequests, [])
	for (const { output } of [repaired, unrepaired]) {
		await rm(output, { recursive: true, force: true })
	}
})

test("each path picks its flags", async () => {
	const readFlags = async (decision: Decision, settings?: Record<string, string>): Promise<string[]> => {
		const { output, checkArguments } = await run(decision, { settings })
		await rm(output, { recursive: true, force: true })
		return (checkArguments[0] ?? []).slice(9)
	}

	// only a person's label and the feature patch setting drop the upgrade-only flag
	assert.deepEqual(await readFlags({ ...inspectDecision, startPath: "major" }), ["--upgrade-only"])
	assert.deepEqual(await readFlags({ ...inspectDecision, startPath: "asked" }), [])
	assert.deepEqual(await readFlags(inspectDecision, { HEALTH_CODE_FEATURE_PATCHES: "true" }), [])
})

test("a verdict without a patch gives a fixed sentence and its status", async () => {
	const check = (result: object): Check => {
		return async (args) => {
			const output = args[args.indexOf("--output") + 1] ?? ""
			await writeFile(join(output, "inspection-report.json"), JSON.stringify(toSavedReport(result)))
			return { isComplete: true }
		}
	}

	// a repair that failed leaves a red status and none of the report's free text
	const cantFix = await run(inspectDecision, {
		check: check({ verdict: "Can't fix", patches: [], reason: "model text" }),
	})
	await rm(cantFix.output, { recursive: true, force: true })
	assert.equal(readStatuses(cantFix.api)[0], "failure: Verdict: Can't fix")
	assert.ok(readComments(cantFix.api)[0]?.includes("- No tested patch: the repair did not pass the checks."))
	assert.equal(readComments(cantFix.api)[0]?.includes("model text"), false)

	// an untested upgrade names the first check that did not pass
	const untestedResult = { verdict: "Untested", patches: [], install: { status: "untested", reason: "command output" } }
	const untested = await run(inspectDecision, { check: check(untestedResult) })
	await rm(untested.output, { recursive: true, force: true })
	assert.equal(readStatuses(untested.api)[0], "error: Verdict: Untested")
	assert.ok(readComments(untested.api)[0]?.includes("- No tested patch: the install check did not pass."))
	assert.equal(readComments(untested.api)[0]?.includes("command output"), false)
})

test("the comment names each package only one side moves", async () => {
	const check: Check = async (args) => {
		const output = args[args.indexOf("--output") + 1] ?? ""
		const newDependencies = [{ name: "vite" }, { name: "$(untrusted)" }]
		await writeFile(join(output, "inspection-report.json"), JSON.stringify(toSavedReport({ newDependencies })))
		return { isComplete: true }
	}

	// let the bot's pull request move a package the patch leaves
	const movedWith = [{ dependency: "widget-dom", from: "1.2.0", to: "2.0.0" }]
	const { api, output } = await run({ ...inspectDecision, movedWith }, { check })
	await rm(output, { recursive: true, force: true })
	const [comment = ""] = readComments(api)
	assert.ok(
		comment.endsWith(
			"\n\nThe patch also moves `vite`, which this pull request does not.\nThis pull request also moves `widget-dom`, which the patch does not.",
		),
	)
	assert.equal(comment.includes("untrusted"), false)
})

test("a second inspection replaces the comment and the mark, and removes the label", async () => {
	const api = createFakeRepositoryApi({ 7: { to: "2.0.0" } })
	const first = await run(inspectDecision, { api })
	const second = await run({ ...inspectDecision, startPath: "asked" }, { api })
	await rm(first.output, { recursive: true, force: true })
	await rm(second.output, { recursive: true, force: true })

	// count one comment, one removed label and the cost of both inspections
	assert.equal(readComments(api).length, 1)
	assert.deepEqual(api.removedLabels, ["health-code"])
	assert.equal(await readWeekSpend(client(api), now), 3.6)
})

test("a re-run of the same workflow run takes over the mark it left unfinished", async () => {
	const api = createFakeRepositoryApi({ 7: { to: "2.0.0" } })
	const mark = { dependency: "widget", to: "2.0.0", pullRequest: 7, startedAt: "2026-11-27T10:00:00Z", runId: "42" }
	await claimMark(client(api), { mark, baseCommit })

	// run both steps again under the same run id
	const { output, checkArguments } = await run(inspectDecision, { api })
	await rm(output, { recursive: true, force: true })
	assert.equal(checkArguments.length, 1)
	assert.equal(readStatuses(api)[0], "success: Verdict: Fixed")
})

test("a head the pull request moved to during the inspection gets the status too", async () => {
	const oldHead = "9".repeat(40)
	const { api, output } = await run({ ...inspectDecision, headCommit: oldHead })
	await rm(output, { recursive: true, force: true })
	assert.equal(api.statuses.get(oldHead)?.[0]?.description, "Verdict: Fixed")
	assert.equal(readStatuses(api)[0], "success: Verdict: Fixed")

	// a new head that holds another version keeps no status of the old one
	const movedApi = createFakeRepositoryApi({ 7: { to: "3.0.0" } })
	const moved = await run({ ...inspectDecision, headCommit: oldHead }, { api: movedApi })
	await rm(moved.output, { recursive: true, force: true })
	assert.equal(movedApi.statuses.get(oldHead)?.[0]?.description, "Verdict: Fixed")
	assert.deepEqual(readStatuses(movedApi), [])
})

test("a run that loses the claim inspects nothing and writes nothing", async () => {
	const api = createFakeRepositoryApi({ 7: { to: "2.0.0" } })
	const mark = { dependency: "widget", to: "2.0.0", pullRequest: 8, startedAt: "2026-11-27T10:00:00Z" }
	await claimMark(client(api), { mark, baseCommit })

	// run both steps for the version another run holds
	const { output, checkArguments } = await run(inspectDecision, { api })
	await rm(output, { recursive: true, force: true })
	assert.deepEqual([checkArguments, readStatuses(api), readComments(api)], [[], [], []])
	assert.equal((await readMark(client(api), mark))?.pullRequest, 8)
})

test("an inspection that fails or is rejected ends the status and says so", async () => {
	const failing: Check = async () => {
		throw new InspectionError("deadline", "The inspection ran out of time.")
	}
	const failed = await run(inspectDecision, { check: failing })
	await rm(failed.output, { recursive: true, force: true })
	assert.equal(readStatuses(failed.api)[0], "error: The inspection did not finish")
	assert.match(
		readComments(failed.api)[0] ?? "",
		/did not finish its inspection of `widget` 2\.0\.0\. See the \[workflow run\]/,
	)
	assert.equal(await readWeekSpend(client(failed.api), now), 15)

	// a version the registry rule rejects starts no sandbox and costs nothing
	const api = createFakeRepositoryApi({ 7: { to: "9.9.9" } })
	const rejectedUpgrade = { ...upgrade, to: "9.9.9" }
	const rejected = await run({ ...inspectDecision, upgrade: rejectedUpgrade }, { api, check: checkRepository })
	await rm(rejected.output, { recursive: true, force: true })
	assert.equal(readStatuses(api)[0], "error: The version was rejected before any sandbox started")
	assert.match(
		readComments(api)[0] ?? "",
		/started no sandbox for this upgrade\.\n\n```text\nwidget 9\.9\.9 is not published/,
	)
	assert.equal(await readWeekSpend(client(api), now), 0)
})

test("an inspection that reaches the time limit is stopped and reported as unfinished", async () => {
	// wait until the step's own time limit aborts the check
	let isAborted = false
	const waiting: Check = (_args, { signal }) =>
		new Promise((_resolve, reject) => {
			signal.addEventListener("abort", () => {
				isAborted = true
				reject(new InspectionError("cancelled", "The request was stopped."))
			})
		})

	// give the inspection a limit of a few milliseconds
	const { api, output } = await run(inspectDecision, {
		check: waiting,
		settings: { HEALTH_CODE_TIMEOUT_MINUTES: "0.001" },
	})
	await rm(output, { recursive: true, force: true })
	assert.equal(isAborted, true)
	assert.equal(readStatuses(api)[0], "error: The inspection did not finish")
	assert.match(readComments(api)[0] ?? "", /did not finish its inspection/)
})

test("a missing account token stops before the claim and names the Dependabot secret", async () => {
	const api = createFakeRepositoryApi({ 7: { to: "2.0.0" } })
	const output = await mkdtemp(join(tmpdir(), "health-code-report-"))
	const environment = {
		GITHUB_REPOSITORY: fakeRepository,
		HEALTH_CODE_OUTPUT: output,
		HEALTH_CODE_DECISION: JSON.stringify(inspectDecision),
	}
	try {
		const signal = new AbortController().signal
		await assert.rejects(
			inspectPullRequest({ environment, signal, request: api.request, now }),
			(error) => error instanceof UserError && /also add RUNTA_TOKEN as a Dependabot secret/.test(error.message),
		)
		assert.equal(JSON.parse(await readFile(join(output, stateFilename), "utf8")).phase, "blocked")

		// the report step ends the status and leaves the mark unclaimed
		await reportPullRequest({ environment, request: api.request, now })
		assert.deepEqual(readStatuses(api), ["error: The inspection could not start. See the workflow run"])
		assert.equal(await readMark(client(api), { dependency: "widget", to: "2.0.0" }), undefined)
	} finally {
		await rm(output, { recursive: true, force: true })
	}
})

test("the cap gets the status and one comment, or the status only", async () => {
	const capDecision = { outcome: "report" as const, note: "cap" as const, startPath: "major" as const, ...selected }
	const commented = await run(capDecision, { check: "skip" })
	await run(capDecision, { api: commented.api, check: "skip" })
	assert.deepEqual(readStatuses(commented.api)[0], "error: Not inspected: this week's cap of $25.00 is reached")
	assert.equal(readComments(commented.api).length, 1)
	assert.match(readComments(commented.api)[0] ?? "", /This week's spending cap of \$25\.00 is reached/)

	// the status setting leaves the pull request without a comment
	const quiet = await run(capDecision, { check: "skip", settings: { HEALTH_CODE_AT_CAP: "status" } })
	assert.deepEqual([readStatuses(quiet.api).length, readComments(quiet.api)], [1, []])

	// a cap reached between the two steps is answered the same way and claims no mark
	const api = createFakeRepositoryApi({ 7: { to: "2.0.0" } })
	await addWeekSpend(client(api), { usd: 30, baseCommit, now })
	const late = await run(inspectDecision, { api })
	assert.deepEqual([late.checkArguments, readStatuses(api).length, readComments(api).length], [[], 1, 1])
	assert.equal(await readMark(client(api), { dependency: "widget", to: "2.0.0" }), undefined)

	// remove the output folders
	for (const { output } of [commented, quiet, late]) {
		await rm(output, { recursive: true, force: true })
	}
})

test("a marked result is copied to a new head, and a person who asked gets the reason", async () => {
	const api = createFakeRepositoryApi({ 7: { to: "2.0.0" } })
	const first = await run(inspectDecision, { api })
	const newHead = "9".repeat(40)
	const copy = { outcome: "report" as const, note: "status-copy" as const, startPath: "major" as const, ...selected }
	const copied = await run({ ...copy, headCommit: newHead }, { api, check: "skip" })
	assert.deepEqual(
		api.statuses.get(newHead)?.map((status) => status.description),
		["Verdict: Fixed"],
	)
	assert.equal(readComments(api).length, 1)

	// a grouped pull request with the label gets one comment and loses the label
	const groupedApi = createFakeRepositoryApi({ 7: { to: "2.0.0" } })
	const grouped = { outcome: "report" as const, note: "grouped" as const, startPath: "asked" as const, pullRequest: 7 }
	const answered = await run(grouped, { api: groupedApi, check: "skip" })
	assert.match(
		readComments(groupedApi)[0] ?? "",
		/tries one upgrade at a time\. The pull request moves several unrelated packages\./,
	)
	assert.deepEqual([groupedApi.removedLabels, groupedApi.statuses.size], [["health-code"], 0])
	for (const { output } of [first, copied, answered]) {
		await rm(output, { recursive: true, force: true })
	}
})

test("the real check runs for the decision with the fake sandbox provider and a stub gh", async () => {
	const { provider, restore } = await modelRequestSandboxFixture({
		makeProvider: createFakeSandboxProvider,
		selectedUpgrade: { to: "1.3.0" },
	})
	const publicProject = await createPublicProject()
	const { commit } = JSON.parse(await readFile(inspectionFixtureUrl, "utf8")) as { commit: string }
	const commands: string[] = []
	const check: Check = (args, options) =>
		checkRepository(args, {
			...options,
			sandboxProvider: provider,
			request: publicProject.request,
			run: async (file, commandArguments) => {
				commands.push(
					`${file} ${commandArguments.find((argument) => /^(switch|am|push|checkout|api|pr)$/.test(argument))}`,
				)
				return ""
			},
		})
	try {
		// inspect the recorded upgrade at the recorded commit on the red path
		const recordedUpgrade = { dependency: "widget", from: "1.2.0", to: "1.3.0" }
		const decision = { ...inspectDecision, baseCommit: commit, upgrade: recordedUpgrade }
		const { api, output, openedPullRequests } = await run(decision, { check })
		await rm(output, { recursive: true, force: true })

		// an upgrade that passes as is repeats the original pull request, so none is opened
		assert.deepEqual([commands, openedPullRequests], [[], []])
		assert.equal(readStatuses(api)[0], "success: Verdict: Passes as is")
		assert.ok(readComments(api)[0]?.includes("- Tested patch: none needed. The upgrade passed as is."))
		assert.match(
			readComments(api)[0] ?? "",
			/tried `widget` 1\.3\.0 at `[0-9a-f]{7}`[\s\S]*- Cost: \$\d+\.\d\d model and \$\d+\.\d\d sandbox/,
		)
	} finally {
		restore()
	}
})
