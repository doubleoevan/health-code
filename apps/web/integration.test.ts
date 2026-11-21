import { expect, test } from "bun:test"
import { createFakeSandboxProvider, type InspectionReport, inspectRepository } from "health-code"
import { createLiveSource } from "./configureSite.ts"
import { createTestSite, replay } from "./fixtures/createTestSite.ts"
import { toLaunchLimits } from "./launchLimits.ts"
import { publishReport } from "./publishReport.ts"
import { replayRepositoryUrl as repositoryUrl } from "./report.ts"
import { InspectionStore } from "./storeInspections.ts"

test("live inspections forward all four model roles, limits, credentials and events at the public boundary", async () => {
	// configure all hosted roles with synthetic credentials and limits
	const output = await replay.inspect(repositoryUrl, () => {})
	const environment = {
		RUNTA_TOKEN: "example-provider-token",
		ANTHROPIC_API_KEY: "example-host-key",
		HEALTH_CODE_STORED_CREDENTIAL: "example-model-name",
		HEALTH_CODE_MODEL: "claude-opus-5-5",
		HEALTH_CODE_DEPLOYMENT: "fixture",
		HEALTH_CODE_MAX_UPGRADES: "1",
		HEALTH_CODE_MAX_COST_USD: "3",
		HEALTH_CODE_MAX_DURATION_MS: "420000",
	}

	// check both anonymous and authenticated release lookups
	for (const githubToken of [undefined, "example-github-token"]) {
		let called = false
		const source = createLiveSource({ ...environment, GITHUB_TOKEN: githubToken }, async (options) => {
			called = true
			expect(options.repositoryUrl).toBe(repositoryUrl)
			expect(options.githubToken).toBe(githubToken)
			expect(options.limits).toEqual({
				maxUpgrades: 1,
				maxCostUsd: 3,
				maxDurationMs: 420000,
				agent: { repair: { maxCostUsd: 2 }, featureAdoption: { maxCostUsd: 1 } },
			})

			// verify the same configured model reaches each role
			const { releaseSummary, featureMatch, repair, featureAdoption } = options.models
			expect([
				releaseSummary.model.modelId,
				featureMatch.model.modelId,
				repair.modelId,
				featureAdoption.modelId,
			]).toEqual(Array(4).fill(environment.HEALTH_CODE_MODEL))
			for (const route of [repair, featureAdoption]) {
				expect(route.credential.name).toBe(environment.HEALTH_CODE_STORED_CREDENTIAL)
				expect(JSON.stringify(route)).not.toContain(environment.ANTHROPIC_API_KEY)
			}

			// emit recorded evidence through the public callback
			const event = output.report.timeline[0]
			if (event) {
				await options.onEvent?.(event)
			}
			return output.report
		})

		// verify the live source forwards the event to its caller
		let events = 0
		const result = await source.inspect(repositoryUrl, () => {
			events++
		})
		expect(called).toBe(true)
		expect(events).toBe(1)

		// inspect the published report for private account settings
		const publicReport = JSON.stringify(publishReport(result, "MPL-2.0").card)
		for (const privateSetting of [
			environment.RUNTA_TOKEN,
			environment.ANTHROPIC_API_KEY,
			environment.HEALTH_CODE_STORED_CREDENTIAL,
			githubToken,
		].filter((value): value is string => !!value)) {
			expect(publicReport).not.toContain(privateSetting)
		}
	}
	expect(() => createLiveSource({ ...environment, HEALTH_CODE_STORED_CREDENTIAL: "" })).toThrow()
})

test("admitted workers forward the current ceilings and the immutable revision", async () => {
	const output = await replay.inspect(repositoryUrl, () => {})
	const environment = {
		RUNTA_TOKEN: "fixture",
		ANTHROPIC_API_KEY: "fixture",
		HEALTH_CODE_STORED_CREDENTIAL: "fixture",
		HEALTH_CODE_DEPLOYMENT: "fixture",
	}

	// Verify the public options at the point where the worker hands off to the library.
	const settings = toLaunchLimits({
		HEALTH_CODE_MAX_COST_USD: "4",
		HEALTH_CODE_MAX_UPGRADES: "1",
		HEALTH_CODE_REPAIR_COST_USD: "1.5",
		HEALTH_CODE_ADOPTION_COST_USD: "0.5",
	})

	const source = createLiveSource(environment, async (options) => {
		expect(options.revision).toBe(output.report.repository.commit)
		expect(options.limits?.maxCostUsd).toBe(4)
		expect(options.limits?.maxUpgrades).toBe(1)
		expect(options.limits?.agent?.repair?.maxCostUsd).toBe(1.5)
		expect(options.limits?.agent?.featureAdoption?.maxCostUsd).toBe(0.5)
		return output.report
	})

	await source.inspect(repositoryUrl, () => {}, { settings, revision: output.report.repository.commit })
})

test("an unavailable sandbox quote stops an inspection before it allocates a runtime", async () => {
	const sandboxProvider = createFakeSandboxProvider({ commit: "a".repeat(40), commands: [] })
	sandboxProvider.estimateMaxCost = () => Number.NaN
	let allocated = false
	sandboxProvider.createSandbox = async () => {
		allocated = true
		throw new Error("Unexpected allocation")
	}

	const source = createLiveSource(
		{
			RUNTA_TOKEN: "fixture",
			ANTHROPIC_API_KEY: "fixture",
			HEALTH_CODE_STORED_CREDENTIAL: "fixture",
			HEALTH_CODE_DEPLOYMENT: "fixture",
		},
		(options) => inspectRepository({ ...options, sandboxProvider }),
	)
	await expect(source.inspect(repositoryUrl, () => {})).rejects.toThrow(/price bound/)
	expect(allocated).toBe(false)
})

test("stored version 1 and version 2 reports show agent startup only with explicit sandbox evidence", async () => {
	// load both report versions into the same web application
	const legacy: InspectionReport = await Bun.file(
		new URL("./fixtures/recorded/inspection.json", import.meta.url),
	).json()
	const reportV2 = (await replay.inspect(repositoryUrl, () => {})).report
	const store = new InspectionStore(":memory:")
	const app = createTestSite(store)
	for (const report of [legacy, reportV2]) {
		// replay the stored timeline before rendering each report
		const id = store.enqueue(repositoryUrl)
		for (const event of report.timeline) {
			store.append(id, event)
		}
		store.finish(id, publishReport({ report }, "MPL-2.0"))

		// check the visible startup and patch controls for each version
		const html = await (await app.request(`/r/${id}`)).text()
		expect(html.includes("Agent started with its real key withheld")).toBe(report.version === 2)
		expect(html.includes("Copy patch instructions")).toBe(report.version === 2)
	}

	// require an attributed sandbox event for feature adoption
	expect(
		reportV2.timeline.some(
			(event) =>
				event.type === "sandbox.event" &&
				event.action === "agent-started" &&
				event.role === "featureAdoption" &&
				!!event.attemptId,
		),
	).toBe(true)
	store.database.close()
})

test("reports distinguish empty findings from incomplete recordings and share the measured counts", async () => {
	const output = await replay.inspect(repositoryUrl, () => {})
	const upgrade = output.report.upgrades[0]
	if (!upgrade) {
		throw new Error("Expected a recorded upgrade")
	}

	// prepare two blocked connections for the coverage scenarios
	const store = new InspectionStore(":memory:")
	const app = createTestSite(store)
	const connections = ["one.example", "two.example"].map((destination) => ({
		kind: "connection" as const,
		outcome: "blocked" as const,
		destination,
	}))

	// vary completeness independently of the number of observed connections
	for (const complete of [true, false]) {
		for (const findings of [[], connections]) {
			upgrade.observation = { complete, findings }
			const id = store.enqueue(repositoryUrl)
			store.finish(id, publishReport(output, "MIT"))

			// verify the empty and incomplete states independently
			const html = await (await app.request(`/r/${id}`)).text()
			expect(html.includes("No findings.")).toBe(complete && findings.length === 0)
			expect(html.includes("Some install activity could not be recorded.")).toBe(!complete)

			// compare the page and share titles with the observed counts
			const summary = `1 upgrade inspected, 1 feature patch, ${findings.length} connections blocked during install`
			expect(html).toContain(`<h1>${summary}</h1>`)
			expect(html).toContain(`property="og:title" content="Health Code: ${summary}"`)
			expect(html).toContain(`name="twitter:title" content="Health Code: ${summary}"`)
		}
	}
	store.database.close()
})

test("large raw output is fetched only when the licensed detail is opened", async () => {
	const { report } = await replay.inspect(repositoryUrl, () => {})
	const store = new InspectionStore(":memory:")
	const app = createTestSite(store)
	const id = store.enqueue(repositoryUrl)

	// select an existing output event for the oversized detail
	const detail = report.timeline.find((event) => event.type === "detail")
	if (!detail) {
		throw new Error("Expected recorded command output")
	}

	// keep raw output private before publication
	const text = "test output ".repeat(4096)
	store.append(id, { ...detail, text })
	const path = `/api/inspections/${id}/details/${detail.sequence}`
	expect((await app.request(path)).status).toBe(404)

	// expose the licensed detail only through its dedicated endpoint
	store.finish(id, publishReport({ report }, "MIT"))
	expect(await (await app.request(`/r/${id}`)).text()).not.toContain(text)
	expect(await (await app.request(`/api/inspections/${id}/events`)).text()).not.toContain(text)
	expect(await (await app.request(path)).text()).toBe(text)
	store.database.close()
})

test("the full queue rejects a submission without allocating a report", async () => {
	const store = new InspectionStore(":memory:")
	const app = createTestSite(store)

	// fill every queue slot before submitting another repository
	for (let count = 0; count < 32; count++) {
		store.enqueue(repositoryUrl)
	}
	const submit = (): Response | Promise<Response> =>
		app.request("/api/inspections", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ repositoryUrl }),
		})

	// verify rejection leaves the row count unchanged and claiming frees a slot
	expect((await submit()).status).toBe(429)
	expect(store.database.query("SELECT count(*) AS count FROM inspections").get()).toEqual({ count: 32 })
	store.claim()
	expect((await submit()).status).toBe(202)
	store.database.close()
})
