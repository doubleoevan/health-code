import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { collectJsonInventory } from "../guest/collectTestInventory.ts"
import { isNodeTestScript, reporterArguments, reporterEnvironment } from "../guest/readTestReport.ts"

const reporter = fileURLToPath(new URL("../guest/nodeTestReporter.ts", import.meta.url))

test("Node's test runner reports nested, skipped and failing cases and unloadable files", () => {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "health-code-node-tests-")))
	try {
		// cover each outcome in one file and a load error in another
		writeFileSync(
			join(directory, "cases.test.mjs"),
			`import { describe, it, test } from "node:test"
describe("outer", () => {
	it("passes", () => {})
	it("fails", () => { throw new Error("broken") })
	it.skip("skips", () => {})
	it.todo("later")
})
test("parent", async (context) => { await context.test("child", () => {}) })
`,
		)
		writeFileSync(join(directory, "crash.test.mjs"), 'import "./missing.mjs"\n')

		// run outside the current test runner's context
		const { NODE_TEST_CONTEXT: _context, NODE_OPTIONS: _options, ...env } = process.env
		const run = spawnSync("node", ["--test", `--test-reporter=${reporter}`, "cases.test.mjs", "crash.test.mjs"], {
			cwd: directory,
			encoding: "utf8",
			env,
		})
		const inventory = collectJsonInventory(run.stdout, directory)

		// keep the suite path apart from the case title
		assert.deepEqual(inventory.counts, { passed: 3, failed: 1, skipped: 1, todo: 1 })
		assert.deepEqual(
			inventory.cases.map(({ name, status }) => [name, status]),
			[
				['["outer","passes"]', "passed"],
				['["outer","fails"]', "failed"],
				['["outer","skips"]', "skipped"],
				['["outer","later"]', "todo"],
				['["parent","child"]', "passed"],
				["parent", "passed"],
			],
		)
		assert.deepEqual(
			inventory.testFileErrors.map(({ file }) => file),
			["crash.test.mjs"],
		)
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
})

test("only unmodified Node test commands receive the reporter", () => {
	const recognized = [
		"node --test",
		"tsx --test server/*.test.ts packages/ui/src/*.test.tsx",
		"npm run check && tsx --test 'src/**/*.test.ts'",
		"node --import tsx --test --test-concurrency=1 src/a.test.ts",
	]
	const rejected = [
		"",
		"tsx src/run.ts",
		"node --test --test-reporter=dot",
		"node --test --watch",
		"node --test --import ./setup.mjs",
		"node --test; echo done",
		"node --test && echo done",
		"NODE_ENV=test node --test",
	]

	// accept the runner only as the last command with known flags
	assert.deepEqual(
		recognized.filter((script) => !isNodeTestScript(script)),
		[],
	)
	assert.deepEqual(rejected.filter(isNodeTestScript), [])
	assert.deepEqual(reporterEnvironment("vitest"), {})
	assert.match(reporterEnvironment("node --test", "/inspection-report").NODE_OPTIONS ?? "", /=\/inspection-report$/)
})

test("a runner after a build step receives its reporter", () => {
	assert.deepEqual(reporterArguments("bun run build && bun test ./scripts ./apps"), reporterArguments("bun test"))
	assert.deepEqual(reporterArguments("tsc && vitest run"), reporterArguments("vitest"))

	// leave a runner without its own arguments at exit status
	for (const script of ["bun test && bun run lint", "bun test | tee log", "build; jest"]) {
		assert.deepEqual(reporterArguments(script), [])
	}
})
