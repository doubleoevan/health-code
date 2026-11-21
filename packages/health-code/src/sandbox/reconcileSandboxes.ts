import { z } from "zod"
import { InspectionError } from "../contracts.ts"

const runtimePage = z.object({
	data: z.array(z.object({ id: z.uuid(), display_name: z.string() })),
	pagination: z.object({ has_more: z.boolean(), next_cursor: z.string().nullable() }),
})

export function toSandboxPrefix(deployment: string): string {
	if (!/^[a-z0-9]{1,16}$/.test(deployment)) {
		throw new InspectionError("invalid-deployment", "Expected a stable alphanumeric deployment name")
	}
	return `hc-site-${deployment}-`
}

/** Reclaims abandoned allocations before the single deployment worker starts. */
export async function reconcileSandboxes(options: {
	deployment: string
	token: string
	liveInspectionIds: ReadonlySet<string>
	fetch?: typeof globalThis.fetch
}): Promise<void> {
	const prefix = toSandboxPrefix(options.deployment)
	const origin = "https://api.runta.com/v2/runtimes"
	const request = options.fetch ?? fetch
	const headers = { Authorization: `Bearer ${options.token}` }
	const url = new URL(origin)
	url.searchParams.set("limit", "100")
	const cursors = new Set<string>()
	const orphanIds = new Set<string>()

	// Finish inventory before deletions alter page boundaries.
	while (true) {
		const response = await request(url, { headers, redirect: "error", signal: AbortSignal.timeout(15000) })
		if (!response.ok) {
			await response.body?.cancel()
			throw new InspectionError("cleanup-inventory", "Unable to list deployment sandboxes")
		}
		const page = runtimePage.parse(await response.json())
		for (const id of orphanedRuntimeIds(page.data, prefix, options.liveInspectionIds)) {
			orphanIds.add(id)
		}
		if (!page.pagination.has_more) {
			break
		}
		const cursor = page.pagination.next_cursor
		if (!cursor || cursors.has(cursor)) {
			throw new InspectionError("cleanup-inventory", "Invalid inventory cursor")
		}
		cursors.add(cursor)
		url.searchParams.set("after", cursor)
	}

	await deleteOrphans({ orphanIds, request, headers, origin })
}

async function deleteOrphans({
	orphanIds,
	request,
	headers,
	origin,
}: {
	orphanIds: Set<string>
	request: typeof fetch
	headers: { Authorization: string }
	origin: string
}): Promise<void> {
	let incomplete = false
	for (const id of orphanIds) {
		try {
			const response = await request(`${origin}/${id}`, {
				method: "DELETE",
				headers,
				redirect: "error",
				signal: AbortSignal.timeout(15000),
			})
			await response.body?.cancel()
			if (!response.ok && response.status !== 404) {
				incomplete = true
			}
		} catch {
			incomplete = true
		}
	}
	if (incomplete) {
		throw new InspectionError("cleanup-failed", "Unable to delete every deployment sandbox")
	}
}

function* orphanedRuntimeIds(
	runtimes: z.infer<typeof runtimePage>["data"],
	prefix: string,
	liveInspectionIds: ReadonlySet<string>,
): Generator<string> {
	for (const runtime of runtimes) {
		const suffix = runtime.display_name.slice(prefix.length)
		if (
			runtime.display_name.startsWith(prefix) &&
			z.uuid().safeParse(suffix).success &&
			!liveInspectionIds.has(suffix)
		) {
			yield runtime.id
		}
	}
}
