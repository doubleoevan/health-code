import { InspectionError } from "../contracts.ts"
import { toUtcTime } from "./toUtcTime.ts"

const apiOrigin = "https://api.github.com"
const apiVersion = "2022-11-28"
const requestTimeoutMs = 10000
const maxRedirects = 4
const defaultRetryMs = 60000

// one caller's requests to a public repository, with the rate limit GitHub last reported
export type GithubSession = {
	repository: string
	githubToken?: string
	request: typeof fetch
	signal: AbortSignal

	// the requests sent so far, the requests left and the time the rate limit resets
	requestCount: number
	remainingRequestCount?: number
	resetAt?: number
}

type ResponseErrorOptions = { session: GithubSession; response: Response; remainingRequestCount: number | undefined }

/**
 * Sends one bounded request to GitHub's API and follows redirects that stay on its origin.
 */
export async function requestGithubApi(
	session: GithubSession,
	{ path, accept }: { path: string; accept: string },
): Promise<Response> {
	let url = `${apiOrigin}${path}`
	for (let hop = 0; hop <= maxRedirects; hop++) {
		// return every answer that is not a redirect
		const response = await sendRequest(session, { url, accept })
		const location = response.headers.get("location")
		if (![301, 302, 307, 308].includes(response.status) || !location) {
			return checkResponse(session, response)
		}

		// follow a renamed repository only within the api origin
		await response.body?.cancel()
		const target = new URL(location, url)
		if (target.origin !== apiOrigin || target.username || target.password) {
			break
		}
		url = target.href
	}

	// reject a redirect chain that leaves the origin or never settles
	throw new InspectionError("github-unavailable", "GitHub redirected the request somewhere unexpected. Try again.")
}

/**
 * Builds the error for a used-up rate limit, with the time it lifts.
 */
export function toRateLimitError(session: GithubSession, retryAt = Date.now() + defaultRetryMs): InspectionError {
	const retryTimestamp = new Date(retryAt).toISOString()
	const time = toUtcTime(retryTimestamp)
	const error = new InspectionError(
		"github-rate-limit",
		session.githubToken
			? `GitHub's limit for this token is used up until ${time}. Try again then.`
			: `GitHub's limit for requests without a token is used up until ${time}. Supply a GitHub token or try again then.`,
	)
	error.retryAt = retryTimestamp
	return error
}

/**
 * Tells a caller's cancellation apart from a passed deadline.
 */
export function toAbortError(signal: AbortSignal): InspectionError {
	const isDeadline = signal.reason instanceof DOMException && signal.reason.name === "TimeoutError"
	return isDeadline
		? new InspectionError("deadline", "Reading the repository from GitHub took too long. Try again.")
		: toCancelledError()
}

/**
 * Throws the cancelled error once the caller's signal is aborted.
 */
export function throwIfCancelled(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw toCancelledError()
	}
}

function toCancelledError(): InspectionError {
	return new InspectionError("cancelled", "The request was stopped.")
}

async function sendRequest(
	session: GithubSession,
	{ url, accept }: { url: string; accept: string },
): Promise<Response> {
	// send the token to the api origin only
	const headers: Record<string, string> = { accept, "x-github-api-version": apiVersion, "user-agent": "health-code" }
	if (session.githubToken) {
		headers.authorization = `Bearer ${session.githubToken}`
	}
	const timeout = AbortSignal.timeout(requestTimeoutMs)
	session.requestCount++
	try {
		return await session.request(url, {
			headers,
			redirect: "manual",
			signal: AbortSignal.any([session.signal, timeout]),
		})
	} catch {
		// keep a cancellation or a passed deadline apart from an unreachable api
		if (session.signal.aborted) {
			throw toAbortError(session.signal)
		}
		throw new InspectionError("github-unavailable", "GitHub did not answer. Try again in a minute.")
	}
}

async function checkResponse(session: GithubSession, response: Response): Promise<Response> {
	// remember the rate limit that the last response reported
	const remainingRequestCount = readHeaderNumber(response, "x-ratelimit-remaining")
	const resetSeconds = readHeaderNumber(response, "x-ratelimit-reset")
	session.remainingRequestCount = remainingRequestCount ?? session.remainingRequestCount
	session.resetAt = resetSeconds === undefined ? session.resetAt : resetSeconds * 1000

	// let the caller interpret a found, a missing and an invalid object
	if (response.ok || response.status === 404 || response.status === 422) {
		return response
	}
	await response.body?.cancel()
	throw toResponseError({ session, response, remainingRequestCount })
}

function readHeaderNumber(response: Response, name: string): number | undefined {
	const header = response.headers.get(name)
	return header !== null && Number.isFinite(Number(header)) ? Number(header) : undefined
}

function toResponseError({ session, response, remainingRequestCount }: ResponseErrorOptions): InspectionError {
	if (response.status === 401) {
		return new InspectionError(
			"github-token-rejected",
			"GitHub rejected the token. Check that it is valid and try again.",
		)
	}

	// detect a rate limit by no requests left or a wait in seconds
	const retryAfter = readHeaderNumber(response, "retry-after")
	const hasLimitHeader = remainingRequestCount === 0 || retryAfter !== undefined
	const isLimited = response.status === 429 || (response.status === 403 && hasLimitHeader)
	if (isLimited) {
		return toRateLimitError(session, retryAfter === undefined ? session.resetAt : Date.now() + retryAfter * 1000)
	}

	// report a blocked repository apart from a failing api
	if (response.status === 403 || response.status === 451) {
		return new InspectionError(
			"repository-unavailable",
			"GitHub does not serve this repository. Check that it is public and try again.",
		)
	}
	return new InspectionError("github-unavailable", `GitHub answered ${response.status}. Try again in a minute.`)
}
