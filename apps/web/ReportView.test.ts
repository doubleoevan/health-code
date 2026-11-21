import { expect, test } from "bun:test"
import { origin, replay, createTestSite as site } from "./fixtures/createTestSite.ts"
import { publishReport } from "./publishReport.ts"
import { replayRepositoryUrl as repository } from "./report.ts"
import { InspectionStore } from "./storeInspections.ts"

test("server HTML renders each Verdict, license decision, evidence and preview before JavaScript", async () => {
	const store = new InspectionStore(":memory:")
	const app = site(store)
	const output = await replay.inspect(repository, () => {})
	// require a recorded upgrade for the rendering scenarios
	const upgrade = output.report.upgrades[0]
	if (!upgrade) {
		throw new Error("fixture requires an upgrade")
	}
	// exercise workspace versions and partial installation evidence
	upgrade.from = { "workspace-a": "1.0", "workspace-b": "1.1" }
	upgrade.observation = {
		complete: false,
		reason: "The network trace ended early.",
		findings: [
			{ kind: "connection", destination: "example.org", outcome: "blocked" },
			{ kind: "connection", destination: "example.net", outcome: "unknown" },
		],
	}
	// include unsafe release text and separate turn limits
	upgrade.releaseSummary.text = "</script><script>alert(1)</script>"
	output.report.limits = {
		maxDurationMs: 60000,
		maxCostUsd: 1,
		agent: {
			repair: { maxTurns: 4, maxDurationMs: 20000, maxCostUsd: 0.5 },
			featureAdoption: { maxTurns: 0, maxDurationMs: 0, maxCostUsd: 0 },
		},
	}
	// include unavailable size evidence and a test file error
	upgrade.installSize = { reason: "Size measurement unavailable" }
	upgrade.tests.inventory = {
		counts: { passed: 1, failed: 0, skipped: 0, todo: 0 },
		testFileErrors: [{ file: "helpers.test.ts", reason: "Fixture setup failed" }],
	}
	const match = upgrade.featureMatches[0]
	const patchForReview = upgrade.patches[0]
	if (!match || !patchForReview) {
		throw new Error("The review fixture requires a Feature Match and a Patch")
	}
	// attach a direct quotation and affected call sites to the match
	match.replacement = "direct"
	match.directQuote = "Replace the old configuration with the built-in defaults."
	match.callSites = [match.location]
	upgrade.newDependencies = [
		{
			name: "options-helper",
			version: "1.0.0",
			reason: "Supplies the removed API",
			commit: patchForReview.commits[0]?.sha ?? "commit",
		},
	]
	// supply repair, usage and patch verification evidence
	upgrade.diagnosis = { breakingChange: "Configuration changed", actions: [], stopReason: "Turn limit reached" }
	upgrade.modelUsage.push({ role: "repair", modelId: "fixture", step: "repair", durationMs: 2, reservedUsd: 0.004 })
	patchForReview.verification = {
		...output.report.baseline,
		installation: upgrade.observation,
		testNetwork: upgrade.observation,
		addedCases: [],
	}
	// render the published report for each possible verdict
	for (const verdict of ["Passes as is", "Fixed", "Fixed with test changes", "Can't fix", "Untested"] as const) {
		upgrade.verdict = verdict
		const id = store.enqueue(repository)
		store.finish(id, publishReport(output, "MPL-2.0"))
		const html = (await (await app.request("/r/" + id)).text()).replaceAll("<!-- -->", "")
		for (const expected of [
			verdict.replace("'", "&#x27;"),
			"<h1>1 upgrade inspected, 1 feature patch, 1 connection blocked during install</h1>",
			"Checks before the upgrade",
			"<summary>Turn limit</summary>",
			"<dt>Repair</dt><dd>4</dd>",
			"<dt>Feature adoption</dt><dd>0</dd>",
			"Some install activity could not be recorded. The network trace ended early.",
			"blocked · example.org",
			"unknown · example.net",
			"Unmeasured",
			"workspace-b",
			"twitter:card",
			"og:description",
			"og:title",
			origin + "/r/" + id,
			"Copy patch instructions",
			"Direct replacement",
			match.directQuote,
			"Source location",
			"Affected call sites",
			"Test file errors",
			"Fixture setup failed",
			"Adoption outcome",
			"Why repair stopped",
			"Added dependencies",
			"options-helper@1.0.0",
			"Model cost",
			"Reserved upper bound",
			"Output tokens",
			"some usage unavailable",
			"Patch verification",
			"Download patch",
			"Applies to commit",
			"Tested commit",
			"Required upgrade patch",
			"Copy link",
			"Share",
			"dashboard.runta.com",
			"mcp-setup",
		]) {
			expect(html).toContain(expected)
		}
		// reject a false empty state and unescaped release text
		expect(html).not.toContain("No findings.")
		expect(html).not.toContain(upgrade.releaseSummary.text)
	}
	// render the same evidence without a publication license
	const withheld = store.enqueue(repository)
	store.finish(withheld, publishReport(output, null))
	const html = await (await app.request("/r/" + withheld)).text()
	expect(html).toContain("Findings only")
	expect(html).not.toContain(upgrade.patches[0]?.prompt ?? "Copy patch instructions")
	expect(html).not.toContain("/patches/")
	expect((await app.request("/patches/" + "0".repeat(64) + ".patch")).status).toBe(404)
	// check that changing the mailbox invalidates the recorded digest
	const patch = upgrade.patches[0]
	if (!patch) {
		throw new Error("missing patch")
	}
	patch.mailbox += "changed"
	expect(() => publishReport(output, "MIT")).toThrow("verification")
	store.database.close()
})

test("unsupported and ambiguous projects preserve detection reasons without upgrades", async () => {
	const output = await replay.inspect(repository, () => {})
	const store = new InspectionStore(":memory:")
	const app = site(store)
	// preserve each detection failure on an otherwise empty report
	for (const reason of ["missing root package manifest", "ambiguous package manager"]) {
		output.report.upgrades = []
		output.report.packageManager = { reason }
		const id = store.enqueue(repository)
		store.finish(id, publishReport(output, null))
		// verify the page explains the reason and supported languages
		const html = await (await app.request("/r/" + id)).text()
		expect(html).toContain(reason)
		expect(html).toContain("JavaScript and TypeScript")
		expect(html).toContain("No upgrades inspected")
	}
	store.database.close()
})
