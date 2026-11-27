import { z } from "zod"
import type { PackageManager } from "../contracts.ts"
import { readOwnProperty } from "../readOwnProperty.ts"
import { isExactVersion } from "../sandbox/packageManagerVersions.ts"
import type { Manifest } from "./readLockedDependencies.ts"

const archiveHashPattern = /^sha(?:1|224|256|384|512)\.[0-9a-f]{40,128}$/

// the exact package manager version a repository declares and the manifest field or file that declares it
export const declaredPackageManagerSchema = z.object({
	version: z.string().refine(isExactVersion),
	source: z.enum(["packageManager", "devEngines.packageManager", "engines", ".bun-version"]),
	hash: z.string().regex(archiveHashPattern).optional(),
})
export type DeclaredPackageManager = z.infer<typeof declaredPackageManagerSchema>

/**
 * Reads the first exact version the committed files declare for this package manager.
 */
export function toDeclaredPackageManager({
	manager,
	manifest,
	bunVersionFile,
}: {
	manager: PackageManager
	manifest: Manifest
	bunVersionFile: string | undefined
}): DeclaredPackageManager | undefined {
	// prefer the manifest's packageManager field
	const declaredInField = toDeclaredInField(manager, manifest.packageManager)
	if (declaredInField) {
		return declaredInField
	}

	// read devEngines.packageManager as one entry or a list
	const developmentEngines = readOwnProperty(readOwnProperty(manifest, "devEngines"), "packageManager")
	for (const engine of Array.isArray(developmentEngines) ? developmentEngines : [developmentEngines]) {
		const engineVersion = readOwnProperty(engine, "version")

		// accept the entry that names this package manager with an exact version
		if (
			readOwnProperty(engine, "name") === manager &&
			typeof engineVersion === "string" &&
			isExactVersion(engineVersion)
		) {
			return { version: engineVersion, source: "devEngines.packageManager" }
		}
	}

	// accept only an exact engines version
	const enginesVersion = readOwnProperty(readOwnProperty(manifest, "engines"), manager)
	if (typeof enginesVersion === "string" && isExactVersion(enginesVersion)) {
		return { version: enginesVersion, source: "engines" }
	}

	// fall back to bun's .bun-version file
	const bunVersion = bunVersionFile?.trim() ?? ""
	return manager === "bun" && isExactVersion(bunVersion) ? { version: bunVersion, source: ".bun-version" } : undefined
}

// read the version and the optional archive hash from the packageManager field
function toDeclaredInField(manager: PackageManager, field: unknown): DeclaredPackageManager | undefined {
	const [, name, version, hash] = /^([a-z]+)@([^+]+)(?:\+(.+))?$/.exec(typeof field === "string" ? field : "") ?? []
	const isHashValid = hash === undefined || archiveHashPattern.test(hash)
	if (name !== manager || !version || !isExactVersion(version) || !isHashValid) {
		return undefined
	}
	return { version, source: "packageManager", ...(hash && { hash }) }
}
