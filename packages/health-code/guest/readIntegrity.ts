import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs"
import { join } from "node:path"
import { filesUnder, readText, workspaceDirectories } from "./inventory.ts"

const inventoryFile = "/inspection-inventory"
type InventoryMetadata = { files: string[]; hooks: string[]; discoveredFiles: string[]; testFileErrors: string[] }
type InventoryPage = Partial<Pick<InventoryMetadata, "discoveredFiles">> &
	Omit<InventoryMetadata, "discoveredFiles"> & {
		cases: [string, string, string][]
		nextMetadataOffset?: number
	}

export function readIntegrity(offset: number, metadataOffset?: number): InventoryPage {
	if (![offset, metadataOffset ?? 0].every((value) => Number.isSafeInteger(value) && value >= 0)) {
		throw new Error("Invalid inventory page")
	}
	const page: InventoryPage = JSON.parse(readFileSync(join(inventoryFile, offset + ".json"), "utf8"))
	if (offset) {
		return { cases: page.cases, files: [], hooks: [], testFileErrors: [] }
	}

	// Bound the path and lifecycle metadata independently of the protected test-case pages.
	const metadata = {
		files: filesUnder(".").filter((name) => !/^\.(?:env|git)/.test(name)),
		hooks: readLifecycleHooks(),
		discoveredFiles: page.discoveredFiles ?? [],
		testFileErrors: page.testFileErrors ?? [],
	}
	const result = pageMetadata(metadata, {
		cases: metadataOffset === undefined ? page.cases : [],
		offset: metadataOffset ?? 0,
	})
	if (page.discoveredFiles === undefined) {
		delete result.discoveredFiles
	}
	return result
}

export function pageMetadata(
	metadata: InventoryMetadata,
	{ cases, offset }: { cases: InventoryPage["cases"]; offset: number },
): InventoryPage {
	const result: InventoryMetadata & Pick<InventoryPage, "cases"> = {
		files: [],
		hooks: [],
		discoveredFiles: [],
		testFileErrors: [],
		cases,
	}
	let position = 0
	let size = Buffer.byteLength(JSON.stringify(cases))

	// Allow room for the enclosing object and escaping within the one-MiB transport limit.
	for (const field of ["files", "hooks", "discoveredFiles", "testFileErrors"] as const) {
		for (const entry of metadata[field]) {
			if (position++ < offset) {
				continue
			}

			// Count escaped UTF-8 bytes as they appear in the serialized response.
			const bytes = Buffer.byteLength(JSON.stringify(entry)) + 1
			if (bytes > 512 * 1024) {
				throw new Error("Integrity entry exceeds the metadata page limit")
			}

			// Resume from the first entry excluded from this page.
			if (size + bytes > 768 * 1024) {
				return { ...result, nextMetadataOffset: position - 1 }
			}

			// Keep the entry in its original metadata field.
			size += bytes
			result[field].push(entry)
		}
	}
	return result
}

export function readLifecycleHooks(): string[] {
	// reject installs whose lifecycle inventory cannot be enumerated
	if ([".pnp.cjs", ".pnp.js", ".pnp.loader.mjs"].some((file) => existsSync(file))) {
		throw new Error("Lifecycle inventory unavailable for Yarn Plug'n'Play")
	}
	const hooks = new Set<string>()
	const visited = new Set<string>()
	const copies = new Map<string, number>()

	// inspect each installed package manifest for lifecycle hooks
	function inspect(path: string): void {
		if (!existsSync(join(path, "package.json"))) {
			return
		}
		const manifest = JSON.parse(readText(join(path, "package.json")))

		// hash hook bodies together with their package and location
		for (const name of ["preinstall", "install", "postinstall", "prepare", "prepublish", "prepack", "postpack"]) {
			if (typeof manifest.scripts?.[name] === "string") {
				const location = path.replace(/(\/(?:\.pnpm|\.bun)\/[^/]+?)@\d[^/]*(?=\/)/g, "$1")
				const identity = [
					manifest.name ?? location,
					name,
					createHash("sha256").update(manifest.scripts[name]).digest("hex"),
					location,
				]

				// distinguish repeated installed copies of the same hook
				const key = JSON.stringify(identity)
				const index = copies.get(key) ?? 0
				copies.set(key, index + 1)
				hooks.add(JSON.stringify([...identity, String(index)]))
			}
		}
	}

	// traverse each on-disk package directory inside the repository once
	function visit(directory: string): void {
		if (!existsSync(directory)) {
			return
		}
		const actual = realpathSync(directory)
		if (!actual.startsWith(`${realpathSync(".")}/`) || visited.has(actual)) {
			return
		}

		// record the directory before descending into nested installations
		visited.add(actual)
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name)
			if (entry.name.startsWith("@") || entry.name === ".pnpm" || entry.name === ".bun") {
				visit(path)
				continue
			}

			// skip entries that cannot lead to a package manifest
			if (!entry.isDirectory() && !entry.isSymbolicLink()) {
				continue
			}
			inspect(path)
			visit(join(path, "node_modules"))
		}
	}

	// include the root package and every declared workspace
	for (const dir of [".", ...workspaceDirectories()]) {
		inspect(dir)
		visit(join(dir, "node_modules"))
	}
	return [...hooks].sort()
}
