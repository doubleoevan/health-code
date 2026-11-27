import { matchesGlob } from "node:path"
import { valid, validRange } from "semver"
import type { PackageManager, Project } from "../contracts.ts"
import { parseYaml } from "../parseYaml.ts"
import { readOwnProperty } from "../readOwnProperty.ts"
import { isBoundedGlobList } from "./isBoundedGlob.ts"
import { readVersionLookup } from "./readVersionLookup.ts"
import { type DeclaredPackageManager, toDeclaredPackageManager } from "./toDeclaredPackageManager.ts"

export type Manifest = {
	name?: string
	overrides?: Record<string, string | Record<string, unknown>>
	packageManager?: string
	workspaces?: string[] | { packages: string[] }
	scripts?: { test?: string }

	// list editable dependency sections in the manifest
	dependencies?: Record<string, string>
	devDependencies?: Record<string, string>
	optionalDependencies?: Record<string, string>
	peerDependencies?: Record<string, string>
}

export const lockfiles = {
	npm: ["npm-shrinkwrap.json", "package-lock.json"],
	bun: ["bun.lock", "bun.lockb"],
	pnpm: ["pnpm-lock.yaml"],
	yarn: ["yarn.lock"],
} as const

export const sections = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const

// the locked version of each direct dependency per workspace, with the dependencies that were skipped
export type LockedDependencies = {
	manager: PackageManager
	sources: Project["sources"]
	skipped: string[]
	declaredPackageManager?: DeclaredPackageManager
}

// file contents by path relative to the repository root
type ProjectFileContents = ReadonlyMap<string, string>

export type LockedDependenciesOptions = {
	files: ProjectFileContents
	lockfileNames: readonly string[]
	workspaceDirectories: readonly string[]
}

// a project that cannot be detected. the message holds no repository text
export class ProjectDetectionError extends Error {}

// the reasons a project cannot be detected
export const detectionReasons = {
	manifest: "Unsupported or missing package manifest",
	lockfile: "Unsupported or ambiguous root lockfile",
	workspaces: "Unsupported workspace declaration",
}

// the directories and private environment files a project reader skips, and the most files it lists
const ignoredDirectories = new Set([".git", "node_modules", ".health-code", ".yarn", ".pnpm-store"])
export const maxProjectFiles = 50000

// the most time an untrusted declaration can spend matching directories, and the matches between clock checks
const maxMatchMs = 10000
const matchesPerClockCheck = 1000

// the declared dependencies one project can hold, and the longest name npm accepts
const maxDeclaredDependencies = 10000
const maxNameLength = 214

/**
 * Reads the package manager, the locked version of each direct dependency per workspace and the skipped dependencies.
 */
export function readLockedDependencies({
	files,
	lockfileNames,
	workspaceDirectories,
}: LockedDependenciesOptions): LockedDependencies {
	// identify the package manager and its locked versions
	const rootManifest = parseManifest(files.get("package.json"))
	const manager = selectPackageManager(rootManifest, lockfileNames)
	const lockfileName = toLockfileName(manager, lockfileNames)
	const lockfileText = readLockfileText({ files, lockfileName })
	const readLockedVersion = readVersionLookup({ manager, lockfileName, lockfileText, sections })

	// group resolved dependency versions by workspace
	const sources: Project["sources"] = Object.create(null)
	const skipped = new Set<string>()
	const unsupported = new Set<string>()
	const manifests = new Map([[".", rootManifest]])
	for (const directory of workspaceDirectories) {
		manifests.set(directory, parseManifest(files.get(`${directory}/package.json`)))
	}
	for (const [directory, name, range] of toDeclarations(manifests)) {
		// skip a name no registry package can have, without repeating its text
		if (name.length > maxNameLength) {
			skipped.add(`${directory} ${name.slice(0, 32)}…: unsupported or unresolved source`)
			continue
		}

		// mark incomplete or non-registry resolutions as unsupported
		const lockedVersion = typeof range === "string" ? readLockedVersion(directory, name, range) : undefined
		if (typeof lockedVersion !== "string" || !valid(lockedVersion) || !isRegistrySource(range)) {
			unsupported.add(name)
			skipped.add(`${directory} ${name}: unsupported or unresolved source`)
			continue
		}

		// retain the workspace-specific locked version
		sources[name] ??= Object.create(null)
		;(sources[name] as Record<string, string>)[directory] = lockedVersion
	}

	// exclude dependencies with any unsupported workspace occurrence
	for (const name of unsupported) {
		delete sources[name]
	}
	const declaredPackageManager = toDeclaredPackageManager({
		manager,
		manifest: rootManifest,
		bunVersionFile: files.get(".bun-version"),
	})
	return { manager, sources, skipped: [...skipped].sort(), ...(declaredPackageManager && { declaredPackageManager }) }
}

/**
 * Selects the declared workspace directories among the directories that hold a manifest.
 */
export function selectWorkspaceDirectories({
	rootManifest,
	pnpmWorkspace,
	filePaths,
	manager,
}: {
	rootManifest: string
	pnpmWorkspace?: string
	filePaths: readonly string[]

	// the detected package manager, which decides the file that declares workspaces
	manager?: PackageManager
}): string[] {
	// read the pnpm workspace file for pnpm only. another package manager ignores a leftover one
	const declared = parseManifest(rootManifest).workspaces
	const manifestPatterns: unknown = Array.isArray(declared) ? declared : readOwnProperty(declared, "packages")
	const shouldReadPnpm = pnpmWorkspace !== undefined && (manager === undefined || manager === "pnpm")
	const pnpm = shouldReadPnpm ? readOwnProperty(parseYaml(pnpmWorkspace), "packages") : undefined

	// pnpm reads no workspaces from the manifest, so a workspace file without a list means the root alone
	const patterns: unknown = manager === "pnpm" ? (pnpm ?? []) : (pnpm ?? manifestPatterns ?? [])
	if (!isBoundedGlobList(patterns)) {
		throw new ProjectDetectionError(detectionReasons.workspaces)
	}

	// list the directories below the root that hold a manifest
	const manifestSuffix = "/package.json"
	const manifestDirectories = filePaths
		.filter((path) => path.endsWith(manifestSuffix))
		.map((path) => path.slice(0, -manifestSuffix.length))

	// select only package directories matched by the declarations, inside a time budget
	const started = performance.now()
	const includedDirectories = manifestDirectories.filter((directory, index) => {
		if (index % matchesPerClockCheck === 0 && performance.now() - started > maxMatchMs) {
			throw new ProjectDetectionError(detectionReasons.workspaces)
		}
		return isIncludedWorkspace({ directory, patterns, shouldExcludeFirst: pnpm !== undefined })
	})

	// return the workspaces in a stable order
	return includedDirectories.sort()
}

/**
 * Lists the root lockfiles a project holds.
 */
export function listLockfileNames(isPresent: (name: string) => boolean): string[] {
	return Object.values(lockfiles).flat().filter(isPresent)
}

/**
 * Checks whether a project reader skips a file or directory name.
 */
export function isIgnoredProjectName(name: string): boolean {
	return ignoredDirectories.has(name) || (name.startsWith(".env") && name !== ".env.example")
}

/**
 * Selects the package manager whose root lockfile is present and that the manifest names.
 */
export function selectPackageManager(manifest: Manifest, lockfileNames: readonly string[]): PackageManager {
	const detected = (Object.keys(lockfiles) as PackageManager[]).filter((name) =>
		lockfiles[name].some((file) => lockfileNames.includes(file)),
	)

	// use the declared manager when its lockfile is present
	const declared = typeof manifest.packageManager === "string" ? manifest.packageManager.split("@")[0] : undefined
	if (declared && detected.includes(declared as PackageManager)) {
		return declared as PackageManager
	}
	if (detected.length === 1 && !declared) {
		return detected[0] as PackageManager
	}

	// reject missing or conflicting package manager evidence
	throw new ProjectDetectionError(detectionReasons.lockfile)
}

/**
 * Names the root lockfile that holds the package manager's locked versions.
 */
export function toLockfileName(manager: PackageManager, lockfileNames: readonly string[]): string {
	return lockfiles[manager].find((file) => lockfileNames.includes(file)) ?? lockfiles[manager][0]
}

/**
 * Parses a manifest and rejects a document that is not an object.
 */
export function parseManifest(text: string | undefined): Manifest {
	const manifest: unknown = text === undefined ? undefined : JSON.parse(text)
	if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
		throw new ProjectDetectionError(detectionReasons.manifest)
	}
	return manifest
}

// read the text of the lockfile the package manager reads
function readLockfileText({
	files,
	lockfileName,
}: Pick<LockedDependenciesOptions, "files"> & { lockfileName: string }): string {
	const lockfileText = files.get(lockfileName)
	if (lockfileText !== undefined) {
		return lockfileText
	}

	throw new ProjectDetectionError(detectionReasons.lockfile)
}

function toDeclaredDependencies(manifest: Manifest): [string, unknown][] {
	return sections.flatMap((section) => {
		const declared = readOwnProperty(manifest, section)
		return typeof declared === "object" && declared !== null ? Object.entries(declared) : []
	})
}

// list each workspace's declarations, bounded so the skipped list and the registry lookups stay bounded
function toDeclarations(manifests: Map<string, Manifest>): [directory: string, name: string, range: unknown][] {
	const declarations: [string, string, unknown][] = []
	for (const [directory, manifest] of manifests) {
		for (const [name, range] of toDeclaredDependencies(manifest)) {
			declarations.push([directory, name, range])
		}

		// reject the project once the count passes the bound, before reading more manifests
		if (declarations.length > maxDeclaredDependencies) {
			throw new ProjectDetectionError(`More than ${maxDeclaredDependencies} declared dependencies`)
		}
	}
	return declarations
}

function isRegistrySource(range: unknown): boolean {
	return typeof range === "string" && (!!validRange(range) || /^[a-z][a-z0-9_.-]*$/i.test(range))
}

function isIncludedWorkspace({
	directory,
	patterns,
	shouldExcludeFirst,
}: {
	directory: string
	patterns: string[]
	shouldExcludeFirst: boolean
}): boolean {
	// apply workspace inclusion patterns in order
	let isIncluded = false
	for (const pattern of patterns) {
		const isNegated = pattern.startsWith("!")
		const glob = (isNegated ? pattern.slice(1) : pattern).replace(/\/$/, "")
		if (matchesGlob(directory, glob)) {
			// honor exclusions before later matches for pnpm
			if (isNegated && shouldExcludeFirst) {
				return false
			}
			isIncluded = !isNegated
		}
	}
	return isIncluded
}
