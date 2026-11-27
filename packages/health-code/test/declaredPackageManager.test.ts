import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { createFakeSandboxProvider, inspectRepository, listUpgrades, type SandboxFixture } from "../src/index.ts"
import { packageManagerTools, toArchivePath } from "../src/sandbox/packageManagerVersions.ts"
import { packageManagerInstallFailures, packageManagerInstallScript, provision } from "../src/sandbox/provision.ts"
import { createFakeGithub } from "../src/upgrades/createFakeGithub.ts"
import { fixtureCommit, fixtureUrl } from "./providerContract.ts"
import { fakeRepositoryUrl, readFixtureProject } from "./readFixtureProject.ts"
import { command, scripts } from "./replayProjectChecks.ts"

// replay an inspection whose checkout declares a package manager version
async function inspectDeclared({
	checkoutAnswer,
	fixture = {},
	hasInstallOperation = true,
}: DeclaredInspection): Promise<{
	report: Awaited<ReturnType<typeof inspectRepository>>
	installs: unknown[]
	actions: string[]
}> {
	const provider = createFakeSandboxProvider({
		commit: fixtureCommit,
		commands: [command(["declared-package-manager"], JSON.stringify(checkoutAnswer)), ...scripts([], [], [])],
		...fixture,
	})
	if (!hasInstallOperation) {
		provider.installPackageManager = undefined
	}

	// record every guest command in order
	const actions: string[] = []
	const execute = provider.executeCommand.bind(provider)
	provider.executeCommand = (sandbox, guestCommand) => {
		actions.push(guestCommand.argv[2] ?? "")
		return execute(sandbox, guestCommand)
	}

	// record the install between the commands around it
	const install = provider.installPackageManager?.bind(provider)
	if (install) {
		provider.installPackageManager = (sandbox, request, operation) => {
			actions.push("install-package-manager")
			return install(sandbox, request, operation)
		}
	}

	// inspect one upgrade with that provider
	const report = await inspectRepository({ repositoryUrl: fixtureUrl, sandboxProvider: provider, limits })
	return { report, installs: provider.packageManagerInstalls, actions }
}

// the answer a checkout reports, the fixture it replays and whether the provider can install a package manager
type DeclaredInspection = { checkoutAnswer: object; fixture?: Partial<SandboxFixture>; hasInstallOperation?: boolean }

const limits = { maxUpgrades: 1 }
const declaredBun = { tool: "bun", declaredPackageManager: { version: "1.4.4", source: ".bun-version" } }

test("the sandbox installs the declared package manager version before any other repository command", async () => {
	const { report, installs, actions } = await inspectDeclared({ checkoutAnswer: declaredBun })
	assert.deepEqual(installs, [{ tool: "bun", version: "1.4.4" }])
	assert.deepEqual(actions.slice(0, 3), ["declared-package-manager", "install-package-manager", "detect"])

	// the report says the declared version ran and where it is declared
	assert.ok("name" in report.packageManager)
	assert.equal(report.packageManager.source, "declared")
	assert.deepEqual(report.packageManager.declared, { version: "1.4.4", file: ".bun-version" })
	assert.ok(report.timeline.some((event) => event.type === "step.started" && event.label === "Install Bun 1.4.4"))
})

test("a declared version that cannot be trusted or installed falls back to the bundled version with its reason", async () => {
	const failure = (reason: string): Partial<SandboxFixture> => ({ packageManagerFailure: reason })
	const unsupportedBun = { tool: "bun", declaredPackageManager: { version: "0.9.0", source: "engines" } }
	const cases: [string, DeclaredInspection, string][] = [
		[
			"an integrity mismatch",
			{ checkoutAnswer: declaredBun, fixture: failure(packageManagerInstallFailures.integrity ?? "") },
			"the declared 1.4.4 did not match the registry's integrity",
		],
		[
			"a deprecated version",
			{ checkoutAnswer: declaredBun, fixture: failure(packageManagerInstallFailures.deprecated ?? "") },
			"the declared 1.4.4 is deprecated",
		],
		[
			"a release that is too new",
			{ checkoutAnswer: declaredBun, fixture: failure(packageManagerInstallFailures.recent ?? "") },
			"the declared 1.4.4 was published less than a day ago",
		],
		[
			"a failed download",
			{ checkoutAnswer: declaredBun, fixture: failure("could not be downloaded") },
			"the declared 1.4.4 could not be downloaded",
		],
		[
			"a version below the range",
			{ checkoutAnswer: unsupportedBun },
			"the declared 0.9.0 is outside the supported range",
		],
		[
			"a provider without the operation",
			{ checkoutAnswer: declaredBun, hasInstallOperation: false },
			"the declared 1.4.4 cannot be installed by this sandbox provider",
		],
	]
	for (const [label, declaredInspection, reason] of cases) {
		const { report, installs, actions } = await inspectDeclared(declaredInspection)

		// the inspection continues on the bundled version
		assert.ok("name" in report.packageManager, label)
		assert.equal(report.packageManager.source, "bundled", label)
		assert.equal(report.packageManager.fallbackReason, reason, label)
		assert.equal(installs.length, 0, label)
		assert.ok(actions.includes("detect"), label)
	}
})

test("a value that is more than a version number declares no version", async () => {
	for (const version of ["1.4.4; rm -rf /", "https://evil.example/bun.tgz", "../1.4.4", "1.4.4-canary.1"]) {
		const { report, installs, actions } = await inspectDeclared({
			checkoutAnswer: { tool: "bun", declaredPackageManager: { version, source: "engines" } },
		})
		assert.deepEqual(installs, [])
		assert.ok(!actions.includes("install-package-manager"))
		assert.deepEqual("name" in report.packageManager && report.packageManager.source, "bundled")
	}

	// a tool name outside the fixed set is rejected the same way
	const { installs } = await inspectDeclared({
		checkoutAnswer: { tool: "curl", declaredPackageManager: { version: "1.4.4", source: "engines" } },
	})
	assert.deepEqual(installs, [])
})

test("a repository that declares no version runs the bundled version", async () => {
	const provider = createFakeSandboxProvider({ commit: fixtureCommit, commands: scripts([], [], []) })
	const report = await inspectRepository({ repositoryUrl: fixtureUrl, sandboxProvider: provider, limits })
	assert.deepEqual("name" in report.packageManager && report.packageManager.source, "bundled")
	assert.deepEqual(provider.packageManagerInstalls, [])
	assert.ok(report.timeline.every((event) => event.type !== "step.started" || !event.label.startsWith("Install ")))
})

test("the bundled tools and a declared version download from the fixed package on the registry", () => {
	const script = provision()
	for (const tool of Object.values(packageManagerTools)) {
		const archivePath = toArchivePath({ packageName: tool.package, version: tool.bundledPackageManagerVersion })
		assert.ok(script.includes(`https://registry.npmjs.org/${archivePath} `))
		assert.ok(script.includes(tool.bundledHash))
	}
	assert.equal(
		toArchivePath({ packageName: "@oven/bun-linux-x64", version: "1.4.4" }),
		"@oven/bun-linux-x64/-/bun-linux-x64-1.4.4.tgz",
	)

	// every failure the install script names has a reason for the report
	const markers = [...packageManagerInstallScript.matchAll(/fail[ (]"?([a-z]+)/g)].map((match) => match[1] ?? "")
	assert.deepEqual(
		[...new Set(markers.filter((marker) => marker !== "reason"))].sort(),
		Object.keys(packageManagerInstallFailures).sort(),
	)
})

test("the install script's release check accepts a release that is old enough and names why it rejects another", () => {
	const release = /node -e '\n([\s\S]*?)' "\$record" "\$version"/.exec(packageManagerInstallScript)?.[1]
	assert.ok(release)
	const directory = mkdtempSync(join(tmpdir(), "health-code-install-"))
	const record = join(directory, "record.json")
	const oldEnough = new Date(Date.now() - 3 * 86_400_000).toISOString()
	const integrity = `sha512-${Buffer.alloc(64, 7).toString("base64")}`
	try {
		// write one registry record that holds every case
		writeFileSync(
			record,
			JSON.stringify({
				versions: {
					"1.4.4": { dist: { integrity } },
					"1.4.5": { dist: { integrity }, deprecated: "broken" },
					"1.4.6": { dist: { integrity } },
					"1.4.7": { dist: { integrity: "md5-abc" } },
				},
				time: { "1.4.4": oldEnough, "1.4.5": oldEnough, "1.4.6": new Date().toISOString(), "1.4.7": oldEnough },
			}),
		)
		const check = (version: string): ReturnType<typeof spawnSync> =>
			spawnSync("node", ["-e", release, record, version], { encoding: "utf8" })
		assert.equal(check("1.4.4").stdout, integrity.slice(7))

		// the marker each rejected version prints
		const rejections: [string, string][] = [
			["9.9.9", "unpublished"],
			["1.4.5", "deprecated"],
			["1.4.6", "recent"],
			["1.4.7", "integrity"],
			["__proto__", "unpublished"],
		]

		// each rejection exits with its marker on stderr
		for (const [version, marker] of rejections) {
			const rejectedCheck = check(version)
			assert.equal(rejectedCheck.status, 1, version)
			assert.equal(String(rejectedCheck.stderr).trim(), `hc-install:${marker}`, version)
		}
	} finally {
		// remove the temporary registry record
		rmSync(directory, { recursive: true, force: true })
	}
})

test("the upgrade menu names the declared version the sandbox would run", async () => {
	// replace the manifest's package manager field with a bun version file
	const project = readFixtureProject("bun").files
	const { packageManager: _declared, ...manifest } = JSON.parse(project.get("package.json") ?? "{}")
	const files = new Map([...project, ["package.json", JSON.stringify(manifest)], [".bun-version", "1.4.4\n"]])

	// list the upgrades of the project that declares bun in its version file
	const github = createFakeGithub({ repositories: { "example/project": { files } }, versions: { "1.99.0": {} } })
	const upgradeMenu = await listUpgrades({ repositoryUrl: fakeRepositoryUrl, request: github.request })
	assert.deepEqual(upgradeMenu.packageManager, { name: "bun", version: "1.4.4" })
	assert.ok(github.githubRequests.length <= 22)
})
