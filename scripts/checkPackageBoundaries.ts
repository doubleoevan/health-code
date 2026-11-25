import { readFileSync } from "node:fs"
import { isBuiltin } from "node:module"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { ResolverFactory } from "oxc-resolver"
import { globSync } from "tinyglobby"
import { readImports } from "./readImports.ts"
import { readWorkspace, type Workspace } from "./readWorkspace.ts"

// index workspace names and directories before resolving imports
const workspaces = [...new Bun.Glob("{apps,packages}/*/package.json").scanSync()]
	.sort()
	.map((path) => readWorkspace(resolve(dirname(path))))
const byName = new Map(workspaces.map((workspace) => [workspace.name, workspace]))
const extensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]
const sourcePattern = `**/*{${extensions.join(",")}}`
const excluded = ["**/{node_modules,dist,build,.tsbuild,.next}/**", "**/fixtures/recorded/**"]
const resolver = new ResolverFactory({
	extensions: [...extensions, ".json"],
	extensionAlias: {
		".js": [".ts", ".tsx", ".d.ts", ".js", ".jsx"],
		".jsx": [".tsx", ".d.ts", ".jsx"],
		".mjs": [".mts", ".d.mts", ".mjs"],
		".cjs": [".cts", ".d.cts", ".cjs"],
	},
	mainFields: ["types", "typings", "main"],
	conditionNames: ["types", "node", "import", "require"],
})
const violations: string[] = []
let fileCount = 0

// check dependency declarations against project references
for (const workspace of workspaces) {
	const dependencies = new Set([...workspace.runtime, ...workspace.development])
	for (const target of workspaces) {
		if (workspace === target) {
			continue
		}

		// reject dependencies on private apps
		if (dependencies.has(target.name) && isApp(target)) {
			violations.push(`${relative(".", workspace.folder)}/package.json: ${target.name} is an app`)
		}
		if (dependencies.has(target.name) !== workspace.references.includes(target.folder)) {
			violations.push(
				`${relative(".", workspace.folder)}/tsconfig.json: align the reference to ${target.name} with package.json`,
			)
		}
	}

	// scan each workspace for source imports
	for (const filePath of globSync(sourcePattern, {
		cwd: workspace.folder,
		absolute: true,
		dot: true,
		ignore: excluded,
	})) {
		fileCount++
		for (const imported of readImports(filePath, readFileSync(filePath, "utf8"))) {
			const violation = toImportViolation({
				workspace,
				filePath,
				importPath: imported.path,
				typeOnly: imported.typeOnly,
			})

			// attribute an import violation to its source line
			if (violation) {
				violations.push(`${relative(".", filePath)}:${imported.line} imports ${imported.path}: ${violation}`)
			}
		}
	}
}

// report all boundary violations together
if (violations.length > 0) {
	console.error(violations.join("\n"))
	process.exit(1)
}
console.log(`package boundaries: ${workspaces.length} workspaces, ${fileCount} source files`)

function isApp(workspace: Workspace): boolean {
	return relative(".", workspace.folder).startsWith(`apps${sep}`)
}

function contains(folder: string, path: string): boolean {
	return path === folder || path.startsWith(folder + sep)
}

type ImportOptions = { workspace: Workspace; filePath: string; importPath: string; typeOnly: boolean }

function toImportViolation({ workspace, filePath, importPath, typeOnly }: ImportOptions): string | undefined {
	const path = importPath.replace(/\?.*$/, "")
	if (isBuiltin(path) || path === "bun" || path.startsWith("bun:")) {
		return
	}

	// check imports that name a workspace directly
	const packageName = path.match(/^(?:@[^/]+\/)?[^/]+/)?.[0] ?? path
	const violation = toNamedWorkspaceViolation({ workspace, path, packageName })
	if (violation) {
		return violation
	}

	const local = path.startsWith(".") || isAbsolute(path)
	if (local && !contains(workspace.folder, resolve(dirname(filePath), path))) {
		return "relative and absolute file imports must stay inside their workspace"
	}

	// resolve aliases before deciding whether an import crosses a boundary
	const resolved = resolveWorkspaceImport({ workspace, filePath, path })
	if (resolved && resolved.workspace !== workspace && (path !== resolved.workspace.name || !resolved.external)) {
		return `cross-workspace imports must use a public package name. Found ${relative(".", resolved.workspace.folder)}`
	}
	if (local || resolved?.workspace === workspace || packageName === workspace.name) {
		return
	}

	// check external packages against the importing workspace manifest
	return toDependencyViolation({ workspace, packageName, filePath, typeOnly })
}

function toNamedWorkspaceViolation({
	workspace,
	path,
	packageName,
}: {
	workspace: Workspace
	path: string
	packageName: string
}): string | undefined {
	// identify the workspace named by the import
	const target = byName.get(packageName)
	if (!target || target === workspace) {
		return
	}

	// reject imports of private apps and package internals
	if (isApp(target)) {
		return "apps are private to their workspace"
	}
	if (path !== packageName) {
		return `use the public entry '${packageName}'`
	}
}

function resolveWorkspaceImport({
	workspace,
	filePath,
	path,
}: {
	workspace: Workspace
	filePath: string
	path: string
}): { workspace: Workspace; external: boolean } | undefined {
	// Try mapped files first so an alias cannot impersonate a package's public entry.
	const aliases = workspace.matchPaths?.(path) ?? []
	for (const candidate of [...aliases, path]) {
		const targetPath = resolver.sync(dirname(filePath), candidate).path
		if (targetPath) {
			// identify which workspace owns the resolved file
			const owner = workspaces.find((workspace) => contains(workspace.folder, targetPath))
			return owner && { workspace: owner, external: candidate === path }
		}
	}
}

function toDependencyViolation({
	workspace,
	packageName,
	filePath,
	typeOnly,
}: Omit<ImportOptions, "importPath"> & { packageName: string }): string | undefined {
	// allow packages declared for runtime use
	if (workspace.runtime.has(packageName)) {
		return
	}

	// accept separately declared types for erased imports
	const typePackage = `@types/${packageName.replace(/^@/, "").replace("/", "__")}`
	if (typeOnly && (workspace.development.has(typePackage) || workspace.runtime.has(typePackage))) {
		return
	}

	// restrict development dependencies to types and development files
	if (workspace.development.has(packageName)) {
		if (typeOnly || /\.(?:test|spec|config)\.[cm]?[jt]sx?$/.test(filePath)) {
			return
		}
		return "declare runtime imports in dependencies"
	}
	return `declare ${packageName} in this workspace's package.json`
}
