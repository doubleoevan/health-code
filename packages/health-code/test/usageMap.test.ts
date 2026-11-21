import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { selectRegistryVersions } from "../guest/selectRegistryVersions.ts"
import type { Locator } from "../src/agentContracts.ts"
import { verifyMatch } from "../src/rankFeatureMatches.ts"
import { locateDiagnostics } from "../src/readUpgradeEvidence.ts"

test("pinned usage distinguishes aliases, shadowed names, generated source and dynamic imports", async () => {
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
		mkdirSync(join(root, "apps/a"), { recursive: true })
		writeFileSync(join(root, "package.json"), '{"workspaces":["apps/*"]}')
		writeFileSync(join(root, "apps/a/package.json"), '{"name":"fixture"}')
		writeFileSync(
			join(root, "apps/a/index.ts"),
			'import { example as alias } from "widget"\nalias()\nfunction f(alias){alias()}\nimport("widget")\n',
		)
		writeFileSync(join(root, "apps/a/unknown.ts"), "import(variableName)")
		writeFileSync(join(root, "gen.ts"), '// @generated\nimport "widget"')
		const data = measure('readUsage("widget")') as {
			usage: { symbol: string; workspace: string; line: number }[]
			unresolved: string[]
		}
		assert.deepEqual(
			data.usage.map((entry) => [entry.symbol, entry.line, entry.workspace]),
			[
				["import", 1, "apps/a"],
				["example", 2, "apps/a"],
				["dynamic import", 4, "apps/a"],
			],
		)
		assert.deepEqual(data.unresolved, ["apps/a/unknown.ts"])
		assert.equal(measure("installedBytes()"), null)
		mkdirSync(join(root, "node_modules"))
		mkdirSync(join(root, "apps/a/node_modules"))
		writeFileSync(join(root, "node_modules/a"), "bytes")
		linkSync(join(root, "node_modules/a"), join(root, "apps/a/node_modules/a"))
		symlinkSync(join(root, "apps/a"), join(root, "node_modules/workspace"))
		assert.equal(measure("installedBytes()"), 5)
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
	const verified = verifyMatch({
		...input,
		notes: [{ source, text: "Earlier release", workspaces: ["."] }, ...input.notes],
	})
	const unrelated = "The old behavior is unchanged in current."
	assert.equal(
		verifyMatch({
			...input,
			match: { ...entry, directQuote: unrelated },
			notes: [{ source, text: unrelated, workspaces: ["."] }],
		})?.replacement,
		"inferred",
	)
	assert.equal(verified?.replacement, "direct")
	assert.deepEqual(
		verified?.callSites?.map((loc) => loc.line),
		[1, 2],
	)
	assert.equal(verifyMatch({ ...input, match: { ...entry, directQuote: "unsupported" } })?.replacement, "inferred")
	assert.equal(verifyMatch({ ...input, match: { ...entry, symbol: "different" } }), undefined)
})
