import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { matchesGlob } from "node:path"
import { test } from "node:test"
import { listUpgrades, type UpgradeMenu } from "../src/index.ts"
import { createFakeGithub } from "../src/upgrades/createFakeGithub.ts"
import { isBoundedGlob } from "../src/upgrades/isBoundedGlob.ts"
import { isExcluded, readCommittedReleaseAge, toReleaseAge } from "../src/upgrades/readCommittedReleaseAge.ts"
import { readLockedDependencies, selectWorkspaceDirectories } from "../src/upgrades/readLockedDependencies.ts"
import { fakeRepositoryUrl } from "./readFixtureProject.ts"

async function listFiles(files: Record<string, string>): Promise<UpgradeMenu> {
	const repositories = { "example/project": { files: new Map(Object.entries(files)) } }
	const github = createFakeGithub({ repositories, versions: { "1.99.0": {} } })
	return listUpgrades({ repositoryUrl: fakeRepositoryUrl, request: github.request })
}

// a manifest whose dependency names are members of every object's prototype
const prototypeMemberNames =
	'{"dependencies":{"__proto__":"1.0.0","constructor":"^1.0.0","toString":"^1.0.0","widget":"^1.0.0"}}'
const prototypeMemberSkips = [
	". __proto__: unsupported or unresolved source",
	". constructor: unsupported or unresolved source",
	". toString: unsupported or unresolved source",
]

test("prototype member names are skipped in every lockfile format and change no shared object", async () => {
	const lockfiles: Record<string, string> = {
		"package-lock.json": '{"lockfileVersion":3,"packages":{"node_modules/widget":{"version":"1.0.0"}}}',
		"pnpm-lock.yaml": "importers:\n  .:\n    dependencies:\n      widget:\n        version: 1.0.0\n",
		"bun.lock": '{"workspaces":{"__proto__":{"name":"evil"}},"packages":{"widget":["widget@1.0.0"]}}',
		"yarn.lock": 'widget@^1.0.0:\n  version "1.0.0"\n',
	}
	for (const [lockfileName, lockfileText] of Object.entries(lockfiles)) {
		const upgradeMenu = await listFiles({ "package.json": prototypeMemberNames, [lockfileName]: lockfileText })

		// only the real dependency is offered and the prototype members are listed as skipped
		assert.deepEqual(
			upgradeMenu.dependencies.map((choice) => choice.dependency),
			["widget"],
			lockfileName,
		)
		assert.deepEqual(upgradeMenu.skipped, prototypeMemberSkips, lockfileName)
	}
	assert.deepEqual(Object.keys(Object.prototype), [])
	assert.equal(({} as Record<string, unknown>).name, undefined)
})

test("a locked dependency named like a prototype member is an ordinary entry or is left out", async () => {
	const upgradeMenu = await listFiles({
		"package.json": '{"dependencies":{"__proto__":"^1.0.0","constructor":"^1.0.0"}}',
		"package-lock.json":
			'{"packages":{"node_modules/__proto__":{"version":"1.0.0"},"node_modules/constructor":{"version":"1.0.0"}}}',
	})

	// constructor is a real package name. npm allows no name that starts with an underscore
	const constructorChoice = upgradeMenu.dependencies.find((choice) => choice.dependency === "constructor")
	assert.deepEqual({ ...constructorChoice?.targets[0]?.from }, { ".": "1.0.0" })
	assert.ok(upgradeMenu.dependencies.length <= 2)
	assert.deepEqual(Object.keys(Object.prototype), [])
	assert.equal(Object.getPrototypeOf({}), Object.prototype)
})

test("untrusted workspace paths and lock keys resolve nothing", () => {
	const lockedDependencies = readLockedDependencies({
		files: new Map([
			["package.json", '{"dependencies":{"widget":"^1.0.0"}}'],
			["__proto__/package.json", '{"dependencies":{"widget":"^1.0.0"}}'],
			["pnpm-lock.yaml", "importers:\n  .:\n    dependencies:\n      widget:\n        version: 1.0.0\n"],
		]),
		lockfileNames: ["pnpm-lock.yaml"],
		workspaceDirectories: ["__proto__"],
	})
	assert.deepEqual(lockedDependencies.skipped, ["__proto__ widget: unsupported or unresolved source"])
	assert.deepEqual({ ...lockedDependencies.sources }, {})
})

test("deep nesting, alias expansion and long lines end with a reason and leave the process running", async () => {
	const deepJson = `${"[".repeat(400_000)}${"]".repeat(400_000)}`
	const deepYaml = `importers: ${"[".repeat(20_000)}${"]".repeat(20_000)}\n`
	const aliases = ["a: &a [x,x,x,x,x,x,x,x,x,x]"]
	for (const [previous, next] of [..."abcdefgh"].map((letter, index, letters): [string, string] => [
		letter,
		letters[index + 1] ?? "z",
	])) {
		aliases.push(`${next}: &${next} [${Array(10).fill(`*${previous}`).join(",")}]`)
	}
	const cases: [string, Record<string, string>][] = [
		["a deep manifest", { "package.json": `{"dependencies":${deepJson}}`, "package-lock.json": "{}" }],
		["a deep npm lockfile", { "package.json": prototypeMemberNames, "package-lock.json": deepJson }],
		["a deep pnpm lockfile", { "package.json": prototypeMemberNames, "pnpm-lock.yaml": deepYaml }],
		[
			"an alias bomb",
			{ "package.json": prototypeMemberNames, "pnpm-lock.yaml": `${aliases.join("\n")}\nimporters: *z\n` },
		],
		["a long yarn line", { "package.json": prototypeMemberNames, "yarn.lock": `${"a".repeat(900_000)}\n` }],
		["a manifest that is not an object", { "package.json": "[]", "package-lock.json": "{}" }],
		["an invalid manifest", { "package.json": "{", "package-lock.json": "{}" }],
	]
	for (const [label, files] of cases) {
		const started = performance.now()
		const upgradeMenu = await listFiles(files)

		// nothing is offered from a file the parser gave up on, and the parser's message stays out
		assert.ok(performance.now() - started < 5000, label)
		assert.ok(
			upgradeMenu.dependencies.every((choice) => choice.dependency === "widget"),
			label,
		)
		if ("reason" in upgradeMenu.packageManager) {
			assert.match(upgradeMenu.packageManager.reason, /^(Unreadable project file|Unsupported [a-z ]+)$/, label)
		}
	}
})

test("glob patterns that a backtracking matcher retries are rejected", () => {
	const accepted = ["packages/*", "apps/**", "**/*", "packages/*-plugin-*", "!**/__tests__/**", "libs/{a,b,c}/*"]
	const rejected = [
		"*a*a*a*b",
		"a".repeat(257),
		"{a,b}{c,d}{e,f}",
		`{${Array.from({ length: 18 }, (_, index) => `a${index}`).join(",")}}`,
		"???*",
	]
	assert.deepEqual(accepted.filter(isBoundedGlob), accepted)
	assert.deepEqual(rejected.filter(isBoundedGlob), [])

	// a rejected pattern stops workspace selection and is dropped from an exemption list
	const select = (pattern: string): string[] =>
		selectWorkspaceDirectories({
			rootManifest: JSON.stringify({ workspaces: [pattern] }),
			filePaths: ["a/b/package.json"],
		})
	assert.throws(() => select("*a*a*a*b"), /Unsupported workspace declaration/)
	const releaseAge = toReleaseAge(0, ["@scope/*", "*a*a*a*b", 7, ...Array(300).fill("x")])
	assert.equal(releaseAge.excluded.length, 254)
	assert.ok(isExcluded("@scope/name", releaseAge))
})

// the slowest patterns the bounds still accept, against the longest directory a tree can list
const slowestAccepted = [
	`${"a".repeat(120)}*${"a".repeat(120)}*b`,
	`${"**/".repeat(80)}*a*b`,
	`{${Array.from({ length: 9 }, (_, index) => `a${index}`).join(",")}}/{${Array.from({ length: 9 }, (_, index) => `b${index}`).join(",")}}/*a*`,
]
const longestDirectory = `${"a/".repeat(100)}${"a".repeat(255)}`

test("the slowest accepted pattern matches inside 100 ms on Bun and on Node", () => {
	for (const pattern of slowestAccepted) {
		assert.ok(isBoundedGlob(pattern), pattern)
		const started = performance.now()
		matchesGlob(longestDirectory, pattern)
		assert.ok(performance.now() - started < 100, pattern)
	}

	// time the same matches under Node, whose matcher backtracks
	const script = `const { matchesGlob } = require("node:path"); const [directory, ...patterns] = JSON.parse(process.argv[1]);
		for (const pattern of patterns) { const started = performance.now(); matchesGlob(directory, pattern);
		if (performance.now() - started > 100) { console.error(pattern); process.exit(1) } }`
	const node = spawnSync("node", ["-e", script, JSON.stringify([longestDirectory, ...slowestAccepted])], {
		encoding: "utf8",
		timeout: 20000,
	})

	// skip only a machine without node. a matcher that runs past the timeout fails the test
	const isNodeMissing = (node.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
	if (!isNodeMissing) {
		assert.equal(node.error, undefined)
		assert.equal(node.status, 0, node.stderr)
	}
})

test("configuration lines built to make a matcher retry are read in linear time", () => {
	// a value that ends in a long run of spaces, and a duration that is a long run of digits
	const npmrc = `min-release-age=3${" ".repeat(250000)}x\n`
	const yarnrc = `npmMinimalAgeGate: "${"1".repeat(250000)}x"\n`
	const started = performance.now()
	const npm = readCommittedReleaseAge({
		manager: "npm",
		packageManagerVersion: "11.11.0",
		files: new Map([[".npmrc", npmrc]]),
	})
	const yarn = readCommittedReleaseAge({
		manager: "yarn",
		packageManagerVersion: "4.12.0",
		files: new Map([[".yarnrc.yml", yarnrc]]),
	})

	// both values are unreadable, so one day is assumed, and neither costs more than a moment
	assert.equal(npm.minimumReleaseAge?.isAssumed, true)
	assert.equal(yarn.minimumReleaseAge?.isAssumed, true)
	assert.ok(performance.now() - started < 1000)
})

test("extended globs are rejected before a matcher sees them", () => {
	const pattern = `${"+(a)".repeat(20)}b`
	assert.equal(isBoundedGlob(pattern), false)
	assert.equal(isBoundedGlob("packages/!(internal)"), false)
	assert.equal(isBoundedGlob("packages/{1..20}"), false)
	assert.equal(isBoundedGlob("packages/{app,lib}"), true)

	// check that workspace selection rejects the pattern instead of matching it
	assert.throws(
		() =>
			selectWorkspaceDirectories({
				rootManifest: JSON.stringify({ workspaces: [pattern] }),
				filePaths: [`${"a".repeat(40)}c/package.json`],
			}),
		/Unsupported workspace declaration/,
	)
})

test("a manifest cannot grow the skipped list past the declaration bound or with a long name", async () => {
	// more declarations than one project can hold
	const many = Object.fromEntries(Array.from({ length: 10001 }, (_, index) => [`d${index}`, "1"]))
	const crowded = await listFiles({
		"package.json": JSON.stringify({ dependencies: many }),
		"package-lock.json": '{"lockfileVersion":3,"packages":{}}',
	})
	assert.deepEqual(crowded.packageManager, { reason: "More than 10000 declared dependencies" })
	assert.deepEqual(crowded.skipped, [])

	// a name longer than any registry package is listed by its first characters only
	const long = await listFiles({
		"package.json": JSON.stringify({ dependencies: { ["x".repeat(100000)]: "^1.0.0" } }),
		"package-lock.json": '{"lockfileVersion":3,"packages":{}}',
	})
	assert.deepEqual(long.skipped, [`. ${"x".repeat(32)}…: unsupported or unresolved source`])
})

test("a limit message starts with fixed text and prints a path without control characters", async () => {
	// a workspace directory named like a workflow command, holding a manifest over its bound
	const directory = "::error::rotate your token\n"
	const upgradeMenu = await listFiles({
		"package.json": JSON.stringify({ workspaces: ["*"] }),
		"package-lock.json": '{"lockfileVersion":3,"packages":{}}',
		[`${directory}/package.json`]: `{"name":"${"n".repeat(1100000)}"}`,
	})
	assert.equal(upgradeMenu.unreadable?.reason, "limit")
	assert.match(
		upgradeMenu.unreadable?.message ?? "",
		/^The file ::error::rotate your token\?\/package\.json is 1\.0 MiB\./,
	)
})
