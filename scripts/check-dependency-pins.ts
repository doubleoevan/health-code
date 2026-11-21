import { readFileSync } from "node:fs"
import { z } from "zod"

const lockfile = z.object({
	packages: z.record(z.string(), z.tuple([z.string()], z.unknown())),
})

type PinOptions = {
	bunVersion: string
	manifest: { packageManager?: string; patchedDependencies?: Record<string, string> }
	lockText: string
}

/**
 * Compares the Bun pins and checks every patch against an installed version.
 */
export function toPinViolations({ bunVersion, manifest, lockText }: PinOptions): string[] {
	// look up patched package versions in the lockfile
	const lock = lockfile.parse(Bun.JSONC.parse(lockText))
	const installed = new Set(Object.values(lock.packages).map(([version]) => version))
	const violations = Object.keys(manifest.patchedDependencies ?? {})
		.filter((patch) => !installed.has(patch))
		.map((patch) => `patchedDependencies names ${patch}, which bun.lock does not install`)

	// match the package manager declaration to the pinned bun release
	if (manifest.packageManager !== `bun@${bunVersion.trim()}`) {
		violations.push(`packageManager must match .bun-version (bun@${bunVersion.trim()})`)
	}
	return violations
}

if (import.meta.main) {
	const violations = toPinViolations({
		bunVersion: readFileSync(".bun-version", "utf8"),
		manifest: JSON.parse(readFileSync("package.json", "utf8")),
		lockText: readFileSync("bun.lock", "utf8"),
	})

	// print every pin that needs updating
	if (violations.length > 0) {
		console.error(violations.join("\n"))
		process.exit(1)
	}
	console.log("dependency pins match")
}
