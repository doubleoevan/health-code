import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isReplayEnabled } from "./configureSite.ts"
import { createSite } from "./createSite.tsx"
import { Inspections } from "./executeInspection.ts"
import { origin, replay, createTestSite as site } from "./fixtures/createTestSite.ts"
import { publishReport } from "./publishReport.ts"
import { createReplaySource } from "./replayInspection.ts"
import { replayRepositoryUrl as repository } from "./report.ts"
import { InspectionStore } from "./storeInspections.ts"
import { createRepositoryLookup } from "./verifyRepository.ts"

test("only repository roots receive an ID and Location before execution", async () => {
	const store = new InspectionStore(":memory:")
	const app = site(store)
	const submit = (repositoryUrl?: string): Response | Promise<Response> =>
		app.request("/api/inspections", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ repositoryUrl }),
		})
	for (const input of [
		undefined,
		"https://code.example/a/b",
		"https://name@github.com/a/b",
		"https://github.com:443/a/b",
		repository + "?ref=main",
		repository + "/tree/main",
		repository + "/%2e",
		repository + "#main",
	]) {
		expect((await submit(input)).status).toBe(400)
	}
	expect(store.claim()).toBeNull()
	const response = await submit(repository + ".git/")
	expect(response.status).toBe(202)
	const { id } = await response.json()
	expect(id).toMatch(/^[\w-]{16}$/)
	expect(response.headers.get("Location")).toBe("/r/" + id)
	expect(store.row(id)?.repositoryUrl).toBe(repository)
	expect(store.row(id)?.state).toBe("queued")
	store.database.close()
})

test("replay honors every timestamp delta and production refuses fixtures", async () => {
	const waits: number[] = []
	const events: number[] = []
	const output = await createReplaySource(async (milliseconds) => {
		waits.push(milliseconds)
	}).inspect(repository, (event) => events.push(event.sequence))
	expect(events).toEqual(output.report.timeline.map((event) => event.sequence))
	const times = output.report.timeline.map((event) => Date.parse(event.timestamp))
	expect(waits).toEqual(times.map((time, index) => time - (times[index - 1] ?? time)))
	expect(Math.max(...waits)).toBeGreaterThan(0)
	expect(() => isReplayEnabled({ NODE_ENV: "production", HEALTH_CODE_REPLAY: "1" })).toThrow()
})

test("GitHub checks visibility and uses the pinned license on mixed-language repositories", async () => {
	for (const license of ["MIT", "AGPL-3.0", "GPL-2.0-only", "MPL-2.0", "NOASSERTION", "BUSL-1.1", null]) {
		const request = Object.assign(
			async (input: RequestInfo | URL) => {
				const url = new URL(String(input))
				if (url.pathname.endsWith("/license")) {
					expect(url.searchParams.get("ref")).toBe("a".repeat(40))
					return Response.json({ license: { spdx_id: license } })
				}
				return Response.json({ private: false, language: "Python", license: { spdx_id: "MIT" } })
			},
			{ preconnect: fetch.preconnect },
		)
		const lookup = createRepositoryLookup(undefined, request)
		await lookup.verify(repository)
		expect(await lookup.license({ url: repository, commit: "a".repeat(40) })).toBe(
			["MIT", "AGPL-3.0", "GPL-2.0-only", "MPL-2.0"].includes(license ?? "") ? license : null,
		)
	}
	for (const [status, isPrivate, visibility] of [
		[404, false],
		[429, false],
		[200, true, "private"],
		[200, false, "internal"],
	] as const) {
		const request = Object.assign(async () => Response.json({ private: isPrivate, visibility }, { status }), {
			preconnect: fetch.preconnect,
		})
		await expect(createRepositoryLookup(undefined, request).verify(repository)).rejects.toThrow(
			status === 429 ? "try again" : "public",
		)
	}
})

test("startup marks interruptions before cleanup, retries failures and resumes queued work", async () => {
	const directory = mkdtempSync(join(tmpdir(), "site-recovery-"))
	try {
		const path = join(directory, "site.sqlite")
		const original = new InspectionStore(path)
		const interrupted = original.enqueue(repository)
		original.claim()
		const queued = original.enqueue(repository)
		original.database.close()
		const store = new InspectionStore(path)
		let attempts = 0
		const source = {
			...replay,
			recover: async () => {
				expect(store.row(interrupted)?.message).toContain("server restarted")
				expect(store.row(queued)?.state).toBe("queued")
				if (++attempts === 1) {
					throw new Error("temporary")
				}
			},
		}
		const inspections = new Inspections(store, source)
		await inspections.start(async () => {})
		await waitFor(() => store.row(queued)?.state === "complete")
		expect(attempts).toBe(2)
		const id = store.snapshot(queued)?.card?.upgrades[0]?.patches[0]?.digest
		if (!id) {
			throw new Error("missing patch")
		}
		const backup = join(directory, "backup.sqlite")
		store.database.query("VACUUM INTO ?").run(backup)
		store.database.close()
		const restored = new InspectionStore(backup)
		expect((await site(restored).request("/r/" + queued)).status).toBe(200)
		const bytes = await (await site(restored).request("/patches/" + id + ".patch")).arrayBuffer()
		expect(createHash("sha256").update(new Uint8Array(bytes)).digest("hex")).toBe(id)
		expect(restored.snapshot(interrupted)?.state).toBe("interrupted")
		restored.database.close()
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
})

async function waitFor(condition: () => boolean): Promise<void> {
	for (let count = 0; count < 100; count++) {
		if (condition()) {
			return
		}
		await Bun.sleep(5)
	}
	throw new Error("Timed out waiting for inspection state")
}

test("queue honors the worker bound and retries a short ID collision", async () => {
	const ids = ["first", "first", "second", "third"]
	const store = new InspectionStore(":memory:", () => ids.shift() ?? "unexpected")
	const gate = Promise.withResolvers<void>()
	let started = 0
	const inspections = new Inspections(
		store,
		{
			...replay,
			verify: async () => {
				started++
				await gate.promise
			},
		},
		2,
	)
	await inspections.start()
	const accepted = Array.from({ length: 3 }, () => inspections.submit(repository))
	await waitFor(() => started === 2)
	expect(accepted).toEqual(["first", "second", "third"])
	expect(store.row("third")?.state).toBe("queued")
	gate.resolve()
	await waitFor(() => store.row("third")?.state === "complete")
	store.database.close()
})

test("reconnect honors the native cursor, streams appended rows and waits for publication", async () => {
	const store = new InspectionStore(":memory:")
	const inspections = new Inspections(store, replay)
	const app = createSite({ inspections, origin, replay: true, assets: { script: "/app.js", styles: [] } })
	const id = store.enqueue(repository)
	const output = await replay.inspect(repository, () => {})
	const events = output.report.timeline
	for (const event of events.slice(0, 4)) {
		store.append(id, event)
	}
	const path = `/api/inspections/${id}/events?after=0`
	const open = async (after: string): Promise<ReadableStreamDefaultReader<Uint8Array>> => {
		const response = await app.request(path, { headers: { "Last-Event-ID": after } })
		if (!response.body) {
			throw new Error("Missing event stream")
		}
		return response.body.getReader()
	}
	const read = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> => {
		const { done, value } = await reader.read()
		if (done) {
			throw new Error("Inspection stream ended before the expected event")
		}
		return new TextDecoder().decode(value)
	}
	const first = await open("0")
	expect(await read(first)).toContain("id: 4")
	await first.cancel()
	expect(inspections.changes.listenerCount(id)).toBe(0)
	for (const event of events.slice(4, 6)) {
		store.append(id, event)
	}
	const reader = await open("4")
	const backlog = await read(reader)
	expect(backlog).toContain("id: 5")
	expect(backlog).not.toContain("id: 4")
	expect(await read(reader)).toContain("heartbeat")
	for (const event of events.slice(6)) {
		store.append(id, event)
	}
	inspections.changes.emit(id)
	let resumed = await read(reader)
	while (!resumed.includes("inspection.finished")) {
		resumed += await read(reader)
	}
	expect(resumed).toContain("inspection.finished")
	expect(await read(reader)).toContain("heartbeat")
	store.finish(id, publishReport(output, "MIT"))
	inspections.changes.emit(id)
	expect(await read(reader)).toContain("event: terminal")
	const terminal = await open(String(events.length))
	expect(await read(terminal)).toContain("data: complete")
	store.database.close()
})

test("server HTML renders each Verdict, license decision, evidence and preview before JavaScript", async () => {
	const store = new InspectionStore(":memory:")
	const app = site(store)
	const output = await replay.inspect(repository, () => {})
	const upgrade = output.report.upgrades[0]
	if (!upgrade) {
		throw new Error("fixture requires an upgrade")
	}
	upgrade.from = { "workspace-a": "1.0", "workspace-b": "1.1" }
	upgrade.observation = {
		complete: false,
		reason: "The network trace ended early.",
		findings: [
			{ kind: "connection", destination: "example.org", outcome: "blocked" },
			{ kind: "connection", destination: "example.net", outcome: "unknown" },
		],
	}
	upgrade.releaseSummary.text = "</script><script>alert(1)</script>"
	output.report.limits = {
		maxDurationMs: 60000,
		maxCostUsd: 1,
		agent: {
			repair: { maxTurns: 4, maxDurationMs: 20000, maxCostUsd: 0.5 },
			featureAdoption: { maxTurns: 0, maxDurationMs: 0, maxCostUsd: 0 },
		},
	}
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
	upgrade.diagnosis = { breakingChange: "Configuration changed", actions: [], stopReason: "Turn limit reached" }
	upgrade.modelUsage.push({ role: "repair", modelId: "fixture", step: "repair", durationMs: 2, reservedUsd: 0.004 })
	patchForReview.verification = {
		...output.report.baseline,
		installation: upgrade.observation,
		testNetwork: upgrade.observation,
		addedCases: [],
	}
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
		expect(html).not.toContain("No findings.")
		expect(html).not.toContain(upgrade.releaseSummary.text)
	}
	const withheld = store.enqueue(repository)
	store.finish(withheld, publishReport(output, null))
	const html = await (await app.request("/r/" + withheld)).text()
	expect(html).toContain("Findings only")
	expect(html).not.toContain(upgrade.patches[0]?.prompt ?? "Copy patch instructions")
	expect(html).not.toContain("/patches/")
	expect((await app.request("/patches/" + "0".repeat(64) + ".patch")).status).toBe(404)
	const patch = upgrade.patches[0]
	if (!patch) {
		throw new Error("missing patch")
	}
	patch.mailbox += "changed"
	expect(() => publishReport(output, "MIT")).toThrow("verification")
	store.database.close()
})

test("unlicensed reports withhold patch bytes and raw details through HTTP and SSE", async () => {
	const store = new InspectionStore(":memory:")
	const source = {
		...replay,
		license: async (): Promise<string | null> => {
			throw new Error("lookup unavailable")
		},
	}
	const inspections = new Inspections(store, source)
	await inspections.start()
	const id = inspections.submit(repository)
	await waitFor(() => store.row(id)?.state === "complete")
	const output = await replay.inspect(repository, () => {})
	const patch = output.report.upgrades[0]?.patches[0]
	if (!patch) {
		throw new Error("Missing Patch")
	}
	store.append(id, {
		version: 1,
		inspectionId: "fixture",
		sequence: 100,
		timestamp: new Date().toISOString(),
		type: "detail",
		stepId: "step",
		stream: "stdout",
		text: patch.mailbox,
		truncated: false,
	})
	const app = site(store)
	const html = await (await app.request("/r/" + id)).text()
	const stream = await (await app.request("/api/inspections/" + id + "/events?after=99")).text()
	for (const body of [html, stream]) {
		expect(body).toContain("Output withheld")
		expect(body).not.toContain(patch.mailbox)
		expect(body).not.toContain(patch.prompt)
		expect(body).not.toContain(patch.digest)
	}
	expect((await app.request("/patches/" + patch.digest + ".patch")).status).toBe(404)
	store.database.close()
})

test("unsupported and ambiguous projects preserve detection reasons without upgrades", async () => {
	const output = await replay.inspect(repository, () => {})
	const store = new InspectionStore(":memory:")
	const app = site(store)
	for (const reason of ["missing root package manifest", "ambiguous package manager"]) {
		output.report.upgrades = []
		output.report.packageManager = { reason }
		const id = store.enqueue(repository)
		store.finish(id, publishReport(output, null))
		const html = await (await app.request("/r/" + id)).text()
		expect(html).toContain(reason)
		expect(html).toContain("JavaScript and TypeScript")
		expect(html).toContain("No upgrades inspected")
	}
	store.database.close()
})

test("failed visibility verification terminates the stream before inspection", async () => {
	const store = new InspectionStore(":memory:")
	const inspections = new Inspections(store, replay)
	await inspections.start()
	const id = inspections.submit("https://github.com/example/missing")
	await waitFor(() => store.row(id)?.state === "failed")
	expect(store.publicEvents(id, 0)).toHaveLength(0)
	const app = site(store)
	expect(await (await app.request("/api/inspections/" + id + "/events")).text()).toContain("data: failed")
	expect(await (await app.request("/r/" + id)).text()).toContain("Inspection failed")
	store.database.close()
})
