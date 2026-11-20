import { execFileSync } from "node:child_process"
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { join, matchesGlob, sep } from "node:path"
import { parse as parseClassicLock } from "@yarnpkg/lockfile"
import { parse as jsonc } from "jsonc-parser/lib/esm/main.js"
import { valid, validRange } from "semver"
import { parse as yaml } from "yaml"
import type { PackageManager, Project } from "../src/contracts.ts"

export type Manifest = {
	name?: string
	overrides?: Record<string, string | Record<string, unknown>>
	packageManager?: string
	workspaces?: string[] | { packages: string[] }
	scripts?: { test?: string }
	dependencies?: Record<string, string>
	devDependencies?: Record<string, string>
	optionalDependencies?: Record<string, string>
	peerDependencies?: Record<string, string>
}
const sections = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const
const lockfiles = {
	npm: ["npm-shrinkwrap.json", "package-lock.json"],
	bun: ["bun.lock", "bun.lockb"],
	pnpm: ["pnpm-lock.yaml"],
	yarn: ["yarn.lock"],
} as const
const ignore = new Set([".git", "node_modules", ".health-code", ".yarn", ".pnpm-store"])

export function readText(path: string): string {
	const full = realpathSync(path)
	const base = realpathSync(".")
	if (!full.startsWith(base + sep) || lstatSync(full).size > 16 * 1024 * 1024) {
		throw new Error("Project file exceeds limits")
	}
	return readFileSync(full, "utf8")
}
export function readManifest(path: string): Manifest {
	return JSON.parse(readText(join(path, "package.json")))
}
export function managerName(manifest: Manifest): PackageManager {
	const detected = (Object.keys(lockfiles) as PackageManager[]).filter((name) =>
		lockfiles[name].some((file) => existsSync(file)),
	)
	const declared = manifest.packageManager?.split("@")[0]
	if (declared && detected.includes(declared as PackageManager)) {
		return declared as PackageManager
	}
	if (detected.length === 1 && !declared) {
		return detected[0] as PackageManager
	}
	throw new Error("Unsupported or ambiguous root lockfile")
}
function ignored(name: string, symlink: boolean): boolean {
	return symlink || ignore.has(name) || (name.startsWith(".env") && name !== ".env.example")
}
function filesUnder(root: string): string[] {
	const result: string[] = []
	let count = 0
	function visit(dir: string): void {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (++count > 50000) {
				throw new Error("Project file count exceeds limits")
			}
			if (ignored(entry.name, entry.isSymbolicLink())) {
				continue
			}
			const path = join(dir, entry.name)
			if (entry.isDirectory()) {
				visit(path)
			} else if (entry.isFile()) {
				result.push(path)
			}
		}
	}
	visit(root)
	return result
}
function manifests(files: string[]): [string, Manifest][] {
	const root = readManifest(".")
	const declared = root.workspaces
	const pnpm = existsSync("pnpm-workspace.yaml") ? yaml(readText("pnpm-workspace.yaml"))?.packages : undefined
	const patterns: unknown = pnpm ?? (Array.isArray(declared) ? declared : declared?.packages) ?? []
	if (!Array.isArray(patterns) || !patterns.every((p) => typeof p === "string")) {
		throw new Error("Unsupported workspace declaration")
	}
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
	let included = false
	for (const pattern of patterns) {
		const negative = pattern.startsWith("!")
		const glob = (negative ? pattern.slice(1) : pattern).replace(/\/$/, "")
		if (matchesGlob(dir, glob)) {
			if (negative && excludeFirst) {
				return false
			}
			included = !negative
		}
	}
	return included
}
export function workspaceDirectories(): string[] {
	return manifests(filesUnder("."))
		.map(([dir]) => dir)
		.filter((dir) => dir !== ".")
		.sort((a, b) => b.length - a.length)
}
type VersionLookup = (dir: string, name: string, range: string) => unknown
function versionLookup(manager: PackageManager): VersionLookup {
	if (manager === "npm") {
		const lock = JSON.parse(readText(lockfiles.npm.find((file) => existsSync(file)) ?? "package-lock.json"))
		return (dir, name) =>
			lock.packages?.[join(dir, "node_modules", name)]?.version ??
			lock.packages?.[`node_modules/${name}`]?.version ??
			lock.dependencies?.[name]?.version
	}
	if (manager === "pnpm") {
		const lock = yaml(readText("pnpm-lock.yaml"))
		return (dir, name) => {
			const importer = lock.importers?.[dir] ?? (dir === "." ? lock : {})
			for (const section of sections) {
				const value = importer?.[section]?.[name]
				if (value) {
					return String(value.version ?? value).split("(")[0]
				}
			}
		}
	}
	if (manager === "bun" && existsSync("bun.lock")) {
		const lock = jsonc(readText("bun.lock"))
		return (dir, name) => {
			const workspace = lock.workspaces?.[dir]?.name
			const entry = lock.packages?.[`${workspace}/${name}`] ?? lock.packages?.[name]
			return entry?.[0]?.slice(name.length + 1)
		}
	}
	const raw =
		manager === "bun"
			? execFileSync("bun", [lockfiles.bun[1]], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
			: readText("yarn.lock")
	const lock: Record<string, { version: string }> = raw.includes("__metadata:")
		? yaml(raw)
		: parseClassicLock(raw).object
	return (_dir, name, range) =>
		Object.entries(lock).find(([key]) =>
			key.split(", ").some((k) => k === `${name}@${range}` || k === `${name}@npm:${range}`),
		)?.[1]?.version
}
function envNames(files: string[], skipped: Set<string>): string[] {
	const names = new Set<string>()
	let scanned = 0
	for (const file of files.filter((f) => f.endsWith(".env.example") || /\.[cm]?[jt]sx?$/.test(f))) {
		const size = lstatSync(file).size
		if (size > 1024 * 1024) {
			skipped.add(`${file}: environment scan file limit`)
			continue
		}
		scanned += size
		if (scanned > 32 * 1024 * 1024) {
			throw new Error("Environment scan exceeds limits")
		}
		const text = readText(file)
		recordNames(text, file, names, skipped)
	}
	return [...names].filter(Boolean).sort()
}
function recordNames(text: string, file: string, names: Set<string>, skipped: Set<string>): void {
	const regex = file.endsWith(".env.example")
		? /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm
		: /(?:process|Bun|import\.meta)\.env(?:\.([A-Za-z_]\w*)|\[['"]([A-Za-z_]\w*)['"]\])/g
	for (const match of text.matchAll(regex)) {
		names.add(match[1] ?? match[2] ?? "")
	}
	if (file.endsWith(".env.example")) {
		return
	}
	for (const statement of text.matchAll(/\{([^{}]+)\}\s*=\s*(?:process|Bun|import\.meta)\.env\b/g)) {
		for (const binding of (statement[1] ?? "").split(",")) {
			const name = binding.trim().match(/^([A-Za-z_]\w*)/)?.[1]
			if (name) {
				names.add(name)
			}
		}
	}
	if (/(?:process|Bun|import\.meta)\.env\s*\[\s*[^"'\s]/.test(text)) {
		skipped.add(`${file}: dynamic environment reference`)
	}
}
export function detectProject(): Project {
	const files = filesUnder(".")
	const entries = manifests(files)
	const root = readManifest(".")
	const manager = managerName(root)
	const version = execFileSync(manager, ["--version"], { encoding: "utf8", timeout: 10000 }).trim()
	const lookup = versionLookup(manager)
	const sources: Project["sources"] = Object.create(null)
	const skipped = new Set<string>()
	const unsupported = new Set<string>()
	for (const [dir, manifest] of entries) {
		for (const [name, range] of sections.flatMap((section) => Object.entries(manifest[section] ?? {}))) {
			const value = lookup(dir, name, range)
			if (typeof value !== "string" || !valid(value) || !registrySource(range)) {
				unsupported.add(name)
				skipped.add(`${dir} ${name}: unsupported or unresolved source`)
				continue
			}
			sources[name] ??= Object.create(null)
			;(sources[name] as Record<string, string>)[dir] = value
		}
	}
	for (const name of unsupported) {
		delete sources[name]
	}
	const environment = envNames(files, skipped)
	const config = existsSync("tsconfig.json") ? jsonc(readText("tsconfig.json")) : undefined
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
	if (!valid(target)) {
		throw new Error("Invalid target version")
	}
	for (const [dir, manifest] of manifests(filesUnder("."))) {
		let changed = false
		for (const section of sections) {
			const values = manifest[section]
			if (values && Object.hasOwn(values, name)) {
				if (dir === "." && manifest.overrides) {
					updateOverride(manifest.overrides, name, values[name], target)
				}
				values[name] = target
				changed = true
			}
		}
		if (changed) {
			writeManifest(dir, manifest)
		}
	}
}

function writeManifest(dir: string, manifest: Manifest): void {
	writeFileSync(join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`)
}

function registrySource(range: string): boolean {
	return !!validRange(range) || /^[a-z][a-z0-9_.-]*$/i.test(range)
}

function updateOverride(
	overrides: NonNullable<Manifest["overrides"]>,
	name: string,
	from: string | undefined,
	to: string,
): void {
	const rule = overrides[name]
	if (typeof rule === "string" && rule === from) {
		overrides[name] = to
	} else if (rule && typeof rule === "object" && rule["."] === from) {
		rule["."] = to
	}
}
