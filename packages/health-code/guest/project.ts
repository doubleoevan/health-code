import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { bumpDependency, detectProject, managerName, readManifest } from "./inventory.ts"
import { measureTests } from "./measureTests.ts"
import { readIntegrity, readLifecycleHooks } from "./readIntegrity.ts"
import { readTestReport, reporterArguments, reportPath } from "./readTestReport.ts"
import { installedBytes, readChangelog, readUsage } from "./readUsage.ts"
import { selectRegistryVersions } from "./selectRegistryVersions.ts"

function execute(argv: string[]): number {
	// require an executable before starting a child process
	const [file, ...args] = argv
	if (!file) {
		throw new Error("Missing command")
	}
	const result = spawnSync(file, args, { stdio: "inherit" })
	return result.status ?? 1
}
// resolve the lockfile without running install scripts
function resolveLock(manager: string): number {
	if (manager === "npm") {
		return execute(["npm", "install", "--package-lock-only", "--ignore-scripts"])
	}
	if (manager === "yarn") {
		// select the lockfile mode supported by this yarn version
		const modern = existsSync(".yarnrc.yml") || /^yarn@(?:[2-9]|\d\d)/.test(readManifest(".").packageManager ?? "")
		return execute(modern ? ["yarn", "install", "--mode=update-lockfile"] : ["yarn", "install", "--ignore-scripts"])
	}
	return execute([manager, "install", "--lockfile-only", "--ignore-scripts"])
}
// determine the workspace manager before handling install modes
function install(name?: string, target?: string): number {
	const manager = managerName(readManifest("."))
	if (name === "--resolve-lock") {
		return resolveLock(manager)
	}
	// apply the requested version before updating the lock
	if (name && target && name !== "--update-lock") {
		bumpDependency(name, target)
	}
	if (manager === "npm") {
		return execute(name ? ["npm", "install"] : ["npm", "ci"])
	}
	// choose frozen or mutable installs for the detected manager
	if (manager === "yarn") {
		return installYarn(Boolean(name))
	}
	if (name && manager === "pnpm") {
		return execute([manager, "install", "--no-frozen-lockfile"])
	}
	return execute([manager, "install", ...(name ? [] : ["--frozen-lockfile"])])
}
// enable lockfile edits only for a changed yarn install
function installYarn(changed: boolean): number {
	const modern = existsSync(".yarnrc.yml") || /^yarn@(?:[2-9]|\d\d)/.test(readManifest(".").packageManager ?? "")
	if (changed && modern) {
		process.env.YARN_ENABLE_IMMUTABLE_INSTALLS = "false"
	}
	return execute(["yarn", "install", ...(changed ? [] : [modern ? "--immutable" : "--frozen-lockfile"])])
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
	// pass reporter flags through the package manager
	const args = reporterArguments(script, protectedReport ? "/inspection-report" : reportPath)
	const argv = [manager, "run", "test", ...(manager === "npm" && args.length ? ["--"] : []), ...args]
	return execute(argv)
}
async function registry(names: string[], includePrevious = false): Promise<Record<string, string[]>> {
	const output: Record<string, string[]> = Object.create(null)
	// limit registry requests to well-formed package names
	for (const name of names) {
		if (!/^(?:@[a-z\d_.-]+\/)?[a-z\d_.-]+$/i.test(name)) {
			continue
		}
		try {
			const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
				headers: { accept: "application/vnd.npm.install-v1+json" },
				redirect: "error",
				signal: AbortSignal.timeout(8000),
			})
			// collect supported versions from successful registry responses
			if (response.ok) {
				const record = (await response.json()) as { versions?: Record<string, unknown> }
				output[name] = selectRegistryVersions(Object.keys(record.versions ?? {}), includePrevious)
			}
		} catch {}
	}
	return output
}
// dispatch the requested guest operation
async function main(): Promise<void> {
	const [action, ...args] = process.argv.slice(2)
	switch (action) {
		case "lifecycle":
			console.log(JSON.stringify(readLifecycleHooks()))
			break
		// return a page of integrity evidence
		case "integrity":
			console.log(JSON.stringify(readIntegrity(Number(args[0]))))
			break
		case "changelog":
		case "usage": {
			// validate the dependency before looking up package evidence
			if (!args[0] || !/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(args[0])) {
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
		// distinguish a bounded historical lookup from upgrade discovery
		case "lookup":
			console.log(JSON.stringify(await registry(args.slice(0, 5), true)))
			break
		case "registry":
			console.log(JSON.stringify(await registry(args)))
			break
		// run install and type checks through the detected manager
		case "install":
			process.exitCode = install(args[0], args[1])
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
