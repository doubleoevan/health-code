import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { createPathsMatcher, type PathsMatcher, parseTsconfig } from "get-tsconfig"

type Manifest = {
	name: string
	dependencies?: Record<string, string>
	devDependencies?: Record<string, string>
	peerDependencies?: Record<string, string>
	optionalDependencies?: Record<string, string>
}

export type Workspace = {
	folder: string
	name: string
	runtime: Set<string>
	development: Set<string>
	references: string[]
	matchPaths: PathsMatcher | null
}

/** Reads the workspace's dependency declarations and TypeScript resolution settings. */
export function readWorkspace(folder: string): Workspace {
	const manifest: Manifest = JSON.parse(readFileSync(resolve(folder, "package.json"), "utf8"))
	const configPath = resolve(folder, "tsconfig.json")
	const config = parseTsconfig(configPath)
	return {
		folder,
		name: manifest.name,
		runtime: new Set(
			Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies, ...manifest.optionalDependencies }),
		),
		development: new Set(Object.keys(manifest.devDependencies ?? {})),
		references: (config.references ?? []).map((reference) => resolve(folder, reference.path)),
		matchPaths: createPathsMatcher({ path: configPath, config }),
	}
}
