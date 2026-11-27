import { readFileSync } from "node:fs"

// the files the library reads from its own package at run time. the standalone executable embeds exactly these
export const packageFiles = [
	"package.json",
	"prompts/releaseSummary.md",
	"prompts/featureMatch.md",
	"prompts/repair.md",
	"prompts/featureAdoption.md",
	"prompts/applyPatch.md",
	"prompts/verifyCredential.md",
	"prompts/investigateInspection.md",
	"dist/project.mjs",
	"dist/observe.mjs",
	"dist/agent.mjs",
	"dist/patch.mjs",
	"dist/nodeTestReporter.mjs",
] as const

export type PackageFile = (typeof packageFiles)[number]

// resolve beside the compiled program, or one folder above this module in the package and the workspace
const packageRoot = new URL(isStandaloneExecutable() ? "./" : "../", import.meta.url)

/**
 * Reads one file from the library's own package, on disk or embedded in the standalone executable.
 */
export function readPackageFile(path: PackageFile): Buffer {
	return readFileSync(new URL(path, packageRoot))
}

// detect Bun's compiled program without requiring Bun's types in the Node build
function isStandaloneExecutable(): boolean {
	const runtime = (globalThis as { Bun?: { isStandaloneExecutable?: unknown } }).Bun
	return runtime?.isStandaloneExecutable === true
}
