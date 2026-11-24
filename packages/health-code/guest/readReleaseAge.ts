import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { matchesGlob } from "node:path"
import { parse as toml } from "smol-toml"
import type { PackageManager } from "../src/contracts.ts"
import { readText } from "./inventory.ts"

export type ReleaseAge = { publishedBefore: number; excluded: string[] }

/**
 * Reads the package manager's effective minimum release age for this repository.
 */
export function readReleaseAge(
	manager: PackageManager,
	config: (args: string[]) => string = (args) => readConfig(manager, args),
): ReleaseAge | undefined {
	if (manager === "bun") {
		return readBunReleaseAge()
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

/**
 * Checks whether a package is exempt from the repository's release age.
 */
export function isExcluded(name: string, age: ReleaseAge): boolean {
	return age.excluded.some((pattern) => matchesGlob(name, pattern))
}

function readBunReleaseAge(): ReleaseAge | undefined {
	if (!existsSync("bunfig.toml")) {
		return undefined
	}

	// bun measures the release age in seconds
	const { install } = toml(readText("bunfig.toml")) as {
		install?: { minimumReleaseAge?: unknown; minimumReleaseAgeExcludes?: unknown }
	}

	// skip the age check when the setting is off
	const seconds = install?.minimumReleaseAge
	if (seconds === undefined || seconds === 0) {
		return undefined
	}
	return toReleaseAge(Date.now() - Number(seconds) * 1000, install?.minimumReleaseAgeExcludes)
}

function toReleaseAge(publishedBefore: number, excluded: unknown): ReleaseAge {
	if (!Number.isFinite(publishedBefore)) {
		throw new Error("Unsupported minimum release age")
	}
	const names = Array.isArray(excluded) ? excluded : []
	return { publishedBefore, excluded: names.filter((name) => typeof name === "string") }
}

function toSetting(output: string): string | undefined {
	const value = output.trim()
	return value === "" || value === "undefined" || value === "null" ? undefined : value
}

function toNames(output: string): unknown {
	const value = toSetting(output)
	return value === undefined ? [] : JSON.parse(value)
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
