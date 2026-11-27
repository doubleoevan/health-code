import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { test } from "node:test"
import type { ToolName, Upgrade } from "../src/contracts.ts"
import { inspectRepository } from "../src/inspection/inspectRepository.ts"
import { listUpgrades } from "../src/inspection/listUpgrades.ts"
import { connectProvider } from "../src/sandbox/createSandboxProvider.ts"
import { registryHosts } from "../src/sandbox/networkPolicy.ts"
import { packageManagerTools } from "../src/sandbox/packageManagerVersions.ts"
import { toUpgradeTargetKey } from "../src/upgrades/toUpgradeMenu.ts"
import { fixtureCommit, fixtureUrl, providerContract } from "./providerContract.ts"

const skip = !process.env.RUNTA_TOKEN
type PackageManagerTool = (typeof packageManagerTools)[ToolName]

test("live sandbox provider contract", { skip, timeout: 480000 }, async () => {
	await providerContract(connectProvider({}, fixtureCommit))
})
for (const [url, commit] of [
	[fixtureUrl, fixtureCommit],
	["https://github.com/privatenumber/get-tsconfig", "b4e7751e408eeaf014974a7cb1ec2634914a4d6c"],
] as const) {
	test(`Baseline ${url}`, { skip, timeout: 600000 }, async () => {
		// inspect the commit with upgrade checks disabled
		const started = Date.now()
		const sandboxProvider = connectProvider({}, commit)
		const report = await inspectRepository({
			repositoryUrl: url,
			sandboxProvider,
			limits: { maxUpgrades: 0, maxDurationMs: 540000 },
		})

		// confirm the inspected baseline produced installation evidence
		assert.equal(report.repository.commit, commit)
		assert.ok("name" in report.packageManager, JSON.stringify(report.packageManager))
		assert.ok(report.baseline.install.evidence.length, "Missing Baseline installation evidence")
		if (url === fixtureUrl) {
			// Exercise oxlint's sparse allocator through Nano ID's inspected test script.
			assert.equal(report.baseline.tests.status, "passed", JSON.stringify(report.baseline.tests))
		}

		// report cleanup, elapsed time and the provider cost estimate
		assert.ok(report.timeline.some((e) => e.type === "sandbox.event" && e.action === "deleted"))
		console.log(
			JSON.stringify({
				commit,
				baseline: report.baseline.install.status,
				installEvidence: report.baseline.install.evidence.map((e) => (e.stderr || e.stdout).slice(-450)),
				durationMs: Date.now() - started,
				costUpperBoundUsd: sandboxProvider.estimateMaxCost(Date.now() - started),
				deleted: true,
			}),
		)
	})
}

// drop the skipped entries a checkout's environment scan adds
function withoutEnvironmentScanEntries(skipped: string[]): string[] {
	return skipped.filter((entry) => !/environment (scan|reference)/.test(entry)).sort()
}

for (const [url, commit] of [
	[fixtureUrl, fixtureCommit],
	["https://github.com/privatenumber/get-tsconfig", "b4e7751e408eeaf014974a7cb1ec2634914a4d6c"],
] as const) {
	test(`the upgrade menu equals the sandbox listing for ${url}`, { skip, timeout: 600000 }, async () => {
		// build the upgrade menu in this process from GitHub and the registry
		const started = Date.now()
		const upgradeMenu = await listUpgrades({
			repositoryUrl: url,
			revision: commit,
			githubToken: process.env.GITHUB_TOKEN,
		})
		const menuMs = Date.now() - started

		// list the same commit in a sandbox moments later
		const listing = await inspectRepository({
			repositoryUrl: url,
			revision: commit,
			mode: "listUpgrades",
			sandboxProvider: connectProvider({}, commit),
			limits: { maxDurationMs: 540000 },
		})
		const toKeys = (targets: Upgrade[]): string[] => targets.map(toUpgradeTargetKey).sort()

		// both name the same targets from the same locked versions and skip the same dependencies
		assert.equal(upgradeMenu.repository.commit, listing.repository.commit)
		assert.deepEqual(
			toKeys(upgradeMenu.dependencies.flatMap((choice) => choice.targets)),
			toKeys(listing.selection.eligible),
		)
		assert.deepEqual(
			withoutEnvironmentScanEntries(upgradeMenu.skipped),
			withoutEnvironmentScanEntries(listing.selection.skipped),
		)
		console.log(
			JSON.stringify({
				url,
				menuMs,
				targets: listing.selection.eligible.length,
				packageManager: listing.packageManager,
			}),
		)
	})
}

test("the sandbox runs the Bun version a repository declares", { skip, timeout: 600000 }, async () => {
	const inspectedCommit = "26d414d15374bf2fa6015a1daffc7beb87c6ade2"
	const report = await inspectRepository({
		repositoryUrl: "https://github.com/doubleoevan/health-code",
		revision: inspectedCommit,
		mode: "listUpgrades",
		sandboxProvider: connectProvider({}, inspectedCommit),
		limits: { maxDurationMs: 540000 },
	})

	// the version that ran is the declared one, downloaded and verified before any repository command
	assert.ok("name" in report.packageManager, JSON.stringify(report.packageManager))
	assert.equal(report.packageManager.source, "repository", JSON.stringify(report.packageManager))
	assert.equal(report.packageManager.version, report.packageManager.declared?.version)
	const install = report.timeline.find(
		(event) => event.type === "step.finished" && event.summary.startsWith("Install Bun"),
	)
	console.log(
		JSON.stringify({
			packageManager: report.packageManager,
			installMs: install?.type === "step.finished" && install.durationMs,
		}),
	)
})

// an empty lockfile in each package manager's format, for the package manager to fill
const emptyLockfiles: Record<ToolName, [name: string, text: string]> = {
	npm: ["package-lock.json", '{"name":"floor","lockfileVersion":3,"requires":true,"packages":{}}'],
	pnpm: ["pnpm-lock.yaml", "lockfileVersion: '9.0'\n"],
	bun: ["bun.lock", '{"lockfileVersion":1,"workspaces":{"":{"name":"floor"}},"packages":{}}'],
	yarn: ["yarn.lock", "# yarn lockfile v1\n"],
	"yarn-modern": ["yarn.lock", "__metadata:\n  version: 8\n"],
}

type ToolEntry = [ToolName, PackageManagerTool]

for (const [tool, { supportedRange, commandName }] of Object.entries(packageManagerTools) as ToolEntry[]) {
	const lowestVersion = /^>=(\d+\.\d+\.\d+) /.exec(supportedRange)?.[1] ?? ""
	const title = `the guest's commands work at the lowest supported version of ${tool}, ${lowestVersion}`
	test(title, { skip, timeout: 540000 }, async () => {
		const provider = connectProvider({}, fixtureCommit)
		const options = { timeoutMs: 300000 }
		const sandbox = await provider.createSandbox(`health-code-${randomUUID()}`, options)

		// run one guest command the way the adapter does and require it to succeed
		const guest = async (...args: string[]): Promise<string> => {
			const result = await provider.executeCommand(sandbox, {
				argv: ["node", "/opt/health-code/project.mjs", ...args],
				...options,
			})
			assert.equal(result.exitCode, 0, `${args.join(" ")}: ${result.stderr.slice(-600)}`)
			return result.stdout
		}
		try {
			// replace the checkout's project with one that declares this package manager's version
			await provider.prepareRepository(sandbox, fixtureUrl, options)
			await provider.setNetworkPolicy(sandbox, registryHosts, options)
			await provider.resetProject(sandbox, options)
			const manifest = {
				name: "floor",
				private: true,
				packageManager: `${commandName}@${lowestVersion}`,
				dependencies: { ms: "2.1.1" },
			}
			await provider.writeFile(sandbox, "package.json", JSON.stringify(manifest), options)
			await provider.writeFile(sandbox, "pnpm-workspace.yaml", "packages: []\n", options)
			await provider.writeFile(sandbox, ...emptyLockfiles[tool], options)

			// install the lowest supported version the way a declared version is installed
			assert.deepEqual(JSON.parse(await guest("declared-package-manager")).declaredPackageManager, {
				version: lowestVersion,
				source: "packageManager",
			})
			await provider.installPackageManager?.(sandbox, { tool, version: lowestVersion }, options)

			// change a dependency, install from the frozen lockfile and read the configuration
			await guest("install", "ms", "2.1.2")
			await guest("install")
			const detected = JSON.parse(await guest("detect"))
			assert.equal(detected.manager, commandName)
			assert.equal(detected.version, lowestVersion)
			assert.deepEqual(detected.sources.ms, { ".": "2.1.2" })
			assert.ok(Array.isArray(JSON.parse(await guest("registry", "ms")).ms))

			// upgrade the dependency and resolve the lockfile on its own
			await guest("install", "ms", "2.1.3")
			await guest("install", "--resolve-lock")
			assert.deepEqual(JSON.parse(await guest("detect")).sources.ms, { ".": "2.1.3" })
			console.log(JSON.stringify({ tool, lowestVersion, passed: true }))
		} finally {
			// delete the sandbox whatever the commands did
			await provider.destroySandbox(sandbox, options)
		}
	})
}
