import assert from "node:assert/strict"
import { test } from "node:test"
import { replayRepositoryUrl } from "../report.ts"
import { adminPage } from "./adminPage.tsx"
import { LaunchService } from "./admitInspections.ts"
import { createSite } from "./createSite.tsx"
import { Inspections } from "./executeInspection.ts"
import { toLaunchLimits } from "./launchLimits.ts"
import { publishReport } from "./publishReport.ts"
import { readSiteEnvironment } from "./readConfiguration.ts"
import { createReplaySource } from "./replayInspection.ts"
import { InspectionStore } from "./storeInspections.ts"

test("first-party cohorts exclude repeat and self views, count timely starts once and expire digests", () => {
	const store = new InspectionStore(":memory:")
	const now = Date.now(),
		day = new Date(now).toISOString().slice(0, 10)
	const limits = toLaunchLimits({ HEALTH_CODE_DAILY_COST_USD: "100", HEALTH_CODE_DAILY_DEMO_LIMIT: "10" })

	// Link the report owner and each newly accepted inspection to a separate public queue row.
	function start(key: string, visitor: string, time = now): string {
		return store.admission.admit({
			key,
			head: { repositoryId: key, revision: "b".repeat(40), sizeKiB: 1 },
			limits,
			identity: { visitor, network: visitor },
			now: time,
			enqueue: () => store.enqueue(replayRepositoryUrl),
		}).id
	}
	const id = start("original", "author")
	store.database.query("UPDATE inspections SET state='complete' WHERE id=?").run(id)
	store.admission.view(id, "author")
	store.admission.view(id, "viewer", now)
	store.admission.view(id, "viewer", now)
	store.admission.view(id, "late", now)

	// Count a confirmed foreign viewer only in the originating seven-day cohort.
	start("follow-up", "viewer", now + 1000)
	start("another", "viewer", now + 2000)
	start("too late", "late", now + 8 * 86400000)
	store.admission.count("budgetHits", day)
	store.admission.count("visitorHits", day)
	store.admission.count("cache", day)
	store.admission.settle(id, {
		modelCostUsd: 0.4,
		modelReservedUsd: 0.1,
		totalUpperBoundUsd: 0.75,
		runtimes: [{ upperBoundUsd: 0.25 }],
	})
	const row = store.admission.daily().find((item) => item.day === day)
	assert.ok(row)
	const counts = JSON.parse(row.counts)
	assert.deepEqual(
		{ shared: counts.shared, viewers: counts.viewers, converted: counts.converted },
		{ shared: 1, viewers: 2, converted: 1 },
	)

	// Match each operator-facing rate and dollar amount to its source cohort.
	const html = adminPage(store.admission, null)
	assert.ok(html.includes("Viewers who started an inspection (7 days)"))
	assert.ok(html.includes("<td>1/1 (100%)</td><td>1/2 (50%) (open)</td>"))
	assert.ok(html.includes("<td>$0.40</td><td>$0.25</td><td>$0.75</td><td>$10.00</td>"))
	assert.ok(html.includes("<td>3</td><td>0 / 0</td><td>1</td><td>1 / 1</td>"))

	// Exclude completed upgrade menus from both sides of the share rate across stored choice formats.
	for (const payload of [{ mode: "listUpgrades" }, { discoveryOnly: true }]) {
		const upgradeMenuId = start(JSON.stringify(payload), "author")
		store.database.query("INSERT INTO inspection_choices VALUES(?,?)").run(upgradeMenuId, JSON.stringify(payload))
		store.database.query("UPDATE inspections SET state='complete' WHERE id=?").run(upgradeMenuId)
		store.admission.view(upgradeMenuId, "menu-visitor", now)
	}

	// Count only the tested report and its foreign viewers.
	const activity = store.admission.daily().find((entry) => entry.day === day)
	assert.equal(activity?.completed, 1)
	assert.equal(JSON.parse(activity.counts).shared, 1)

	// Retain aggregate counts after the visitor and network digests expire.
	store.database.exec(
		"UPDATE admissions SET day=date('now','-32 days');UPDATE foreign_views SET day=date('now','-32 days')",
	)
	store.admission.prune()
	assert.deepEqual(
		store.database.query("SELECT count(*) n FROM admissions WHERE visitor IS NOT NULL OR network IS NOT NULL").get(),
		{ n: 0 },
	)
	assert.deepEqual(store.database.query("SELECT count(*) n FROM foreign_views").get(), { n: 0 })
	assert.ok(
		store.admission
			.daily()
			.find((item) => item.day === day)
			?.counts.includes("converted"),
	)
	store.database.close()
})

test("the admin row shows a day's fresh and reused upgrade menus beside its upgrade tests", () => {
	const store = new InspectionStore(":memory:")
	const now = Date.now()
	const day = new Date(now).toISOString().slice(0, 10)
	const limits = toLaunchLimits({ HEALTH_CODE_DAILY_COST_USD: "100", HEALTH_CODE_DAILY_DEMO_LIMIT: "10" })

	// count ten fresh menus and five reused ones
	for (let index = 0; index < 15; index++) {
		store.admission.count(index < 10 ? "menus" : "menuReuses", day)
	}

	// admit three upgrade tests, each for a version selected from a menu
	for (const to of ["1.3.0", "1.4.0", "2.0.0"]) {
		store.admission.admit({
			key: to,
			head: { repositoryId: "example/project", revision: "b".repeat(40), sizeKiB: 1 },
			limits,
			identity: { visitor: to, network: to },
			now,
			enqueue: () => store.enqueue(replayRepositoryUrl),
		})
	}

	// check that the day's row reads starts, then fresh and reused menus
	assert.ok(adminPage(store.admission, null).includes(`<td>${day}</td><td>3</td><td>10 / 5</td>`))
	store.database.close()
})

test("admin protection covers provider hosts and future data routes", async () => {
	const origin = "https://runhealthcode.dev"
	const launch = new LaunchService({ HEALTH_CODE_ADMIN_PASSWORD: "fixture" }, true)
	const store = new InspectionStore(":memory:")
	const app = createSite({
		inspections: new Inspections(store, createReplaySource(), 2, launch),
		origin,
		replay: true,
		assets: { script: "/client.js", styles: [] },
	})
	const readiness = await app.request(origin + "/health/ready")
	assert.equal(readiness.status, 200)
	assert.deepEqual(await readiness.json(), { ready: true, recovered: false })
	const plaintext = await app.request("http://runhealthcode.dev/admin")
	assert.equal(plaintext.status, 403)
	assert.equal(plaintext.headers.has("www-authenticate"), false)
	const authorization = "Basic " + Buffer.from("admin:fixture").toString("base64")

	// Exercise both ingress hostnames through the same admin middleware.
	for (const host of [origin, "https://service.northflank.app"]) {
		for (const route of ["/admin", "/admin/data"]) {
			const denied = await app.request(host + route)
			assert.equal(denied.status, 401)
			assert.ok(denied.headers.get("www-authenticate")?.includes("Basic"))
			assert.match(denied.headers.get("cache-control") ?? "", /no-store/)
		}

		// Show the day’s empty denominators only to a signed-in operator.
		const accepted = await app.request(host + "/admin", { headers: { authorization } })
		assert.equal(accepted.status, 200)
		const html = await accepted.text()
		assert.match(html, /Daily inspection activity/)
		assert.match(html, /—/)
	}
	store.database.close()
})

test("Doppler boot preserves production networking and rejects a malformed configuration", async () => {
	const boot = { HEALTH_CODE_RUNTIME_CONFIG_TOKEN: "fixture", NODE_ENV: "production", PORT: "3000" }
	const runtime = await readSiteEnvironment(boot, async () =>
		Response.json({
			TURNSTILE_SITE_KEY: "public-fixture",
			HEALTH_CODE_REPLAY: "1",
			PORT: "4000",
			NODE_ENV: "development",
			HEALTH_CODE_ADMIN_PASSWORD: "private-fixture",
			UNRELATED: "other",
		}),
	)
	assert.equal(runtime.NODE_ENV, "production")
	assert.equal(runtime.PORT, "3000")
	assert.equal(runtime.HEALTH_CODE_REPLAY, undefined)
	assert.equal(runtime.UNRELATED, undefined)

	// Only the runtime and its named configuration fields receive app credentials.
	assert.equal(runtime.TURNSTILE_SITE_KEY, "public-fixture")
	assert.equal(runtime.HEALTH_CODE_ADMIN_PASSWORD, "private-fixture")
	await assert.rejects(
		readSiteEnvironment(boot, async () => Response.json({ nested: {} })),
		/Invalid Doppler/,
	)
})

test("terminal logs expose only public identity, verdict counts, duration and cost", async () => {
	const store = new InspectionStore(":memory:")
	const records: string[] = []
	const original = console.info
	const launch = new LaunchService({ HEALTH_CODE_ADMIN_PASSWORD: "fixture-password" }, true)
	const recorded = createReplaySource(async () => {})
	const source = {
		...recorded,
		inspect: async (): Promise<never> => {
			throw new Error("fixture-private-provider-output")
		},
	}
	const worker = new Inspections(store, source, 2, launch)
	try {
		console.info = (message: string): void => {
			records.push(message)
		}

		// Recover an existing running row before exercising a new provider failure.
		const unfinished = store.enqueue(replayRepositoryUrl)
		store.claim()
		await worker.start()

		// Supply synthetic visitor identities that must stay out of the diagnostic stream.
		const result = await worker.admit(replayRepositoryUrl, {
			identify: () => ({ visitor: "fixture-private-cookie", network: "fixture-private-network" }),
			challenge: "fixture-token",
			hostname: "example.test",
		})
		for (let retry = 0; retry < 100 && store.state(result.id) !== "failed"; retry++) {
			await Bun.sleep(5)
		}
		assert.equal(store.state(unfinished), "interrupted")
		assert.equal(store.state(result.id), "failed")
		const entries = records.map((value) => JSON.parse(value))
		assert.deepEqual(
			entries.map((entry) => entry.state),
			["interrupted", "failed"],
		)

		// Require the same allowlist for errors as for expired workers.
		for (const entry of entries) {
			assert.deepEqual(Object.keys(entry).sort(), [
				"durationMs",
				"id",
				"modelCostUsd",
				"modelReservedUsd",
				"repo",
				"sandboxUpperBoundUsd",
				"state",
				"totalUpperBoundUsd",
				"verdicts",
			])
			assert.ok(entry.durationMs >= 0)
		}

		assert.doesNotMatch(records.join(" "), /fixture-(?:private|password|token)/)
	} finally {
		console.info = original
		worker.stop()
		store.database.close()
	}
})

test("saved reports remain readable while boot configuration retries", async () => {
	const { startInspections } = await import("./startInspections.ts")
	const retried = Promise.withResolvers<void>()
	const ready = Promise.withResolvers<Awaited<ReturnType<typeof startInspections>>>()
	let reads = 0
	const runtime = await startInspections({
		environment: {
			HEALTH_CODE_DATABASE: ":memory:",
			HEALTH_CODE_RUNTIME_CONFIG_TOKEN: "fixture",
			HEALTH_CODE_REPLAY: "1",
		},
		read: async (environment) => {
			if (++reads === 1) {
				throw Error("fixture outage")
			}
			return environment
		},
		retry: async () => retried.promise,
		onConfigured: ready.resolve,
	})
	const id = runtime.inspections.store.enqueue(replayRepositoryUrl)
	const report = await createReplaySource(async () => {}).inspect(replayRepositoryUrl, () => {})
	runtime.inspections.store.finish(id, publishReport(report, null))
	assert.equal(runtime.inspections.recovered, false)
	assert.equal(runtime.inspections.store.snapshot(id)?.card?.repository.commit, report.report.repository.commit)

	retried.resolve()
	const configured = await ready.promise
	assert.equal(configured.inspections.store, runtime.inspections.store)
	await Bun.sleep(10)
	configured.inspections.stop()
	runtime.inspections.store.database.close()
})
