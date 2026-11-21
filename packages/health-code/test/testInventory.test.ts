import assert from "node:assert/strict"
import { test } from "node:test"
import { type Integrity, verifyCases } from "../src/verifyCandidate.ts"

test("final discovery preserves every comparable case and loaded suite", () => {
	const initial: Integrity = {
		files: [],
		hooks: [],
		testFileErrors: [],
		discoveredFiles: ["custom/empty.ts", "custom/check.ts"],
		cases: [
			["custom/check.ts", "passes", "passed"],
			["custom/check.ts", "fails", "failed"],
		],
	}
	const [passes, fails] = initial.cases
	assert.ok(passes && fails)
	const changed = (cases: Integrity["cases"]): void => verifyCases(initial, { ...initial, cases })
	assert.doesNotThrow(() => changed([passes, fails, ["custom/check.ts", "additional", "passed"]]))
	assert.throws(() => changed([passes, passes]), /ambiguous/)
	assert.throws(() => changed([passes]), /omitted/)
	assert.throws(() => changed([passes, ["custom/check.ts", "fails", "skipped"]]), /weakened/)
	assert.throws(() => changed([passes, fails, ["custom/check.ts", "new failure", "failed"]]), /New failures/)
	assert.throws(() => verifyCases(initial, { ...initial, discoveredFiles: ["custom/check.ts"] }), /disappeared/)
})

test("repeated Baseline titles retain every passing invocation", () => {
	const repeated = ["advisories.test.ts", "invalid audit output fails closed", "passed"] as const
	const cases: Integrity["cases"] = Array.from({ length: 4 }, () => [...repeated])
	const initial: Integrity = { cases, files: [], hooks: [], testFileErrors: [] }
	const compare = (current: Integrity["cases"]): void => verifyCases(initial, { ...initial, cases: current })
	assert.doesNotThrow(() => compare(cases))
	assert.throws(() => compare(cases.slice(1)), /ambiguous|omitted/)
	assert.throws(() => compare([...cases, [...repeated]]), /ambiguous/)
	for (const state of ["failed", "skipped", "todo"] as const) {
		const mixed: Integrity["cases"] = [...cases.slice(1), [repeated[0], repeated[1], state]]
		assert.throws(() => compare(mixed), /ambiguous/)
		assert.throws(() => verifyCases({ ...initial, cases: mixed }, initial), /ambiguous/)
	}
})

test("runner suite and case titles retain their boundaries", async () => {
	const { jsonCaseName, caseMatchesTitle } = await import("../src/testCaseName.ts")
	const left = jsonCaseName({ ancestorTitles: ["outer", "inner"], title: "example" })
	const right = jsonCaseName({ ancestorTitles: ["outer"], title: "inner > example" })
	assert.notEqual(left, right)
	assert.equal(caseMatchesTitle(jsonCaseName({ title: "", ancestorTitles: [] }), ""), true)
	assert.equal(caseMatchesTitle(left, left), false)
	assert.equal(caseMatchesTitle(jsonCaseName({ fullName: left }), left), true)
	assert.equal(caseMatchesTitle(right, "example"), false)
	assert.equal(caseMatchesTitle(left, "example"), true)
})
