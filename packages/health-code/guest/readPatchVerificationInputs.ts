import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs"
import { join } from "node:path"
import { filesUnder, readText, workspaceDirectories } from "./inventory.ts"

const testCasePagesDirectory = "/inspection-inventory"
type FileAndHookEntries = {
	projectFilePaths: string[]
	lifecycleHookSignatures: string[]
	discoveredTestFiles: string[]
	testFileErrors: string[]
}

// Older test captures may omit the list of discovered test files.
type PatchVerificationInputsPage = Partial<Pick<FileAndHookEntries, "discoveredTestFiles">> &
	Omit<FileAndHookEntries, "discoveredTestFiles"> & {
		cases: [string, string, string][]
		nextFileAndHookEntryOffset?: number
	}

export function readPatchVerificationInputs(
	testCaseOffset: number,
	fileAndHookEntryOffset?: number,
): PatchVerificationInputsPage {
	if (![testCaseOffset, fileAndHookEntryOffset ?? 0].every((value) => Number.isSafeInteger(value) && value >= 0)) {
		throw new Error("Invalid patch verification page offset")
	}

	// Only the first test case page includes repository-wide entries.
	const page: { cases: PatchVerificationInputsPage["cases"]; discoveredFiles?: string[]; testFileErrors?: string[] } =
		JSON.parse(readFileSync(join(testCasePagesDirectory, testCaseOffset + ".json"), "utf8"))
	if (testCaseOffset) {
		return { cases: page.cases, projectFilePaths: [], lifecycleHookSignatures: [], testFileErrors: [] }
	}

	// Bound the path and lifecycle hook entries independently of the protected test-case pages.
	const fileAndHookEntries = {
		projectFilePaths: filesUnder(".").filter((name) => !/^\.(?:env|git)/.test(name)),
		lifecycleHookSignatures: readLifecycleHookSignatures(),
		discoveredTestFiles: page.discoveredFiles ?? [],
		testFileErrors: page.testFileErrors ?? [],
	}
	const result = pageFileAndHookEntries(fileAndHookEntries, {
		cases: fileAndHookEntryOffset === undefined ? page.cases : [],
		fileAndHookEntryOffset: fileAndHookEntryOffset ?? 0,
	})
	if (page.discoveredFiles === undefined) {
		delete result.discoveredTestFiles
	}
	return result
}

export function pageFileAndHookEntries(
	fileAndHookEntries: FileAndHookEntries,
	{ cases, fileAndHookEntryOffset }: { cases: PatchVerificationInputsPage["cases"]; fileAndHookEntryOffset: number },
): PatchVerificationInputsPage {
	const result: FileAndHookEntries & Pick<PatchVerificationInputsPage, "cases"> = {
		projectFilePaths: [],
		lifecycleHookSignatures: [],
		discoveredTestFiles: [],
		testFileErrors: [],
		cases,
	}
	let position = 0
	let size = Buffer.byteLength(JSON.stringify(cases))

	// Allow room for the enclosing object and escaping within the one-MiB transport limit.
	for (const field of [
		"projectFilePaths",
		"lifecycleHookSignatures",
		"discoveredTestFiles",
		"testFileErrors",
	] as const) {
		for (const entry of fileAndHookEntries[field]) {
			if (position++ < fileAndHookEntryOffset) {
				continue
			}

			// Count escaped UTF-8 bytes as they appear in the serialized response.
			const bytes = Buffer.byteLength(JSON.stringify(entry)) + 1
			if (bytes > 512 * 1024) {
				throw new Error("File or hook entry exceeds the page size limit")
			}

			// Resume from the first entry excluded from this page.
			if (size + bytes > 768 * 1024) {
				return { ...result, nextFileAndHookEntryOffset: position - 1 }
			}

			// Keep the entry in its original field.
			size += bytes
			result[field].push(entry)
		}
	}
	return result
}

// package managers run these scripts for installed registry packages
const installEvents = ["preinstall", "install", "postinstall"] as const

// the root package and workspaces also run preparation scripts
const projectEvents = [...installEvents, "prepare", "prepublish", "prepack", "postpack"] as const

export function readLifecycleHookSignatures(): string[] {
	// reject installs whose lifecycle inventory cannot be enumerated
	if ([".pnp.cjs", ".pnp.js", ".pnp.loader.mjs"].some((file) => existsSync(file))) {
		throw new Error("Lifecycle inventory unavailable for Yarn Plug'n'Play")
	}
	const hooks = new Set<string>()
	const visited = new Set<string>()
	const copies = new Map<string, number>()

	// inspect each installed package manifest for lifecycle hooks
	function inspect(path: string, events: readonly string[]): void {
		if (!existsSync(join(path, "package.json"))) {
			return
		}
		const manifest = JSON.parse(readText(join(path, "package.json")))

		// hash hook bodies together with their package and location
		for (const name of events) {
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
			inspect(path, installEvents)
			visit(join(path, "node_modules"))
		}
	}

	// include the root package and every declared workspace
	for (const dir of [".", ...workspaceDirectories()]) {
		inspect(dir, projectEvents)
		visit(join(dir, "node_modules"))
	}
	return [...hooks].sort()
}
