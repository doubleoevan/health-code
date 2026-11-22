import assert from "node:assert/strict"
import { test } from "node:test"
import type { UpgradeFeatures } from "health-code"
import { ReleaseFeatureCache } from "./cacheReleaseFeatures.ts"
import { toLaunchLimits } from "./launchLimits.ts"
import { LaunchService } from "./launchService.ts"
import { publishReport } from "./publishReport.ts"
import { createReplaySource } from "./replayInspection.ts"
import { replayRepositoryUrl } from "./report.ts"
import { InspectionStore } from "./storeInspections.ts"

test("a deployed commit starts a fresh cache and keeps previous reports readable", async () => {
	const store = new InspectionStore(":memory:")
	const source = createReplaySource(async () => {})
	const options = {
		input: replayRepositoryUrl,
		request: { identify: () => ({ visitor: "browser", network: "network" }), challenge: undefined, hostname: "local" },
		source,
		store,
		workerAvailable: () => true,
		wake: () => {},
	}

	// Recreate the service on the same database for each simulated deployment.
	const launch = (revision: string): LaunchService => new LaunchService({ NF_DEPLOYMENT_SHA: revision }, true)
	const first = await launch("first").admit(options)
	const output = await source.inspect(replayRepositoryUrl, () => {})
	store.finish(first.id, publishReport(output, "MIT"))
	assert.deepEqual(await launch("first").admit(options), { ...first, reused: true })

	// Reuse the new inspection within its deployment.
	const next = await launch("second").admit(options)
	assert.notEqual(next.id, first.id)
	assert.deepEqual(await launch("second").admit(options), { ...next, reused: true })

	// Resume an inspection queued by an older release without a second charge.
	const third = launch("third")
	third.resumeQueued(store)
	assert.deepEqual(await third.admit(options), { ...next, reused: true })
	assert.equal(store.snapshot(first.id)?.state, "complete")
	store.database.close()
})

test("incomplete reports allow retries and confirmed upgrade failures can be reused", async () => {
	const source = createReplaySource(async () => {})
	for (const outcome of [
		"registry",
		"baseline",
		"untested",
		"confirmed failure",
		"no upgrades",
		"test timeout",
		"baseline only",
	]) {
		const store = new InspectionStore(":memory:")
		const input = {
			head: { repositoryId: "fixture", sizeKiB: 1, revision: "a".repeat(40) },
			key: "same",
			identity: { visitor: "visitor", network: "network" },
			limits: toLaunchLimits({}),
			now: Date.now(),
			enqueue: () => store.enqueue(replayRepositoryUrl),
		}

		// Publish each outcome through the same transaction as a live inspection.
		const first = store.admission.admit(input)
		const output = await source.inspect(replayRepositoryUrl, () => {})
		const failed = { status: "failed" as const, evidence: [], failingTests: [] }
		switch (outcome) {
			case "registry":
				output.report.selection.registryLookupIssue = "Registry lookup timed out"
				break

			// Preserve the failure that blocked baseline comparisons.
			case "baseline":
				output.report.baseline.typecheck = failed
				break

			// Distinguish an inconclusive upgrade from a confirmed regression.
			case "untested":
				output.report.upgrades[0]!.verdict = "Untested"
				break
			case "confirmed failure":
				output.report.upgrades[0]!.verdict = "Can't fix"
				output.report.upgrades[0]!.result = failed
				break

			// Retry a timed-out baseline even when the registry found no upgrades.
			case "test timeout":
				output.report.baseline.tests = { status: "untested", reason: "command-timeout", evidence: [] }
				output.report.upgrades = []
				break
			case "baseline only":
				output.report.selection.limit = 0
				output.report.upgrades = []
				break

			// Cache a genuine empty discovery result.
			case "no upgrades":
				output.report.upgrades = []
		}

		// Preserve the original report for every outcome.
		store.finish(first.id, publishReport(output, "MIT"))
		const next = store.admission.admit(input)
		assert.equal(next.id === first.id, outcome === "confirmed failure" || outcome === "no upgrades", outcome)
		assert.equal(store.snapshot(first.id)?.state, "complete")
		store.database.close()
	}
})

test("a partial report caches only the exact completed upgrade and links its proof", async () => {
	const store = new InspectionStore(":memory:")
	const source = createReplaySource(async () => {})
	const output = await source.inspect(replayRepositoryUrl, () => {})
	const { report } = output
	const finished = report.upgrades[0]!

	// Leave the second target eligible for a retry.
	const skipped = { ...finished, dependency: "skipped", coverage: "skipped" as const, verdict: "Untested" as const }
	report.upgrades.push(skipped)
	report.stoppedReason = "The sandbox became unavailable."

	// Admit a retry at the same pin with a higher selection limit.
	function admit(release: string, limit: number): string {
		return store.admission.admit({
			head: { repositoryId: "fixture", sizeKiB: 1, revision: report.repository.commit },
			key: JSON.stringify(["fixture", report.repository.commit, "library", release, limit]),
			identity: { visitor: "visitor", network: "network" },
			limits: toLaunchLimits({ HEALTH_CODE_DAILY_COST_USD: "50" }),
			now: Date.now(),
			enqueue: () => store.enqueue(replayRepositoryUrl),
		}).id
	}

	// Keep the immutable report after admitting additional work.
	const original = admit("release", 2)
	store.finish(original, publishReport(output, "MIT"))
	const retry = admit("release", 3)
	const lookup = store.upgrades.reader(retry)

	// Reject changed pins, targets, workspace versions and releases.
	assert.equal(lookup(report.repository, finished)?.reusedFromInspectionId, original)
	assert.equal(lookup(report.repository, skipped), undefined)
	assert.equal(lookup({ ...report.repository, commit: "b".repeat(40) }, finished), undefined)
	assert.equal(lookup(report.repository, { ...finished, to: "9.0.0" }), undefined)
	assert.equal(lookup(report.repository, { ...finished, from: { ".": "0.1.0" } }), undefined)
	assert.equal(store.upgrades.reader(admit("new", 3))(report.repository, finished), undefined)
	store.database.close()
})

test("an upgrade menu joins only the ready target from the current checkout and release", async () => {
	const store = new InspectionStore(":memory:")
	const source = createReplaySource(async () => {})
	const output = await source.inspect(replayRepositoryUrl, () => {})
	const upgrade = output.report.upgrades[0]
	assert.ok(upgrade)
	const request = {
		identify: () => ({ visitor: "visitor", network: "network" }),
		challenge: undefined,
		hostname: "local",
	}
	const options = { input: replayRepositoryUrl, request, source, store, workerAvailable: () => true, wake: () => {} }

	// Publish a licensed report and request its exact upgrade from a separate upgrade menu.
	const first = new LaunchService({ NF_DEPLOYMENT_SHA: "first" }, true)
	const original = await first.admit(options)
	store.finish(original.id, publishReport(output, "MIT"))
	const choice = { revision: output.report.repository.commit, upgrade }
	assert.deepEqual(await first.admit({ ...options, choice }), { id: original.id, reused: true })

	// Revalidate the head before reuse and keep a different deployment's cache separate.
	await assert.rejects(
		first.admit({ ...options, choice: { ...choice, revision: "b".repeat(40) } }),
		/repository has changed/,
	)
	const next = new LaunchService({ NF_DEPLOYMENT_SHA: "second" }, true)
	assert.equal((await next.admit({ ...options, choice })).reused, false)
	store.database.close()
})

test("release lookups share a result until its coverage-specific expiry", async () => {
	let now = 0
	let calls = 0
	const cache = new ReleaseFeatureCache(() => now)
	const target = { dependency: "dep", from: { ".": "1.0.0" }, kind: "minor" as const, to: "1.1.0" }
	const load = async (): Promise<UpgradeFeatures> => ({
		features: [],
		sources: [],
		gaps: ++calls === 1 ? ["Unavailable"] : [],
	})

	// Retry a missing release sooner than a complete response.
	await Promise.all([cache.read(target, load), cache.read(target, load)])
	await cache.read(target, load)
	assert.equal(calls, 1)

	// Refresh the incomplete result, then reuse the complete one.
	now += 60000
	await cache.read(target, load)
	now += 60000
	await cache.read(target, load)
	assert.equal(calls, 2)
})
