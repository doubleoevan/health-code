import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs"
import { join } from "node:path"
import { filesUnder, readText, workspaceDirectories } from "./inventory.ts"

const inventoryFile = "/inspection-inventory"
export function readIntegrity(offset: number): {
	discoveredFiles?: string[]
	files: string[]
	hooks: string[]
	testFileErrors: string[]
	cases: [string, string, string][]
} {
	if (!Number.isSafeInteger(offset) || offset < 0) {
		throw new Error("Invalid inventory page")
	}
	const page: { cases: [string, string, string][]; discoveredFiles?: string[]; testFileErrors?: string[] } = JSON.parse(
		readFileSync(join(inventoryFile, offset + ".json"), "utf8"),
	)
	const { cases } = page
	if (offset) {
		return { cases, files: [], hooks: [], testFileErrors: [] }
	}
	const files = filesUnder(".").filter((name) => !/^\.(?:env|git)/.test(name))
	return {
		files,
		discoveredFiles: page.discoveredFiles,
		hooks: readLifecycleHooks(),
		cases,
		testFileErrors: page.testFileErrors ?? [],
	}
}

export function readLifecycleHooks(): string[] {
	if ([".pnp.cjs", ".pnp.js", ".pnp.loader.mjs"].some((file) => existsSync(file))) {
		throw new Error("Lifecycle inventory unavailable for Yarn Plug'n'Play")
	}
	const hooks = new Set<string>()
	const visited = new Set<string>()
	const copies = new Map<string, number>()
	function inspect(path: string): void {
		if (!existsSync(join(path, "package.json"))) {
			return
		}
		const manifest = JSON.parse(readText(join(path, "package.json")))
		for (const name of ["preinstall", "install", "postinstall", "prepare", "prepublish", "prepack", "postpack"]) {
			if (typeof manifest.scripts?.[name] === "string") {
				const location = path.replace(/(\/(?:\.pnpm|\.bun)\/[^/]+?)@\d[^/]*(?=\/)/g, "$1")
				const identity = [
					manifest.name ?? location,
					name,
					createHash("sha256").update(manifest.scripts[name]).digest("hex"),
					location,
				]
				const key = JSON.stringify(identity)
				const index = copies.get(key) ?? 0
				copies.set(key, index + 1)
				hooks.add(JSON.stringify([...identity, String(index)]))
			}
		}
	}
	function visit(directory: string): void {
		if (!existsSync(directory)) {
			return
		}
		const actual = realpathSync(directory)
		if (!actual.startsWith(`${realpathSync(".")}/`) || visited.has(actual)) {
			return
		}
		visited.add(actual)
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name)
			if (entry.name.startsWith("@") || entry.name === ".pnpm" || entry.name === ".bun") {
				visit(path)
				continue
			}
			if (!entry.isDirectory() && !entry.isSymbolicLink()) {
				continue
			}
			inspect(path)
			visit(join(path, "node_modules"))
		}
	}
	for (const dir of [".", ...workspaceDirectories()]) {
		inspect(dir)
		visit(join(dir, "node_modules"))
	}
	return [...hooks].sort()
}
