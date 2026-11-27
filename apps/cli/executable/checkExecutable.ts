import { fileURLToPath } from "node:url"
import { libraryVersion, type PackageFileDigest } from "health-code"

// the npm command the executable is compared with, and what a finished command printed
export const npmCliPath = fileURLToPath(new URL("../../../packages/health-code/dist/cli/cli.js", import.meta.url))
export type CommandRun = { status: number | null; stdout: string; stderr: string }

// the most the embedded code and package files may add to the Bun runtime
export const maxEmbeddedBytes = 15 * 1024 * 1024

// the platforms the standalone executable ships for, by Node's platform and architecture names
const platformNames = new Set(["linux-x64", "linux-arm64", "darwin-arm64"])

/**
 * Names the release platform of a Node platform and architecture, or undefined when no executable ships for it.
 */
export function toPlatformName(platform: string, architecture: string): string | undefined {
	const platformName = `${platform}-${architecture}`
	return platformNames.has(platformName) ? platformName : undefined
}

/**
 * Locates the executable the build writes for a release platform.
 */
export function toExecutablePath(platformName: string | undefined): string {
	return fileURLToPath(new URL(`../build/health-code-${libraryVersion}-${platformName}`, import.meta.url))
}

/**
 * Lists each package file the executable is missing, adds or reports with a different digest.
 */
export function findEmbeddedFileDifferences(
	expectedDigests: PackageFileDigest[],
	reportedFiles: Record<string, string>,
): string[] {
	const expectedFiles = new Map(expectedDigests.map(({ path, sha256 }) => [path as string, sha256]))
	const differences: string[] = []

	// compare each expected file with the executable's report
	for (const [path, sha256] of expectedFiles) {
		const reportedDigest = reportedFiles[path]

		// name a file the executable lacks or reads with other bytes
		if (reportedDigest === undefined) {
			differences.push(`missing ${path}`)
		} else if (reportedDigest !== sha256) {
			differences.push(`different ${path}`)
		}
	}

	// name files the library does not read
	for (const path of Object.keys(reportedFiles)) {
		if (!expectedFiles.has(path)) {
			differences.push(`extra ${path}`)
		}
	}
	return differences
}

/**
 * Describes an executable that grew past the size limit, or returns undefined when it fits.
 */
export function describeOversizedExecutable(executableBytes: number, runtimeBytes: number): string | undefined {
	const embeddedBytes = executableBytes - runtimeBytes
	if (embeddedBytes <= maxEmbeddedBytes) {
		return undefined
	}
	const embeddedMegabytes = (embeddedBytes / 1024 / 1024).toFixed(1)
	return `The executable adds ${embeddedMegabytes} MB to the Bun runtime. The limit is ${maxEmbeddedBytes / 1024 / 1024} MB.`
}
