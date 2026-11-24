import assert from "node:assert/strict"
import { test } from "node:test"
import { InspectionError } from "health-code"
import { replayRepositoryUrl } from "../report.ts"
import { LaunchService } from "./admitInspections.ts"
import { createLocalSiteRuntime } from "./createLocalSiteRuntime.ts"
import { createSite } from "./createSite.tsx"
import { Inspections } from "./executeInspection.ts"
import { modelSettings } from "./fixtures/modelSettings.ts"
import { toLaunchLimits } from "./launchLimits.ts"
import { AdmissionError, toUtcDay } from "./recordAdmissions.ts"
import { createReplaySource } from "./replayInspection.ts"
import { InspectionStore } from "./storeInspections.ts"

test("local live submissions use their own queue even when the hosted allowances are zero", async () => {
	const environment = {
		RUNTA_TOKEN: "fixture",
		MODEL_API_KEY: "fixture",
		...modelSettings,
		HEALTH_CODE_DATABASE: ":memory:",
		HEALTH_CODE_DAILY_DEMO_LIMIT: "0",
		HEALTH_CODE_DAILY_COST_USD: "0",
	}
	const runtime = createLocalSiteRuntime(environment)
	const app = createSite({ ...runtime, assets: { script: "/client.js", styles: [] } })
	try {
		// Leave the worker stopped so these real-repository submissions never allocate a sandbox.
		assert.equal(runtime.replay, false)
		assert.equal(runtime.origin, "http://localhost:3000")
		for (let index = 0; index < 6; index++) {
			const result = await app.request("/api/inspections", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ repositoryUrl: "https://github.com/octocat/hello-world", action: "discover" }),
			})
			assert.equal(result.status, 202)
		}
		assert.throws(() => createLocalSiteRuntime({ ...environment, NODE_ENV: "production" }), /production server/)
	} finally {
		runtime.inspections.store.database.close()
	}
})

test("a full queue joins existing work without billing for a rejected insertion", () => {
	const store = new InspectionStore(":memory:")
	const limits = toLaunchLimits({})
	const submit = (key: string): { id: string; reused: boolean } =>
		store.admission.admit({
			key,
			head: { repositoryId: "1", revision: "a".repeat(40), sizeKiB: 1 },
			limits,
			now: Date.now(),
			identity: { visitor: key, network: key },
			enqueue: () => store.enqueue(replayRepositoryUrl),
		})
	const first = submit("cached")
	for (const error of [new AdmissionError(403, "Verification expired."), new AdmissionError(503, "Limits changed.")]) {
		const rejection = { error, day: toUtcDay() }
		assert.deepEqual(store.admission.handleRejection({ ...rejection, key: "cached" }), { ...first, reused: true })
		assert.throws(() => store.admission.handleRejection({ ...rejection, key: "missing" }), error)
	}

	for (let index = 1; index < 32; index++) {
		store.enqueue(replayRepositoryUrl)
	}
	assert.deepEqual(submit("cached"), { ...first, reused: true })
	assert.throws(() => submit("new"), /queue is full/)
	assert.equal(store.database.query<{ n: number }, []>("SELECT count(*) n FROM admissions").get()?.n, 1)
	store.database.close()
})

test("a quota identity obtained before midnight cannot debit the next day", async () => {
	const launch = new LaunchService({ HEALTH_CODE_CONCURRENCY: "0" }, true)
	const store = new InspectionStore(":memory:")
	const worker = new Inspections(store, createReplaySource(), 2, launch)
	await worker.start()

	const original = Date.now
	const midnight = Date.parse("2026-11-21T00:00:00Z")
	Date.now = () => midnight - 5
	try {
		await assert.rejects(
			worker.admit(replayRepositoryUrl, {
				challenge: null,
				hostname: "localhost",
				identify: () => {
					Date.now = () => midnight + 5
					return { visitor: "fixture", network: "previous-day" }
				},
			}),
			/daily allowance just reset/,
		)
		assert.equal(store.database.query<{ n: number }, []>("SELECT count(*) n FROM admissions").get()?.n, 0)
	} finally {
		Date.now = original
		worker.stop()
		store.database.close()
	}
})

test("a limit change during repository verification returns an unstarted job to its FIFO place", async () => {
	const store = new InspectionStore(":memory:")
	const launch = new LaunchService({}, true)
	const source = createReplaySource(async () => {})
	const verifyStarted = Promise.withResolvers<void>()
	const allowVerification = Promise.withResolvers<void>()
	let dispatches = 0
	const worker = new Inspections(
		store,
		{
			...source,
			resolve: () => source.resolve!(replayRepositoryUrl),
			verify: async () => {
				verifyStarted.resolve()
				await allowVerification.promise
			},
			inspect: async (...args) => {
				dispatches++
				return source.inspect(...args)
			},
		},
		2,
		launch,
	)
	await worker.start()
	const accepted = await worker.admit(replayRepositoryUrl, {
		identify: () => ({ visitor: "v", network: "n" }),
		challenge: null,
		hostname: "localhost",
	})
	await verifyStarted.promise
	const next = store.enqueue(replayRepositoryUrl)
	launch.settings.current = { ...launch.settings.current, dailyMicros: 0 }
	const requeued = new Promise<void>((resolve) => worker.changes.once(accepted.id, resolve))
	allowVerification.resolve()

	await requeued
	assert.equal(store.position(accepted.id), 1)
	assert.equal(store.position(next), 2)
	assert.equal(dispatches, 0)
	worker.stop()
	store.database.close()
})

test("stopping during startup prevents deferred recovery from claiming a queued inspection", async () => {
	const source = createReplaySource(async () => {})
	const gate = Promise.withResolvers<number>()
	const store = new InspectionStore(":memory:")
	const id = store.enqueue(replayRepositoryUrl)
	const worker = new Inspections(store, { ...source, recover: () => gate.promise })
	const starting = worker.start()

	worker.stop()
	gate.resolve(0)
	await starting
	assert.equal(worker.recovered, false)
	assert.equal(store.position(id), 1)
	store.database.close()
})

test("a sweep started before a failed deletion cannot reopen admission", async () => {
	const source = createReplaySource(async () => {})
	const entered = Promise.withResolvers<void>()
	const inspect = Promise.withResolvers<never>()
	const sweep = Promise.withResolvers<number>()
	let sweeps = 0
	const store = new InspectionStore(":memory:")
	const worker = new Inspections(
		store,
		{
			...source,
			recover: async (options) => (options && ++sweeps === 1 ? sweep.promise : 0),
			inspect: async () => {
				entered.resolve()
				return inspect.promise
			},
		},
		2,
		new LaunchService({}, true),
	)
	await worker.start()
	const result = await worker.admit(replayRepositoryUrl, {
		identify: () => ({ visitor: "v", network: "n" }),
		challenge: null,
		hostname: "localhost",
	})
	await entered.promise
	const earlierSweep = worker.reap()

	// Simulate a deletion failure arriving after the older sweep took its snapshot.
	const failure = new InspectionError("cleanup-failed", "Fixture cleanup failed")
	failure.cleanupId = "fixture"
	const finished = new Promise<void>((resolve) => worker.changes.once(result.id, resolve))
	inspect.reject(failure)
	await finished
	sweep.resolve(0)

	await earlierSweep
	assert.equal(worker.paused, true)
	await worker.reap()
	assert.equal(worker.paused, false)
	worker.stop()
	store.database.close()
})

test("a stopped local worker requeues a claim awaiting repository verification", async () => {
	const store = new InspectionStore(":memory:")
	const checking = Promise.withResolvers<void>()
	const verified = Promise.withResolvers<void>()
	let dispatched = false
	const worker = new Inspections(store, {
		...createReplaySource(),
		verify: async () => {
			checking.resolve()
			await verified.promise
		},
		inspect: async () => {
			dispatched = true
			throw Error("Unexpected dispatch")
		},
	})
	await worker.start()
	const id = worker.submit(replayRepositoryUrl)
	await checking.promise
	worker.stop()

	const requeued = new Promise<void>((resolve) => worker.changes.once(id, resolve))
	verified.resolve()
	await requeued
	assert.equal(dispatched, false)
	assert.equal(store.position(id), 1)
	store.database.close()
})

test("a transient reservation maintenance error leaves paid dispatch paused", async () => {
	const store = new InspectionStore(":memory:")
	const launch = new LaunchService({}, true)
	store.admission.prune = () => {
		throw Error("temporary storage failure")
	}

	const worker = new Inspections(store, createReplaySource(), 2, launch)
	await worker.start()
	assert.equal(worker.recovered, true)
	assert.equal(worker.paused, true)
	await assert.rejects(
		worker.admit(replayRepositoryUrl, {
			identify: () => ({ visitor: "v", network: "n" }),
			challenge: null,
			hostname: "localhost",
		}),
		/temporarily unavailable/,
	)
	worker.stop()
	store.database.close()
})

test("an unreadable funding gate pauses dispatch and preserves the durable FIFO place", async () => {
	const store = new InspectionStore(":memory:")
	const worker = new Inspections(store, createReplaySource(), 2, new LaunchService({}, true))
	await worker.start()

	const checked = Promise.withResolvers<void>()
	store.admission.canDispatch = () => {
		checked.resolve()
		throw Error("temporary funding read failure")
	}
	const { id } = await worker.admit(replayRepositoryUrl, {
		identify: () => ({ visitor: "v", network: "n" }),
		challenge: null,
		hostname: "localhost",
	})
	await checked.promise
	assert.equal(worker.paused, true)
	assert.equal(store.position(id), 1)
	worker.stop()
	store.database.close()
})

test("a failed deletion pauses paid work even when settlement must retry", async () => {
	const store = new InspectionStore(":memory:")
	const failedWrite = Promise.withResolvers<void>()

	// Fail the first write, then allow the original reservation to settle.
	const settle = store.admission.settle.bind(store.admission)
	store.admission.settle = () => {
		store.admission.settle = settle
		failedWrite.resolve()
		throw Error("temporary accounting write failure")
	}

	const failure = new InspectionError("cleanup-failed", "Fixture cleanup failed")
	failure.cleanupId = "fixture-runtime"
	const worker = new Inspections(
		store,
		{
			...createReplaySource(),
			inspect: async () => {
				throw failure
			},
		},
		2,
		new LaunchService({}, true),
	)
	await worker.start()
	const { id } = await worker.admit(replayRepositoryUrl, {
		identify: () => ({ visitor: "v", network: "n" }),
		challenge: null,
		hostname: "localhost",
	})
	await failedWrite.promise
	assert.equal(worker.paused, true)
	assert.equal(store.state(id), "running")

	await new Promise<void>((resolve) => worker.changes.once(id, resolve))
	assert.equal(store.state(id), "failed")
	worker.stop()
	store.database.close()
})
