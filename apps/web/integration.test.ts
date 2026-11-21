import { expect, test } from "bun:test"
import type { ReportCard } from "health-code"
import { createLiveSource } from "./configureSite.ts"
import { createTestSite, replay } from "./fixtures/createTestSite.ts"
import { publishReport } from "./publishReport.ts"
import { replayRepositoryUrl as repositoryUrl } from "./report.ts"
import { InspectionStore } from "./storeInspections.ts"

test("live inspections forward all four model roles, limits, credentials and events at the public boundary", async () => {
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
	for (const githubToken of [undefined, "example-github-token"]) {
		let called = false
		const source = createLiveSource({ ...environment, GITHUB_TOKEN: githubToken }, async (options) => {
			called = true
			expect(options.repositoryUrl).toBe(repositoryUrl)
			expect(options.githubToken).toBe(githubToken)
			expect(options.limits).toEqual({ maxUpgrades: 1, maxCostUsd: 3, maxDurationMs: 420000 })
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
			const event = output.report.timeline[0]
			if (event) {
				await options.onEvent?.(event)
			}
			return output.report
		})
		let events = 0
		const result = await source.inspect(repositoryUrl, () => {
			events++
		})
		expect(called).toBe(true)
		expect(events).toBe(1)
		const publicCard = JSON.stringify(publishReport(result, "MPL-2.0").card)
		for (const privateSetting of [
			environment.RUNTA_TOKEN,
			environment.ANTHROPIC_API_KEY,
			environment.HEALTH_CODE_STORED_CREDENTIAL,
			githubToken,
		].filter((value): value is string => !!value)) {
			expect(publicCard).not.toContain(privateSetting)
		}
	}
	expect(() => createLiveSource({ ...environment, HEALTH_CODE_STORED_CREDENTIAL: "" })).toThrow()
})

test("stored version 1 and version 2 reports show agent startup only with explicit sandbox evidence", async () => {
	const legacy: ReportCard = await Bun.file(new URL("./fixtures/recorded/inspection.json", import.meta.url)).json()
	const reportV2 = (await replay.inspect(repositoryUrl, () => {})).report
	const store = new InspectionStore(":memory:")
	const app = createTestSite(store)
	for (const report of [legacy, reportV2]) {
		const id = store.enqueue(repositoryUrl)
		for (const event of report.timeline) {
			store.append(id, event)
		}
		store.finish(id, publishReport({ report }, "MPL-2.0"))
		const html = await (await app.request("/r/" + id)).text()
		expect(html.includes("Agent started with its real key withheld")).toBe(report.version === 2)
		expect(html.includes("Copy patch instructions")).toBe(report.version === 2)
	}
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
	const store = new InspectionStore(":memory:")
	const app = createTestSite(store)
	const connections = ["one.example", "two.example"].map((destination) => ({
		kind: "connection" as const,
		outcome: "blocked" as const,
		destination,
	}))
	for (const complete of [true, false]) {
		for (const findings of [[], connections]) {
			upgrade.observation = { complete, findings }
			const id = store.enqueue(repositoryUrl)
			store.finish(id, publishReport(output, "MIT"))
			const html = await (await app.request(`/r/${id}`)).text()
			expect(html.includes("No findings.")).toBe(complete && findings.length === 0)
			expect(html.includes("Some install activity could not be recorded.")).toBe(!complete)
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
	const detail = report.timeline.find((event) => event.type === "detail")
	if (!detail) {
		throw new Error("Expected recorded command output")
	}
	const text = "test output ".repeat(4096)
	store.append(id, { ...detail, text })
	const path = `/api/inspections/${id}/details/${detail.sequence}`
	expect((await app.request(path)).status).toBe(404)
	store.finish(id, publishReport({ report }, "MIT"))
	expect(await (await app.request("/r/" + id)).text()).not.toContain(text)
	expect(await (await app.request(`/api/inspections/${id}/events`)).text()).not.toContain(text)
	expect(await (await app.request(path)).text()).toBe(text)
	store.database.close()
})

test("the full queue rejects a submission without allocating a report", async () => {
	const store = new InspectionStore(":memory:")
	const app = createTestSite(store)
	for (let count = 0; count < 32; count++) {
		store.enqueue(repositoryUrl)
	}
	const submit = (): Response | Promise<Response> =>
		app.request("/api/inspections", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ repositoryUrl }),
		})
	expect((await submit()).status).toBe(429)
	expect(store.database.query("SELECT count(*) AS count FROM inspections").get()).toEqual({ count: 32 })
	store.claim()
	expect((await submit()).status).toBe(202)
	store.database.close()
})
