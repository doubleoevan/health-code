import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import type { PackageManager } from "../src/contracts.ts"
import { type ReleaseAge, readBunReleaseAge, toReleaseAge } from "../src/upgrades/readCommittedReleaseAge.ts"
import { readText } from "./readProjectFiles.ts"

/**
 * Reads the package manager's effective minimum release age for this repository.
 */
export function readReleaseAge(
	manager: PackageManager,
	config: (args: string[]) => string = (args) => readConfig(manager, args),
): ReleaseAge | undefined {
	if (manager === "bun") {
		return readBunReleaseAge(existsSync("bunfig.toml") ? readText("bunfig.toml") : undefined)
	}

	// npm resolves its age setting into a publish date
	if (manager === "npm") {
		const before = toSetting(config(["before"]))
		return before === undefined ? undefined : toReleaseAge(Date.parse(before), [])
	}

	// pnpm and yarn report minutes, including their own defaults
	const [age, exclusions] =
		manager === "pnpm"
			? (["minimumReleaseAge", "minimumReleaseAgeExclude"] as const)
			: (["npmMinimalAgeGate", "npmPreapprovedPackages"] as const)

	// skip the age check when the setting is off
	const minutes = toSetting(config([age]))
	if (minutes === undefined || Number(minutes) === 0) {
		return undefined
	}
	return toReleaseAge(Date.now() - Number(minutes) * 60_000, toNames(config([exclusions, "--json"])))
}

function toSetting(output: string): string | undefined {
	const value = output.trim()
	return value === "" || value === "undefined" || value === "null" ? undefined : value
}

function toNames(output: string): unknown {
	const value = toSetting(output)

	// read output that is not a list as no exempt packages, which applies the age to every package
	try {
		return value === undefined ? [] : JSON.parse(value)
	} catch {
		return []
	}
}

function readConfig(manager: PackageManager, args: string[]): string {
	try {
		return execFileSync(manager, ["config", "get", ...args], { encoding: "utf8", stdio: "pipe", timeout: 10000 })
	} catch (error) {
		// older yarn releases reject settings they do not support
		const output = String((error as { stdout?: unknown }).stdout ?? "")
		if (manager === "yarn" && /Couldn't find a configuration settings named/.test(output)) {
			return ""
		}
		throw error
	}
}
