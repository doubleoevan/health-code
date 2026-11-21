import licenses from "spdx-license-list"
import { type InspectionSource, SiteError } from "./executeInspection.ts"

export function createRepositoryLookup(
	token?: string,
	request: typeof fetch = fetch,
): Pick<InspectionSource, "verify" | "license"> {
	async function metadata(url: string): Promise<Response> {
		return request(url, {
			headers: { Accept: "application/vnd.github+json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
			redirect: "error",
			signal: AbortSignal.timeout(10000),
		})
	}
	// derive metadata paths under the trusted github api origin
	const endpoint = (repositoryUrl: string): string => `https://api.github.com/repos${new URL(repositoryUrl).pathname}`
	return {
		async verify(repositoryUrl: string): Promise<void> {
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
