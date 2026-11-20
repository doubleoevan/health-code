import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import ts from "typescript"

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
	options: ts.CompilerOptions
}

/** Reads the workspace's dependency declarations and TypeScript resolution settings. */
export function readWorkspace(folder: string): Workspace {
	const manifest: Manifest = JSON.parse(readFileSync(resolve(folder, "package.json"), "utf8"))
	const configPath = resolve(folder, "tsconfig.json")
	const config = ts.readConfigFile(configPath, ts.sys.readFile)
	if (config.error) {
		throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"))
	}
	const project = ts.parseJsonConfigFileContent(config.config, ts.sys, folder, {}, configPath)
	return {
		folder,
		name: manifest.name,
		runtime: new Set(
			Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies, ...manifest.optionalDependencies }),
		),
		development: new Set(Object.keys(manifest.devDependencies ?? {})),
		references: (project.projectReferences ?? []).map((reference) => resolve(reference.path)),
		options: project.options,
	}
}
