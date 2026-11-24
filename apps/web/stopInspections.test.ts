import { expect, test } from "bun:test"
import { createSite } from "./createSite.tsx"
import { Inspections } from "./executeInspection.ts"
import { origin, replay } from "./fixtures/createTestSite.ts"
import { toLaunchLimits } from "./launchLimits.ts"
import { replayRepositoryUrl as repository } from "./report.ts"
import { InspectionStore } from "./storeInspections.ts"

test("a running inspection stops through its signal and a queued one leaves the queue", async () => {
	// hold the running inspection until its signal aborts
	const store = new InspectionStore(":memory:")
	const inspections = new Inspections(
		store,
		{
			...replay,
			inspect: async (_url, _emit, options) => {
				const aborted = Promise.withResolvers<never>()
				options?.signal?.addEventListener("abort", () => aborted.reject(new Error("aborted")))
				return aborted.promise
			},
		},
		1,
	)
	await inspections.start()
	const running = inspections.submit(repository)
	const queued = inspections.submit(repository)
	await Bun.sleep(10)

	// require a request from the site itself
	const app = createSite({ inspections, origin, replay: true, assets: { script: "", styles: [] } })
	const stop = (id: string, from = origin): Response | Promise<Response> =>
		app.request(`/api/inspections/${id}/stop`, { method: "POST", headers: { origin: from } })
	expect((await stop(running, "https://other.example")).status).toBe(403)
	expect((await stop("missing")).status).toBe(404)
	expect(await (await app.request(`/r/${running}`)).text()).toContain("Stop inspection")

	// stop the waiting inspection before the running one frees its slot
	expect((await stop(queued)).status).toBe(202)
	expect(store.state(queued)).toBe("stopped")
	expect((await stop(running)).status).toBe(202)
	await Bun.sleep(10)
	expect(store.state(running)).toBe("stopped")
	expect((await stop(running)).status).toBe(409)

	// explain the stop on the saved page
	const page = await (await app.request(`/r/${running}`)).text()
	expect(page).toContain("<h1>Inspection stopped</h1>")
	expect(page).not.toContain("Stop this inspection")
	inspections.stop()
	store.database.close()
})

test("only the starting visitor can stop a hosted inspection that nobody joined", () => {
	const store = new InspectionStore(":memory:")
	const inspections = new Inspections(store, replay)
	const admit = (key: string, visitor: string): string =>
		store.admission.admit({
			key,
			head: { repositoryId: "1", sizeKiB: 1, revision: "a".repeat(40) },
			now: Date.now(),
			limits: toLaunchLimits({ HEALTH_CODE_DAILY_COST_USD: "100" }),
			identity: { visitor, network: visitor },
			enqueue: () => store.enqueue(repository),
		}).id
	const id = admit("head", "starter")
	expect(inspections.stops.canStop(id, "starter")).toBe(true)
	expect(inspections.stops.canStop(id, "other")).toBe(false)

	// keep the inspection running once another visitor joins it
	expect(admit("head", "other")).toBe(id)
	expect(inspections.stops.canStop(id, "starter")).toBe(false)

	// release the reservation of a stopped queue entry and admit fresh work
	const stopped = admit("second", "starter")
	inspections.stopInspection(stopped)
	expect(store.admission.liability(new Date().toISOString().slice(0, 10))).toBe(5_000_000)
	expect(admit("second", "other")).not.toBe(stopped)
	store.database.close()
})
