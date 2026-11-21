import { toRepositoryUrl } from "health-code"
import licenses from "spdx-license-list"
import { type InspectionSource, SiteError } from "./executeInspection.ts"
import { AdmissionError, type RepositoryHead } from "./recordAdmissions.ts"

export function createRepositoryLookup(
	token?: string,
	request: typeof fetch = fetch,
): Pick<InspectionSource, "verify" | "license" | "resolve"> {
	async function metadata(url: string): Promise<Response> {
		// Follow repository renames only within the authenticated GitHub API origin.
		const headers = { Accept: "application/vnd.github+json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }
		const signal = AbortSignal.timeout(10000)
		for (let hop = 0; hop < 4; hop++) {
			// Keep one timeout across the entire redirect chain.
			const response = await request(url, { headers, redirect: "manual", signal }).catch(() => null)
			if (!response) {
				throw new SiteError("GitHub could not verify the repository right now. Please try again.")
			}
			if (![301, 302, 307, 308].includes(response.status)) {
				return response
			}

			// Release the redirect body before following the next location.
			await response.body?.cancel()
			const next = toRedirect(url, response.headers.get("location"))
			if (!next) {
				break
			}

			// Retry with the verified same-origin location.
			url = next
		}
		throw new SiteError("GitHub could not verify the repository redirect.")
	}

	// derive metadata paths under the trusted github api origin
	const endpoint = (repositoryUrl: string): string => `https://api.github.com/repos${new URL(repositoryUrl).pathname}`
	return {
		async resolve(repositoryUrl): Promise<RepositoryHead> {
			const url = endpoint(repositoryUrl)

			// Check fresh repository visibility before cache lookup.
			const response = await metadata(url)
			if (!response.ok) {
				await response.body?.cancel()
				if (response.status === 404) {
					throw new SiteError(
						"GitHub couldn’t find a public repository at this URL. Check the address and make sure the repository is public.",
					)
				}
				throw new AdmissionError(503, "GitHub could not verify this repository right now. Please try again.")
			}

			// Require public metadata and a nonnegative GitHub size.
			const repo = await response.json()
			if (
				repo.private !== false ||
				repo.visibility !== "public" ||
				!Number.isSafeInteger(repo.size) ||
				// Validate the immutable repository identity and branch name.
				repo.size < 0 ||
				!Number.isSafeInteger(repo.id) ||
				!repo.default_branch
			) {
				throw new SiteError("A public repository with a known size is required.")
			}

			// Resolve the actual default branch before cache lookup, including on hits.
			const branch = await metadata(`${url}/git/ref/heads/${encodeURIComponent(repo.default_branch)}`)
			if (!branch.ok) {
				await branch.body?.cancel()
				throw new SiteError("GitHub could not verify the current commit.")
			}

			// Accept only the full commit hash returned by GitHub.
			const revision = (await branch.json()).object?.sha
			if (typeof revision !== "string" || !/^[a-f0-9]{40}$/.test(revision)) {
				throw new SiteError("GitHub returned an invalid revision.")
			}
			const canonicalUrl = repo.full_name ? toRepositoryUrl("https://github.com/" + repo.full_name) : repositoryUrl
			return { repositoryId: String(repo.id), sizeKiB: repo.size, revision, canonicalUrl }
		},
		async verify(repositoryUrl: string, admission?: { repositoryId: string; maxSizeKiB: number }): Promise<void> {
			// discard error response bodies before classifying lookup failures
			const response = await metadata(endpoint(repositoryUrl)).catch(() => null)
			if (response && !response.ok) {
				await response.body?.cancel()
			}
			if (response?.status === 404) {
				throw new SiteError(
					"GitHub couldn’t find a public repository at this URL. Check the address and make sure the repository is public.",
				)
			}

			// distinguish transient verification failures from a missing repository
			if (!response?.ok) {
				throw new SiteError("GitHub could not verify this repository right now. Please try again.")
			}

			// require an explicitly public repository before inspection
			const repository = await response.json()
			if (repository.private !== false || (repository.visibility !== undefined && repository.visibility !== "public")) {
				throw new SiteError("This repository must be public before Health Code can inspect it.")
			}

			// Recheck identity and current size before starting a previously queued checkout.
			if (
				admission &&
				(String(repository.id) !== admission.repositoryId ||
					!Number.isSafeInteger(repository.size) ||
					// Reject size metadata that cannot support a paid checkout.
					repository.size < 0 ||
					repository.size > admission.maxSizeKiB)
			) {
				throw new SiteError("The repository identity or size changed while queued. Submit the repository again.")
			}
		},
		async license(repository: { url: string; commit: string }): Promise<string | null> {
			// resolve the license at the inspected commit
			const url = new URL(`${endpoint(repository.url)}/license`)
			url.searchParams.set("ref", repository.commit)
			const response = await metadata(url.href)
			if (!response.ok) {
				await response.body?.cancel()
				return null
			}

			// accept only known licenses with osi approval
			const id: unknown = (await response.json()).license?.spdx_id
			if (typeof id !== "string" || !Object.hasOwn(licenses, id)) {
				return null
			}
			return licenses[id]?.osiApproved ? id : null
		},
	}
}

function toRedirect(base: string, location: string | null): string | undefined {
	if (!location) {
		return
	}
	const next = new URL(location, base)

	// Keep the optional GitHub credential within its approved HTTPS origin.
	if (next.origin === "https://api.github.com" && !next.username && !next.password) {
		return next.href
	}
}
