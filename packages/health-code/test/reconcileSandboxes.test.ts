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
	const abandoned = makeRuntime("hc-site-demo-" + orphan)
	const absent = makeRuntime("hc-site-demo-" + randomUUID())
	const sibling = makeRuntime("hc-site-demo-" + orphan + "-relay")
	const first = [
		sibling,
		makeRuntime("hc-site-demo-" + live + "-relay"),
		makeRuntime("hc-site-demo-" + orphan + "-relay-extra"),
		makeRuntime("health-code-" + orphan),
		makeRuntime("hc-site-demox-" + orphan),
		abandoned,
	]
	const second = [absent, makeRuntime("hc-site-demo-" + live), makeRuntime("hc-site-demo-bad")]
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
