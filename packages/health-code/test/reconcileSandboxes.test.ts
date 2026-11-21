import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { reconcileSandboxes } from "../src/index.ts"

test("recovery deletes only orphaned deployment allocations across all inventory pages", async () => {
	const live = randomUUID()
	const orphan = randomUUID()
	const deleted: string[] = []

	// mix orphaned, live and unrelated runtimes across two pages
	const makeRuntime = (name: string): { id: string; display_name: string } => ({ id: randomUUID(), display_name: name })
	const abandoned = makeRuntime(`hc-site-demo-${orphan}`)
	const absent = makeRuntime(`hc-site-demo-${randomUUID()}`)
	const sibling = makeRuntime(`hc-site-demo-${orphan}-relay`)
	const first = [
		sibling,
		makeRuntime(`hc-site-demo-${live}-relay`),
		makeRuntime(`hc-site-demo-${orphan}-relay-extra`),
		makeRuntime(`health-code-${orphan}`),
		makeRuntime(`hc-site-demox-${orphan}`),
		abandoned,
	]
	const second = [absent, makeRuntime(`hc-site-demo-${live}`), makeRuntime("hc-site-demo-bad")]

	// record each deletion and tolerate an already absent runtime
	const request = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
		const url = new URL(String(input))
		if (init?.method === "DELETE") {
			deleted.push(url.pathname.split("/").at(-1) ?? "")
			return new Response(null, { status: url.pathname.endsWith(absent.id) ? 404 : 204 })
		}

		// return a cursor until the final inventory page
		const more = !url.searchParams.has("after")
		return Response.json({
			data: more ? first : second,
			pagination: { has_more: more, next_cursor: more ? "next" : null },
		})
	}
	await reconcileSandboxes({
		deployment: "demo",
		token: "test",
		liveInspectionIds: new Set([live]),
		fetch: request as typeof fetch,
	})

	// verify that deletion stays inside the named deployment
	assert.deepEqual(deleted, [sibling.id, abandoned.id, absent.id])
	await assert.rejects(
		reconcileSandboxes({ deployment: "", token: "test", liveInspectionIds: new Set(), fetch: request as typeof fetch }),
	)
})

test("a failed deletion still allows cleanup of later orphans", async () => {
	const victims = [randomUUID(), randomUUID()]
	const removed: string[] = []
	const runtimes = victims.map((id) => ({ id, display_name: `hc-site-demo-${randomUUID()}` }))
	await assert.rejects(
		reconcileSandboxes({
			deployment: "demo",
			token: "fixture",
			liveInspectionIds: new Set(),
			fetch: async (input, init) => {
				// list both orphans before failing the first deletion
				if (init?.method !== "DELETE") {
					return Response.json({ data: runtimes, pagination: { has_more: false, next_cursor: null } })
				}
				const id = new URL(String(input)).pathname.split("/").at(-1) ?? ""
				removed.push(id)
				return new Response(null, { status: id === victims[0] ? 503 : 204 })
			},
		}),
	)
	assert.deepEqual(removed, victims)
})

test("scheduled cleanup preserves live, young and undated runtimes", async () => {
	const cutoff = Date.now() - 3600000
	const live = randomUUID()
	const old = new Date(cutoff - 1).toISOString()
	const recent = new Date(cutoff + 1).toISOString()

	// Include a live sibling and an allocation whose creation event never reached storage.
	const runtime = (
		inspection: string,
		created_at?: string,
	): { id: string; display_name: string; created_at?: string } => ({
		id: randomUUID(),
		display_name: `hc-site-demo-${inspection}`,
		created_at,
	})
	const orphan = runtime(randomUUID(), old)
	const data = [orphan, runtime(`${live}-relay`, old), runtime(randomUUID(), recent), runtime(randomUUID())]
	const removed: string[] = []
	const firstSeen = new Map<string, number>()
	await reconcileSandboxes({
		deployment: "demo",
		token: "fixture",
		liveInspectionIds: new Set([live]),
		createdBefore: cutoff,
		firstSeen,
		fetch: async (input, init) => {
			if (init?.method === "DELETE") {
				removed.push(new URL(String(input)).pathname.split("/").at(-1) ?? "")
				return new Response(null, { status: 204 })
			}
			return Response.json({ data, pagination: { has_more: false, next_cursor: null } })
		},
	})
	assert.deepEqual(removed, [orphan.id])
	assert.equal(firstSeen.size, 2)
})

test("successive sweeps reclaim an undated orphan after a full lifetime of observation", async () => {
	const runtime = { id: randomUUID(), display_name: "hc-site-demo-" + randomUUID() }
	const firstSeen = new Map<string, number>()
	let deleted = false
	const options = {
		deployment: "demo",
		token: "fixture",
		firstSeen,
		liveInspectionIds: new Set<string>(),
		fetch: async (_input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
			if (init?.method === "DELETE") {
				deleted = true
				return new Response(null, { status: 204 })
			}
			return Response.json({ data: [runtime], pagination: { next_cursor: null, has_more: false } })
		},
	}
	await reconcileSandboxes({ ...options, createdBefore: Date.now() - 3600000 })
	assert.equal(deleted, false)

	// Advance beyond the first independently observed lifetime.
	const observed = firstSeen.get(runtime.id)
	assert.ok(observed)
	await reconcileSandboxes({ ...options, createdBefore: observed + 1 })
	assert.equal(deleted, true)
	assert.equal(firstSeen.size, 0)
})
