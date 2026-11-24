import { existsSync, writeFileSync } from "node:fs"
import { valid } from "semver"
import { lockfiles, sections } from "../src/patches/bumpManifest.ts"
import { filesUnder, readText, workspaceManifests } from "./inventory.ts"

type LockedPackage = { version?: string; link?: boolean }
type NpmLockfile = { packages?: Record<string, LockedPackage> }

/**
 * Removes npm lockfile entries whose version differs from an exact manifest version.
 */
export function removeOutdatedLockfileEntries(): void {
	const lockfilePath = lockfiles.npm.find((name) => existsSync(name))
	if (!lockfilePath) {
		return
	}

	// npm reports false peer conflicts when it resolves changed versions against outdated entries
	const text = readText(lockfilePath)
	const lockfile: NpmLockfile = JSON.parse(text)
	const outdatedPaths = findOutdatedPaths(lockfile.packages ?? {})
	if (!outdatedPaths.length) {
		return
	}

	// remove each outdated package and the packages nested under it
	for (const path of Object.keys(lockfile.packages ?? {})) {
		if (outdatedPaths.some((outdatedPath) => path === outdatedPath || path.startsWith(`${outdatedPath}/`))) {
			delete lockfile.packages?.[path]
		}
	}

	// keep the indentation that npm reuses for the new lockfile
	const indentation = /\n([ \t]+)"/.exec(text)?.[1] ?? "  "
	writeFileSync(lockfilePath, `${JSON.stringify(lockfile, null, indentation)}\n`)
}

// compare each exact declaration with the package its workspace uses
function findOutdatedPaths(packages: Record<string, LockedPackage>): string[] {
	return workspaceManifests(filesUnder(".")).flatMap(([dir, manifest]) =>
		sections.flatMap((section) =>
			Object.entries(manifest[section] ?? {}).flatMap(([name, version]) => {
				const rootPath = `node_modules/${name}`
				const workspacePath = dir === "." ? rootPath : `${dir}/${rootPath}`
				const path = Object.hasOwn(packages, workspacePath) ? workspacePath : rootPath
				const lockedPackage = packages[path]

				// keep ranges, workspace links and matching versions
				const isOutdated = lockedPackage?.version && !lockedPackage.link && lockedPackage.version !== version
				return valid(version) && isOutdated ? [path] : []
			}),
		),
	)
}
