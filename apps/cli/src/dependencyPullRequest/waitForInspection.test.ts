import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import {
	createFakeRepositoryApi,
	type FakeRepositoryApi,
	fakeRepository,
	toHeadCommit,
	withWorkflowEvent,
} from "../fixtures/fakeRepositoryApi.ts"
import { UserError } from "../userError.ts"
import { createGithubClient } from "./githubClient.ts"
import { setStatus } from "./pullRequestWrites.ts"
import { waitForInspection } from "./waitForInspection.ts"

type Wait = { outcome: string; lines: string[]; sleepCount: number }
type WaitSetup = {
	event?: { name: string; payload: unknown }
	settings?: Record<string, string>

	// what happens while the step sleeps between two polls
	onSleep?: (sleepCount: number) => Promise<void>
}

const pullRequestEvent = { name: "pull_request", payload: { pull_request: { number: 7 } } }

// run the wait step with a clock that moves only when the step sleeps
async function wait(
	api: FakeRepositoryApi,
	{ event = pullRequestEvent, settings, onSleep }: WaitSetup = {},
): Promise<Wait> {
	const lines: string[] = []
	let time = 0
	let sleepCount = 0

	// advance the clock by each sleep and let the test change the status meanwhile
	const sleep = async (milliseconds: number): Promise<void> => {
		time += milliseconds
		sleepCount++
		await onSleep?.(sleepCount)
	}
	const outcome = await withWorkflowEvent(event, (environment) =>
		waitForInspection({
			environment: { ...environment, ...settings },
			request: api.request,
			sleep,
			now: () => time,
			log: (line) => lines.push(line),
		}),
	)
	return { outcome, lines, sleepCount }
}

// set the inspection's status on the head of pull request 7
async function setHeadStatus(
	api: FakeRepositoryApi,
	state: "pending" | "success" | "failure" | "error",
): Promise<void> {
	const client = createGithubClient({ repository: fakeRepository, request: api.request })
	await setStatus(client, { commit: toHeadCommit(7), status: { state, description: state } })
}

test("the wait ends when the status on a major's head leaves pending", async () => {
	const api = createFakeRepositoryApi({ 7: { to: "2.0.0" } })
	const result = await wait(api, {
		onSleep: async (sleepCount) => {
			// start the inspection during the first sleep and end it during the third
			if (sleepCount === 1) {
				await setHeadStatus(api, "pending")
			}
			if (sleepCount === 3) {
				await setHeadStatus(api, "failure")
			}
		},
	})
	assert.deepEqual([result.outcome, result.sleepCount], ["inspected", 3])
	assert.match(result.lines[0] ?? "", /waiting for the inspection of widget 2\.0\.0/)
})

test("anything but a pull request with one major upgrade returns at once", async () => {
	const minor = await wait(createFakeRepositoryApi({ 7: { to: "1.3.0" } }))
	const mixed = await wait(createFakeRepositoryApi({ 7: { to: "2.0.0", files: ["package.json", "src/index.ts"] } }))
	const push = await wait(createFakeRepositoryApi({}), { event: { name: "push", payload: {} } })
	assert.deepEqual(
		[minor, mixed, push].map((result) => [result.outcome, result.sleepCount]),
		[
			["skipped", 0],
			["skipped", 0],
			["skipped", 0],
		],
	)
})

test("an inspection that did not run lets the job continue with a warning, or fails it when required", async () => {
	const api = createFakeRepositoryApi({ 7: { to: "2.0.0" } })
	await setHeadStatus(api, "error")
	const result = await wait(api)
	assert.equal(result.outcome, "not-inspected")
	assert.match(
		result.lines.at(-1) ?? "",
		/^::warning::Health Code: The health inspector did not try this upgrade\..* The job continues\.$/,
	)
	await assert.rejects(
		wait(api, { settings: { HEALTH_CODE_REQUIRE_INSPECTION: "true" } }),
		(error) => error instanceof UserError && /requires an inspection before it installs/.test(error.message),
	)
})

test("a job for a head the pull request has left gets no result, and fails when one is required", async () => {
	const api = createFakeRepositoryApi({ 7: { to: "2.0.0" } })
	await setHeadStatus(api, "success")
	const staleHead = { number: 7, head: { sha: "9".repeat(40) } }
	const event = { name: "pull_request", payload: { pull_request: staleHead } }

	// the newer head's result does not answer for the commit this job tests
	const result = await wait(api, { event })
	assert.deepEqual([result.outcome, result.sleepCount], ["moved", 0])
	await assert.rejects(wait(api, { event, settings: { HEALTH_CODE_REQUIRE_INSPECTION: "true" } }), UserError)
})

test("no status within the time limit ends the wait the same way", async () => {
	const api = createFakeRepositoryApi({ 7: { to: "2.0.0" } })
	const result = await wait(api, { settings: { HEALTH_CODE_WAIT_MINUTES: "1" } })
	assert.deepEqual([result.outcome, result.sleepCount], ["timed-out", 2])
	assert.match(result.lines.at(-1) ?? "", /No inspection result arrived within the wait step's time limit/)
	await assert.rejects(
		wait(api, { settings: { HEALTH_CODE_WAIT_MINUTES: "1", HEALTH_CODE_REQUIRE_INSPECTION: "true" } }),
		UserError,
	)
})
