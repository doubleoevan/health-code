import { execFileSync } from "node:child_process"
import { existsSync, lstatSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { applyEdits, parse as jsonc, modify } from "jsonc-parser/lib/esm/main.js"
import { valid } from "semver"
import type { PackageManager, Project, ToolName } from "../src/contracts.ts"
import { applyManifestChanges } from "../src/patches/applyManifestChanges.ts"
import { bumpManifest } from "../src/patches/bumpManifest.ts"
import { toToolName } from "../src/sandbox/packageManagerVersions.ts"
import {
	type LockedDependenciesOptions,
	listLockfileNames,
	type Manifest,
	parseManifest,
	readLockedDependencies,
	selectPackageManager,
	toLockfileName,
} from "../src/upgrades/readLockedDependencies.ts"
import { type DeclaredPackageManager, toDeclaredPackageManager } from "../src/upgrades/toDeclaredPackageManager.ts"
import { filesUnder, readManifest, readText, workspaceManifests } from "./readProjectFiles.ts"

export function detectProject(): Project {
	// read the locked dependencies from the checkout's committed files
	const files = filesUnder(".")
	const rootManifest = readManifest(".")
	const lockedDependencies = readLockedDependencies(readLockedDependenciesFiles(files, rootManifest))
	const { manager } = lockedDependencies
	const version = execFileSync(manager, ["--version"], { encoding: "utf8", timeout: 10000 }).trim()

	// scan the names of the environment variables the project reads
	const skipped = new Set(lockedDependencies.skipped)
	const environment = envNames(files, skipped)
	const config = existsSync("tsconfig.json") ? jsonc(readText("tsconfig.json")) : undefined

	// report the available project checks and locked dependencies
	return {
		manager,
		version,
		sources: lockedDependencies.sources,
		skipped: [...skipped].sort(),
		typecheck: config ? (config.references?.length ? "build" : "check") : "none",
		testScript: rootManifest.scripts?.test,
		environment,
	}
}

/**
 * Reads the tool the checkout runs and the package manager version its committed files declare.
 */
export function readCheckoutDeclaredPackageManager(): {
	tool: ToolName
	declaredPackageManager?: DeclaredPackageManager
} {
	// read the manifest, the lockfile names and bun's version file from the checkout
	const manifest = parseManifest(readText("package.json"))
	const manager = selectPackageManager(manifest, listLockfileNames(existsSync))
	const bunVersionFile = existsSync(".bun-version") ? readText(".bun-version") : undefined
	const declaredPackageManager = toDeclaredPackageManager({ manager, manifest, bunVersionFile })
	return { tool: readToolName(manager), ...(declaredPackageManager && { declaredPackageManager }) }
}

/**
 * Names the tool the checkout runs for a package manager.
 */
export function readToolName(manager: PackageManager): ToolName {
	// read the files that tell modern yarn from classic
	const files = new Map<string, string>()
	for (const name of [".yarnrc.yml", "yarn.lock"]) {
		if (manager === "yarn" && existsSync(name)) {
			files.set(name, readText(name))
		}
	}
	return toToolName(manager, files)
}

/**
 * Selects the checkout's package manager from a manifest and the lockfiles present.
 */
export function detectPackageManager(manifest: Manifest): PackageManager {
	return selectPackageManager(manifest, listLockfileNames(existsSync))
}

// collect the text of the manifests, the lockfile and the bun version file
function readLockedDependenciesFiles(files: string[], rootManifest: Manifest): LockedDependenciesOptions {
	const lockfileNames = listLockfileNames(existsSync)
	const workspaces = workspaceManifests(files).map(([directory]) => directory)
	const workspaceDirectories = workspaces.filter((directory) => directory !== ".")

	// read the root manifest and each workspace manifest as text
	const fileContents = new Map<string, string>([["package.json", readText("package.json")]])
	for (const directory of workspaceDirectories) {
		fileContents.set(`${directory}/package.json`, readText(join(directory, "package.json")))
	}

	// decode a binary bun lockfile with bun and read every other lockfile as text
	const lockfileName = toLockfileName(selectPackageManager(rootManifest, lockfileNames), lockfileNames)
	const lockfileText =
		lockfileName === "bun.lockb"
			? execFileSync("bun", [lockfileName], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
			: readText(lockfileName)
	fileContents.set(lockfileName, lockfileText)

	// include the bun version file when the project commits one
	if (existsSync(".bun-version")) {
		fileContents.set(".bun-version", readText(".bun-version"))
	}
	return { files: fileContents, lockfileNames, workspaceDirectories }
}

function envNames(files: string[], skipped: Set<string>): string[] {
	const names = new Set<string>()
	let scanned = 0

	// scan source and example environment declarations within size limits
	for (const file of files.filter((f) => f.endsWith(".env.example") || /\.[cm]?[jt]sx?$/.test(f))) {
		const size = lstatSync(file).size
		if (size > 1024 * 1024) {
			skipped.add(`${file}: environment scan file limit`)
			continue
		}
		scanned += size

		// bound the cumulative environment scan
		if (scanned > 32 * 1024 * 1024) {
			throw new Error("Environment scan exceeds limits")
		}
		const text = readText(file)
		recordNames(text, file, names, skipped)
	}
	return [...names].filter(Boolean).sort()
}

// collect static environment names without reading their values
function recordNames(text: string, file: string, names: Set<string>, skipped: Set<string>): void {
	const regex = file.endsWith(".env.example")
		? /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm
		: /(?:process|Bun|import\.meta)\.env(?:\.([A-Za-z_]\w*)|\[['"]([A-Za-z_]\w*)['"]\])/g
	for (const match of text.matchAll(regex)) {
		names.add(match[1] ?? match[2] ?? "")
	}

	// skip destructuring scans for example configuration files
	if (file.endsWith(".env.example")) {
		return
	}
	for (const statement of text.matchAll(/\{([^{}]+)\}\s*=\s*(?:process|Bun|import\.meta)\.env\b/g)) {
		for (const binding of (statement[1] ?? "").split(",")) {
			const name = binding.trim().match(/^([A-Za-z_]\w*)/)?.[1]

			// collect the original name from each destructured binding
			if (name) {
				names.add(name)
			}
		}
	}

	// record references that require runtime computation
	if (/(?:process|Bun|import\.meta)\.env\s*\[\s*[^"'\s]/.test(text)) {
		skipped.add(`${file}: dynamic environment reference`)
	}
}

export function bumpDependency(name: string, target: string): void {
	// require a concrete target version for the manifest change
	if (!valid(target)) {
		throw new Error("Invalid target version")
	}

	// update each workspace that declares the dependency
	for (const [dir, manifest] of workspaceManifests(filesUnder("."))) {
		if (bumpManifest({ dir, manifest, name, target })) {
			writeManifest(dir, manifest)
		}
	}
}

function writeManifest(dir: string, manifest: Manifest): void {
	const file = join(dir, "package.json")
	writeFileSync(file, applyManifestChanges({ applyEdits, modify }, readText(file), manifest))
}
