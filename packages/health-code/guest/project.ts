import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { fetchRegistryVersions, isPackageName } from "./fetchRegistryVersions.ts"
import { bumpDependency, detectProject, managerName, readManifest } from "./inventory.ts"
import { measureTests } from "./measureTests.ts"
import { readLifecycleHookSignatures, readPatchVerificationInputs } from "./readPatchVerificationInputs.ts"
import { readReleaseAge } from "./readReleaseAge.ts"
import { readTestReport, reporterArguments, reporterEnvironment, reportPath } from "./readTestReport.ts"
import { installedBytes, readChangelog, readUsage } from "./readUsage.ts"
import { removeOutdatedLockfileEntries } from "./removeOutdatedLockfileEntries.ts"

function execute(argv: string[], environment: NodeJS.ProcessEnv = {}): number {
	// require an executable before starting a child process
	const [file, ...args] = argv
	if (!file) {
		throw new Error("Missing command")
	}
	const result = spawnSync(file, args, { stdio: "inherit", env: { ...process.env, ...environment } })
	return result.status ?? 1
}

// resolve the lockfile without running install scripts
function resolveLock(manager: string): number {
	if (manager === "npm") {
		removeOutdatedLockfileEntries()
		return execute(["npm", "install", "--package-lock-only", "--ignore-scripts"])
	}
	if (manager === "yarn") {
		// select the lockfile mode supported by this yarn version
		const modern = existsSync(".yarnrc.yml") || /^yarn@(?:[2-9]|\d\d)/.test(readManifest(".").packageManager ?? "")
		return execute(modern ? ["yarn", "install", "--mode=update-lockfile"] : ["yarn", "install", "--ignore-scripts"])
	}
	return execute([manager, "install", "--lockfile-only", "--ignore-scripts"])
}

// separate the script policy from the install target
function install(args: string[]): number {
	const skipsScripts = args.includes("--ignore-scripts")
	const [name, target] = args.filter((argument) => argument !== "--ignore-scripts")
	const scripts = skipsScripts ? ["--ignore-scripts"] : []

	// determine the workspace manager before handling install modes
	const manager = managerName(readManifest("."))

	// resolve only the lockfile when requested
	if (name === "--resolve-lock") {
		return resolveLock(manager)
	}

	// apply the requested version before updating the lock
	if (name && target && name !== "--update-lock") {
		bumpDependency(name, target)
	}

	// remove outdated lockfile entries only before a changed install
	if (manager === "npm") {
		if (name) {
			removeOutdatedLockfileEntries()
		}
		return execute(["npm", name ? "install" : "ci", ...scripts])
	}

	// choose frozen or mutable installs for the detected manager
	if (manager === "yarn") {
		return installYarn(Boolean(name), skipsScripts)
	}
	if (name && manager === "pnpm") {
		return execute([manager, "install", "--no-frozen-lockfile", ...scripts])
	}
	return execute([manager, "install", ...(name ? [] : ["--frozen-lockfile"]), ...scripts])
}

// enable lockfile edits only for a changed yarn install
function installYarn(changed: boolean, skipsScripts: boolean): number {
	const modern = existsSync(".yarnrc.yml") || /^yarn@(?:[2-9]|\d\d)/.test(readManifest(".").packageManager ?? "")
	if (changed && modern) {
		process.env.YARN_ENABLE_IMMUTABLE_INSTALLS = "false"
	}

	// match the lockfile and script flags to this yarn version
	const frozen = changed ? [] : [modern ? "--immutable" : "--frozen-lockfile"]
	const scripts = skipsScripts ? [modern ? "--mode=skip-build" : "--ignore-scripts"] : []
	return execute(["yarn", "install", ...frozen, ...scripts])
}

// prepare a reporter path for the project's test script
function tests(protectedReport = false): number {
	const manifest = readManifest(".")
	const manager = managerName(manifest)
	const script = manifest.scripts?.test ?? ""
	mkdirSync(".health-code", { recursive: true })
	if (!protectedReport) {
		rmSync(reportPath, { force: true })
	}

	// pass the reporter through the package manager or the environment
	const path = protectedReport ? "/inspection-report" : reportPath
	const args = reporterArguments(script, path)
	const argv = [manager, "run", "test", ...(manager === "npm" && args.length ? ["--"] : []), ...args]
	return execute(argv, reporterEnvironment(script, path))
}

function discoverVersions(args: string[]): ReturnType<typeof fetchRegistryVersions> {
	// Return completed packages before the supervising command times out.
	const prefix = "--timeout-ms="
	const budget = args[0]?.startsWith(prefix) ? Number(args[0].slice(prefix.length)) : undefined
	const signal = budget === undefined ? undefined : AbortSignal.timeout(budget)

	// Offer only releases the repository's own policy would install.
	const releaseAge = readReleaseAge(managerName(readManifest(".")))
	return fetchRegistryVersions(budget === undefined ? args : args.slice(1), { releaseAge, signal })
}

// dispatch the requested guest operation
async function main(): Promise<void> {
	const [action, ...args] = process.argv.slice(2)
	switch (action) {
		case "lifecycle":
			console.log(JSON.stringify(readLifecycleHookSignatures()))
			break

		// return a page of patch verification inputs
		case "integrity": {
			const [testCaseOffset = Number.NaN, fileAndHookEntryOffset] = args.map(Number)
			const page = readPatchVerificationInputs(testCaseOffset, fileAndHookEntryOffset)

			// Preserve the field names used by sandbox providers on the wire.
			console.log(
				JSON.stringify({
					files: page.projectFilePaths,
					hooks: page.lifecycleHookSignatures,
					discoveredFiles: page.discoveredTestFiles,
					cases: page.cases,
					testFileErrors: page.testFileErrors,
					nextMetadataOffset: page.nextFileAndHookEntryOffset,
				}),
			)
			break
		}
		case "changelog":
		case "usage": {
			// validate the dependency before looking up package evidence
			if (!args[0] || !isPackageName(args[0])) {
				throw new Error("Invalid package name")
			}
			console.log(JSON.stringify(action === "usage" ? readUsage(args[0]) : readChangelog(args[0])))
			break
		}

		// report installed size or project inventory
		case "installed-size":
			console.log(JSON.stringify(installedBytes()))
			break
		case "detect":
			console.log(JSON.stringify(detectProject()))
			break

		// distinguish a bounded historical lookup from the upgrade menu lookup
		case "lookup":
			console.log(JSON.stringify(await fetchRegistryVersions(args.slice(0, 5), { includePrevious: true })))
			break
		case "registry":
			console.log(JSON.stringify(await discoverVersions(args)))
			break

		// run install and type checks through the detected manager
		case "install":
			process.exitCode = install(args)
			break
		case "typecheck": {
			const options = args[0] === "build" ? ["-b"] : ["--noEmit"]
			const local = join("node_modules", ".bin", "tsc")

			// prefer the local compiler and fall back to yarn execution
			process.exitCode = existsSync(local)
				? execute([local, ...options])
				: managerName(readManifest(".")) === "yarn"
					? execute(["yarn", "exec", "tsc", ...options])
					: 1
			break
		}

		// capture test evidence with the supervisor-selected reporter
		case "capture-tests":
			process.exitCode = measureTests(args[0] ?? "", args.slice(1))
			break
		case "tests":
			process.exitCode = tests(args[0] === "--inventory")
			break

		// read the test results for the selected runner
		case "report":
			console.log(JSON.stringify(readTestReport(readManifest(".").scripts?.test ?? "", args[0] === "--protected")))
			break
		default:
			throw new Error("Unknown project command")
	}
}

// send command errors to stderr and signal failure
main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : "Project command failed")
	process.exitCode = 1
})
