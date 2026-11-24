import { expect, test } from "bun:test"
import { createTestSite, replay } from "./fixtures/createTestSite.ts"
import { publishReport } from "./publishReport.ts"
import { replayRepositoryUrl as repositoryUrl } from "./report.ts"
import { InspectionStore } from "./storeInspections.ts"

test("browse an inspected upgrade menu, choose one release and reopen its licensed patch", async () => {
	const store = new InspectionStore(":memory:")
	const app = createTestSite(store)
	const submit = (body: Record<string, unknown>): Promise<Response> =>
		Promise.resolve(
			app.request("/api/inspections", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ repositoryUrl, ...body }),
			}),
		)
	try {
		// Publish the upgrade menu fixture through the durable submission path.
		const upgradeMenu = await (await submit({ action: "discover" })).json()
		expect(await (await app.request(`/r/${upgradeMenu.id}`)).text()).toContain(
			'<h1 class="shimmer">Finding upgrades...</h1>',
		)
		expect(store.choice(upgradeMenu.id)).toEqual({ mode: "listUpgrades" })
		const menuReport = await replay.inspect(repositoryUrl, () => {}, { mode: "listUpgrades" })
		store.finish(upgradeMenu.id, publishReport(menuReport, "MIT"))
		const html = await (await app.request(`/r/${upgradeMenu.id}`)).text()
		for (const label of ["Test an upgrade", "Search dependencies", "Most workspaces first", "Test upgrade"]) {
			expect(html).toContain(label)
		}

		// Ignore the patch filter until a tested patch exists.
		const unfiltered = await (await app.request(`/r/${upgradeMenu.id}?ready=on`)).text()
		expect(unfiltered).not.toContain("Tested patch available")
		expect(unfiltered).toContain("Test upgrade")

		// Read release features for the selected version before starting its tests.
		const path = `/api/inspections/${upgradeMenu.id}/features?dependency=widget&to=`
		const preview = await app.request(path + "1.3.0")
		expect((await preview.json()).features[0].text).toBe("Widget now provides shared configuration defaults.")
		expect((await app.request(path + "9.9.9")).status).toBe(404)

		// Reject invented versions and forward the chosen target with its workspace pins.
		const choice = { action: "select", upgradeMenuId: upgradeMenu.id, dependency: "widget", to: "1.3.0" }
		expect((await submit({ ...choice, to: "9.9.9" })).status).toBe(400)
		const result = await (await submit({ ...choice, repositoryUrl: repositoryUrl + ".git/" })).json()
		const selectedPage = await (await app.request(`/r/${result.id}`)).text()
		expect(selectedPage).toContain('<h1 class="shimmer">Testing widget upgrade...</h1>')
		expect(selectedPage).toContain(" · widget 1.2.0 → 1.3.0")
		expect(store.choice(result.id)?.upgrade).toEqual({ dependency: "widget", to: "1.3.0", from: { ".": "1.2.0" } })
		expect(store.choice(result.id)?.revision).toBe(menuReport.report.repository.commit)

		// Reopen the verified patch without queuing a second test.
		const checked = await replay.inspect(repositoryUrl, () => {}, store.choice(result.id))
		store.finish(result.id, publishReport(checked, "MIT"))

		// A later report that withholds downloads must preserve the published patch reference.
		const other = store.enqueue(repositoryUrl, store.choice(result.id))
		store.finish(other, publishReport(checked, null))

		// Follow the original result on the next selection.
		const ready = await submit(choice)
		expect(ready.status).toBe(200)
		expect(await ready.json()).toEqual({ id: result.id })

		// show the patch link and its filter on the refreshed menu
		const refreshed = await (await app.request(`/r/${upgradeMenu.id}`)).text()
		expect(refreshed).toContain("View tested patch")
		expect(refreshed).toContain("Tested patch available")
	} finally {
		store.database.close()
	}
})

test("dependency pages sort and filter the whole upgrade menu before loading visible feature lists", async () => {
	const store = new InspectionStore(":memory:")
	try {
		const id = store.enqueue(repositoryUrl, { mode: "listUpgrades" })
		const menuReport = await replay.inspect(repositoryUrl, () => {}, { mode: "listUpgrades" })
		const example = menuReport.report.selection.eligible[0]!
		menuReport.report.selection.eligible = ["echo", "alpha", "delta", "charlie", "bravo", "foxtrot"].map(
			(dependency) => ({
				...example,
				dependency,
			}),
		)
		store.finish(id, publishReport(menuReport, "MIT"))

		// Check both the rendered choices and the hydrated upgrade menu.
		const app = createTestSite(store)
		const page = async (query: string): Promise<string> => (await app.request(`/r/${id}?${query}`)).text()
		const first = await page("order=alphabetical")
		expect(first).toContain("Dependencies 1–5 of 6")
		expect(first).toContain("<h2>alpha</h2>")
		expect(first).not.toContain("foxtrot")

		// Out-of-range pages stay within the filtered result set.
		const last = await page("order=alphabetical&page=2")
		expect(last).toContain("<h2>foxtrot</h2>")
		expect(last).toContain("Dependencies 6–6 of 6")
		expect(last).not.toContain("<h2>alpha</h2>")

		// Clamp the requested page after applying the search.
		expect(await page("search=bravo&page=9")).toContain("<h2>bravo</h2>")
	} finally {
		store.database.close()
	}
})

test("saved upgrade menus and queued jobs retain their meaning across the field rename", async () => {
	const store = new InspectionStore(":memory:")
	try {
		const id = store.enqueue(repositoryUrl)
		store.database.query("INSERT INTO inspection_choices VALUES(?,?)").run(id, JSON.stringify({ discoveryOnly: true }))
		expect(store.requestedWork(id, null).mode).toBe("listUpgrades")

		// Publish the fixture before restoring its earlier storage shape.
		const output = await replay.inspect(repositoryUrl, () => {}, { mode: "listUpgrades" })
		const publication = publishReport(output, "MIT")
		store.finish(id, publication)

		// Reopen the previous on-disk field names through both routes used by the browser.
		const { upgradeMenu, ...report } = publication.card
		store.database
			.query("UPDATE inspections SET report=? WHERE id=?")
			.run(JSON.stringify({ ...report, menu: upgradeMenu }), id)

		// Exercise both the shared page and its feature endpoint.
		const app = createTestSite(store)
		expect(await (await app.request(`/r/${id}`)).text()).toContain("Test an upgrade")
		expect((await app.request(`/api/inspections/${id}/features?dependency=widget&to=1.3.0`)).status).toBe(200)
	} finally {
		store.database.close()
	}
})

test("an incomplete registry lookup explains why the upgrade menu is empty", async () => {
	const store = new InspectionStore(":memory:")
	try {
		const id = store.enqueue(repositoryUrl)
		const output = await replay.inspect(repositoryUrl, () => {}, { mode: "listUpgrades" })

		// Preserve the lookup failure on the published upgrade menu.
		output.report.selection.eligible = []
		const reason = "Couldn’t list available upgrades: registry lookup timed out after 60s."
		output.report.selection.registryLookupIssue = reason
		store.finish(id, publishReport(output, "MIT"))

		// Distinguish an incomplete lookup from a successful lookup with no upgrades.
		const html = await (await createTestSite(store).request(`/r/${id}`)).text()
		expect(html).toContain(reason)
		expect(html).not.toContain("No eligible upgrades were found.")
	} finally {
		store.database.close()
	}
})
