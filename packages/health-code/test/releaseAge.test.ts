import assert from "node:assert/strict"
import { test } from "node:test"
import type { PackageManager } from "../src/contracts.ts"
import { packageManagerTools, toSandboxPackageManagerVersion } from "../src/sandbox/packageManagerVersions.ts"
import { readCommittedReleaseAge, toReleaseAgeNotice } from "../src/upgrades/readCommittedReleaseAge.ts"
import { fixtureNow } from "./readFixtureProject.ts"

// read the release age of one package manager version from committed file contents
function read(
	packageManager: `${PackageManager}@${string}` | PackageManager,
	files: Record<string, string> = {},
): ReturnType<typeof readCommittedReleaseAge> {
	const [manager, packageManagerVersion] = packageManager.split("@") as [PackageManager, string | undefined]
	const fileContents = new Map(Object.entries(files))
	return readCommittedReleaseAge({ manager, packageManagerVersion, files: fileContents, now: fixtureNow })
}

test("each package manager's committed configuration sets the minimum release age", () => {
	// bun measures seconds, npm days, pnpm minutes and yarn a duration
	const cases: [PackageManager, string, Record<string, string>, number, string][] = [
		["bun", "1.4.3", { "bunfig.toml": "[install]\nminimumReleaseAge = 259200\n" }, 4320, "bunfig.toml"],
		["npm", "11.11.0", { ".npmrc": "min-release-age=3\n" }, 4320, ".npmrc"],
		["pnpm", "10.19.0", { "pnpm-workspace.yaml": "minimumReleaseAge: 4320\n" }, 4320, "pnpm-workspace.yaml"],
		["pnpm", "10.19.0", { ".npmrc": "minimum-release-age=4320\n" }, 4320, ".npmrc"],
		["yarn", "4.12.0", { ".yarnrc.yml": "npmMinimalAgeGate: 3d\n" }, 4320, ".yarnrc.yml"],
		["yarn", "4.10.3", { ".yarnrc.yml": "npmMinimalAgeGate: 4320\n" }, 4320, ".yarnrc.yml"],
	]
	for (const [manager, version, files, minutes, source] of cases) {
		const { releaseAge, minimumReleaseAge } = read(`${manager}@${version}`, files)
		assert.deepEqual(minimumReleaseAge, { minutes, excluded: [], source }, `${manager} ${source}`)
		assert.equal(releaseAge?.publishedBefore, fixtureNow - minutes * 60000)
	}
})

test("exempt packages come from the same committed file", () => {
	const pnpm = read("pnpm@10.19.0", {
		"pnpm-workspace.yaml": "minimumReleaseAge: 60\nminimumReleaseAgeExclude:\n  - '@scope/*'\n",
	})
	assert.deepEqual(pnpm.releaseAge?.excluded, ["@scope/*"])
	const yarn = read("yarn@4.12.0", { ".yarnrc.yml": "npmMinimalAgeGate: 1h\nnpmPreapprovedPackages:\n  - foo\n" })
	assert.deepEqual(yarn.minimumReleaseAge, { minutes: 60, excluded: ["foo"], source: ".yarnrc.yml" })
})

test("npm prefers an explicit date and reads no other key", () => {
	const npmrc = [
		"registry=https://evil.example/",
		"//registry.npmjs.org/:_authToken=npm_secretsecretsecret",
		"before=2026-11-20T00:00:00.000Z",
		"min-release-age=30",
	].join("\n")
	const { releaseAge, minimumReleaseAge } = read("npm@11.11.0", { ".npmrc": npmrc })
	assert.equal(releaseAge?.publishedBefore, Date.parse("2026-11-20"))
	assert.equal(minimumReleaseAge?.source, ".npmrc")
	assert.doesNotMatch(JSON.stringify({ releaseAge, minimumReleaseAge }), /evil|secret/)
})

test("an unset age takes the default of the version the sandbox would run", () => {
	// the first version on each side of every default change
	assert.deepEqual(read("pnpm@10.33.0"), {})
	assert.equal(read("pnpm@11.0.0").minimumReleaseAge?.minutes, 1440)
	assert.equal(read("pnpm@11.0.0").minimumReleaseAge?.source, "pnpm 11 default")

	// pnpm gained the setting in 10.16
	const pnpmAge = { "pnpm-workspace.yaml": "minimumReleaseAge: 4320\n" }
	assert.deepEqual(read("pnpm@10.15.1", pnpmAge), {})
	assert.deepEqual(read("pnpm@9.15.9", pnpmAge), {})
	assert.equal(read("pnpm@10.16.0", pnpmAge).minimumReleaseAge?.minutes, 4320)

	// yarn gained the gate in 4.10 and its one-day default in 4.15
	assert.deepEqual(read("yarn@4.9.2", { ".yarnrc.yml": "npmMinimalAgeGate: 3d\n" }), {})
	assert.deepEqual(read("yarn@4.10.0", { ".yarnrc.yml": "nodeLinker: node-modules\n" }), {})
	assert.deepEqual(read("yarn@4.14.1"), {})
	assert.equal(read("yarn@4.15.0").minimumReleaseAge?.source, "Yarn 4.15 default")

	// classic yarn, npm and bun have no default
	assert.deepEqual(read("yarn@1.22.22"), {})
	assert.deepEqual(read("npm@11.11.0"), {})
	assert.deepEqual(read("bun@1.4.3"), {})

	// an explicit zero turns a default off
	assert.deepEqual(read("pnpm@11.2.0", { "pnpm-workspace.yaml": "minimumReleaseAge: 0\n" }), {})
	assert.deepEqual(read("yarn@4.18.0", { ".yarnrc.yml": "npmMinimalAgeGate: 0m\n" }), {})
})

test("pnpm 11 reads no age from .npmrc", () => {
	const { minimumReleaseAge } = read("pnpm@11.0.0", { ".npmrc": "minimum-release-age=10080\n" })
	assert.equal(minimumReleaseAge?.source, "pnpm 11 default")
})

test("an age the upgrade menu cannot know is assumed to be at least one day", () => {
	const cases: [string, ReturnType<typeof read>, number][] = [
		[
			"conflicting sources",
			read("pnpm@10.19.0", {
				"pnpm-workspace.yaml": "minimumReleaseAge: 60\n",
				".npmrc": "minimum-release-age=4320\n",
			}),
			4320,
		],
		["unparsable value", read("pnpm@10.19.0", { "pnpm-workspace.yaml": "minimumReleaseAge: soon\n" }), 1440],
		["unparsable file", read("bun@1.4.3", { "bunfig.toml": "[install\n" }), 1440],
		["undeclared version", read("pnpm"), 1440],
		["pnpm newer than the known defaults", read("pnpm@12.0.0"), 1440],
		["yarn newer than the known defaults", read("yarn@5.0.0"), 1440],
		["yarn duration", read("yarn@4.12.0", { ".yarnrc.yml": "npmMinimalAgeGate: soon\n" }), 1440],
		["npm date", read("npm@11.11.0", { ".npmrc": "before=soon\n" }), 1440],
	]
	for (const [label, { minimumReleaseAge, releaseAge }, minutes] of cases) {
		assert.equal(minimumReleaseAge?.isAssumed, true, label)
		assert.equal(minimumReleaseAge?.minutes, minutes, label)
		assert.ok(minimumReleaseAge?.source, label)
		assert.equal(releaseAge?.publishedBefore, fixtureNow - minutes * 60000, label)
	}
})

test("the notice names the age that was assumed", () => {
	const notice = (minutes: number): string => toReleaseAgeNotice({ minutes })
	const prefix = "The health inspector could not read this repository’s minimum release age and assumed"
	assert.equal(notice(1440), `${prefix} one day.`)
	assert.equal(notice(4320), `${prefix} 3 days.`)
	assert.equal(notice(2000), `${prefix} 2000 minutes.`)
})

test("the sandbox runs a supported declared version and otherwise its bundled version", () => {
	const resolve = (
		manager: PackageManager,
		declaredPackageManagerVersion?: string,
		files: Record<string, string> = {},
	): unknown =>
		toSandboxPackageManagerVersion({ manager, declaredPackageManagerVersion, files: new Map(Object.entries(files)) })
	assert.equal(resolve("pnpm", "11.2.0"), "11.2.0")
	assert.equal(resolve("pnpm"), packageManagerTools.pnpm.bundledPackageManagerVersion)
	assert.equal(resolve("pnpm", "7.0.0"), packageManagerTools.pnpm.bundledPackageManagerVersion)
	assert.equal(resolve("bun", "1.4.4"), "1.4.4")

	// yarn is classic or modern by its committed files, and a committed binary hides the version
	assert.equal(resolve("yarn"), packageManagerTools.yarn.bundledPackageManagerVersion)
	assert.equal(
		resolve("yarn", undefined, { ".yarnrc.yml": "nodeLinker: pnp\n" }),
		packageManagerTools["yarn-modern"].bundledPackageManagerVersion,
	)
	assert.equal(resolve("yarn", "4.15.0", { "yarn.lock": "__metadata:\n  version: 8\n" }), "4.15.0")
	assert.equal(resolve("yarn", undefined, { ".yarnrc.yml": "yarnPath: .yarn/releases/yarn.cjs\n" }), undefined)
	assert.equal(resolve("yarn", "4.18.0", { ".yarnrc.yml": "yarnPath: .yarn/releases/yarn.cjs\n" }), "4.18.0")
})

test("npm ends an unquoted value at an inline comment and pnpm assumes an age for a value that is not a number", () => {
	// a comment after the value, and a quoted value that holds a hash sign
	assert.equal(read("npm@11.11.0", { ".npmrc": "min-release-age=7 # seven days\n" }).minimumReleaseAge?.minutes, 10080)
	assert.equal(read("npm@11.11.0", { ".npmrc": "min-release-age=7 ; a week\n" }).minimumReleaseAge?.minutes, 10080)
	assert.equal(read("npm@11.11.0", { ".npmrc": 'min-release-age="3"\n' }).minimumReleaseAge?.minutes, 4320)

	// a list or an empty value is unreadable, and an explicit zero stays off
	const list = read("pnpm@10.19.0", { "pnpm-workspace.yaml": "minimumReleaseAge: []\n" })
	assert.equal(list.minimumReleaseAge?.isAssumed, true)
	assert.equal(list.minimumReleaseAge?.minutes, 1440)
	assert.deepEqual(read("pnpm@10.19.0", { "pnpm-workspace.yaml": "minimumReleaseAge: 0\n" }), {})
})
