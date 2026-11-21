import { gt, lte, valid } from "semver"
import { z } from "zod"
import type { Upgrade } from "./contracts.ts"

export type ReleaseNote = { source: string; text: string; workspaces: string[] }
type Options = {
	upgrade: Upgrade
	githubToken?: string
	changelog: string
	signal?: AbortSignal
	request?: typeof fetch
}
// validate release metadata before using its tag or body
const release = z.object({
	tag_name: z.string(),
	body: z.string().nullable(),
	draft: z.boolean(),
	prerelease: z.boolean(),
})
/** Reads bounded release evidence for the exact versions each workspace crosses. */
export async function readReleases({
	upgrade,
	githubToken,
	changelog,
	signal: callerSignal,
	request = fetch,
}: Options): Promise<{ notes: ReleaseNote[]; gaps: string[] }> {
	// share the release lookup deadline with caller cancellation
	const timeout = AbortSignal.timeout(15000)
	const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout
	const notes: ReleaseNote[] = []
	const gaps: string[] = []
	const registry = `https://registry.npmjs.org/${encodeURIComponent(upgrade.dependency)}/${encodeURIComponent(upgrade.to)}`
	try {
		// fetch the package metadata without following redirects
		const response = await request(registry, { signal, redirect: "error" })
		if (!response.ok) {
			await response.body?.cancel()
			throw new Error()
		}
		const info = (await readReleaseJson(response)) as { repository?: string | { url?: string } }
		// extract the published github repository identity
		const address = (typeof info.repository === "string" ? info.repository : info.repository?.url) ?? ""
		const parsed =
			/^(?:git\+https?:\/\/github\.com\/|https?:\/\/github\.com\/|git\+ssh:\/\/git@github\.com\/|git:\/\/github\.com\/|github:)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(
				address,
			)
		if (!parsed || parsed.slice(1).includes("..")) {
			throw new Error()
		}
		// page through a bounded number of releases
		const repository = `${parsed[1]}/${parsed[2]}`
		let cursor: string | null = null
		for (let page = 1; page <= 4; page++) {
			const batch = await readReleasePage({ repository, githubToken, signal, request, page, cursor })
			if ("gap" in batch) {
				gaps.push(batch.gap)
				break
			}
			// keep only notes for versions between the pinned and target releases
			notes.push(...toReleaseNotes({ releases: batch.releases, repository, upgrade }))
			if (!batch.next) {
				break
			}
			cursor = batch.next
			// record when the page limit leaves release coverage incomplete
			if (page === 4) {
				gaps.push("Release page limit reached")
			}
		}
	} catch {
		gaps.push("Package repository or release metadata unavailable")
	}
	// supplement github evidence with versioned changelog sections
	notes.push(...toChangelogNotes({ changelog, upgrade, registry }))
	if (!notes.length) {
		gaps.push("No matching release notes")
	}
	return { notes: notes.slice(0, 40), gaps }
}
// request visibility alongside release notes in the same authenticated query
const releaseQuery = `query PublicReleasePage($owner:String!,$name:String!,$after:String) {
 repository(owner:$owner,name:$name) {
   visibility releases(first:50,after:$after,orderBy:{field:CREATED_AT,direction:DESC}) {
     pageInfo { hasNextPage endCursor }
     nodes { tag_name:tagName body:description draft:isDraft prerelease:isPrerelease }
   }
 }
}`

async function readReleasePage(options: {
	repository: string
	githubToken?: string
	signal?: AbortSignal
	request: typeof fetch
	page: number
	cursor: string | null
}): Promise<{ releases: z.infer<typeof release>[]; next: string | null } | { gap: string }> {
	// choose the authenticated or public release endpoint
	const { repository, githubToken, signal, request, page, cursor } = options
	const [owner, name] = repository.split("/")
	const response = githubToken
		? await request("https://api.github.com/graphql", {
				method: "POST",
				signal,
				redirect: "error",
				headers: { authorization: `Bearer ${githubToken}`, "content-type": "application/json" },
				body: JSON.stringify({ query: releaseQuery, variables: { owner, name, after: cursor } }),
			})
		: await request(`https://api.github.com/repos/${repository}/releases?per_page=50&page=${page}`, {
				signal,
				redirect: "error",
				headers: { accept: "application/vnd.github+json" },
			})
	// retain a coverage gap when the release service rejects the request
	if (!response.ok) {
		await response.body?.cancel()
		return { gap: `GitHub releases unavailable (${response.status})` }
	}
	const json = await readReleaseJson(response)
	if (!githubToken) {
		// parse public releases and advance full pages
		const releases = z.array(release).parse(json)
		return { releases, next: releases.length === 50 ? String(page + 1) : null }
	}
	// Check the visibility returned with each page before accepting any credentialed release evidence.
	// require public visibility in the authenticated response
	const { data } = z
		.object({
			data: z.object({
				repository: z.object({
					visibility: z.literal("PUBLIC"),
					releases: z.object({
						nodes: z.array(release),
						pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
					}),
				}),
			}),
		})
		.parse(json)
	const { nodes, pageInfo } = data.repository.releases
	return { releases: nodes, next: pageInfo.hasNextPage ? pageInfo.endCursor : null }
}
function toReleaseNotes({
	releases,
	repository,
	upgrade,
}: {
	releases: z.infer<typeof release>[]
	repository: string
	upgrade: Upgrade
}): ReleaseNote[] {
	// normalize release tags before comparing versions
	const notes: ReleaseNote[] = []
	for (const entry of releases) {
		const tag = entry.tag_name
		const raw = tag.startsWith(`${upgrade.dependency}@`)
			? tag.slice(upgrade.dependency.length + 1)
			: tag.replace(/^v/, "")
		const version = valid(raw)
		// skip drafts, prereleases and releases newer than the target
		if (!version || entry.draft || entry.prerelease || !lte(version, upgrade.to)) {
			continue
		}
		const workspaces = toAffectedWorkspaces(upgrade, version)
		// retain source links and workspaces alongside bounded notes
		if (workspaces.length && entry.body) {
			notes.push({
				source: `https://github.com/${repository}/releases/tag/${encodeURIComponent(tag)}`,
				text: entry.body.slice(0, 4000),
				workspaces,
			})
		}
	}
	return notes
}
// select workspaces whose pinned version precedes the release
function toAffectedWorkspaces(upgrade: Upgrade, version: string): string[] {
	return Object.entries(upgrade.from)
		.filter(([, from]) => gt(version, from))
		.map(([path]) => path)
}
function toChangelogNotes({
	changelog,
	upgrade,
	registry,
}: {
	changelog: string
	upgrade: Upgrade
	registry: string
}): ReleaseNote[] {
	const notes: ReleaseNote[] = []
	// split the changelog at version or unreleased headings
	const sections = changelog.split(/(?=^#{1,4}[ \t]+\[?(?:v?\d+\.\d+\.\d+|unreleased\b))/im)
	for (const section of sections) {
		const heading = /^#{1,4}[ \t]+\[?v?(\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?)(?=[\]\s(]|$)/.exec(section)
		const version = valid(heading?.[1])
		// require a versioned section within the upgrade range
		if (!version || !lte(version, upgrade.to)) {
			continue
		}
		const workspaces = toAffectedWorkspaces(upgrade, version)
		// retain changelog text only for affected workspaces
		if (workspaces.length) {
			notes.push({ source: registry, text: section.slice(0, 4000), workspaces })
		}
	}
	return notes
}
// read release metadata within a fixed byte limit
async function readReleaseJson(response: Response): Promise<unknown> {
	const reader = response.body?.getReader()
	if (!reader) {
		throw new Error("Empty release response")
	}
	const chunks: Uint8Array[] = []
	let bytes = 0
	try {
		// stream the response while tracking its cumulative size
		for (;;) {
			const { value, done } = await reader.read()
			if (done) {
				break
			}
			bytes += value.byteLength
			// cancel oversized responses before decoding the json
			if (bytes > 4 * 1024 * 1024) {
				await reader.cancel()
				throw new Error("Release metadata exceeds the size limit")
			}
			// accumulate only chunks within the response budget
			chunks.push(value)
		}
	} finally {
		reader.releaseLock()
	}
	// parse the completed response after releasing the reader
	return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}
