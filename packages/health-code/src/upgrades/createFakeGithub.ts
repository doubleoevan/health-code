import { createHash } from "node:crypto"

type FileContent = string | Uint8Array

// one public repository as github's api would serve it at a single commit
export type FakeRepository = {
	files: ReadonlyMap<string, FileContent>
	commit?: string

	// the paths git records as symbolic links and as submodules
	links?: readonly string[]
	submodules?: readonly string[]
	isPrivate?: boolean
	isTruncated?: boolean
	redirectsTo?: string
}

type Intercept = (url: URL, init: RequestInit) => Response | Promise<Response> | undefined

type FakeGithubOptions = {
	repositories: Record<string, FakeRepository>

	// the releases every package has, and a function that can answer a registry lookup in their place
	versions?: Record<string, unknown>
	registry?: (name: string, accept: string) => Response | Promise<Response> | undefined
	remainingRequests?: number
	validToken?: string
	intercept?: Intercept
}

export type FakeGithub = {
	request: typeof fetch
	githubRequests: string[]
	registryRequests: string[]
	unexpectedRequests: string[]
	authorizations: (string | null)[]
}

type RateLimitHeaders = Record<string, string>
type BlobRequest = { repository: FakeRepository; route: string; headers: RateLimitHeaders }

export const fakeCommit = "c".repeat(40)

/**
 * Serves recorded projects in the shapes of GitHub's commit, repository, tree and blob responses.
 */
export function createFakeGithub(options: FakeGithubOptions): FakeGithub {
	const github: FakeGithub = {
		request: fetch,
		githubRequests: [],
		registryRequests: [],
		unexpectedRequests: [],
		authorizations: [],
	}
	let remainingRequestCount = options.remainingRequests ?? 5000
	github.request = (async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
		const url = new URL(String(input))
		const headers = new Headers(init.headers)
		if (url.origin === "https://registry.npmjs.org") {
			return answerRegistry({ github, options, url, headers, init })
		}

		// reject a request to any other origin
		if (url.origin !== "https://api.github.com") {
			github.unexpectedRequests.push(url.href)
			throw new Error(`unexpected request to ${url.origin}`)
		}

		// record the request and reject a token the fake was not given
		github.githubRequests.push(url.pathname)
		github.authorizations.push(headers.get("authorization"))
		if (options.validToken !== undefined && headers.get("authorization") !== `Bearer ${options.validToken}`) {
			return new Response(null, { status: 401 })
		}

		// spend one request of the hourly rate limit
		const rateLimitHeaders = {
			"x-ratelimit-remaining": String(Math.max(0, --remainingRequestCount)),
			"x-ratelimit-reset": "1795731326",
		}
		if (remainingRequestCount < 0) {
			return new Response(null, { status: 403, headers: rateLimitHeaders })
		}

		// let a test take over before the default answer
		const accept = headers.get("accept") ?? ""
		return (
			options.intercept?.(url, init) ??
			answerRepository({ url, accept, repositories: options.repositories, rateLimitHeaders })
		)
	}) as typeof fetch
	return github
}

// answer registry lookups and flag one that includes a token
function answerRegistry({
	github,
	options,
	url,
	headers,
	init,
}: {
	github: FakeGithub
	options: FakeGithubOptions
	url: URL
	headers: Headers
	init: RequestInit
}): Response | Promise<Response> {
	// record the lookup and flag a token that reached the registry
	github.registryRequests.push(url.pathname)
	if (headers.has("authorization")) {
		github.unexpectedRequests.push(`token sent to ${url.href}`)
	}

	// let a test take over before the default answer
	const name = decodeURIComponent(url.pathname.slice(1))
	const accept = headers.get("accept") ?? ""
	const answer = options.intercept?.(url, init) ?? options.registry?.(name, accept)
	if (answer) {
		return answer
	}

	// answer every package with the supplied releases, dated before any release age
	return options.versions
		? Response.json({ versions: options.versions, modified: "2020-01-01T00:00:00Z" })
		: new Response(null, { status: 404 })
}

function answerRepository({
	url,
	accept,
	repositories,
	rateLimitHeaders,
}: {
	url: URL
	accept: string
	repositories: Record<string, FakeRepository>
	rateLimitHeaders: RateLimitHeaders
}): Response {
	// match the repository by its name or by the id a rename redirects to
	const [, kind, owner, name, ...rest] = url.pathname.split("/")
	const key = kind === "repositories" ? owner : `${owner}/${name}`
	const route = (kind === "repositories" ? [name, ...rest] : rest).join("/")
	const repository = repositories[key ?? ""]
	if (!repository) {
		return Response.json({ message: "Not Found" }, { status: 404, headers: rateLimitHeaders })
	}

	// send a renamed repository to its new address
	if (repository.redirectsTo) {
		const location = `${repository.redirectsTo}/${route}${url.search}`
		return new Response(null, { status: 301, headers: { ...rateLimitHeaders, location } })
	}

	return answerRoute({ repository, route, accept, search: url.searchParams, rateLimitHeaders })
}

// serve the repository record, the head commit, the tree and each blob
function answerRoute({
	repository,
	route,
	accept,
	search,
	rateLimitHeaders: headers,
}: {
	repository: FakeRepository
	route: string
	accept: string
	search: URLSearchParams
	rateLimitHeaders: RateLimitHeaders
}): Response {
	// report the visibility a token would see
	const commit = repository.commit ?? fakeCommit
	if (route === "") {
		const isPrivate = repository.isPrivate ?? false
		return Response.json({ private: isPrivate, visibility: isPrivate ? "private" : "public" }, { headers })
	}
	if (route === "commits/HEAD" && accept === "application/vnd.github.sha") {
		return new Response(commit, { headers })
	}

	// list the tree only for the commit this repository holds
	if (route === `git/trees/${commit}` && search.get("recursive") === "1") {
		const tree = { sha: commit, truncated: repository.isTruncated ?? false, tree: toTree(repository) }
		return Response.json(tree, { headers })
	}

	// answer any other commit as github answers an unknown object
	if (route.startsWith("git/trees/")) {
		return Response.json({ message: "Invalid object requested." }, { status: 422, headers })
	}
	return answerBlob({ repository, route, headers })
}

function answerBlob({ repository, route, headers }: BlobRequest): Response {
	const content = [...repository.files.values()].find((file) => route === `git/blobs/${toBlobId(file)}`)
	return content === undefined
		? Response.json({ message: "Not Found" }, { status: 404, headers })
		: new Response(content as ConstructorParameters<typeof Response>[0], { headers })
}

// list files, symbolic links and submodules with the modes git records for them
function toTree(repository: FakeRepository): object[] {
	const entries: object[] = []
	for (const [path, content] of repository.files) {
		const isSymbolicLink = repository.links?.includes(path) ?? false
		const size = typeof content === "string" ? Buffer.byteLength(content) : content.byteLength
		entries.push({ path, mode: isSymbolicLink ? "120000" : "100644", type: "blob", sha: toBlobId(content), size })
	}

	// list a submodule as a commit entry with no content
	for (const path of repository.submodules ?? []) {
		entries.push({ path, mode: "160000", type: "commit", sha: "d".repeat(40) })
	}
	return entries
}

function toBlobId(content: FileContent): string {
	return createHash("sha1").update(content).digest("hex")
}
