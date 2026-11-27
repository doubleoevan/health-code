import { createHash, randomUUID } from "node:crypto"
import { z } from "zod"
import { parseJson } from "../parseJson.ts"
import { UserError } from "../userError.ts"
import { type GithubClient, readProperty } from "./githubClient.ts"

// the result a finished inspection leaves for a later head of the same pull request
const markStatusSchema = z.object({
	state: z.enum(["success", "failure", "error"]),
	description: z.string().max(140),
})
export type MarkStatus = z.infer<typeof markStatusSchema>

// the record that one dependency and version was inspected in this repository
const inspectionMarkSchema = z.object({
	dependency: z.string(),
	to: z.string(),
	pullRequest: z.number(),
	startedAt: z.string(),
	runId: z.string().optional(),
	status: markStatusSchema.optional(),
})
export type InspectionMark = z.infer<typeof inspectionMarkSchema>

// one inspection's cost, in a reference of its own. github accepts a non-fast-forward update outside branches
const spendRecordSchema = z.object({ usd: z.number().nonnegative() })

type RecordCommit = { commit: string; tree: string; record: unknown }
// a mark to write and the commit whose tree its record reuses
type MarkWrite = { mark: InspectionMark; baseCommit: string }
type MarkKey = Pick<InspectionMark, "dependency" | "to">

const spendPrefix = "health-code/spend"

/**
 * Names the Git reference that marks one dependency and version by its digest.
 */
export function toMarkReference({ dependency, to }: MarkKey): string {
	const digest = createHash("sha256").update(`${dependency}@${to}`).digest("hex")
	return `health-code/inspections/${digest}`
}

/**
 * Reads the mark of a dependency and version, or nothing when it was never inspected.
 */
export async function readMark(client: GithubClient, key: MarkKey): Promise<InspectionMark | undefined> {
	const recordCommit = await readRecordCommit(client, toMarkReference(key))
	const parsed = inspectionMarkSchema.safeParse(recordCommit?.record)

	// treat a reference with an unreadable record as a mark without a result
	if (recordCommit && !parsed.success) {
		return { ...key, pullRequest: 0, startedAt: "" }
	}
	return parsed.data
}

/**
 * Claims a dependency and version for one inspection, or reports that another run holds the mark.
 */
export async function claimMark(client: GithubClient, markWrite: MarkWrite): Promise<boolean> {
	return (await createMark(client, markWrite)).isCreated
}

/**
 * Writes a mark's record, replacing the record of an earlier inspection of the same dependency and version.
 */
export async function writeMark(client: GithubClient, markWrite: MarkWrite): Promise<void> {
	const { commit, isCreated } = await createMark(client, markWrite)
	if (isCreated) {
		return
	}

	// point the existing reference at the new record
	const reference = toMarkReference(markWrite.mark)
	const updateResponse = await client.send("PATCH", `/git/refs/${reference}`, { sha: commit, force: true })
	if (updateResponse.status !== 200) {
		throw toStateError(updateResponse.status)
	}
}

// store the record in a commit and create the mark's reference, which github rejects when it exists
async function createMark(
	client: GithubClient,
	{ mark, baseCommit }: MarkWrite,
): Promise<{ commit: string; isCreated: boolean }> {
	const tree = await readTree(client, baseCommit)
	const commit = await createRecordCommit(client, { record: mark, tree, parents: [] })

	// create the reference once. 422 means it exists
	const reference = `refs/${toMarkReference(mark)}`
	const createResponse = await client.send("POST", "/git/refs", { ref: reference, sha: commit })
	if (createResponse.status === 201) {
		return { commit, isCreated: true }
	}

	// github also answers 422 to a request it cannot validate, so confirm that the reference exists
	const existing = createResponse.status === 422 ? await client.get(`/git/ref/${toMarkReference(mark)}`) : undefined
	if (existing?.status !== 200) {
		throw toStateError(createResponse.status)
	}
	return { commit, isCreated: false }
}

/**
 * Adds up the recorded cost of every inspection in the ISO week that holds the given time.
 */
export async function readWeekSpend(client: GithubClient, now: number): Promise<number> {
	// ponytail: read the first 100 records of a week. page through them if a week holds more inspections
	const listed = await client.get(`/git/matching-refs/${spendPrefix}/${toIsoWeek(now)}/?per_page=100`)
	if (listed.status !== 200 || !Array.isArray(listed.body)) {
		throw toStateError(listed.status)
	}

	// read each record's commit and add its cost
	let totalUsd = 0
	for (const reference of listed.body) {
		const commit = readProperty(reference, "object", "sha")
		const response = await client.get(`/git/commits/${commit}`)
		const record = spendRecordSchema.safeParse(parseJson(String(readProperty(response.body, "message") ?? "")))

		// stop the count at a record that cannot be read
		if (response.status !== 200 || !record.success) {
			throw toStateError(response.status)
		}
		totalUsd += record.data.usd
	}
	return Math.round(totalUsd * 1e6) / 1e6
}

/**
 * Records one inspection's cost under its week, in a reference of its own that no other run writes.
 */
export async function addWeekSpend(
	client: GithubClient,
	{ usd, baseCommit, now }: { usd: number; baseCommit: string; now: number },
): Promise<void> {
	const tree = await readTree(client, baseCommit)
	const record = { usd: Math.round(usd * 1e6) / 1e6, id: randomUUID() }
	const commit = await createRecordCommit(client, { record, tree, parents: [] })

	// name the reference after the record's own commit
	const reference = `refs/${spendPrefix}/${toIsoWeek(now)}/${commit}`
	const created = await client.send("POST", "/git/refs", { ref: reference, sha: commit })
	if (created.status !== 201) {
		throw toStateError(created.status)
	}
}

/**
 * Names the ISO week of a time in UTC, such as 2026-W48.
 */
export function toIsoWeek(time: number): string {
	// move to the thursday of the same iso week. the thursday decides the week's year
	const date = new Date(time)
	const day = date.getUTCDay() || 7
	date.setUTCDate(date.getUTCDate() + 4 - day)
	date.setUTCHours(0, 0, 0, 0)
	const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1)
	const week = Math.ceil(((date.getTime() - yearStart) / 86_400_000 + 1) / 7)
	return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`
}

// read the commit a reference points at and the JSON record in its message
async function readRecordCommit(client: GithubClient, reference: string): Promise<RecordCommit | undefined> {
	const found = await client.get(`/git/ref/${reference}`)
	if (found.status === 404) {
		return undefined
	}

	// require the commit the reference points at
	const commit = readProperty(found.body, "object", "sha")
	if (found.status !== 200 || typeof commit !== "string") {
		throw toStateError(found.status)
	}

	// read the record and the tree the next record can reuse
	const answer = await client.get(`/git/commits/${commit}`)
	const tree = readProperty(answer.body, "tree", "sha")
	const message = readProperty(answer.body, "message")
	if (answer.status !== 200 || typeof tree !== "string" || typeof message !== "string") {
		throw toStateError(answer.status)
	}
	return { commit, tree, record: parseJson(message) }
}

async function readTree(client: GithubClient, commit: string): Promise<string> {
	const answer = await client.get(`/git/commits/${commit}`)
	const tree = readProperty(answer.body, "tree", "sha")
	if (answer.status !== 200 || typeof tree !== "string") {
		throw toStateError(answer.status)
	}
	return tree
}

// store a record as the message of a commit that changes no file
async function createRecordCommit(
	client: GithubClient,
	{ record, tree, parents }: { record: unknown; tree: string; parents: string[] },
): Promise<string> {
	const created = await client.send("POST", "/git/commits", { message: JSON.stringify(record), tree, parents })
	const commit = readProperty(created.body, "sha")
	if (created.status !== 201 || typeof commit !== "string") {
		throw toStateError(created.status)
	}
	return commit
}

function toStateError(status: number): UserError {
	return new UserError(
		`GitHub answered ${status} while reading or writing a reference under refs/health-code/. Check that the job has contents: write and run it again.`,
	)
}
