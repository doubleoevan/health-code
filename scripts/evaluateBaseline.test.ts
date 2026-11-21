import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { pathToFileURL } from "node:url"
import type { InspectionReport } from "health-code"
import { openBaseline } from "./evaluateBaseline.ts"

test("record requires a complete pinned Baseline and scores only reviewed measurements", async () => {
	const dir = await mkdtemp(join(tmpdir(), "health-code-case-"))
	const path = pathToFileURL(join(dir, "case.json"))
	try {
		// seed an unmeasured baseline case
		const fixture = JSON.parse(await readFile(new URL("../evals/carlnotes-baseline.json", import.meta.url), "utf8"))
		const seed = { ...fixture, review: "unmeasured", expected: null }
		await writeFile(path, JSON.stringify(seed))

		// build a complete inspection with one test file error
		const counts = { passed: 1, failed: 0, skipped: 1, todo: 0 }
		const inventory = { counts, testFileErrors: [{ file: "missing.test.ts", reason: "Missing dependency" }] }
		const passed = { status: "passed", evidence: [] }
		const report = {
			repository: { commit: fixture.commit },
			upgrades: [],
			baseline: { install: passed, tests: { ...passed, inventory } },
			timeline: [{ type: "sandbox.event", action: "deleted" }],
		} as unknown as InspectionReport

		// reject incomplete evidence and preserve the seed
		await assert.rejects(openBaseline(path, false), /awaits review/)
		const record = await openBaseline(path, true)
		await assert.rejects(record.finish({ ...report, timeline: [] }), /Incomplete Baseline/)
		assert.deepEqual(JSON.parse(await readFile(path, "utf8")), seed)

		// record the complete inventory for review
		await record.finish(report)
		const pending = JSON.parse(await readFile(path, "utf8"))
		assert.deepEqual(pending.expected, inventory)
		assert.equal(pending.review, "pending-review")
		await assert.rejects(openBaseline(path, false), /awaits review/)
		const reviewed = JSON.stringify({
			...pending,
			review: "reviewed",
			expected: { counts, exclusions: inventory.testFileErrors },
		})

		// score current and historical inventory field names
		await writeFile(path, reviewed)
		const score = await openBaseline(path, false)
		await score.finish(report)
		const historicalReport = JSON.parse(JSON.stringify(report).replace('"testFileErrors":', '"exclusions":'))
		assert.deepEqual(await score.finish(historicalReport), inventory)

		// reject drift without rewriting the reviewed case
		inventory.testFileErrors = []
		await assert.rejects(score.finish(report), /drift/)
		assert.equal(await readFile(path, "utf8"), reviewed)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})
