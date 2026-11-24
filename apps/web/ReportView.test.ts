import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { origin, replay, createTestSite as site } from "./fixtures/createTestSite.ts"
import { publishReport } from "./publishReport.ts"
import { replayRepositoryUrl as repository, toReportHeading, toSummary } from "./report.ts"
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

	// include unsafe release text
	upgrade.releaseSummary.text = "</script><script>alert(1)</script>"

	// include unavailable size evidence and a test file error
	upgrade.installSize = { reason: "Size measurement unavailable" }
	upgrade.tests.inventory = {
		counts: { passed: 1, failed: 0, skipped: 0, todo: 0 },
		testFileErrors: [{ file: "helpers.test.ts", reason: "Fixture setup failed" }],
	}
	const match = upgrade.featureMatches[0]
	const patchForReview = upgrade.patches[0]
	if (!match || !patchForReview) {
		throw new Error("The review fixture requires a Code Feature Match and a Patch")
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
		if (verdict === "Untested") {
			upgrade.result = { status: "untested", reason: "The pinned project has no test script.", evidence: [] }
		}

		// publish and render the saved report
		const id = store.enqueue(repository)
		store.finish(id, publishReport(output, "MPL-2.0"))
		const html = (await (await app.request(`/r/${id}`)).text()).replaceAll("<!-- -->", "")
		expect((html.match(/<h2>Upgrade prompt for your coding agent<\/h2>/g) ?? []).length).toBe(1)
		for (const expected of [
			verdict.replace("'", "&#x27;"),
			...(verdict === "Untested" ? ["Why this upgrade was untested", "The pinned project has no test script."] : []),
			"<h1>Inspection complete</h1>",
			"<p>Your 2 tested patches are ready. 1 connection blocked during install.</p>",
			"Checks before the upgrade",
			"<h2>Health inspection details</h2>",
			"Some install activity could not be recorded. The network trace ended early.",
			"blocked · example.org",
			"unknown · example.net",
			"Unmeasured",
			"workspace-b",
			"twitter:card",
			"og:description",
			"og:title",
			`${origin}/r/${id}`,
			"Upgrade prompt for your coding agent",
			"Direct replacement",
			match.directQuote,
			"Source location",
			"Affected call sites",
			"Test file errors",
			"Fixture setup failed",
			"Adoption outcome",
			"Why no tested patch is available",
			"Turn limit reached",
			"What the health inspector could verify",
			"Upgraded typecheck",
			"Upgraded tests",
			"Dependency changes",
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
			"Copy report link",
			"dashboard.runta.com",
			"mcp-setup",
		]) {
			expect(html).toContain(expected)
		}

		// keep internal run settings, false empty states and unescaped release text off the page
		expect(html).not.toMatch(/Prompt versions|Turn limit<|Usage measured through/)
		expect(html).not.toContain("No findings.")
		expect(html).not.toContain(upgrade.releaseSummary.text)
	}

	// render the same evidence without a publication license
	const withheld = store.enqueue(repository)
	store.finish(withheld, publishReport(output, null))
	const html = await (await app.request(`/r/${withheld}`)).text()
	expect(html).toContain("Findings only")
	expect(html).not.toContain(upgrade.patches[0]?.prompt ?? "Upgrade prompt for your coding agent")
	expect(html).not.toContain("/patches/")
	expect((await app.request(`/patches/${"0".repeat(64)}.patch`)).status).toBe(404)

	// check that changing the mailbox invalidates the recorded digest
	const patch = upgrade.patches[0]
	if (!patch) {
		throw new Error("missing patch")
	}
	patch.mailbox += "changed"
	expect(() => publishReport(output, "MIT")).toThrow("verification")
	store.database.close()
})

test("a timed-out upgrade install explains which checks did not run", async () => {
	const output = await replay.inspect(repository, () => {})
	const upgrade = output.report.upgrades[0]!
	const timeout = "The upgrade install timed out after 180 seconds."
	upgrade.install = { status: "untested", reason: "command-timeout", detail: timeout, evidence: [] }
	upgrade.result = upgrade.install
	upgrade.typecheck = upgrade.tests = { status: "untested", reason: "not-run", evidence: [] }

	// Only describe both checks as skipped when the recorded results support it.
	const published = (): string | undefined => publishReport(output, null).card.upgrades[0]?.untestedReason
	expect(published()).toBe(`${timeout} The upgraded typecheck and tests did not run.`)
	upgrade.tests = { status: "passed", evidence: [] }
	expect(published()).toBe(timeout)
})

test("the summary names the outcome and whether a patch is available", async () => {
	const output = await replay.inspect(repository, () => {})
	const { card } = publishReport(output, "MIT")
	const upgrade = card.upgrades[0]
	if (!upgrade) {
		throw new Error("The fixture requires an upgrade")
	}

	// Remove the patches and installation findings from one upgrade.
	const observation = { ...upgrade.observation, findings: [] }
	const tested = { ...upgrade, observation, patches: [] }
	const skipped = { ...tested, coverage: "skipped" as const, verdict: "Untested" as const }
	const failed = { ...card, upgrades: [skipped], baseline: { ...card.baseline, install: "failed" } }

	// Explain an upgrade that never started.
	expect(toReportHeading(failed)).toBe("Upgrade not tested")
	expect(toSummary(failed)).toBe(
		"No patch. Your project’s dependencies failed to install so the health inspector couldn’t test this upgrade.",
	)

	// Distinguish unsuccessful repairs, incomplete checks and ready patches.
	const unfixed = { ...card, upgrades: [{ ...tested, verdict: "Can't fix" as const }] }
	expect(toSummary(unfixed)).toBe("No patch. The upgrade broke your checks and the health inspector couldn’t fix it.")
	expect(toReportHeading(unfixed)).toBe("Inspection complete")
	const incomplete = { ...card, upgrades: [{ ...tested, verdict: "Untested" as const }] }
	expect(toSummary(incomplete)).toBe("No patch. The health inspector couldn’t finish testing this upgrade.")

	// Count the upgrades without a patch beside a ready one.
	const mixed = { ...card, upgrades: [{ ...upgrade, observation, patches: upgrade.patches.slice(0, 1) }, skipped] }
	expect(toSummary(mixed)).toBe("Your tested patch is ready. No patch for 1 of 2 upgrades.")
	expect(toReportHeading(mixed)).toBe("Inspection complete")
	expect(toSummary({ ...card, upgrades: [] })).toBe("No patch. No upgrades were tested.")
})

test("patch order belongs to the dependency that requires it", async () => {
	// Publish a standalone upgrade alongside a feature with a required upgrade patch.
	const output = await replay.inspect(repository, () => {})
	const widget = output.report.upgrades[0]
	const patch = widget?.patches.find((item) => item.role === "upgrade")
	if (!widget || !patch) {
		throw new Error("The fixture requires a tested upgrade patch")
	}

	// Give the independent target its own downloadable bytes.
	const mailbox = patch.mailbox.replaceAll("widget", "gadget")
	const digest = createHash("sha256").update(mailbox).digest("hex")
	output.report.upgrades.push({ ...widget, dependency: "gadget", patches: [{ ...patch, id: digest, digest, mailbox }] })
	const store = new InspectionStore(":memory:")
	try {
		// Read the public report and find the two dependency cards in display order.
		const id = store.enqueue(repository)
		store.finish(id, publishReport(output, "MIT"))
		const app = site(store)
		const html = await (await app.request(`/r/${id}`)).text()
		const [first, second] = html.match(/<article>[\s\S]*?<\/article>/g) ?? []

		// Number the verified prerequisite and feature within the first target only.
		expect(first).toContain("<h3>widget</h3>")
		expect(first).toMatch(/1\. Upgrade patch[\s\S]*2\. Optional feature patch/)
		expect(first).not.toContain(digest)
		expect(second).toContain("<h3>gadget</h3>")
		expect(second).toContain("<h4>Upgrade patch</h4>")
		expect(second).not.toContain(patch.digest)

		// Fetch the independent patch directly from the link on its card.
		const path = `/patches/${digest}.patch`
		expect(second).toContain(`href="${path}"`)
		expect(await (await app.request(path)).text()).toBe(mailbox)
	} finally {
		store.database.close()
	}
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
		const html = await (await app.request(`/r/${id}`)).text()
		expect(html).toContain(reason)
		expect(html).toContain("JavaScript and TypeScript")
		expect(html).toContain("No upgrades inspected")
	}
	store.database.close()
})

test("an empty report explains registry failure on the shared report page", async () => {
	const output = await replay.inspect(repository, () => {})
	const store = new InspectionStore(":memory:")
	const app = site(store)
	output.report.upgrades = []
	const reason = "Couldn’t list available upgrades: registry lookup timed out after 60s."
	output.report.selection.registryLookupIssue = reason

	// Exercise publication, persistence, server rendering and the share title.
	const upgrade = { dependency: "requested-package", from: "1.0.0", to: "2.0.0" }
	const id = store.enqueue(repository, { upgrade })
	store.finish(id, publishReport(output, null))
	const html = await (await app.request(`/r/${id}`)).text()
	expect(html).toContain(`<p>${reason}</p>`)
	expect(html).toContain("<h2>Troubleshooting prompt for your coding agent</h2>")
	expect(html).toContain("identify the first failed or skipped check")
	expect(html).not.toContain("SHA-256: ")

	// Keep the requested target in the copied prompt when discovery returned no cards.
	const state = JSON.parse(html.match(/<script id="page-state" type="application\/json">(.*?)<\/script>/s)![1]!)
	expect(state.snapshot.investigationPrompt).toContain(upgrade.dependency)

	// Highlight the evidence without changing the displayed prompt.
	const prompt = /<pre tabindex="0">(.*?)<\/pre>/is.exec(html)?.[1] ?? ""
	expect(prompt).toContain('class="token property"')

	// Decode the displayed text.
	const displayed = prompt
		.replace(/<[^>]+>/g, "")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&#x27;", "'")
		.replaceAll("&amp;", "&")
	expect(displayed).toBe(state.snapshot.investigationPrompt)

	// Preserve the same registry diagnosis in shared previews.
	expect(html).toContain(`property="og:title" content="Health Code: ${reason}"`)
	expect(html).toContain(`name="twitter:title" content="Health Code: ${reason}"`)
	expect(html).not.toContain("No upgrades inspected")

	// Preserve the recorded timeout when opening a report saved with the earlier field name.
	store.database
		.query(
			"UPDATE inspections SET report = json_remove(json_set(report, '$.discoveryIssue', ?), '$.registryLookupIssue') WHERE id = ?",
		)
		.run(reason, id)
	expect(store.snapshot(id)?.card?.registryLookupIssue).toBe(reason)

	// Recover the registry failure from an older inspection’s timeline.
	delete output.report.selection.registryLookupIssue
	const previous = store.enqueue(repository)
	store.append(previous, {
		type: "step.finished",
		version: 1,
		sequence: 1,
		inspectionId: previous,
		timestamp: new Date().toISOString(),
		stepId: "1",
		summary: "registry",
		status: "failed",
		durationMs: 59100,
	})
	store.finish(previous, publishReport(output, null))
	const previousHtml = await (await app.request(`/r/${previous}`)).text()
	expect(previousHtml).toContain("Couldn’t list available upgrades: registry lookup failed.")
	expect(previousHtml).not.toContain("No upgrades inspected")
	store.database.close()
})

test("a partial report shows the interrupted step, skipped upgrades and reused evidence", async () => {
	const store = new InspectionStore(":memory:")
	const output = await replay.inspect(repository, () => {})
	const upgrade = output.report.upgrades[0]!
	output.report.stoppedReason = "The sandbox became unavailable. Last step: tests."
	upgrade.reusedFromInspectionId = "original-proof"
	output.report.upgrades.push({
		...upgrade,
		dependency: "unfinished",
		coverage: "skipped",
		reusedFromInspectionId: undefined,
		verdict: "Untested",
	})
	output.report.selection.omitted = [{ ...upgrade, dependency: "outside-limit" }]

	// Render a persisted report as a visitor would open its shared link.
	const id = store.enqueue(repository)
	store.finish(id, publishReport(output, null))
	const html = (await (await site(store).request(`/r/${id}`)).text()).replaceAll("<!-- -->", "")

	// Verify the reason, scope and original evidence are visible without JavaScript.
	expect(html).toContain("<h1>Inspection complete</h1>")
	expect(html).toContain("Previously tested in")
	expect(html).toContain("Where this fits in your code")

	// Show unfinished work alongside the link to the previous inspection.
	expect(html).toContain("its patch can’t be published")
	expect(html).toContain("Skipped before checking this upgrade.")
	expect(html).toContain("Last step: tests")
	expect(html).toContain("outside-limit@")
	expect(html).toContain('href="/r/original-proof"')

	// Open the same source link from a report saved with the earlier field.
	store.database
		.query("UPDATE inspections SET report=replace(report,?,?) WHERE id=?")
		.run('"reusedFromInspectionId"', '"reusedFrom"', id)
	expect(await (await site(store).request(`/r/${id}`)).text()).toContain('href="/r/original-proof"')
	store.database.close()
})
