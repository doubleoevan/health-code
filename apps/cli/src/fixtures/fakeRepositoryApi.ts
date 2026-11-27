import { createHash } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFakeGithub, type FakeGithub, type FakePullRequest } from "health-code"

type Files = Map<string, string>
type FakeComment = { id: number; body: string; user: { login: string } }
type FakeStatus = { context: string; state: string; description: string; target_url?: string }
type FakePull = { author?: string; to: string; headRef?: string; headRepository?: string; files?: string[] }

// one repository's pull requests, checks, references, statuses and comments, kept in memory
export type FakeRepositoryApi = {
	request: typeof fetch
	github: FakeGithub
	requests: string[]

	// what the steps under test wrote
	references: Map<string, string>
	commitMessages: Map<string, string>
	statuses: Map<string, FakeStatus[]>
	comments: Map<number, FakeComment[]>
	commentCount: number
	removedLabels: string[]

	// what a test sets up: check conclusions by commit, permissions by login and open patch pull requests
	checks: Map<string, Record<string, string>>
	permissions: Map<string, string>
	patchPullRequests: Map<string, number>
}

export const fakeRepository = "example/project"
export const baseCommit = "b".repeat(40)

/**
 * Names the head commit of a fake pull request by its number.
 */
export function toHeadCommit(pullRequest: number): string {
	return createHash("sha1").update(`pull request ${pullRequest}`).digest("hex")
}

/**
 * Builds an npm project that locks one version of widget.
 */
export function toWidgetProject(version: string): Files {
	const manifest = JSON.stringify({ name: "example", dependencies: { widget: version } })
	const lockfile = JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/widget": { version } } })
	return new Map([
		["package.json", manifest],
		["package-lock.json", lockfile],
	])
}

/**
 * Serves pull requests that each move widget, and the GitHub endpoints the workflow steps read and write.
 */
export function createFakeRepositoryApi(pulls: Record<number, FakePull>): FakeRepositoryApi {
	// give each pull request its own head commit over one shared base commit
	const revisions: Record<string, Files> = {}
	const pullRequests: Record<number, FakePullRequest> = {}
	for (const [number, pull] of Object.entries(pulls)) {
		const headCommit = toHeadCommit(Number(number))
		revisions[headCommit] = toWidgetProject(pull.to)
		pullRequests[Number(number)] = {
			author: pull.author ?? "renovate[bot]",
			headCommit,
			baseCommit,
			headRef: pull.headRef,
			headRepository: pull.headRepository,
			changedFiles: pull.files,
		}
	}
	const repository = { files: toWidgetProject("1.2.0"), commit: baseCommit, revisions, pullRequests }
	const github = createFakeGithub({
		repositories: { [fakeRepository]: repository },
		versions: { "1.2.0": {}, "2.0.0": {} },
	})

	// keep everything the steps write
	const api: FakeRepositoryApi = {
		request: fetch,
		github,
		requests: [],
		references: new Map(),
		commitMessages: new Map(),
		statuses: new Map(),
		comments: new Map(),
		commentCount: 0,
		removedLabels: [],
		checks: new Map(),
		permissions: new Map(),
		patchPullRequests: new Map(),
	}
	api.request = (async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
		// answer the workflow steps' endpoints first
		const url = new URL(String(input))
		const route = url.pathname.replace(`/repos/${fakeRepository}`, "")
		const method = init.method ?? "GET"

		// record the call and parse what it sends
		api.requests.push(`${method} ${route}`)
		const body: unknown = typeof init.body === "string" ? JSON.parse(init.body) : undefined
		return answer({ api, pulls, method, route, search: url.searchParams, body }) ?? github.request(input, init)
	}) as typeof fetch
	return api
}

type Call = {
	api: FakeRepositoryApi
	pulls: Record<number, FakePull>
	method: string
	route: string
	search: URLSearchParams
	body: unknown
}

// one endpoint: its method, the shape of its path and what it answers
type Route = { method: string; pattern: RegExp; answer: (call: Call, match: RegExpExecArray) => Response }

const commitPattern = "([0-9a-f]{40})"
const routes: Route[] = [
	{ method: "POST", pattern: /^\/git\/commits$/, answer: createCommit },
	{ method: "POST", pattern: /^\/git\/refs$/, answer: createReference },
	{ method: "PATCH", pattern: /^\/git\/refs\/(.+)$/, answer: moveReference },
	{ method: "GET", pattern: /^\/git\/ref\/(.+)$/, answer: readReference },
	{ method: "GET", pattern: /^\/git\/matching-refs\/(.+)$/, answer: listReferences },
	{ method: "GET", pattern: /^\/git\/commits\/(.+)$/, answer: readCommit },
	{ method: "POST", pattern: new RegExp(`^/statuses/${commitPattern}$`), answer: addStatus },
	{ method: "POST", pattern: /^\/issues\/(\d+)\/comments$/, answer: addComment },
	{ method: "PATCH", pattern: /^\/issues\/comments\/(\d+)$/, answer: replaceComment },
	{ method: "DELETE", pattern: /^\/issues\/\d+\/labels\/(.+)$/, answer: removeLabel },
	{ method: "GET", pattern: new RegExp(`^/commits/${commitPattern}/check-runs$`), answer: listChecks },
	{ method: "GET", pattern: new RegExp(`^/commits/${commitPattern}/statuses$`), answer: listStatuses },
	{ method: "GET", pattern: new RegExp(`^/commits/${commitPattern}/status$`), answer: readCombinedStatus },
	{ method: "GET", pattern: new RegExp(`^/commits/${commitPattern}/pulls$`), answer: listCommitPullRequests },
	{ method: "GET", pattern: /^\/collaborators\/([^/]+)\/permission$/, answer: readPermission },
	{ method: "GET", pattern: /^\/issues\/(\d+)\/comments$/, answer: listComments },
	{ method: "GET", pattern: /^\/pulls$/, answer: listPatchPullRequests },
]

// answer the first endpoint whose method and path match
function answer(call: Call): Response | undefined {
	for (const route of routes) {
		// try the path only for a route of the same method
		const match = route.method === call.method ? route.pattern.exec(call.route) : null
		if (match) {
			return route.answer(call, match)
		}
	}
	return undefined
}

function readFields(body: unknown): Record<string, string> {
	return (body ?? {}) as Record<string, string>
}

// store a record's commit under an id made from its message
function createCommit({ api, body }: Call): Response {
	const { message = "" } = readFields(body)
	const commit = createHash("sha1").update(`${api.commitMessages.size}${message}`).digest("hex")
	api.commitMessages.set(commit, message)
	return Response.json({ sha: commit }, { status: 201 })
}

// create a reference once, and reject a second create as github does
function createReference({ api, body }: Call): Response {
	const { ref = "", sha = "" } = readFields(body)
	const reference = ref.replace(/^refs\//, "")
	if (api.references.has(reference)) {
		return Response.json({ message: "Reference already exists" }, { status: 422 })
	}

	// point the new reference at the commit
	api.references.set(reference, sha)
	return Response.json({}, { status: 201 })
}

function moveReference({ api, body }: Call, match: RegExpExecArray): Response {
	api.references.set(match[1] ?? "", readFields(body).sha ?? "")
	return Response.json({})
}

function readReference({ api }: Call, match: RegExpExecArray): Response {
	const commit = api.references.get(match[1] ?? "")
	return commit ? Response.json({ object: { sha: commit } }) : Response.json({}, { status: 404 })
}

// list every reference under a prefix with the commit it points at
function listReferences({ api }: Call, match: RegExpExecArray): Response {
	const references = [...api.references].filter(([reference]) => reference.startsWith(match[1] ?? ""))
	return Response.json(references.map(([reference, sha]) => ({ ref: `refs/${reference}`, object: { sha } })))
}

// serve a record's commit, and any other commit with a tree of its own
function readCommit({ api }: Call, match: RegExpExecArray): Response {
	const commit = match[1] ?? ""
	return Response.json({ sha: commit, tree: { sha: "e".repeat(40) }, message: api.commitMessages.get(commit) ?? "" })
}

// keep a commit's statuses newest first
function addStatus({ api, body }: Call, match: RegExpExecArray): Response {
	const commit = match[1] ?? ""
	api.statuses.set(commit, [readFields(body) as unknown as FakeStatus, ...(api.statuses.get(commit) ?? [])])
	return Response.json({}, { status: 201 })
}

// add a comment as the workflow's own account
function addComment({ api, body }: Call, match: RegExpExecArray): Response {
	const pullRequest = Number(match[1])
	const list = api.comments.get(pullRequest) ?? []
	const comment = {
		id: api.commentCount + 1,
		body: readFields(body).body ?? "",
		user: { login: "github-actions[bot]" },
	}
	api.commentCount++
	api.comments.set(pullRequest, [...list, comment])
	return Response.json({}, { status: 201 })
}

// replace the body of the comment with the given id
function replaceComment({ api, body }: Call, match: RegExpExecArray): Response {
	const comment = [...api.comments.values()].flat().find((item) => item.id === Number(match[1]))
	if (comment) {
		comment.body = readFields(body).body ?? ""
	}
	return Response.json({}, { status: comment ? 200 : 404 })
}

function removeLabel({ api }: Call, match: RegExpExecArray): Response {
	api.removedLabels.push(decodeURIComponent(match[1] ?? ""))
	return Response.json([])
}

function listChecks({ api }: Call, match: RegExpExecArray): Response {
	const checks = Object.entries(api.checks.get(match[1] ?? "") ?? {})
	return Response.json({ check_runs: checks.map(([name, conclusion]) => ({ name, conclusion })) })
}

function listStatuses({ api }: Call, match: RegExpExecArray): Response {
	return Response.json(api.statuses.get(match[1] ?? "") ?? [])
}

// keep the newest status of each context, as github's combined status does
function readCombinedStatus({ api }: Call, match: RegExpExecArray): Response {
	const newestFirst = api.statuses.get(match[1] ?? "") ?? []
	const statuses = newestFirst.filter(
		(status, index) => newestFirst.findIndex((item) => item.context === status.context) === index,
	)
	return Response.json({ statuses })
}

// list the open pull requests whose head is the commit
function listCommitPullRequests({ pulls }: Call, match: RegExpExecArray): Response {
	const commit = match[1] ?? ""
	const numbers = Object.keys(pulls).filter((number) => toHeadCommit(Number(number)) === commit)
	const head = { sha: commit, repo: { full_name: fakeRepository } }
	return Response.json(numbers.map((number) => ({ number: Number(number), state: "open", head })))
}

// answer read for an account the test gave no permission
function readPermission({ api }: Call, match: RegExpExecArray): Response {
	return Response.json({ permission: api.permissions.get(decodeURIComponent(match[1] ?? "")) ?? "read" })
}

function listComments({ api }: Call, match: RegExpExecArray): Response {
	return Response.json(api.comments.get(Number(match[1])) ?? [])
}

// find the open pull request of a patch branch
function listPatchPullRequests({ api, search }: Call): Response {
	const branch = (search.get("head") ?? "").split(":")[1] ?? ""
	const number = api.patchPullRequests.get(branch)
	return Response.json(number ? [{ number, html_url: `https://github.com/${fakeRepository}/pull/${number}` }] : [])
}

/**
 * Writes an event's payload to a temporary file, runs the work with the runner's event variables and removes the file.
 */
export async function withWorkflowEvent<Value>(
	event: { name: string; payload: unknown },
	work: (environment: Record<string, string>) => Promise<Value>,
): Promise<Value> {
	const folder = await mkdtemp(join(tmpdir(), "health-code-event-"))
	try {
		const eventPath = join(folder, "event.json")
		await writeFile(eventPath, JSON.stringify(event.payload))
		return await work({
			GITHUB_EVENT_NAME: event.name,
			GITHUB_EVENT_PATH: eventPath,
			GITHUB_REPOSITORY: fakeRepository,
		})
	} finally {
		await rm(folder, { recursive: true, force: true })
	}
}
