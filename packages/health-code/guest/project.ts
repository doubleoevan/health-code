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
	const [file, ...args] = argv
	if (!file) {
		throw new Error("Missing command")
	}
	const result = spawnSync(file, args, { stdio: "inherit" })
	return result.status ?? 1
}
function resolveLock(manager: string): number {
	if (manager === "npm") {
		return execute(["npm", "install", "--package-lock-only", "--ignore-scripts"])
	}
	if (manager === "yarn") {
		const modern = existsSync(".yarnrc.yml") || /^yarn@(?:[2-9]|\d\d)/.test(readManifest(".").packageManager ?? "")
		return execute(modern ? ["yarn", "install", "--mode=update-lockfile"] : ["yarn", "install", "--ignore-scripts"])
	}
	return execute([manager, "install", "--lockfile-only", "--ignore-scripts"])
}
function install(name?: string, target?: string): number {
	const manager = managerName(readManifest("."))
	if (name === "--resolve-lock") {
		return resolveLock(manager)
	}
	if (name && target && name !== "--update-lock") {
		bumpDependency(name, target)
	}
	if (manager === "npm") {
		return execute(name ? ["npm", "install"] : ["npm", "ci"])
	}
	if (manager === "yarn") {
		return installYarn(Boolean(name))
	}
	if (name && manager === "pnpm") {
		return execute([manager, "install", "--no-frozen-lockfile"])
	}
	return execute([manager, "install", ...(name ? [] : ["--frozen-lockfile"])])
}
function installYarn(changed: boolean): number {
	const modern = existsSync(".yarnrc.yml") || /^yarn@(?:[2-9]|\d\d)/.test(readManifest(".").packageManager ?? "")
	if (changed && modern) {
		process.env.YARN_ENABLE_IMMUTABLE_INSTALLS = "false"
	}
	return execute(["yarn", "install", ...(changed ? [] : [modern ? "--immutable" : "--frozen-lockfile"])])
}
function tests(protectedReport = false): number {
	const manifest = readManifest(".")
	const manager = managerName(manifest)
	const script = manifest.scripts?.test ?? ""
	mkdirSync(".health-code", { recursive: true })
	if (!protectedReport) {
		rmSync(reportPath, { force: true })
	}
	const args = reporterArguments(script, protectedReport ? "/inspection-report" : reportPath)
	const argv = [manager, "run", "test", ...(manager === "npm" && args.length ? ["--"] : []), ...args]
	return execute(argv)
}
async function registry(names: string[], includePrevious = false): Promise<Record<string, string[]>> {
	const output: Record<string, string[]> = Object.create(null)
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
			if (response.ok) {
				const record = (await response.json()) as { versions?: Record<string, unknown> }
				output[name] = selectRegistryVersions(Object.keys(record.versions ?? {}), includePrevious)
			}
		} catch {}
	}
	return output
}
async function main(): Promise<void> {
	const [action, ...args] = process.argv.slice(2)
	switch (action) {
		case "lifecycle":
			console.log(JSON.stringify(readLifecycleHooks()))
			break
		case "integrity":
			console.log(JSON.stringify(readIntegrity(Number(args[0]))))
			break
		case "changelog":
		case "usage": {
			if (!args[0] || !/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(args[0])) {
				throw new Error("Invalid package name")
			}
			console.log(JSON.stringify(action === "usage" ? readUsage(args[0]) : readChangelog(args[0])))
			break
		}
		case "installed-size":
			console.log(JSON.stringify(installedBytes()))
			break
		case "detect":
			console.log(JSON.stringify(detectProject()))
			break
		case "lookup":
			console.log(JSON.stringify(await registry(args.slice(0, 5), true)))
			break
		case "registry":
			console.log(JSON.stringify(await registry(args)))
			break
		case "install":
			process.exitCode = install(args[0], args[1])
			break
		case "typecheck": {
			const options = args[0] === "build" ? ["-b"] : ["--noEmit"]
			const local = join("node_modules", ".bin", "tsc")
			process.exitCode = existsSync(local)
				? execute([local, ...options])
				: managerName(readManifest(".")) === "yarn"
					? execute(["yarn", "exec", "tsc", ...options])
					: 1
			break
		}
		case "capture-tests":
			process.exitCode = measureTests(args[0] ?? "", args.slice(1))
			break
		case "tests":
			process.exitCode = tests(args[0] === "--inventory")
			break
		case "report":
			console.log(JSON.stringify(readTestReport(readManifest(".").scripts?.test ?? "", args[0] === "--protected")))
			break
		default:
			throw new Error("Unknown project command")
	}
}
main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : "Project command failed")
	process.exitCode = 1
})
