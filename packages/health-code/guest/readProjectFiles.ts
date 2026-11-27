import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs"
import { join, sep } from "node:path"
import type { PackageManager } from "../src/contracts.ts"
import {
	isIgnoredProjectName,
	listLockfileNames,
	type Manifest,
	maxProjectFiles,
	parseManifest,
	selectPackageManager,
	selectWorkspaceDirectories,
} from "../src/upgrades/readLockedDependencies.ts"

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

export function filesUnder(root: string): string[] {
	// enumerate project files with a shared traversal budget
	const result: string[] = []
	let count = 0
	function visit(dir: string): void {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (++count > maxProjectFiles) {
				throw new Error("Project file count exceeds limits")
			}

			// skip links, dependency trees and private environment files
			if (entry.isSymbolicLink() || isIgnoredProjectName(entry.name)) {
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
	// resolve the declared workspaces among the directories that hold a manifest
	const rootManifest = readText("package.json")
	const directories = selectWorkspaceDirectories({
		rootManifest,
		pnpmWorkspace: existsSync("pnpm-workspace.yaml") ? readText("pnpm-workspace.yaml") : undefined,
		filePaths: files,
		manager: readPackageManager(rootManifest),
	})
	const manifests = directories.map((directory): [string, Manifest] => [directory, readManifest(directory)])
	return [[".", readManifest(".")], ...manifests]
}

// name the package manager when the lockfiles select one, so a patch that removes a lockfile still lists workspaces
function readPackageManager(rootManifest: string): PackageManager | undefined {
	try {
		return selectPackageManager(parseManifest(rootManifest), listLockfileNames(existsSync))
	} catch {
		return undefined
	}
}

// prefer deeper workspaces when assigning a source file
export function workspaceDirectories(): string[] {
	return workspaceManifests(filesUnder("."))
		.map(([dir]) => dir)
		.filter((dir) => dir !== ".")
		.sort((a, b) => b.length - a.length)
}
