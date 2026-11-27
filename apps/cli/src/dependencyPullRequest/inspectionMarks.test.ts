import assert from "node:assert/strict"
import { test } from "node:test"
import { baseCommit, createFakeRepositoryApi, fakeRepository } from "../fixtures/fakeRepositoryApi.ts"
import { createGithubClient, type GithubClient } from "./githubClient.ts"
import {
	addWeekSpend,
	claimMark,
	readMark,
	readWeekSpend,
	toIsoWeek,
	toMarkReference,
	writeMark,
} from "./inspectionMarks.ts"

const now = Date.parse("2026-11-27T12:00:00Z")
const mark = { dependency: "@scope/widget", to: "2.0.0", pullRequest: 7, startedAt: "2026-11-27T10:00:00Z" }

function setup(): { client: GithubClient; api: ReturnType<typeof createFakeRepositoryApi> } {
	const api = createFakeRepositoryApi({})
	return { api, client: createGithubClient({ repository: fakeRepository, request: api.request }) }
}

test("a mark is claimed once, finished and replaced", async () => {
	const { client, api } = setup()
	assert.equal(await readMark(client, mark), undefined)
	assert.equal(await claimMark(client, { mark, baseCommit }), true)
	assert.equal(await claimMark(client, { mark: { ...mark, pullRequest: 8 }, baseCommit }), false)
	assert.deepEqual(await readMark(client, mark), mark)

	// the reference holds a digest and no part of the package name
	const [reference] = [...api.references.keys()]
	assert.match(reference ?? "", /^health-code\/inspections\/[0-9a-f]{64}$/)
	assert.equal(reference, toMarkReference(mark))

	// a finished inspection and a later one both replace the record
	const finished = { ...mark, status: { state: "failure" as const, description: "Can't fix" } }
	await writeMark(client, { mark: finished, baseCommit })
	assert.deepEqual(await readMark(client, mark), finished)
	await writeMark(client, { mark: { ...mark, pullRequest: 9 }, baseCommit })
	assert.equal((await readMark(client, mark))?.pullRequest, 9)
})

test("another version of the same dependency has no mark", async () => {
	const { client } = setup()
	await claimMark(client, { mark, baseCommit })
	assert.equal(await readMark(client, { ...mark, to: "2.0.1" }), undefined)
})

test("the week's spend adds up and starts from zero in a new week", async () => {
	const { client } = setup()
	assert.equal(await readWeekSpend(client, now), 0)
	await addWeekSpend(client, { usd: 1.25, baseCommit, now })
	await addWeekSpend(client, { usd: 2.5, baseCommit, now })
	assert.equal(await readWeekSpend(client, now), 3.75)

	// the next monday starts a new total
	const nextMonday = Date.parse("2026-11-30T00:00:00Z")
	assert.equal(await readWeekSpend(client, nextMonday), 0)
	await addWeekSpend(client, { usd: 4, baseCommit, now: nextMonday })
	assert.equal(await readWeekSpend(client, nextMonday), 4)
})

test("costs that two runs record at once both count", async () => {
	const { client, api } = setup()
	await Promise.all([1, 2, 3].map((usd) => addWeekSpend(client, { usd, baseCommit, now })))
	assert.equal(await readWeekSpend(client, now), 6)

	// each record has a reference of its own under the week
	const references = [...api.references.keys()]
	assert.equal(references.length, 3)
	assert.ok(references.every((reference) => /^health-code\/spend\/2026-W48\/[0-9a-f]{40}$/.test(reference)))
})

test("a time names its ISO week in UTC", () => {
	assert.equal(toIsoWeek(now), "2026-W48")
	assert.equal(toIsoWeek(Date.parse("2026-11-29T23:59:59Z")), "2026-W48")
	assert.equal(toIsoWeek(Date.parse("2026-11-30T00:00:00Z")), "2026-W49")
	assert.equal(toIsoWeek(Date.parse("2027-01-01T00:00:00Z")), "2026-W53")
})
