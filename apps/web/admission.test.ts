import assert from "node:assert/strict"
import { test } from "node:test"
import { createSite } from "./createSite.tsx"
import { Inspections } from "./executeInspection.ts"
import { LaunchSettings, toLaunchLimits } from "./launchLimits.ts"
import { LaunchService } from "./launchService.ts"
import { createReplaySource } from "./replayInspection.ts"
import { replayRepositoryUrl } from "./report.ts"
import { InspectionStore } from "./storeInspections.ts"
import { createRepositoryLookup } from "./verifyRepository.ts"
import { identifyVisitor, verifyAdmin, verifyChallenge } from "./verifyVisitor.ts"

test("atomic admission shares pending work and enforces separate network and browser quotas", () => {
	const store = new InspectionStore(":memory:")
	const limits = toLaunchLimits({ HEALTH_CODE_DAILY_COST_USD: "100", HEALTH_CODE_DAILY_DEMO_LIMIT: "1" })
	const now = Date.now()
	const day = new Date(now).toISOString().slice(0, 10)

	// Record a stable cache identity and a real FIFO row for each miss.
	function admit(key: string, visitor: string, network: string): { id: string; reused: boolean } {
		return store.admission.admit({
			key,
			head: { repositoryId: "1", sizeKiB: 1, revision: "a".repeat(40) },
			now,
			limits,
			identity: { visitor, network },
			enqueue: () => store.enqueue(replayRepositoryUrl),
		})
	}
	const first = admit("head", "browser", "network")
	assert.deepEqual(admit("head", "other", "elsewhere"), { ...first, reused: true })
	assert.throws(() => admit("other", "new-cookie", "network"), /allowance/)
	assert.throws(() => admit("other", "browser", "new-network"), /allowance/)

	// Reserve both workers at the default inspection ceiling and keep their positions stable.
	const second = admit("other", "other", "elsewhere")
	assert.equal(store.position(first.id), 1)
	assert.equal(store.position(second.id), 2)
	assert.equal(store.admission.liability(day), 10000000)
	store.database.close()
})

test("missing receipts retain a reservation across midnight and settlement runs once", () => {
	const store = new InspectionStore(":memory:")
	const limits = toLaunchLimits({ HEALTH_CODE_DAILY_COST_USD: "5" })
	const head = { repositoryId: "1", sizeKiB: 1, revision: "a".repeat(40) }

	// Keep yesterday's reservation outstanding while another visitor submits today.
	const input = {
		key: "one",
		head,
		limits,
		identity: { visitor: "v", network: "n" },
		enqueue: () => store.enqueue(replayRepositoryUrl),
	}
	const { id } = store.admission.admit({ ...input, now: Date.now() - 86400000 })
	store.admission.settle(id)
	const today = new Date().toISOString().slice(0, 10)
	assert.equal(store.admission.liability(today), 5000000)
	assert.throws(() => store.admission.admit({ ...input, key: "two", now: Date.now() }), /budget/)

	// Settle against the measured model charge and the bounded runtime cost.
	const usage = {
		totalUpperBoundUsd: 0.75,
		modelCostUsd: 0.4,
		modelReservedUsd: 0.1,
		runtimes: [{ upperBoundUsd: 0.25 }],
	}
	store.admission.settle(id, usage)
	store.admission.settle(id, { ...usage, totalUpperBoundUsd: 4 })
	assert.equal(store.admission.liability(today), 750000)
	store.database.close()
})

test("lower ceilings reduce queued holds before the FIFO worker claims them", () => {
	const settings = toLaunchLimits({})
	const store = new InspectionStore(":memory:")
	const { id } = store.admission.admit({
		head: { repositoryId: "1", sizeKiB: 1, revision: "a".repeat(40) },
		key: "queued",
		identity: { visitor: "browser", network: "network" },
		limits: settings,
		now: Date.now(),
		enqueue: () => store.enqueue(replayRepositoryUrl),
	})
	const reduced = { ...settings, maxCostUsd: 3, repairUsd: 1, adoptionUsd: 0.5, maxUpgrades: 1 }
	store.admission.tightenQueued(reduced.maxCostUsd)
	assert.deepEqual(store.admission.workerLimits(id, reduced), reduced)
	assert.equal(store.admission.canDispatch(2999999), false)
	assert.equal(store.admission.canDispatch(3000000), true)

	// A subsequent increase cannot exceed the amount still reserved.
	assert.equal(store.admission.workerLimits(id, settings).maxCostUsd, 3)
	store.database.close()
})

test("ingress identity ignores forwarded chains and admin authentication requires TLS", () => {
	const key = "fixture-only"
	const url = "https://example.test/admin"
	const headers = { "x-envoy-external-address": "2001:db8::1", "x-forwarded-for": "203.0.113.42" }
	const first = identifyVisitor(new Request(url, { headers }), key, false)
	const second = identifyVisitor(
		new Request(url, {
			headers: { ...headers, cookie: `hc_visitor=${first.cookie}`, "x-forwarded-for": "203.0.113.44" },
		}),
		key,
		false,
	)
	assert.deepEqual(first.identity, second.identity)
	assert.ok(!Object.values(first.identity).includes(first.cookie))
	assert.throws(() => identifyVisitor(new Request(url, { headers: { "x-forwarded-for": "127.0.0.1" } }), key, false))

	// Rotate the password and reject insecure transport and an empty configured password.
	const auth = { Authorization: `Basic ${Buffer.from("admin:fixture").toString("base64")}` }
	assert.equal(verifyAdmin(new Request(url, { headers: auth }), "fixture"), true)
	for (const password of [undefined, "", "rotated"]) {
		assert.equal(verifyAdmin(new Request(url, { headers: auth }), password), false)
	}
	assert.equal(verifyAdmin(new Request("http://example.test/admin", { headers: auth }), "fixture"), false)
})

test("replay submits once and hydrates analytics only for an eligible foreign viewer", async () => {
	const origin = "https://example.test"
	const store = new InspectionStore(":memory:")
	const launch = new LaunchService({ HEALTH_CODE_ADMIN_PASSWORD: "fixture" }, true)
	const inspections = new Inspections(
		store,
		createReplaySource(async () => {}),
		2,
		launch,
	)
	const app = createSite({ inspections, origin, replay: true, assets: { script: "/client.js", styles: [] } })
	await inspections.start()

	// Submit concurrent identical requests through the normal public endpoint.
	const submit = async (): Promise<Response> =>
		app.request(`${origin}/api/inspections`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ repositoryUrl: replayRepositoryUrl }),
		})
	const [first, second] = await Promise.all([submit(), submit()])
	assert.deepEqual([first.status, second.status].sort(), [200, 202])
	const path = first.headers.get("location")
	assert.equal(second.headers.get("location"), path)
	assert.ok(path)
	const id = path.split("/").at(-1) ?? ""

	// Inspect the saved report even after paid admissions have been suspended.
	for (let index = 0; index < 100 && store.state(id) !== "complete"; index++) {
		await Bun.sleep(5)
	}
	assert.equal(store.state(id), "complete")
	launch.settings.current.dailyMicros = 0
	assert.equal((await submit()).headers.get("location"), path)

	// Open the report with a fresh visitor cookie.
	const reportResponse = await app.request(origin + path)
	const cookie = reportResponse.headers.get("set-cookie")?.split(";")[0] ?? ""
	const view = async (agent: string): Promise<Response> =>
		app.request(`${origin}/api/inspections/${id}/view`, {
			method: "POST",
			headers: { origin, cookie, "user-agent": agent },
		})
	await view("Slackbot")
	assert.equal(store.admission.daily()[0]?.counts.includes("shared"), false)
	await view("Browser")
	await view("Browser")

	// Check both cohort numerators after a repeated visit.
	const counts = JSON.parse(store.admission.daily()[0]?.counts ?? "{}")
	assert.equal(counts.shared, 1)
	assert.equal(counts.viewers, 1)
	assert.equal((await app.request(`${origin}/admin`)).status, 401)
	assert.equal((await app.request(`${origin}/health/ready`)).status, 200)
	inspections.stop()
	store.database.close()
})

test("launch settings retain the last valid snapshot and pause after three minutes", async () => {
	let now = 1000000
	const original = Date.now
	Date.now = () => now
	const values = {
		HEALTH_CODE_DAILY_DEMO_LIMIT: "7",
		HEALTH_CODE_CONCURRENCY: "2",
		HEALTH_CODE_DAILY_COST_USD: "10",
		HEALTH_CODE_MAX_REPO_MIB: "100",
		HEALTH_CODE_MAX_UPGRADES: "2",
		HEALTH_CODE_MAX_COST_USD: "5",
		HEALTH_CODE_REPAIR_COST_USD: "2",
		HEALTH_CODE_ADOPTION_COST_USD: "1",
	}
	let complete = true
	const settings = new LaunchSettings({}, "fixture", async () => Response.json(complete ? values : {}))
	try {
		// Apply a complete replacement during the next refresh.
		assert.equal(settings.available, false)
		assert.equal(settings.current.dailyVisitorInspections, 5)
		await settings.refresh()
		assert.equal(settings.current.dailyVisitorInspections, 7)
		const snapshot = settings.current
		await settings.refresh()
		assert.equal(snapshot, settings.current)
		assert.equal(settings.available, true)

		values.HEALTH_CODE_DAILY_COST_USD = "1"
		now += 60000
		await settings.refresh()
		assert.equal(settings.current.dailyMicros, 1000000)

		// Reject an incomplete refresh while preserving the lower accepted budget.
		complete = false
		await assert.rejects(settings.refresh())

		// Expire the last good snapshot during an outage.
		assert.equal(settings.current.dailyMicros, 1000000)
		now += 180000
		assert.equal(settings.available, false)
	} finally {
		Date.now = original
	}
})

test("a budget refusal links to MCP and explains the UTC reset on the home page", async () => {
	const store = new InspectionStore(":memory:")
	const launch = new LaunchService({ HEALTH_CODE_DAILY_COST_USD: "0" }, true)
	const worker = new Inspections(store, createReplaySource(), 2, launch)
	const origin = "https://example.test"
	const app = createSite({ inspections: worker, origin, replay: true, assets: { script: "/client.js", styles: [] } })
	await worker.start()
	const response = await app.request(`${origin}/api/inspections`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ repositoryUrl: replayRepositoryUrl }),
	})
	assert.equal(response.status, 429)
	const problem = await response.json()
	assert.match(problem.message, /00:00 UTC/)

	// Offer the same self-funded path in the API response and the server-rendered page.
	const home = await (await app.request(origin)).text()
	assert.ok(home.includes(problem.mcpSetupUrl))
	assert.ok(home.includes("Cached reports remain available"))
	assert.equal(JSON.parse(store.admission.daily()[0]!.counts).budgetHits, 1)
	worker.stop()
	store.database.close()
})

test("the hosted header counts the demo calls left for the visitor and network", async () => {
	const store = new InspectionStore(":memory:")
	const launch = new LaunchService(
		{
			HEALTH_CODE_DAILY_DEMO_LIMIT: "2",
			HEALTH_CODE_LIMITS_TOKEN: "fixture",
			HEALTH_CODE_VISITOR_KEY: "k".repeat(32),
			TURNSTILE_SITE_KEY: "fixture",
			TURNSTILE_SECRET_KEY: "fixture",
		},
		false,
	)
	let available = true
	Object.defineProperty(launch.settings, "available", { get: () => available })

	// Render the hosted home page for one network address.
	const worker = new Inspections(store, createReplaySource(), 2, launch)
	const origin = "https://example.test"
	const app = createSite({ inspections: worker, origin, replay: false, assets: { script: "/client.js", styles: [] } })
	const headers = { "x-envoy-external-address": "203.0.113.1" }
	const readHeader = async (init?: RequestInit): Promise<string | undefined> =>
		/<small>(.*?)<\/small>/.exec(await (await app.request(origin, init)).text())?.[1]?.replaceAll("<!-- -->", "")
	assert.equal(await readHeader({ headers }), "2 demo calls left")

	// Spend the allowance from the same network and check each label.
	const { identity } = identifyVisitor(new Request(origin, { headers }), launch.visitorKey, false)
	for (const expected of ["1 demo call left", "0 demo calls left"]) {
		store.admission.admit({
			key: expected,
			head: { repositoryId: "1", sizeKiB: 1, revision: "a".repeat(40) },
			limits: launch.settings.current,
			identity,
			now: Date.now(),
			enqueue: () => store.enqueue(replayRepositoryUrl),
		})
		assert.equal(await readHeader({ headers }), expected)
	}
	assert.equal(await readHeader({ headers: { "x-envoy-external-address": "203.0.113.2" } }), "2 demo calls left")

	// Hide the label when the visitor or the limits are unknown.
	assert.equal(await readHeader(), undefined)
	available = false
	assert.equal(await readHeader({ headers }), undefined)
	store.database.close()
})

test("a challenge must belong to the site and the inspection action", async () => {
	const verify = (success: boolean, hostname: string, action: string): Promise<void> =>
		verifyChallenge("test", "test", "runhealthcode.dev", async () => Response.json({ success, hostname, action }))
	await verify(true, "runhealthcode.dev", "inspect")
	await assert.rejects(verify(false, "runhealthcode.dev", "inspect"))
	await assert.rejects(verify(true, "other.test", "inspect"))
	await assert.rejects(verify(true, "runhealthcode.dev", "signup"))
})

test("admission resolves the current public commit even when its cache key exists", async () => {
	let revision = "a".repeat(40)
	let size = 102400
	let visible = true
	let throttled = false
	const lookup = createRepositoryLookup(
		undefined,
		Object.assign(
			async (input: RequestInfo | URL) => {
				if (String(input).includes("/git/ref/heads/")) {
					return Response.json({ object: { sha: revision } })
				}

				// Model GitHub throttling independently of visibility.
				if (throttled) {
					return new Response(null, { status: 429 })
				}
				return Response.json({
					id: 123,
					size,
					private: !visible,
					visibility: visible ? "public" : "private",
					default_branch: "main",
				})
			},
			{ preconnect: fetch.preconnect },
		),
	)
	const store = new InspectionStore(":memory:")
	const launch = new LaunchService({ HEALTH_CODE_CONCURRENCY: "0", HEALTH_CODE_DAILY_COST_USD: "20" }, true)
	const inspections = new Inspections(store, { ...createReplaySource(), ...lookup }, 2, launch)
	await inspections.start()

	// Reuse one identity for submissions at the cutoff.
	const request = { identify: () => ({ network: "n", visitor: "v" }), challenge: undefined, hostname: "localhost" }
	const submit = (): Promise<{ id: string; reused: boolean }> => inspections.admit(replayRepositoryUrl, request)
	const first = await submit()
	size++
	assert.deepEqual(await submit(), { ...first, reused: true })

	// Refresh the head before allowing a free hit or accepting a different revision.
	revision = "b".repeat(40)
	await assert.rejects(submit(), /size limit/)
	size--
	const second = await submit()
	assert.notEqual(second.id, first.id)

	// Emulate a report produced by the previous library release at the same SHA.
	store.database
		.query("UPDATE admissions SET cacheKey=json_set(cacheKey,'$[2]','previous-release') WHERE id=?")
		.run(second.id)
	const fresh = await submit()
	assert.notEqual(fresh.id, second.id)
	assert.equal((await submit()).id, fresh.id)

	// Revoke visibility before submitting a previously cached head.
	visible = false
	await assert.rejects(submit(), /public repository/)
	throttled = true
	await assert.rejects(submit(), /right now/)
	inspections.stop()
	store.database.close()
})

test("queued visitors see their FIFO position after a disconnect and a worker restart", async () => {
	const store = new InspectionStore(":memory:")
	const recorded = createReplaySource(async () => {})
	const gate = Promise.withResolvers<void>()
	const source = {
		...recorded,
		verify: async () => {},
		resolve: async (url: string) => ({ ...(await recorded.resolve!(replayRepositoryUrl)), repositoryId: url }),
		inspect: async (...args: Parameters<typeof recorded.inspect>) => {
			await gate.promise
			const output = await recorded.inspect(...args)
			output.report.repository.url = args[0]
			return output
		},
	}

	// Pause dispatch while both anonymous visitors receive their durable IDs.
	const launch = new LaunchService({ HEALTH_CODE_CONCURRENCY: "0" }, true)
	const origin = "https://example.test"
	let worker = new Inspections(store, source, 2, launch)
	await worker.start()
	const request = {
		identify: () => ({ visitor: "fixture", network: "fixture" }),
		challenge: undefined,
		hostname: "local",
	}
	const first = await worker.admit("https://github.com/example/first", request)
	const second = await worker.admit("https://github.com/example/second", request)
	worker.stop()

	// Reopen the worker over the same durable queue before permitting a single claim.
	worker = new Inspections(store, source, 2, launch)
	await worker.start()
	const app = createSite({ inspections: worker, replay: true, origin, assets: { script: "/client.js", styles: [] } })
	const page = await app.request(`${origin}/r/${second.id}`)
	assert.match(await page.text(), /Queue position: 2/)
	async function position(after: number): Promise<string> {
		const abort = new AbortController()
		const events = await app.request(`${origin}/api/inspections/${second.id}/events?after=${after}`, {
			signal: abort.signal,
		})
		const reader = events.body!.getReader()
		const frame = await reader.read()
		abort.abort()
		await reader.cancel()
		return new TextDecoder().decode(frame.value)
	}

	// Compare the initial frame with a fresh subscription after the first claim.
	assert.match(await position(0), /event: position\ndata: 2/)
	launch.settings.current.concurrency = 1
	await worker.reap()
	assert.equal(store.state(first.id), "running")
	assert.match(await position(0), /event: position\ndata: 1/)

	// Verify that the second worker starts once the first settles.
	gate.resolve()
	for (let retry = 0; retry < 100 && store.state(second.id) !== "complete"; retry++) {
		await Bun.sleep(5)
	}
	assert.equal(store.state(second.id), "complete")
	worker.stop()
	store.database.close()
})
