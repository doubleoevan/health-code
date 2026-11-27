import { libraryVersion, type PackageFileDigest, readPackageFileDigests } from "health-code"
import { UserError } from "./userError.ts"

export const versionUsage = "Usage: health-code --version [--json]"

/**
 * Describes the installed release, and with --json the runtime and the digest of every package file.
 */
export function describeVersion(
	args: string[],
	readDigests: () => PackageFileDigest[] = readPackageFileDigests,
): string {
	if (args.length > 1 || (args.length === 1 && args[0] !== "--json")) {
		throw new UserError(versionUsage)
	}

	// read and validate every package file before naming the version
	const digests = readDigests()
	if (!args.length) {
		return `health-code ${libraryVersion}`
	}

	// list each file's digest so two builds of one version can be compared
	const files = Object.fromEntries(digests.map(({ path, sha256 }) => [path, sha256]))
	return JSON.stringify({ version: libraryVersion, runtime: toRuntimeName(), files }, null, "\t")
}

// name the runtime and its version
function toRuntimeName(): string {
	const bunVersion = process.versions.bun
	return bunVersion ? `bun ${bunVersion}` : `node ${process.versions.node}`
}
