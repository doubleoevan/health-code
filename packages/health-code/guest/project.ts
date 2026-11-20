import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { gt, major, prerelease, valid } from "semver"
import { bumpDependency, detectProject, managerName, readManifest } from "./inventory.ts"
import { readTestReport, reporterArguments, reportPath } from "./readTestReport.ts"

function execute(argv: string[]): number {
	const [file, ...args] = argv
	if (!file) {
		throw new Error("Missing command")
	}
	const result = spawnSync(file, args, { stdio: "inherit" })
	return result.status ?? 1
}
function install(name?: string, target?: string): number {
	const manager = managerName(readManifest("."))
	if (name && target) {
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
function tests(): number {
	const manifest = readManifest(".")
	const manager = managerName(manifest)
	const script = manifest.scripts?.test ?? ""
	mkdirSync(".health-code", { recursive: true })
	rmSync(reportPath, { force: true })
	const args = reporterArguments(script)
	return execute([manager, "run", "test", ...(manager === "npm" && args.length ? ["--"] : []), ...args])
}
function newestByMajor(versions: string[]): string[] {
	const latest = new Map<number, string>()
	for (const value of versions) {
		if (!valid(value) || prerelease(value)) {
			continue
		}
		const key = major(value)
		const current = latest.get(key)
		if (!current || gt(value, current)) {
			latest.set(key, value)
		}
	}
	return [...latest.values()]
}
async function registry(names: string[]): Promise<Record<string, string[]>> {
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
				output[name] = newestByMajor(Object.keys(record.versions ?? {}))
			}
		} catch {}
	}
	return output
}
async function main(): Promise<void> {
	const [action, ...args] = process.argv.slice(2)
	switch (action) {
		case "detect":
			console.log(JSON.stringify(detectProject()))
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
		case "tests":
			process.exitCode = tests()
			break
		case "report":
			console.log(JSON.stringify(readTestReport(readManifest(".").scripts?.test ?? "")))
			break
		default:
			throw new Error("Unknown project command")
	}
}
main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : "Project command failed")
	process.exitCode = 1
})
