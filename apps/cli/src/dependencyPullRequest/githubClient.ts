import { UserError } from "../userError.ts"

const apiOrigin = "https://api.github.com"
const requestTimeoutMs = 20000
const maxResponseBytes = 4 * 1024 * 1024

// one answer from GitHub's API with its parsed JSON body
type GithubResponse = { status: number; body: unknown }

// the calls a workflow step makes to one repository with the workflow's token
export type GithubClient = {
	repository: string
	get(path: string): Promise<GithubResponse>
	send(method: "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<GithubResponse>
}

type GithubClientOptions = { repository: string; token?: string; request?: typeof fetch; signal?: AbortSignal }

/**
 * Creates a client that sends the workflow's token to GitHub's API origin only, for one repository.
 */
export function createGithubClient({ repository, token, request = fetch, signal }: GithubClientOptions): GithubClient {
	if (!/^[a-z0-9-]{1,39}\/[a-z0-9_.-]{1,100}$/i.test(repository)) {
		throw new UserError("GITHUB_REPOSITORY is not an owner and a repository name.")
	}
	const send = async (method: string, path: string, body?: unknown): Promise<GithubResponse> => {
		// build the address under the repository and keep redirects off
		const timeout = AbortSignal.timeout(requestTimeoutMs)
		const response = await request(`${apiOrigin}/repos/${repository}${path}`, {
			method,
			redirect: "manual",
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
			headers: toHeaders(token, body !== undefined),
			...(body !== undefined && { body: JSON.stringify(body) }),
		})

		// name a used-up request limit apart from a rejected token or a missing permission
		const isLimited = response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after")
		if (response.status === 429 || (response.status === 403 && isLimited)) {
			await response.body?.cancel()
			throw new UserError("GitHub's request limit for the workflow's token is used up. Run the job again in an hour.")
		}
		if (response.status === 401 || response.status === 403) {
			await response.body?.cancel()
			throw new UserError(
				`GitHub rejected the workflow's token with ${response.status}. Grant the permissions the CI guide lists for this workflow.`,
			)
		}
		return { status: response.status, body: await readJson(response) }
	}
	return { repository, get: (path) => send("GET", path), send }
}

function toHeaders(token: string | undefined, hasBody: boolean): Record<string, string> {
	return {
		accept: "application/vnd.github+json",
		"x-github-api-version": "2022-11-28",
		"user-agent": "health-code",
		...(token && { authorization: `Bearer ${token}` }),
		...(hasBody && { "content-type": "application/json" }),
	}
}

// read a bounded JSON body, or nothing when the answer has none
async function readJson(response: Response): Promise<unknown> {
	const text = await response.text()
	if (!text || text.length > maxResponseBytes) {
		return undefined
	}

	// treat a body that is not JSON as no body
	try {
		return JSON.parse(text)
	} catch {
		return undefined
	}
}

/**
 * Reads a property path from an untyped answer, or nothing when any step is missing.
 */
export function readProperty(value: unknown, ...keys: (string | number)[]): unknown {
	let current = value
	for (const key of keys) {
		// stop at anything that is not an object holding the key
		if (current === null || typeof current !== "object" || !Object.hasOwn(current, key)) {
			return undefined
		}
		current = (current as Record<string | number, unknown>)[key]
	}
	return current
}
