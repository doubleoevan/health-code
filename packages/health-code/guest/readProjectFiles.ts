import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs"
import { join, matchesGlob, sep } from "node:path"
import { parse as yaml } from "yaml"
import type { Manifest } from "../src/patches/bumpManifest.ts"

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
