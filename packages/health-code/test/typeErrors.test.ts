import assert from "node:assert/strict"
import { test } from "node:test"
import type { CheckResult } from "../src/contracts.ts"
import { confirm, excludeBaselineFailures, isComparable } from "../src/inspection/confirmCheck.ts"
import { readTypeErrors } from "../src/inspection/readTypeErrors.ts"

const known = "src/a.ts(20,24): error TS2322: Type 'x' is not assignable.\n  Type 'final' is not assignable.\n"

function failed(output: string): CheckResult {
	return { status: "failed", evidence: [], failingTests: readTypeErrors(output) }
}

test("compiler errors keep their identity when lines move", () => {
	assert.deepEqual(readTypeErrors(known), [
		{ workspace: ".", file: "src/a.ts", name: "TS2322: Type 'x' is not assignable." },
	])
	assert.deepEqual(readTypeErrors(known), readTypeErrors(known.replace("20,24", "31,2")))

	// count repeated messages and leave unidentified output opaque
	assert.equal(readTypeErrors(known + known).length, 2)
	assert.notDeepEqual(readTypeErrors(known + known)[0], readTypeErrors(known + known)[1])
	assert.deepEqual(readTypeErrors(`${known}error TS5023: Unknown compiler option.\n`), [])
})

test("existing type errors permit a comparison and new ones fail", async () => {
	const baseline = failed(known)
	assert.equal(isComparable(baseline), true)
	assert.equal(isComparable(failed("crashed")), false)
	assert.equal(excludeBaselineFailures(failed(known), baseline).status, "passed")

	// report a new error and a second copy of a known message
	for (const output of [`${known}src/b.ts(1,1): error TS2304: Cannot find name 'b'.\n`, known + known, "crashed"]) {
		assert.equal(excludeBaselineFailures(failed(output), baseline).status, "failed")
	}
	const confirmed = await confirm(failed(known + known), baseline, async () => failed(known + known))
	assert.equal(confirmed.status, "failed")
	assert.equal(confirmed.status === "failed" && confirmed.failingTests.length, 1)
})
