import assert from "node:assert/strict"
import { test } from "node:test"
import { mergeTestInventory } from "../src/inspection/mergeTestInventory.ts"
import {
	type PatchVerificationInputs,
	readPatchVerificationInputs,
	verifyCases,
} from "../src/patches/verifyCandidate.ts"

test("final discovery preserves every comparable case and loaded suite", () => {
	const initial: PatchVerificationInputs = {
		projectFilePaths: [],
		lifecycleHookSignatures: [],
		testFileErrors: [],
		discoveredTestFiles: ["custom/empty.ts", "custom/check.ts"],
		cases: [
			["custom/check.ts", "passes", "passed"],
			["custom/check.ts", "fails", "failed"],
		],
	}
	const [passes, fails] = initial.cases
	assert.ok(passes && fails)

	// compare case inventories against the discovered baseline
	const changed = (cases: PatchVerificationInputs["cases"]): void => verifyCases(initial, { ...initial, cases })
	assert.doesNotThrow(() => changed([passes, fails, ["custom/check.ts", "additional", "passed"]]))

	// reject ambiguous, omitted and weakened cases
	assert.throws(() => changed([passes, passes]), /ambiguous/)
	assert.throws(() => changed([passes]), /omitted/)
	assert.throws(() => changed([passes, ["custom/check.ts", "fails", "skipped"]]), /weakened/)
	assert.throws(() => changed([passes, fails, ["custom/check.ts", "new failure", "failed"]]), /New failures/)

	// require the empty suite to remain discoverable
	assert.throws(() => verifyCases(initial, { ...initial, discoveredTestFiles: ["custom/check.ts"] }), /disappeared/)
})

test("repeated Baseline titles retain every passing invocation", () => {
	const repeated = ["advisories.test.ts", "invalid audit output fails closed", "passed"] as const
	const cases: PatchVerificationInputs["cases"] = Array.from({ length: 4 }, () => [...repeated])
	const initial: PatchVerificationInputs = {
		cases,
		projectFilePaths: [],
		lifecycleHookSignatures: [],
		testFileErrors: [],
	}

	// compare invocation counts before accepting repeated titles
	const compare = (current: PatchVerificationInputs["cases"]): void =>
		verifyCases(initial, { ...initial, cases: current })
	assert.doesNotThrow(() => compare(cases))
	assert.throws(() => compare(cases.slice(1)), /ambiguous|omitted/)
	assert.throws(() => compare([...cases, [...repeated]]), /ambiguous/)

	// reject mixed outcomes for indistinguishable invocations in either inventory
	for (const state of ["failed", "skipped", "todo"] as const) {
		const mixed: PatchVerificationInputs["cases"] = [...cases.slice(1), [repeated[0], repeated[1], state]]
		assert.throws(() => compare(mixed), /ambiguous/)
		assert.throws(() => verifyCases({ ...initial, cases: mixed }, initial), /ambiguous/)
	}
})

test("runner suite and case titles retain their boundaries", async () => {
	const { jsonCaseName, caseMatchesTitle } = await import("../src/patches/testCaseName.ts")
	const left = jsonCaseName({ ancestorTitles: ["outer", "inner"], title: "example" })
	const right = jsonCaseName({ ancestorTitles: ["outer"], title: "inner > example" })
	assert.notEqual(left, right)

	// distinguish a literal title match from a structured suite path
	assert.equal(caseMatchesTitle(jsonCaseName({ title: "", ancestorTitles: [] }), ""), true)
	assert.equal(caseMatchesTitle(left, left), false)
	assert.equal(caseMatchesTitle(jsonCaseName({ fullName: left }), left), true)
	assert.equal(caseMatchesTitle(right, "example"), false)
	assert.equal(caseMatchesTitle(left, "example"), true)
})

test("reads every patch verification input from an existing sandbox provider", async () => {
	const commands: string[][] = []
	const inputs = await readPatchVerificationInputs({
		async data(args) {
			commands.push(args)
			const files = ["src/widget.ts"]
			const hook = "postinstall signature"

			// Older providers use the same command with a separate offset for file and hook entries.
			if (args.length === 2) {
				return {
					files,
					hooks: [],
					cases: [["widget.test.ts", "loads", "passed"]],
					testFileErrors: [],
					nextMetadataOffset: 1,
				}
			}
			return { files: [], hooks: [hook], discoveredFiles: ["widget.test.ts"], cases: [], testFileErrors: [] }
		},
	})

	// Reassemble both pages without losing the test result from the first response.
	assert.deepEqual(commands, [
		["integrity", "0"],
		["integrity", "0", "1"],
	])
	assert.deepEqual(inputs, {
		projectFilePaths: ["src/widget.ts"],
		lifecycleHookSignatures: ["postinstall signature"],
		discoveredTestFiles: ["widget.test.ts"],
		cases: [["widget.test.ts", "loads", "passed"]],
		testFileErrors: [],
	})
})

test("a test file that fails to load is listed once", () => {
	const file = "packages/app/src/App.test.tsx"
	const counts = { passed: 1, failed: 0, skipped: 0, todo: 0 }
	const stdout = JSON.stringify({ counts, testFileErrors: [{ file, reason: "Load failed" }] })
	const commandResult = {
		exitCode: 1,
		stdout,
		stderr: "",
		durationMs: 1,
		stdoutTruncated: false,
		stderrTruncated: false,
	}

	// keep a named failure beside the same file's load error
	const reported = [
		{ workspace: "packages/app", file: "src/App.test.tsx" },
		{ workspace: "packages/app", file: "src/App.test.tsx", name: "renders" },
	]
	const check = mergeTestInventory({
		check: { status: "failed", evidence: [], failingTests: reported },
		commandResult: commandResult as Parameters<typeof mergeTestInventory>[0]["commandResult"],
		evidence: {} as Parameters<typeof mergeTestInventory>[0]["evidence"],
	})
	assert.deepEqual(check.status === "failed" && check.failingTests, reported)
})
