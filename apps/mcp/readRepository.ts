import { toRepositoryUrl } from "health-code"
import * as z from "zod"
import { UserError } from "./modelSettings.ts"

export const repositoryInput = z
	.string()
	.max(256)
	.optional()
	.describe(
		"A public GitHub repository as owner/repository. If the user names none, run git remote get-url origin in their current checkout and pass only its owner/repository. Never pass a credential.",
	)

const missingRepository =
	"Name a public GitHub repository. For the current checkout run git remote get-url origin and pass only its owner/repository as repositoryUrl."

/**
 * Returns the GitHub URL for shorthand, a URL or a Git remote address.
 */
export function readRepository(input: string | undefined): string {
	const address = input?.trim()
	if (!address) {
		throw new UserError(missingRepository)
	}

	// reduce every form to its owner and name without credentials
	const path = address
		.replace(/^(?:(?:https?|ssh|git):\/\/)?(?:[^/@]+@)?(?:www\.|ssh\.)?github\.com(?::\d+\/|[/:])/i, "")
		.replace(/\/$/, "")

	// show the accepted form when the address is unsupported
	try {
		return toRepositoryUrl(`https://github.com/${path}`)
	} catch {
		throw new UserError("That is not a GitHub repository. Pass owner/repository such as vercel/ai.")
	}
}

/**
 * Throws when GitHub shows no public repository at the URL.
 */
export async function requirePublicRepository(
	repositoryUrl: string,
	{
		githubToken,
		signal,
		request = fetch,
	}: { githubToken?: string | undefined; signal?: AbortSignal | undefined; request?: typeof fetch },
): Promise<void> {
	// leave an unreachable lookup to the public clone
	const timeout = AbortSignal.timeout(5000)
	const path = new URL(repositoryUrl).pathname
	const response = await request(`https://api.github.com/repos${path}`, {
		headers: {
			Accept: "application/vnd.github+json",
			...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
		},
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
	}).catch(() => undefined)

	// release an unread response and stop for a cancelled caller
	if (response && !response.ok) {
		await response.body?.cancel().catch(() => undefined)
	}
	signal?.throwIfAborted()

	// look again without a token that GitHub rejects
	if (response?.status === 401 && githubToken) {
		return requirePublicRepository(repositoryUrl, { signal, request })
	}

	// explain a missing or private repository before a sandbox starts
	const repository: { private?: boolean } = response?.ok ? await response.json().catch(() => ({})) : {}
	if (response?.status === 404) {
		throw new UserError(
			`GitHub shows no public repository at ${path.slice(1)}. Check the name. The health inspector can test it only if it is public.`,
		)
	}
	if (repository.private) {
		throw new UserError(`${path.slice(1)} is private. The health inspector tests public repositories only.`)
	}
}
