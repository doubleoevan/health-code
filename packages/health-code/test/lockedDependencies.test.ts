import assert from "node:assert/strict"
import { test } from "node:test"
import { fetchRegistryVersions } from "../src/upgrades/fetchRegistryVersions.ts"
import {
	ProjectDetectionError,
	readLockedDependencies,
	selectWorkspaceDirectories,
} from "../src/upgrades/readLockedDependencies.ts"
import { readFixtureProject, textFixtureNames } from "./readFixtureProject.ts"

for (const name of textFixtureNames) {
	test(`reads the recorded ${name} locked dependencies from file contents`, () => {
		const lockedDependencies = readLockedDependencies(readFixtureProject(name))
		assert.equal(lockedDependencies.manager, name.split("-")[0])
		assert.ok(Object.keys(lockedDependencies.sources).length)

		// every locked version is one the registry could serve
		for (const versions of Object.values(lockedDependencies.sources)) {
			for (const version of Object.values(versions)) {
				assert.match(version, /^\d+\.\d+\.\d+/)
			}
		}
	})
}

test("pnpm keeps per-workspace versions and honors the workspace file", () => {
	const lockedDependencies = readLockedDependencies(readFixtureProject("pnpm"))
	assert.deepEqual({ ...lockedDependencies.sources.widget }, { ".": "1.2.0", "packages/child": "1.1.0" })
})

test("a binary bun lockfile cannot be read without its decoded text", () => {
	const project = readFixtureProject("bun-binary")
	assert.throws(() => readLockedDependencies(project), ProjectDetectionError)
})

test("workspace patterns apply in order and pnpm exclusions win", () => {
	const filePaths = ["packages/a/package.json", "packages/b/package.json", "tools/c/package.json", "tools/c/index.ts"]
	const select = (rootManifest: object, pnpmWorkspace?: string): string[] =>
		selectWorkspaceDirectories({ rootManifest: JSON.stringify(rootManifest), pnpmWorkspace, filePaths })
	assert.deepEqual(select({ workspaces: ["packages/*"] }), ["packages/a", "packages/b"])
	assert.deepEqual(select({ workspaces: { packages: ["tools/*"] } }), ["tools/c"])
	assert.deepEqual(select({}, "packages:\n  - 'packages/*'\n  - '!packages/b'\n"), ["packages/a"])

	// a package manager reads only its own workspace declaration
	const leftover = "packages:\n  - 'tools/*'\n"
	const selectFor = (manager: "npm" | "pnpm", rootManifest: object, pnpmWorkspace?: string): string[] =>
		selectWorkspaceDirectories({ rootManifest: JSON.stringify(rootManifest), pnpmWorkspace, filePaths, manager })
	assert.deepEqual(selectFor("npm", { workspaces: ["packages/*"] }, leftover), ["packages/a", "packages/b"])
	assert.deepEqual(selectFor("pnpm", { workspaces: ["packages/*"] }, "onlyBuiltDependencies: []\n"), [])
	assert.deepEqual(selectFor("pnpm", { workspaces: ["packages/*"] }), [])
	assert.deepEqual(selectFor("pnpm", {}, leftover), ["tools/c"])

	// reject a declaration that is not a bounded list of strings
	assert.throws(() => select({ workspaces: [1] }), /Unsupported workspace declaration/)
	assert.throws(() => select({ workspaces: Array(257).fill("a/*") }), /Unsupported workspace declaration/)
	assert.throws(() => select({ workspaces: ["a".repeat(257)] }), /Unsupported workspace declaration/)
})

test("the declared package manager version is the first exact version among the committed sources", () => {
	const hash = `sha512.${"a".repeat(128)}`
	const readDeclaredPackageManager = (manifest: object, bunVersion?: string): unknown => {
		const files = new Map([
			["package.json", JSON.stringify(manifest)],
			["bun.lock", '{ "workspaces": {}, "packages": {} }'],
		])
		if (bunVersion !== undefined) {
			files.set(".bun-version", bunVersion)
		}
		return readLockedDependencies({ files, lockfileNames: ["bun.lock"], workspaceDirectories: [] })
			.declaredPackageManager
	}

	// each source declares a version on its own
	assert.deepEqual(readDeclaredPackageManager({ packageManager: "bun@1.4.4" }), {
		version: "1.4.4",
		source: "packageManager",
	})
	assert.deepEqual(readDeclaredPackageManager({ packageManager: `bun@1.4.4+${hash}` }), {
		version: "1.4.4",
		source: "packageManager",
		hash,
	})
	assert.deepEqual(readDeclaredPackageManager({ devEngines: { packageManager: { name: "bun", version: "1.4.2" } } }), {
		version: "1.4.2",
		source: "devEngines.packageManager",
	})
	assert.deepEqual(readDeclaredPackageManager({ engines: { bun: "1.4.1" } }), { version: "1.4.1", source: "engines" })
	assert.deepEqual(readDeclaredPackageManager({}, "1.4.4\n"), { version: "1.4.4", source: ".bun-version" })

	// the manifest field wins and a range declares no version
	assert.deepEqual(readDeclaredPackageManager({ packageManager: "bun@1.4.4" }, "1.3.0"), {
		version: "1.4.4",
		source: "packageManager",
	})
	assert.equal(readDeclaredPackageManager({ engines: { bun: ">=1.4" } }), undefined)
	assert.equal(
		readDeclaredPackageManager({ devEngines: { packageManager: { name: "bun", version: "^1.4.0" } } }),
		undefined,
	)

	// a version declared for another package manager is ignored
	assert.deepEqual(readDeclaredPackageManager({ engines: { pnpm: "9.0.0" } }, "1.4.4"), {
		version: "1.4.4",
		source: ".bun-version",
	})
	assert.equal(
		readDeclaredPackageManager({ devEngines: { packageManager: { name: "pnpm", version: "9.0.0" } } }),
		undefined,
	)

	// a value that is more than a version number declares no version
	for (const version of ["https://evil.example/bun.tgz", "../1.4.4", "1.4.4; rm -rf /", "1.4.4-canary.1", "v1.4.4"]) {
		assert.equal(readDeclaredPackageManager({ engines: { bun: version } }, version), undefined, version)
		assert.equal(readDeclaredPackageManager({ packageManager: `bun@${version}` }), undefined, version)
	}
	assert.equal(readDeclaredPackageManager({ packageManager: "bun@1.4.4+md5.abc" }), undefined)
})

test("a release age requests publish dates only for a recently modified package", async () => {
	const publishedBefore = Date.parse("2026-02-15")
	const versions = { "1.0.0": {}, "1.1.0": {}, "1.2.0": {} }
	const settledVersions = { "1.0.0": {}, "1.1.0": {} }
	const time = { "1.0.0": "2026-01-01", "1.1.0": "2026-02-01", "1.2.0": "2026-03-01" }
	const requestedAccepts: Record<string, string[]> = { settled: [], recent: [], undated: [] }
	const modifiedTimes: Record<string, string | undefined> = { settled: "2026-02-01", recent: "2026-03-01" }

	const registryVersions = await fetchRegistryVersions(["settled", "recent", "undated"], {
		releaseAge: { publishedBefore, excluded: [] },
		request: async (url, options) => {
			const name = new URL(url).pathname.slice(1)
			const accept = new Headers(options.headers).get("accept") ?? ""
			requestedAccepts[name]?.push(accept)
			const isDated = accept === "application/json"
			const releases = name === "settled" ? settledVersions : versions
			return Response.json(
				isDated ? { versions: releases, time } : { versions: releases, modified: modifiedTimes[name] },
			)
		},
	})

	// the settled package needs one summary request and the others add the dated one
	const summary = "application/vnd.npm.install-v1+json"
	assert.deepEqual(requestedAccepts, {
		settled: [summary],
		recent: [summary, "application/json"],
		undated: [summary, "application/json"],
	})
	assert.deepEqual({ ...registryVersions }, { settled: ["1.1.0"], recent: ["1.1.0"], undated: ["1.1.0"] })

	// the dated path returns the same versions for the settled package
	const datedVersions = await fetchRegistryVersions(["settled"], {
		releaseAge: { publishedBefore, excluded: [] },
		request: async () => Response.json({ versions: settledVersions, time }),
	})
	assert.deepEqual(datedVersions.settled, registryVersions.settled)
})

test("a bun lockfile keeps commas inside strings and loses only the trailing ones", () => {
	const lockfile = `{
  // a line comment with a "quote
  "lockfileVersion": 1, /* a block
  comment */
  "workspaces": { "": { "name": "root", "dependencies": { "widget": "^1.0.0", }, }, },
  "packages": {
    "widget": ["widget@1.2.0", "", { "note": "a, ] b \\" , }" }, "sha512-abc",],
  },
}`
	const lockedDependencies = readLockedDependencies({
		files: new Map([
			["package.json", '{"dependencies":{"widget":"^1.0.0"}}'],
			["bun.lock", lockfile],
		]),
		lockfileNames: ["bun.lock"],
		workspaceDirectories: [],
	})
	assert.deepEqual({ ...lockedDependencies.sources.widget }, { ".": "1.2.0" })
})

test("npm resolves a nested workspace through each ancestor directory before the root", () => {
	const lockfile = {
		lockfileVersion: 3,
		packages: {
			"node_modules/widget": { version: "2.0.0" },
			"packages/parent/node_modules/widget": { version: "1.2.0" },
		},
	}
	const lockedDependencies = readLockedDependencies({
		files: new Map([
			["package.json", '{"dependencies":{"widget":"^2.0.0"}}'],
			["packages/parent/child/package.json", '{"dependencies":{"widget":"^1.0.0"}}'],
			["package-lock.json", JSON.stringify(lockfile)],
		]),
		lockfileNames: ["package-lock.json"],
		workspaceDirectories: ["packages/parent/child"],
	})
	assert.deepEqual({ ...lockedDependencies.sources.widget }, { ".": "2.0.0", "packages/parent/child": "1.2.0" })
})
