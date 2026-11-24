import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { collectJsonInventory } from "../guest/collectTestInventory.ts"
import { selectRegistryVersions } from "../guest/selectRegistryVersions.ts"
import type { Locator } from "../src/agentContracts.ts"
import { verifyMatch } from "../src/inspection/rankFeatureMatches.ts"
import { locateDiagnostics } from "../src/inspection/readUpgradeEvidence.ts"

test("inspected usage distinguishes aliases, shadowed names, generated source and dynamic imports", async () => {
	const root = mkdtempSync(join(tmpdir(), "usage-fixture-"))
	const guest = new URL("../guest/readUsage.ts", import.meta.url).href
	const measure = (expression: string): unknown =>
		JSON.parse(
			execFileSync(
				"bun",
				[
					"-e",
					`import {readUsage,installedBytes} from ${JSON.stringify(guest)};console.log(JSON.stringify(${expression}))`,
				],
				{ cwd: root, encoding: "utf8" },
			),
		)
	try {
		// build a workspace with aliased, shadowed and dynamic usage
		mkdirSync(join(root, "apps/a"), { recursive: true })
		writeFileSync(join(root, "package.json"), '{"workspaces":["apps/*"]}')
		writeFileSync(join(root, "apps/a/package.json"), '{"name":"fixture"}')
		writeFileSync(
			join(root, "apps/a/index.ts"),
			'import { example as alias } from "widget"\nalias()\nfunction f(alias){alias()}\nimport("widget")\n',
		)
		writeFileSync(join(root, "apps/a/unknown.ts"), "import(variableName)")
		writeFileSync(join(root, "apps/a/subpath.ts"), 'void import("widget/lib/a.js")\nimport "widget-other"\n')
		writeFileSync(join(root, "apps/a/widget.d.ts"), 'declare module "widget/lib/a.js" {}\n')
		writeFileSync(join(root, "gen.ts"), '// @generated\nimport "widget"')

		// check the verified call sites against the inspected source
		const data = measure('readUsage("widget")') as {
			usage: { file: string; symbol: string; workspace: string; line: number }[]
			unresolved: string[]
		}
		assert.deepEqual(
			data.usage.map((entry) => [entry.file, entry.symbol, entry.line, entry.workspace].join(" ")).sort(),
			[
				"apps/a/index.ts dynamic import 4 apps/a",
				"apps/a/index.ts example 2 apps/a",
				"apps/a/index.ts import 1 apps/a",
				"apps/a/subpath.ts dynamic import 1 apps/a",
				"apps/a/widget.d.ts module declaration 1 apps/a",
			],
		)
		assert.deepEqual(data.unresolved, ["apps/a/unknown.ts"])

		// measure shared installed files once across workspace links
		assert.equal(measure("installedBytes()"), null)
		mkdirSync(join(root, "node_modules"))
		mkdirSync(join(root, "apps/a/node_modules"))
		writeFileSync(join(root, "node_modules/a"), "bytes")
		linkSync(join(root, "node_modules/a"), join(root, "apps/a/node_modules/a"))
		symlinkSync(join(root, "apps/a"), join(root, "node_modules/workspace"))
		assert.equal(measure("installedBytes()"), 5)

		// resolve diagnostic links only for lines present in the inspected source
		const locators: Locator[] = [
			{ file: "my file.ts", line: 2 },
			{ file: "missing.ts", line: 3 },
		]
		await locateDiagnostics({
			repository: { url: "https://github.com/test/project", commit: "a".repeat(40) },
			locators,
			read: async () => "one\ntwo",
		})
		assert.match(locators[0]?.url ?? "", /my%20file.ts#L2$/)
		assert.equal(locators[1]?.url, undefined)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test("package lookups retain older stable versions for repository release-age policies", () => {
	const versions = ["1.0.0", "2.0.2", "2.0.0", "2.0.3", "2.0.1", "2.1.0-rc.1"]
	assert.deepEqual(selectRegistryVersions(versions, false), ["2.0.3", "1.0.0"])
	assert.deepEqual(selectRegistryVersions(versions, true), ["2.0.3", "2.0.2", "2.0.0", "1.0.0"])
})

test("feature ranking uses the cited symbol and distinct verified call sites", () => {
	const file = "src/library.ts"
	const usage = {
		usage: [1, 2].map((line) => ({ file, line, symbol: "old", text: "old()", workspace: "." })),
		unresolved: [],
		changelog: "",
	}

	// propose a release-backed match with one unverified call site
	const source = "notes"
	const quote = "Replace old with current."
	const entry = {
		feature: "current",
		kind: "deprecated" as const,
		source,
		file,
		line: 1,
		symbol: "old",
		directQuote: quote,
		sites: [1, 2, 3].map((line) => ({ file, line })),
	}
	const input = {
		match: entry,
		usage,
		repository: { url: "https://github.com/test/fixture", commit: "a".repeat(40) },
		notes: [{ source, text: quote, workspaces: ["."] }],
	}

	// compare replacement direction and negation in the cited text
	for (const [text, expected] of [
		["current replaces old", "direct"],
		["old replaces current", "inferred"],
		["current doesn’t replace old", "inferred"],
	]) {
		assert.equal(
			verifyMatch({
				...input,
				match: { ...entry, directQuote: text },
				notes: [{ source, text: text ?? "", workspaces: ["."] }],
			})?.replacement,
			expected,
		)
	}

	// retain the supporting quote across multiple release notes
	const verified = verifyMatch({
		...input,
		notes: [{ source, text: "Earlier release", workspaces: ["."] }, ...input.notes],
	})

	// treat an unrelated mention of both symbols as inferred
	const unrelated = "The old behavior is unchanged in current."
	assert.equal(
		verifyMatch({
			...input,
			match: { ...entry, directQuote: unrelated },
			notes: [{ source, text: unrelated, workspaces: ["."] }],
		})?.replacement,
		"inferred",
	)

	// verify only call sites supported by inspected usage
	assert.equal(verified?.replacement, "direct")
	assert.deepEqual(
		verified?.callSites?.map((loc) => loc.line),
		[1, 2],
	)
	assert.equal(verifyMatch({ ...input, match: { ...entry, directQuote: "unsupported" } })?.replacement, "inferred")
	assert.equal(verifyMatch({ ...input, match: { ...entry, symbol: "different" } }), undefined)
})

test("a JSON suite that fails to load reports the first line of its runner error", () => {
	const suite = { name: "/project/a.test.ts", status: "failed", assertionResults: [] }
	const toReasons = (message?: string): string[] =>
		collectJsonInventory(
			JSON.stringify({
				testResults: [{ ...suite, message }],
				numTotalTests: 0,
				numPassedTests: 0,
				numFailedTests: 0,
			}),
			"/project",
		).testFileErrors.map((entry) => entry.reason)

	// remove terminal codes and the sandbox root
	assert.deepEqual(toReasons("\u001b[31mCannot resolve widget in /project/a.ts\u001b[0m\nstack"), [
		"Cannot resolve widget in a.ts",
	])
	assert.deepEqual(toReasons(), ["Suite failed before reporting a failing test"])
})
