import { z } from "zod"
import { InspectionError } from "../contracts.ts"

const runtimePage = z.object({
	data: z.array(z.object({ id: z.uuid(), display_name: z.string(), created_at: z.string().optional() })),
	pagination: z.object({ has_more: z.boolean(), next_cursor: z.string().nullable() }),
})

export function toSandboxPrefix(deployment: string): string {
	if (!/^[a-z0-9]{1,16}$/.test(deployment)) {
		throw new InspectionError("invalid-deployment", "Expected a stable alphanumeric deployment name")
	}
	return `hc-site-${deployment}-`
}

/**
 * Reclaims abandoned deployment sandboxes at startup and during scheduled cleanup.
 */
export async function reconcileSandboxes(options: {
	deployment: string
	token: string
	liveInspectionIds: ReadonlySet<string>
	createdBefore?: number
	firstSeen?: Map<string, number>
	fetch?: typeof globalThis.fetch
}): Promise<void> {
	// Age undated allocations against observations retained between scheduled sweeps.
	if (options.createdBefore !== undefined && !options.firstSeen) {
		throw new InspectionError("cleanup-inventory", "Scheduled cleanup requires a persistent firstSeen map")
	}

	// restrict runtime inventory to the selected deployment
	const prefix = toSandboxPrefix(options.deployment)
	const origin = "https://api.runta.com/v2/runtimes"
	const request = options.fetch ?? fetch
	const headers = { Authorization: `Bearer ${options.token}` }
	const url = new URL(origin)

	// request bounded pages and retain ids for deferred deletion
	url.searchParams.set("limit", "100")
	const cursors = new Set<string>()
	const orphanIds = new Set<string>()
	const observed = new Map<string, number>()

	// Finish inventory before deletions alter page boundaries.
	while (true) {
		const response = await request(url, { headers, redirect: "error", signal: AbortSignal.timeout(15000) })
		if (!response.ok) {
			await response.body?.cancel()
			throw new InspectionError("cleanup-inventory", "Unable to list deployment sandboxes")
		}

		// separate abandoned deployment runtimes from live inspections
		const page = runtimePage.parse(await response.json())
		for (const id of orphanedRuntimeIds(page.data, { prefix, observed, ...options })) {
			orphanIds.add(id)
		}
		if (!page.pagination.has_more) {
			break
		}

		// require a fresh cursor before requesting the next inventory page
		const cursor = page.pagination.next_cursor
		if (!cursor || cursors.has(cursor)) {
			throw new InspectionError("cleanup-inventory", "Invalid inventory cursor")
		}
		cursors.add(cursor)
		url.searchParams.set("after", cursor)
	}

	updateObservedTimes(options.firstSeen, observed)
	await deleteOrphans({ orphanIds, request, headers, origin })

	// Remove allocations only after deletion has been confirmed.
	for (const id of orphanIds) {
		options.firstSeen?.delete(id)
	}
}

function updateObservedTimes(firstSeen: Map<string, number> | undefined, observed: ReadonlyMap<string, number>): void {
	// Retain only live inventory entries for the next age check.
	if (firstSeen) {
		firstSeen.clear()
		for (const [id, time] of observed) {
			firstSeen.set(id, time)
		}
	}
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
	// attempt every orphan deletion before reporting incomplete cleanup
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

			// accept a missing runtime as already reclaimed
			if (!response.ok && response.status !== 404) {
				incomplete = true
			}
		} catch {
			incomplete = true
		}
	}

	// report any remaining cleanup failure after processing the inventory
	if (incomplete) {
		throw new InspectionError("cleanup-failed", "Unable to delete every deployment sandbox")
	}
}

function* orphanedRuntimeIds(
	runtimes: z.infer<typeof runtimePage>["data"],
	options: {
		prefix: string
		liveInspectionIds: ReadonlySet<string>
		createdBefore?: number
		firstSeen?: Map<string, number>
		observed: Map<string, number>
	},
): Generator<string> {
	for (const runtime of runtimes) {
		const suffix = runtime.display_name.slice(options.prefix.length).replace(/-relay$/, "")
		if (!runtime.display_name.startsWith(options.prefix) || !z.uuid().safeParse(suffix).success) {
			continue
		}

		// Use observation time as a conservative lower bound if inventory omits creation time.
		// Remember only unleased allocations that may need a later age check.
		if (options.liveInspectionIds.has(suffix)) {
			continue
		}

		// Use first observation when the provider omits creation time.
		const timestamp = Date.parse(runtime.created_at ?? "")
		const observed = Number.isFinite(timestamp) ? timestamp : (options.firstSeen?.get(runtime.id) ?? Date.now())
		options.observed.set(runtime.id, observed)

		// Leave younger unleased runtimes visible to the next sweep.
		if (options.createdBefore !== undefined && observed >= options.createdBefore) {
			continue
		}
		yield runtime.id
	}
}
