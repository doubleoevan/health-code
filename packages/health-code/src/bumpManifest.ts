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

export function bumpManifest({
	dir,
	manifest,
	name,
	target,
}: {
	dir: string
	manifest: Manifest
	name: string
	target: string
}): boolean {
	// change only declarations that already contain the dependency
	let changed = false
	for (const section of sections) {
		const values = manifest[section]
		if (values && Object.hasOwn(values, name)) {
			if (dir === "." && manifest.overrides) {
				// align root overrides with the changed direct dependency
				updateOverride(manifest.overrides, name, values[name], target)
			}
			values[name] = target
			changed = true
		}
	}
	// report whether the manifest requires writing
	return changed
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
