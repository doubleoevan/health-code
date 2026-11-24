import { execFileSync } from "node:child_process"
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { join, matchesGlob, sep } from "node:path"
import { parse as parseClassicLock } from "@yarnpkg/lockfile"
import { applyEdits, parse as jsonc, modify } from "jsonc-parser/lib/esm/main.js"
import { valid, validRange } from "semver"
import { parse as yaml } from "yaml"
import { applyManifestChanges } from "../src/applyManifestChanges.ts"
import { bumpManifest, lockfiles, type Manifest, sections } from "../src/bumpManifest.ts"
import type { PackageManager, Project } from "../src/contracts.ts"

export type { Manifest } from "../src/bumpManifest.ts"

const ignore = new Set([".git", "node_modules", ".health-code", ".yarn", ".pnpm-store"])

export function readText(path: string): string {
	// limit reads to bounded files inside the project
	const full = realpathSync(path)
	const base = realpathSync(".")
	if (!full.startsWith(base + sep) || lstatSync(full).size > 16 * 1024 * 1024) {
		throw new Error("Project file exceeds limits")
	}
	return readFileSync(full, "utf8")
}

// read the manifest through the project path checks
export function readManifest(path: string): Manifest {
	return JSON.parse(readText(join(path, "package.json")))
}
export function managerName(manifest: Manifest): PackageManager {
	const detected = (Object.keys(lockfiles) as PackageManager[]).filter((name) =>
		lockfiles[name].some((file) => existsSync(file)),
	)

	// use the declared manager when its lockfile is present
	const declared = manifest.packageManager?.split("@")[0]
	if (declared && detected.includes(declared as PackageManager)) {
		return declared as PackageManager
	}
	if (detected.length === 1 && !declared) {
		return detected[0] as PackageManager
	}

	// reject missing or conflicting package manager evidence
	throw new Error("Unsupported or ambiguous root lockfile")
}
function ignored(name: string, symlink: boolean): boolean {
	return symlink || ignore.has(name) || (name.startsWith(".env") && name !== ".env.example")
}
export function filesUnder(root: string): string[] {
	// enumerate project files with a shared traversal budget
	const result: string[] = []
	let count = 0
	function visit(dir: string): void {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (++count > 50000) {
				throw new Error("Project file count exceeds limits")
			}

			// skip links, dependency trees and private environment files
			if (ignored(entry.name, entry.isSymbolicLink())) {
				continue
			}
			const path = join(dir, entry.name)

			// recurse into directories and collect regular files
			if (entry.isDirectory()) {
				visit(path)
			} else if (entry.isFile()) {
				result.push(path)
			}
		}
	}

	// start traversal at the requested root
	visit(root)
	return result
}
export function workspaceManifests(files: string[]): [string, Manifest][] {
	// resolve workspace declarations from the root manifests
	const root = readManifest(".")
	const declared = root.workspaces
	const pnpm = existsSync("pnpm-workspace.yaml") ? yaml(readText("pnpm-workspace.yaml"))?.packages : undefined
	const patterns: unknown = pnpm ?? (Array.isArray(declared) ? declared : declared?.packages) ?? []
	if (!Array.isArray(patterns) || !patterns.every((p) => typeof p === "string")) {
		throw new Error("Unsupported workspace declaration")
	}

	// select only package directories matched by the declarations
	const dirs = files.filter((f) => f.endsWith("/package.json")).map((f) => f.slice(0, -13))
	return [
		[".", root],
		...dirs
			.filter((dir) => includedWorkspace(dir, patterns, pnpm !== undefined))
			.sort()
			.map((d): [string, Manifest] => [d, readManifest(d)]),
	]
}
function includedWorkspace(dir: string, patterns: string[], excludeFirst: boolean): boolean {
	// apply workspace inclusion patterns in order
	let included = false
	for (const pattern of patterns) {
		const negative = pattern.startsWith("!")
		const glob = (negative ? pattern.slice(1) : pattern).replace(/\/$/, "")
		if (matchesGlob(dir, glob)) {
			// honor exclusions before later matches for pnpm
			if (negative && excludeFirst) {
				return false
			}
			included = !negative
		}
	}
	return included
}

// prefer deeper workspaces when assigning a source file
export function workspaceDirectories(): string[] {
	return workspaceManifests(filesUnder("."))
		.map(([dir]) => dir)
		.filter((dir) => dir !== ".")
		.sort((a, b) => b.length - a.length)
}
type VersionLookup = (dir: string, name: string, range: string) => unknown
function versionLookup(manager: PackageManager): VersionLookup {
	// resolve npm versions through workspace and root lock entries
	if (manager === "npm") {
		const lock = JSON.parse(readText(lockfiles.npm.find((file) => existsSync(file)) ?? "package-lock.json"))
		return (dir, name) =>
			lock.packages?.[join(dir, "node_modules", name)]?.version ??
			lock.packages?.[`node_modules/${name}`]?.version ??
			lock.dependencies?.[name]?.version
	}

	// read the matching importer from the pnpm lockfile
	if (manager === "pnpm") {
		const lock = yaml(readText("pnpm-lock.yaml"))
		return (dir, name) => {
			const importer = lock.importers?.[dir] ?? (dir === "." ? lock : {})
			for (const section of sections) {
				const value = importer?.[section]?.[name]

				// strip peer dependency qualifiers from the locked version
				if (value) {
					return String(value.version ?? value).split("(")[0]
				}
			}
		}
	}

	// resolve bun workspace package aliases before root packages
	if (manager === "bun" && existsSync("bun.lock")) {
		const lock = jsonc(readText("bun.lock"))
		return (dir, name) => {
			const workspace = lock.workspaces?.[dir]?.name
			const entry = lock.packages?.[`${workspace}/${name}`] ?? lock.packages?.[name]
			return entry?.[0]?.slice(name.length + 1)
		}
	}

	// decode binary bun lockfiles or read yarn text directly
	const raw =
		manager === "bun"
			? execFileSync("bun", [lockfiles.bun[1]], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
			: readText("yarn.lock")
	const lock: Record<string, { version: string }> = raw.includes("__metadata:")
		? yaml(raw)
		: parseClassicLock(raw).object

	// match the requested descriptor in the decoded lockfile
	return (_dir, name, range) =>
		Object.entries(lock).find(([key]) =>
			key.split(", ").some((k) => k === `${name}@${range}` || k === `${name}@npm:${range}`),
		)?.[1]?.version
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
export function detectProject(): Project {
	// identify the package manager and its locked versions
	const files = filesUnder(".")
	const entries = workspaceManifests(files)
	const root = readManifest(".")
	const manager = managerName(root)
	const version = execFileSync(manager, ["--version"], { encoding: "utf8", timeout: 10000 }).trim()
	const lookup = versionLookup(manager)

	// group resolved dependency versions by workspace
	const sources: Project["sources"] = Object.create(null)
	const skipped = new Set<string>()
	const unsupported = new Set<string>()
	for (const [dir, manifest] of entries) {
		for (const [name, range] of sections.flatMap((section) => Object.entries(manifest[section] ?? {}))) {
			// mark incomplete or non-registry resolutions as unsupported
			const value = lookup(dir, name, range)
			if (typeof value !== "string" || !valid(value) || !registrySource(range)) {
				unsupported.add(name)
				skipped.add(`${dir} ${name}: unsupported or unresolved source`)
				continue
			}

			// retain the workspace-specific installed version
			sources[name] ??= Object.create(null)
			;(sources[name] as Record<string, string>)[dir] = value
		}
	}

	// exclude dependencies with any unsupported workspace occurrence
	for (const name of unsupported) {
		delete sources[name]
	}
	const environment = envNames(files, skipped)
	const config = existsSync("tsconfig.json") ? jsonc(readText("tsconfig.json")) : undefined

	// report the available project checks and public inventory
	return {
		manager,
		version,
		sources,
		skipped: [...skipped].sort(),
		typecheck: config ? (config.references?.length ? "build" : "check") : "none",
		testScript: root.scripts?.test,
		environment,
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

function registrySource(range: string): boolean {
	return !!validRange(range) || /^[a-z][a-z0-9_.-]*$/i.test(range)
}
