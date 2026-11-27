import { satisfies } from "semver"
import type { PackageManager, ToolName } from "../contracts.ts"
import { parseYaml } from "../parseYaml.ts"
import { readOwnProperty } from "../readOwnProperty.ts"

type PackageManagerTool = {
	package: string
	bundledPackageManagerVersion: string
	bundledHash: string
	supportedRange: string

	// the executable inside the archive and the command name it is linked as
	bin: string
	commandName: PackageManager
}

// the official npm package, the bundled version and the versions the guest's commands support
export const packageManagerTools: Record<ToolName, PackageManagerTool> = {
	npm: {
		package: "npm",
		bundledPackageManagerVersion: "11.11.0",
		bundledHash: "82gRxKrh/eY5UnNorkTFcdBQAGpgjWehkfGVqAGlJjejEtJZGGJUqjo3mbBTNbc5BTnPKGVtGPBZGhElujX5cw==",
		supportedRange: ">=10.0.0 <12.0.0",
		bin: "bin/npm-cli.js",
		commandName: "npm",
	},
	pnpm: {
		package: "pnpm",
		bundledPackageManagerVersion: "10.19.0",
		bundledHash: "yfxyNukq31yK9C/VvxYS35nCzrYvJwRwMvRyCzP46s3eMRhl6RxBHyd09hjYLzIICOy1Fxi/qCwGDEunx2oyuA==",
		supportedRange: ">=9.0.0 <12.0.0",
		bin: "bin/pnpm.cjs",
		commandName: "pnpm",
	},
	bun: {
		package: "@oven/bun-linux-x64",
		bundledPackageManagerVersion: "1.4.3",
		bundledHash: "RArgnpjeXjaGzjp5h7Rs89cUYJutO8IyqR3itE8OBaBzEt8KNm2jp/YozxBHq4eFovwrQLryeSwTAcmiT+zcoA==",
		supportedRange: ">=1.2.0 <2.0.0",
		bin: "bin/bun",
		commandName: "bun",
	},
	yarn: {
		package: "yarn",
		bundledPackageManagerVersion: "1.22.22",
		bundledHash: "prL3kGtyG7o9Z9Sv8IPfBNrWTDmXB4Qbes8A9rEzt6wkJV8mUvoirjU0Mp3GGAU06Y0XQyA3/2/RQFVuK7MTfg==",
		supportedRange: ">=1.22.0 <2.0.0",
		bin: "bin/yarn.js",
		commandName: "yarn",
	},
	"yarn-modern": {
		package: "@yarnpkg/cli-dist",
		bundledPackageManagerVersion: "4.9.2",
		bundledHash: "qrMyWzvEnWhaWOflvE1pGxWGiVOPsO/q4XfGCeRPnLU8ECkvhrhJEfCNakcy3s3VHcApBASQ4fmL0sOEw6xtZQ==",
		supportedRange: ">=4.0.0 <5.0.0",
		bin: "bin/yarn.js",
		commandName: "yarn",
	},
}

// the name each tool is shown by
export const packageManagerDisplayNames: Record<ToolName, string> = {
	npm: "npm",
	pnpm: "pnpm",
	bun: "Bun",
	yarn: "Yarn",
	"yarn-modern": "Yarn",
}

// the reason a declared version is not installed when the range excludes it
export const unsupportedVersionReason = "is outside the supported range"

/**
 * Builds the registry path of a package version's archive from its fixed name.
 */
export function toArchivePath({ packageName, version }: { packageName: string; version: string }): string {
	return `${packageName}/-/${packageName.split("/").at(-1)}-${version}.tgz`
}

type PackageManagerVersionOptions = {
	manager: PackageManager
	declaredPackageManagerVersion?: string
	files: ReadonlyMap<string, string>
}

/**
 * Names the tool the sandbox runs for a package manager, telling modern yarn from classic.
 */
export function toToolName(manager: PackageManager, files: ReadonlyMap<string, string>): ToolName {
	const isModernYarn = files.has(".yarnrc.yml") || files.get("yarn.lock")?.includes("__metadata:")
	return manager === "yarn" && isModernYarn ? "yarn-modern" : manager
}

/**
 * Checks whether a version is three plain numbers, with no range, tag or prerelease.
 */
export function isExactVersion(version: string): boolean {
	return /^\d+\.\d+\.\d+$/.test(version)
}

/**
 * Checks whether a declared version is inside the range the sandbox installs.
 */
export function isSupportedVersion(toolName: ToolName, version: string): boolean {
	return satisfies(version, packageManagerTools[toolName].supportedRange)
}

/**
 * Resolves the package manager version the sandbox would run, or nothing when committed input hides it.
 */
export function toSandboxPackageManagerVersion({
	manager,
	declaredPackageManagerVersion,
	files,
}: PackageManagerVersionOptions): string | undefined {
	const toolName = toToolName(manager, files)

	// return the declared version when yarn runs a committed binary
	if (toolName === "yarn-modern" && hasYarnPath(files.get(".yarnrc.yml"))) {
		return declaredPackageManagerVersion
	}

	// run a declared version inside the supported range and otherwise the bundled one
	const isDeclaredVersionSupported =
		declaredPackageManagerVersion !== undefined && isSupportedVersion(toolName, declaredPackageManagerVersion)
	return isDeclaredVersionSupported
		? declaredPackageManagerVersion
		: packageManagerTools[toolName].bundledPackageManagerVersion
}

function hasYarnPath(configuration: string | undefined): boolean {
	if (configuration === undefined) {
		return false
	}

	// treat an unreadable configuration as a committed binary
	try {
		return readOwnProperty(parseYaml(configuration), "yarnPath") !== undefined
	} catch {
		return true
	}
}
