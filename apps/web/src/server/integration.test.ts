import { expect, test } from "bun:test"
import {
	createFakeSandboxProvider,
	type InspectionReport,
	inspectRepository,
	SandboxUnavailableError,
	toModelSecretName,
} from "health-code"
import { replayRepositoryUrl as repositoryUrl } from "../report.ts"
import { createLiveSource } from "./createLiveSource.ts"
import { createTestSite, replay } from "./fixtures/createTestSite.ts"
import { modelSettings } from "./fixtures/modelSettings.ts"
import { toLaunchLimits } from "./launchLimits.ts"
import { publishReport } from "./publishReport.ts"
import { InspectionStore } from "./storeInspections.ts"

test("live inspections forward all four model roles, limits, credentials and events at the public boundary", async () => {
	// configure all hosted roles with synthetic credentials and limits
	const output = await replay.inspect(repositoryUrl, () => {})
	const environment = {
		RUNTA_TOKEN: "example-provider-token",
		MODEL_API_KEY: "example-host-key",
		...modelSettings,
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
				expect(route).toMatchObject({ protocol: "openai-compatible", baseUrl: "https://models.example.com/v1" })
				expect(route.credential.name).toBe(toModelSecretName("https://models.example.com"))
				expect(JSON.stringify(route)).not.toContain(environment.MODEL_API_KEY)
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
		for (const privateSetting of [environment.RUNTA_TOKEN, environment.MODEL_API_KEY, githubToken].filter(
			(value): value is string => !!value,
		)) {
			expect(publicReport).not.toContain(privateSetting)
		}
	}
	expect(() => createLiveSource({ ...environment, HEALTH_CODE_MODEL: "" })).toThrow("Set HEALTH_CODE_MODEL ")
})

test("admitted workers forward the current ceilings and the immutable revision", async () => {
	const output = await replay.inspect(repositoryUrl, () => {})
	const environment = {
		RUNTA_TOKEN: "fixture",
		MODEL_API_KEY: "fixture",
		...modelSettings,
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
		for (const route of [options.models.repair, options.models.featureAdoption]) {
			expect(route.modelId).toBe("example-model")
			expect(route.pricing).toMatchObject({ inputUsdPerMillion: 3, outputUsdPerMillion: 16 })
		}

		// Preserve the hosted ceilings on a selected upgrade.
		expect(options.limits?.maxCostUsd).toBe(4)
		expect(options.limits?.maxUpgrades).toBe(1)
		expect(options.limits?.agent?.repair?.maxCostUsd).toBe(1.5)
		expect(options.limits?.agent?.featureAdoption?.maxCostUsd).toBe(0.5)
		return output.report
	})

	await source.inspect(repositoryUrl, () => {}, {
		settings,
		revision: output.report.repository.commit,
		upgrade: { dependency: "widget", from: "1.2.0", to: "1.3.0" },
	})
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
			MODEL_API_KEY: "fixture",
			...modelSettings,
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
		expect(html.includes("Agent started with its model key kept outside the sandbox")).toBe(report.version === 2)
		expect(html).toMatch(/Inspection time · (<!-- -->)?\d+ (min|sec)/)
		expect(html.includes("Upgrade prompt for your coding agent")).toBe(report.version === 2)
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
			const blocked = findings.length ? ` ${findings.length} connections blocked during install.` : ""
			const summary = `Your 2 tested patches are ready.${blocked}`

			// repeat the summary on the page and in shared previews
			expect(html).toContain(`<p>${summary}</p>`)
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
	expect(JSON.stringify(store.publicEvents(id, 0))).toContain("verified after inspection completes...")

	// expose live output while the license found at the start stands
	store.saveInspectedLicense(id, "MIT")
	expect(await (await app.request(path)).text()).toBe(text)
	expect(JSON.stringify(store.publicEvents(id, 0))).not.toContain("Output withheld")
	store.saveInspectedLicense(id, null)
	expect((await app.request(path)).status).toBe(404)

	// expose the licensed detail only through its dedicated endpoint
	store.finish(id, publishReport({ report }, "MIT"))
	expect(await (await app.request(`/r/${id}`)).text()).not.toContain(text)
	expect(await (await app.request(`/api/inspections/${id}/events`)).text()).not.toContain(text)
	expect(await (await app.request(path)).text()).toBe(text)
	store.database.close()
})

test("a failed inspection keeps the output its inspected license allowed", async () => {
	const { report } = await replay.inspect(repositoryUrl, () => {})
	const store = new InspectionStore(":memory:")
	const app = createTestSite(store)
	const detail = report.timeline.find((event) => event.type === "detail")
	if (!detail) {
		throw new Error("Expected recorded command output")
	}

	// fail one licensed and one unlicensed inspection
	for (const [license, status] of [
		["MIT", 200],
		[null, 404],
	] as const) {
		const id = store.enqueue(repositoryUrl)
		store.append(id, detail)
		store.saveInspectedLicense(id, license)
		store.fail({ id, message: "Stopped", dispatched: true })

		// request the saved output after the failure
		expect((await app.request(`/api/inspections/${id}/details/${detail.sequence}`)).status).toBe(status)
	}
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

test("a hosted retry runs a fresh baseline and only installs outstanding targets", async () => {
	const { report: prior } = await replay.inspect(repositoryUrl, () => {})
	const finished = prior.upgrades[0]!
	const project = {
		manager: "npm",
		version: "10.0.0",
		sources: { widget: finished.from },
		skipped: [],
		typecheck: "none",
		environment: [],
	}
	const tool = ["node", "/opt/health-code/project.mjs"]
	const commands = [
		{ argv: [...tool, "detect"], result: { stdout: JSON.stringify(project) } },
		{ argv: [...tool, "registry", "widget"], result: { stdout: JSON.stringify({ widget: ["1.3.0", "2.0.0"] }) } },
		{
			argv: [...tool, "usage", "widget"],
			result: { stdout: JSON.stringify({ usage: [], unresolved: [], changelog: "" }) },
		},
		{ argv: [...tool, "install"], result: { exitCode: 0 } },
	]
	const fake = createFakeSandboxProvider({ commit: prior.repository.commit, commands })

	// Lose the sandbox on the first outstanding upgrade after baseline installation.
	const installs: string[][] = []
	const execute = fake.executeCommand.bind(fake)
	fake.executeCommand = (sandbox, command) => {
		if (command.argv[2] === "install") {
			installs.push(command.argv.slice(2))

			// Let the original installation finish before interrupting the new target.
			if (command.argv.length > 3) {
				// Keep the selected target for the replacement checkout.
				if (commands[1]?.argv[2] === "registry") {
					commands.splice(1, 1)
				}
				throw new SandboxUnavailableError("unavailable")
			}
		}
		return execute(sandbox, command)
	}

	// Run the public library through the hosted options with offline model handles.
	const source = createLiveSource(
		{
			HEALTH_CODE_DEPLOYMENT: "fixture",
			...modelSettings,
			RUNTA_TOKEN: "fixture",
			MODEL_API_KEY: "fixture",
		},
		(options) => inspectRepository({ ...options, sandboxProvider: fake }),
	)
	const { report } = await source.inspect(repositoryUrl, () => {}, {
		revision: prior.repository.commit,
		reuseUpgrade: (_repository, target) =>
			target.to === finished.to ? { ...finished, reusedFromInspectionId: "original-proof" } : undefined,
	})

	// Retain immutable proof from the earlier run alongside the new interruption.
	expect(installs).toEqual([["install"], ["install", "widget", "2.0.0"], ["install"], ["install", "widget", "2.0.0"]])
	expect(report.upgrades[0]).toMatchObject({ reusedFromInspectionId: "original-proof", verdict: "Passes as is" })
	expect(report.upgrades[1]).toMatchObject({ coverage: "partial", verdict: "Untested" })
	expect(report.stoppedReason).toContain("replacement sandbox also became unavailable")
	expect(report.runtimeUsage?.runtimes.map((runtime) => runtime.deleted)).toEqual([true, true])
	expect(report.runtimeUsage?.totalUpperBoundUsd).toBeDefined()
})
