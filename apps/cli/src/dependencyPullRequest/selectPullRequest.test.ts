import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import {
	baseCommit,
	createFakeRepositoryApi,
	type FakeRepositoryApi,
	fakeRepository,
	toHeadCommit,
	withWorkflowEvent,
} from "../fixtures/fakeRepositoryApi.ts"
import { createGithubClient } from "./githubClient.ts"
import { addWeekSpend, claimMark, writeMark } from "./inspectionMarks.ts"
import type { Decision } from "./pullRequestSettings.ts"
import { selectPullRequest, writeDecision } from "./selectPullRequest.ts"

const now = Date.parse("2026-11-27T12:00:00Z")
const majorPull = { to: "2.0.0" }
const minorPull = { to: "1.3.0" }

// run the select step for one event against the fake repository
async function select(
	api: FakeRepositoryApi,
	event: { name: string; payload: unknown },
	settings: Record<string, string> = {},
	time = now,
): Promise<Decision> {
	return withWorkflowEvent(event, (environment) =>
		selectPullRequest({ environment: { ...environment, ...settings }, request: api.request, now: time }),
	)
}

function pullRequestEvent(action: string, pullRequest = 7, extra: object = {}): { name: string; payload: unknown } {
	return { name: "pull_request_target", payload: { action, pull_request: { number: pullRequest }, ...extra } }
}

function labeledEvent(label: string, login: string): { name: string; payload: unknown } {
	return pullRequestEvent("labeled", 7, { label: { name: label }, sender: { login } })
}

function failedRunEvent(pullRequest = 7, run: object = {}): { name: string; payload: unknown } {
	const workflowRun = {
		conclusion: "failure",
		head_sha: toHeadCommit(pullRequest),
		head_repository: { full_name: fakeRepository },
		...run,
	}
	return { name: "workflow_run", payload: { action: "completed", workflow_run: workflowRun } }
}

// set the checks a failed run leaves on the head and what the base commit shows
function setChecks(api: FakeRepositoryApi, head: Record<string, string>, base: Record<string, string>): void {
	api.checks.set(toHeadCommit(7), head)
	api.checks.set(baseCommit, base)
}

function client(api: FakeRepositoryApi): ReturnType<typeof createGithubClient> {
	return createGithubClient({ repository: fakeRepository, request: api.request })
}

test("a major starts an inspection when the pull request opens", async () => {
	const decision = await select(createFakeRepositoryApi({ 7: majorPull }), pullRequestEvent("opened"))
	assert.deepEqual(decision, {
		outcome: "inspect",
		startPath: "major",
		pullRequest: 7,
		headCommit: toHeadCommit(7),
		baseCommit,
		upgrade: { dependency: "widget", from: "1.2.0", to: "2.0.0" },
		movedWith: [],
	})
})

test("an upgrade that is not a major waits for red CI, and the Major path can be turned off", async () => {
	const open = async (pull: { to: string }, settings?: Record<string, string>): Promise<Decision> =>
		select(createFakeRepositoryApi({ 7: pull }), pullRequestEvent("opened"), settings)
	assert.equal((await open(minorPull)).outcome, "none")
	assert.deepEqual(await open(majorPull, { HEALTH_CODE_MAJOR: "false" }), {
		outcome: "none",
		reason: "The Major path is off.",
	})
})

test("red CI starts an inspection only for a check that is green on the base commit", async () => {
	const run = async (
		head: Record<string, string>,
		base: Record<string, string>,
		settings?: Record<string, string>,
	): Promise<Decision> => {
		const api = createFakeRepositoryApi({ 7: minorPull })
		setChecks(api, head, base)
		return select(api, failedRunEvent(), settings)
	}
	const red = await run({ test: "failure", lint: "success" }, { test: "success" })
	assert.deepEqual([red.outcome, "startPath" in red && red.startPath], ["inspect", "red"])

	// a failure the base commit shares, or has no result for, starts nothing
	const shared = await run({ test: "failure" }, { test: "failure" })
	assert.deepEqual(shared, { outcome: "none", reason: "Every failed check also fails on the base commit." })
	const unknown = await run({ test: "failure" }, {})
	assert.match("reason" in unknown ? unknown.reason : "", /No check on the base commit matched/)

	// only the listed checks count, and the path can be turned off
	const unlisted = await run({ lint: "failure" }, { lint: "success" }, { HEALTH_CODE_RED_CHECKS: "test" })
	assert.deepEqual(unlisted, { outcome: "none", reason: "No listed check failed on the pull request." })
	const off = await run({ test: "failure" }, { test: "success" }, { HEALTH_CODE_RED: "false" })
	assert.deepEqual(off, { outcome: "none", reason: "The Red path is off." })
})

test("a green run, a fork's run and a run with no pull request make no request for files", async () => {
	const api = createFakeRepositoryApi({ 7: minorPull })
	const green = await select(api, failedRunEvent(7, { conclusion: "success" }))
	const fork = await select(api, failedRunEvent(7, { head_repository: { full_name: "stranger/project" } }))
	assert.deepEqual([green.outcome, fork.outcome, api.requests], ["none", "none", []])
	const stray = await select(api, failedRunEvent(3))
	assert.match("reason" in stray ? stray.reason : "", /no open pull request/)
})

test("the label starts an inspection only from a person with write access", async () => {
	// add the label as an account with the given permission
	const ask = async (label: string, permission: string, pull = minorPull): Promise<Decision> => {
		const api = createFakeRepositoryApi({ 7: pull })
		api.permissions.set("maintainer", permission)
		return select(api, labeledEvent(label, "maintainer"))
	}
	const asked = await ask("health-code", "write")
	assert.deepEqual([asked.outcome, "startPath" in asked && asked.startPath], ["inspect", "asked"])
	assert.equal((await ask("health-code", "admin")).outcome, "inspect")

	// triage can add labels and has no write access
	assert.equal((await ask("health-code", "read")).outcome, "none")
	assert.deepEqual(await ask("bug", "write"), {
		outcome: "none",
		reason: "The label is not the one that asks for an inspection.",
	})
})

test("a pull request with no single upgrade gets an answer only when a person asked", async () => {
	const grouped = { to: "1.3.0", files: ["Dockerfile"] }
	const api = createFakeRepositoryApi({ 7: grouped })
	api.permissions.set("maintainer", "write")

	// the same pull request gets a reason in the summary and an answer for a person
	const opened = await select(api, pullRequestEvent("opened"))
	assert.deepEqual(opened, { outcome: "none", reason: "The pull request changes no package manifest and no lockfile." })
	const asked = await select(api, labeledEvent("health-code", "maintainer"))
	assert.deepEqual(asked, { outcome: "report", note: "no-npm-dependency", startPath: "asked", pullRequest: 7 })
})

test("a fork, a pull request with other changes and a branch Health Code pushed start nothing", async () => {
	const open = async (pull: object): Promise<Decision> =>
		select(createFakeRepositoryApi({ 7: { ...majorPull, ...pull } }), pullRequestEvent("opened"))
	const reasons = [
		await open({ headRepository: "stranger/project", headRef: "renovate/widget-2.x" }),
		await open({ files: ["package.json", "package-lock.json", "src/index.ts"] }),
		await open({ headRef: "health-code/widget-2.0.0" }),
	]
	assert.deepEqual(
		reasons.map((decision) => "reason" in decision && decision.reason),
		[
			"The pull request comes from a fork.",
			"The pull request changes files other than package manifests, lockfiles and the package manager's generated files.",
			"The pull request comes from a branch Health Code pushed.",
		],
	)
})

test("a marked version starts nothing again, except for a person who asks", async () => {
	const api = createFakeRepositoryApi({ 7: majorPull })
	api.permissions.set("maintainer", "write")
	setChecks(api, { test: "failure" }, { test: "success" })
	const mark = { dependency: "widget", to: "2.0.0", pullRequest: 7, startedAt: "2026-11-27T10:00:00Z" }
	assert.equal(await claimMark(client(api), { mark, baseCommit }), true)

	// a second red CI and a rebase find the mark
	assert.match(JSON.stringify(await select(api, failedRunEvent())), /already inspected/)
	assert.match(JSON.stringify(await select(api, pullRequestEvent("synchronize"))), /already inspected/)
	assert.equal((await select(api, labeledEvent("health-code", "maintainer"))).outcome, "inspect")

	// a finished mark is copied to a new head without an inspection
	await writeMark(client(api), { mark: { ...mark, status: { state: "success", description: "Fixed" } }, baseCommit })
	const copied = await select(api, pullRequestEvent("synchronize"))
	assert.deepEqual([copied.outcome, "note" in copied && copied.note], ["report", "status-copy"])

	// another pull request for the same version gets no copy of that result
	await writeMark(client(api), {
		mark: { ...mark, pullRequest: 8, status: { state: "success", description: "Fixed" } },
		baseCommit,
	})
	assert.match(JSON.stringify(await select(api, pullRequestEvent("synchronize"))), /already inspected/)
})

test("the week's cap stops every path and a new week starts from zero", async () => {
	const api = createFakeRepositoryApi({ 7: majorPull })
	await addWeekSpend(client(api), { usd: 26, baseCommit, now })
	const capped = await select(api, pullRequestEvent("opened"))
	assert.deepEqual([capped.outcome, "note" in capped && capped.note], ["report", "cap"])

	// a higher cap and a later week both let the inspection start
	const raised = await select(api, pullRequestEvent("opened"), { HEALTH_CODE_WEEKLY_CAP_USD: "50" })
	assert.equal(raised.outcome, "inspect")
	const nextWeek = now + 7 * 86_400_000
	const later = await select(api, pullRequestEvent("opened"), {}, nextWeek)
	assert.equal(later.outcome, "inspect")
})

test("the outputs and the summary hold no text from the pull request", async () => {
	const untrusted = "renovate/$(curl evil)`id`"
	const api = createFakeRepositoryApi({ 7: { ...majorPull, headRef: untrusted } })
	const event = pullRequestEvent("opened", 7, {
		pull_request: { number: 7, title: untrusted, head: { ref: untrusted } },
	})
	const decision = await select(api, event)
	const folder = await mkdtemp(join(tmpdir(), "health-code-output-"))
	try {
		// write the decision as the step does
		const environment = { GITHUB_OUTPUT: join(folder, "output"), GITHUB_STEP_SUMMARY: join(folder, "summary") }
		await writeDecision(decision, environment)
		const output = await readFile(environment.GITHUB_OUTPUT, "utf8")
		const summary = await readFile(environment.GITHUB_STEP_SUMMARY, "utf8")

		// find the outcome on its own line and nothing of the untrusted name
		assert.match(output, /^outcome=inspect\ndecision=\{.*\}\n$/)
		assert.equal(`${output}${summary}`.includes("curl"), false)
		assert.equal(summary, "Health Code: Inspecting widget 2.0.0 for pull request 7 on the major path.\n")
	} finally {
		await rm(folder, { recursive: true, force: true })
	}
})
