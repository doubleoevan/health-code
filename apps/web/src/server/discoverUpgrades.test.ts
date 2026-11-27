import { expect, test } from "bun:test"
import { InspectionError, type UpgradeMenu } from "health-code"
import { adminPage } from "./adminPage.tsx"
import { Inspections } from "./executeInspection.ts"
import {
	commit,
	countRows,
	createUpgradeMenuHarness as createHarness,
	createUpgradeMenu,
} from "./fixtures/createUpgradeMenuHarness.ts"
import type { InspectionSource } from "./inspectionSource.ts"
import { toLaunchLimits } from "./launchLimits.ts"
import { createReplaySource } from "./replayInspection.ts"
import { InspectionStore } from "./storeInspections.ts"

test("a fresh menu creates no admission, reservation or queue entry and leaves the allowance alone", async () => {
	const pending = Promise.withResolvers<UpgradeMenu>()
	const { store, inspections, discover, page, settle } = await createHarness({}, { upgradeMenu: () => pending.promise })
	const response = await discover("project")
	const { id } = await response.json()
	expect(response.status).toBe(202)
	expect(store.row(id)?.state).toBe("running")
	expect(store.position(id)).toBeNull()

	// check that the progress state has no sandbox panel, queue position or stop control
	const progress = await page(id)
	expect(progress).toContain('<h1 class="shimmer">Finding upgrades...</h1>')
	for (const absent of ["<h2>Runta sandbox</h2>", "Queue position", "Queued for inspection", "<button"]) {
		expect(progress).not.toContain(absent)
	}

	// check that the finished menu cost no admission and held no budget
	pending.resolve(createUpgradeMenu("https://github.com/example/project"))
	await settle(id)
	expect(await page(id)).toContain("Try upgrade")
	expect(countRows(store, "admissions")).toBe(0)
	expect(store.admission.liability(new Date().toISOString().slice(0, 10))).toBe(0)

	// check that selecting a target goes through paid admission at the menu's commit
	const selection = await discover("project", {
		action: "select",
		upgradeMenuId: id,
		dependency: "widget",
		to: "1.3.0",
	})
	expect(selection.status).toBe(202)
	expect(countRows(store, "admissions")).toBe(1)
	expect(store.checkout((await selection.json()).id)?.revision).toBe(commit)
	inspections.stop()
	store.database.close()
})

test("simultaneous submissions share one build and a complete menu is reused for an hour", async () => {
	const { store, upgradeMenuRequests, discover, settle } = await createHarness()
	const [first, second] = await Promise.all([discover("project"), discover("project")])
	const id = (await first.json()).id
	expect((await second.json()).id).toBe(id)
	expect([first.status, second.status].sort()).toEqual([200, 202])
	await settle(id)

	// check that a later request makes no build and counts as a reuse
	const later = await discover("project")
	expect(later.status).toBe(200)
	expect((await later.json()).id).toBe(id)
	expect(upgradeMenuRequests).toEqual(["https://github.com/example/project"])
	const html = adminPage(store.admission, null)
	expect(html).toContain("Fresh / reused upgrade menus")
	expect(html).toContain("<td>1 / 2</td>")

	// check that the same head builds again after the hour
	store.database.query("UPDATE inspections SET updated=datetime('now','-2 hours') WHERE id=?").run(id)
	const expired = await discover("project")
	expect(expired.status).toBe(202)
	expect((await expired.json()).id).not.toBe(id)
	expect(await (await discover("project")).json()).not.toEqual({ id })
	await settle((await (await discover("project")).json()).id)
	store.database.close()
})

test("an incomplete or failed menu is not reused", async () => {
	const issue = "Couldn’t list available upgrades for 1 of 2 dependencies: registry requests timed out."
	const partial = await createHarness({}, { upgradeMenu: async (url) => createUpgradeMenu(url, { issue }) })
	const first = await (await partial.discover("project")).json()
	await partial.settle(first.id)
	expect(await partial.page(first.id)).toContain("registry requests timed out")

	// check that the next request builds again
	const second = await partial.discover("project")
	expect(second.status).toBe(202)
	await partial.settle((await second.json()).id)
	partial.store.database.close()

	// check that a failure shows what to do next and leaves the cache key free
	const failing = await createHarness(
		{},
		{ upgradeMenu: async () => Promise.reject(new InspectionError("deadline", "late")) },
	)
	const failed = await (await failing.discover("project")).json()
	await failing.settle(failed.id)
	expect(failing.store.row(failed.id)?.state).toBe("failed")
	expect(await failing.page(failed.id)).toContain(
		"The upgrade menu took too long to build. Click New features to try again.",
	)
	expect(await failing.page(failed.id)).toContain("Couldn’t list upgrades")
	expect((await failing.discover("project")).status).toBe(202)
	failing.store.database.close()
})

test("fresh menus are limited per visitor, by capacity and by the GitHub quota while saved menus stay open", async () => {
	const limited = await createHarness({ HEALTH_CODE_DAILY_MENU_LIMIT: "1" })
	const saved = await (await limited.discover("first")).json()
	await limited.settle(saved.id)
	const refused = await limited.discover("second")
	expect(refused.status).toBe(429)
	expect((await refused.json()).message).toBe(
		"You have reached today’s limit of 1 upgrade menus. It resets at 00:00 UTC. Saved upgrade menus stay open.",
	)
	expect((await limited.discover("first")).status).toBe(200)
	expect(await limited.page(saved.id)).toContain("Try upgrade")
	limited.store.database.close()

	// check that fresh menus pause below the floor until GitHub's reset time
	const resetAt = Date.parse("2099-01-01T14:32:00Z")
	const low = await createHarness({}, { githubQuota: () => ({ remaining: 499, resetAt }) })
	const paused = await low.discover("project")
	expect(paused.status).toBe(503)
	expect((await paused.json()).message).toBe(
		"New upgrade menus are paused until 14:32 UTC. Saved upgrade menus stay open.",
	)
	low.store.database.close()

	// check that one build runs, eight wait and the next submission is refused
	const pending = Promise.withResolvers<UpgradeMenu>()
	const busy = await createHarness({}, { upgradeMenu: () => pending.promise })
	const statuses: number[] = []
	for (let index = 0; index < 10; index++) {
		statuses.push((await busy.discover(`project-${index}`)).status)
		await Bun.sleep(1)
	}
	expect(statuses).toEqual([...Array(9).fill(202), 429])

	// let the waiting builds finish before closing the store
	pending.resolve(createUpgradeMenu("https://github.com/example/project-0"))
	await Bun.sleep(20)
	busy.store.database.close()
})

test("an operator pauses fresh menus by setting their concurrency to zero", async () => {
	const { store, discover } = await createHarness({ HEALTH_CODE_MENU_CONCURRENCY: "0" })
	const response = await discover("project")
	expect(response.status).toBe(503)
	expect(await response.json()).toMatchObject({
		message: "New upgrade menus are paused. Saved upgrade menus stay open.",
		shouldOfferSandboxListing: true,
	})
	expect(countRows(store, "upgrade_menus")).toBe(0)

	// check that the menu settings default when the configuration omits them
	expect(toLaunchLimits({})).toMatchObject({
		dailyVisitorUpgradeMenus: 30,
		upgradeMenuConcurrency: 1,
		githubQuotaFloor: 500,
		maxUpgradeMenuResponseMiB: 16,
		maxUpgradeMenuMemoryMiB: 320,
	})
	expect(() => toLaunchLimits({ HEALTH_CODE_MAX_MENU_RESPONSE_MIB: "64" })).toThrow("Invalid launch limit")
	expect(() => toLaunchLimits({ HEALTH_CODE_DAILY_MENU_LIMIT: "many" })).toThrow("Invalid launch limit")
	store.database.close()
})

test("a repository the menu cannot read offers the sandbox listing and debits nothing until it is chosen", async () => {
	const unreadable = {
		reason: "binary-lockfile" as const,
		message:
			"This repository commits a binary bun.lockb, which only Bun can decode. Commit a text bun.lock or list upgrades in a sandbox.",
	}
	const { store, inspections, discover, page, settle } = await createHarness(
		{},
		{
			upgradeMenu: async (url) =>
				createUpgradeMenu(url, {
					dependencies: [],
					issue: unreadable.message,
					unreadable,
					packageManager: { reason: unreadable.message },
				}),
		},
	)
	const { id } = await (await discover("project")).json()
	await settle(id)
	const html = await page(id)
	expect(html).toContain("which only Bun can decode")
	expect(html).toContain("List upgrades in a sandbox")
	expect(countRows(store, "admissions")).toBe(0)

	// check that an unreadable menu answers a repeat submission for its commit
	expect((await discover("project")).status).toBe(200)

	// check that choosing the sandbox listing goes through paid admission
	const listing = await discover("project", { isSandboxListing: true })
	expect(listing.status).toBe(202)
	expect(countRows(store, "admissions")).toBe(1)
	inspections.stop()
	store.database.close()
})

test("a menu that assumed the minimum release age says so", async () => {
	const minimumReleaseAge = {
		minutes: 1440,
		excluded: [],
		source: "the pnpm version is not declared",
		isAssumed: true as const,
	}
	const { store, discover, page, settle } = await createHarness(
		{},
		{ upgradeMenu: async (url) => createUpgradeMenu(url, { minimumReleaseAge }) },
	)
	const { id } = await (await discover("project")).json()
	await settle(id)
	expect(await page(id)).toContain("could not read this repository’s minimum release age and assumed one day")
	store.database.close()
})

test("a build left running by a restart fails with a message and frees its key", async () => {
	const pending = Promise.withResolvers<UpgradeMenu>()
	const { store, discover, page } = await createHarness({}, { upgradeMenu: () => pending.promise })
	const { id } = await (await discover("project")).json()
	store.upgradeMenus.interrupt()
	expect(store.row(id)?.state).toBe("failed")
	expect(await page(id)).toContain(
		"This upgrade menu was interrupted when the server restarted. Click New features to try again.",
	)
	expect((await discover("project")).status).toBe(202)
	pending.reject(new Error("stopped"))
	await Bun.sleep(5)
	store.database.close()
})

test("a visitor at the daily Inspection limit still gets a menu and is refused only at selection", async () => {
	const { store, inspections, discover, settle } = await createHarness({ HEALTH_CODE_DAILY_DEMO_LIMIT: "0" })
	const response = await discover("project")
	expect(response.status).toBe(202)
	const { id } = await response.json()
	await settle(id)
	expect(store.row(id)?.state).toBe("complete")

	// check that the allowance applies when the visitor tries an upgrade
	const selection = await discover("project", {
		action: "select",
		upgradeMenuId: id,
		dependency: "widget",
		to: "1.3.0",
	})
	expect(selection.status).toBe(429)
	expect((await selection.json()).message).toContain("Your daily inspection allowance is used")
	expect(countRows(store, "admissions")).toBe(0)
	inspections.stop()
	await Bun.sleep(5)
	store.database.close()
})

test("the GitHub request floor holds before a head is resolved and counts the builds already admitted", async () => {
	// count the heads the source resolves
	const resetAt = Date.parse("2099-01-01T14:32:00Z")
	let resolveCount = 0
	const resolve: InspectionSource["resolve"] = async (url) => {
		resolveCount++
		return { repositoryId: url, revision: commit, sizeKiB: 1 }
	}

	// check that a submission below the floor sends no GitHub request
	const low = await createHarness({}, { resolve, githubQuota: () => ({ remaining: 499, resetAt }) })
	expect((await low.discover("project")).status).toBe(503)
	expect(resolveCount).toBe(0)
	low.store.database.close()

	// check that each admitted build holds back the requests it may send, so the third would cross the floor
	const pending = Promise.withResolvers<UpgradeMenu>()
	const source = { resolve, upgradeMenu: () => pending.promise, githubQuota: () => ({ remaining: 800, resetAt }) }
	const near = await createHarness({}, source)
	const statuses = [
		(await near.discover("first")).status,
		(await near.discover("second")).status,
		(await near.discover("third")).status,
	]
	expect(statuses).toEqual([202, 202, 503])
	pending.resolve(createUpgradeMenu("https://github.com/example/first"))
	await Bun.sleep(20)
	near.store.database.close()
})

test("a repeat submission inside a minute reuses the saved upgrade menu without a GitHub request", async () => {
	// count the heads the source resolves
	let resolveCount = 0
	const resolve: InspectionSource["resolve"] = async (url) => {
		resolveCount++
		return { repositoryId: url, revision: commit, sizeKiB: 1 }
	}

	// build one upgrade menu
	const { store, discover, settle } = await createHarness({}, { resolve })
	const { id } = await (await discover("project")).json()
	await settle(id)

	// check that ten more submissions resolve nothing
	for (let index = 0; index < 10; index++) {
		expect(await (await discover("project")).json()).toMatchObject({ id })
	}
	expect(resolveCount).toBe(1)
	store.database.close()
})

test("a lowered build limit applies to the builds already waiting", async () => {
	// start two builds at once and leave two waiting
	const builds: PromiseWithResolvers<UpgradeMenu>[] = []
	const upgradeMenu: InspectionSource["upgradeMenu"] = () => {
		builds.push(Promise.withResolvers<UpgradeMenu>())
		return (builds.at(-1) as PromiseWithResolvers<UpgradeMenu>).promise
	}

	// submit four repositories under a limit of two builds
	const { store, inspections, discover } = await createHarness({ HEALTH_CODE_MENU_CONCURRENCY: "2" }, { upgradeMenu })
	for (const name of ["one", "two", "three", "four"]) {
		await discover(name)
	}
	await Bun.sleep(5)
	expect(builds.length).toBe(2)

	// check that after the limit drops to one, finishing one build starts no other
	const settings = inspections.launch?.settings
	if (settings) {
		settings.current = { ...settings.current, upgradeMenuConcurrency: 1 }
	}
	builds[0]?.resolve(createUpgradeMenu("https://github.com/example/one"))
	await Bun.sleep(10)
	expect(builds.length).toBe(2)

	// check that finishing the second build starts the next one
	builds[1]?.resolve(createUpgradeMenu("https://github.com/example/two"))
	await Bun.sleep(10)
	expect(builds.length).toBe(3)

	// let the waiting builds finish before closing the store
	for (let index = 2; index < 4; index++) {
		await Bun.sleep(10)
		builds[index]?.resolve(createUpgradeMenu("https://github.com/example/three"))
	}
	await Bun.sleep(20)
	store.database.close()
})

test("a startup recovery retry leaves the builds of this process running", async () => {
	// serve a source whose first recovery attempt fails
	const pending = Promise.withResolvers<UpgradeMenu>()
	const recover = (() => {
		let attempts = 0
		return async (): Promise<number> => (attempts++ === 0 ? Promise.reject(new Error("inventory")) : 0)
	})()
	const store = new InspectionStore(":memory:")
	const stub = { ...createReplaySource(async () => {}), upgradeMenu: () => pending.promise, recover }
	const inspections = new Inspections(store, stub, 2)

	// start a build while the first recovery attempt sleeps, then let the retry run
	const wake = Promise.withResolvers<void>()
	const started = inspections.start(() => wake.promise)
	await Bun.sleep(5)
	const { id } = await inspections.upgradeMenuBuilds.discover("https://github.com/example/project")
	wake.resolve()
	await started

	// check that the build is running after the retry
	expect(store.row(id)?.state).toBe("running")
	pending.resolve(createUpgradeMenu("https://github.com/example/project"))
	await Bun.sleep(10)
	store.database.close()
})
