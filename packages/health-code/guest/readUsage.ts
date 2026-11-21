import { existsSync, lstatSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { parse } from "@babel/parser"
import { filesUnder, readText, workspaceDirectories } from "./inventory.ts"

type Usage = { file: string; line: number; symbol: string; workspace: string; text: string }
type Syntax = {
	type: string
	name?: string
	value?: unknown
	loc?: { start: { line: number } }
	[key: string]: unknown
}
function node(value: unknown): value is Syntax {
	return !!value && typeof value === "object" && "type" in value && typeof value.type === "string"
}

function childNodes(entry: Syntax): Syntax[] {
	return Object.values(entry)
		.flatMap((child) => (Array.isArray(child) ? child : [child]))
		.filter(node)
}
/** Records unresolved imports alongside verified call sites for feature matching. */
export function readUsage(dependency: string): { usage: Usage[]; unresolved: string[]; changelog: string } {
	const usage: Usage[] = []
	const unresolved: string[] = []
	const workspaces = workspaceDirectories()
	for (const file of filesUnder(".")) {
		if (!/\.[cm]?[jt]sx?$/.test(file) || lstatSync(file).size > 512_000) {
			continue
		}
		const text = readText(file)
		if (/@generated\b/i.test(text.slice(0, 512)) || /(?:^|\/)(?:dist|build|generated)\//.test(file)) {
			continue
		}
		if (!text.includes(dependency) && !/\bimport\s*\(/.test(text)) {
			continue
		}
		try {
			const ast = parse(text, {
				sourceType: "unambiguous",
				createImportExpressions: true,
				plugins: ["jsx", "typescript", "decorators-legacy"],
			})
			const names = new Map<string, string>()
			const lines = text.split("\n")
			const workspace = workspaces.find((name) => file.startsWith(`${name}/`)) ?? "."
			function add(entry: Syntax, symbol: string): void {
				const line = entry.loc?.start.line
				if (!line || usage.length >= 128) {
					if (!unresolved.includes(file)) {
						unresolved.push(file)
					}
					return
				}
				usage.push({ file, line, symbol, workspace, text: lines[line - 1]?.trim().slice(0, 230) ?? "" })
			}

			walk(ast as unknown as Syntax, {
				dependency,
				names,
				add,
				unresolved: () => {
					if (!unresolved.includes(file)) {
						unresolved.push(file)
					}
				},
			})
		} catch {
			unresolved.push(file)
		}
	}
	return { usage, unresolved: unresolved.slice(0, 100), changelog: "" }
}
export function readChangelog(dependency: string): string {
	const directory = join("node_modules", dependency)
	const log = existsSync(directory)
		? readdirSync(directory).find((name) => /^changelog(?:\.md|\.txt)?$/i.test(name))
		: undefined
	return log ? readText(join(directory, log)).slice(0, 12000) : ""
}

/** Counts installed regular files once per device and inode. */
export function installedBytes(): number | null {
	if (!existsSync("node_modules")) {
		return null
	}
	const seen = new Set<string>()
	let bytes = 0
	function visit(path: string): void {
		for (const entry of readdirSync(path, { withFileTypes: true })) {
			const child = join(path, entry.name)
			if (entry.isDirectory()) {
				visit(child)
				continue
			}
			if (!entry.isFile()) {
				continue
			}
			const stat = lstatSync(child)
			const key = [stat.dev, stat.ino].join("/")
			if (!seen.has(key)) {
				seen.add(key)
				bytes += stat.size
			}
		}
	}
	for (const dir of [".", ...workspaceDirectories()]) {
		const root = join(dir, "node_modules")
		if (existsSync(root) && lstatSync(root).isDirectory()) {
			visit(root)
		}
	}
	return bytes
}
function isRequiredModule(entry: Syntax, dependency: string): boolean {
	return (
		entry.type === "VariableDeclarator" &&
		node(entry.init) &&
		entry.init.type === "CallExpression" &&
		node(entry.init.callee) &&
		entry.init.callee.name === "require" &&
		Array.isArray(entry.init.arguments) &&
		entry.init.arguments[0]?.value === dependency
	)
}
function recordImport({
	entry,
	dependency,
	names,
	add,
}: {
	entry: Syntax
	dependency: string
	names: Map<string, string>
	add: (entry: Syntax, symbol: string) => void
}): void {
	if (
		entry.type === "ImportDeclaration" &&
		node(entry.source) &&
		entry.source.value === dependency &&
		Array.isArray(entry.specifiers)
	) {
		add(entry, "import")
		for (const specifier of entry.specifiers) {
			if (node(specifier) && node(specifier.local) && specifier.local.name) {
				names.set(specifier.local.name, node(specifier.imported) ? (specifier.imported.name ?? "*") : "*")
			}
		}
	}
}
type Bindings = {
	unresolved: () => void
	dependency: string
	names: Map<string, string>
	add: (entry: Syntax, symbol: string) => void
}
function nestedScope(entry: Syntax, scope: Bindings): Bindings {
	const names = new Map(scope.names)
	for (const param of Array.isArray(entry.params) ? entry.params : []) {
		for (const name of bindingNames(param)) {
			names.delete(name)
		}
	}
	for (const item of Array.isArray(entry.body) ? entry.body : []) {
		for (const name of declaredNames(item)) {
			names.delete(name)
		}
	}
	return { ...scope, names }
}
function declaredNames(statement: Syntax): string[] {
	if (statement.type === "VariableDeclaration" && Array.isArray(statement.declarations)) {
		return statement.declarations.flatMap((declaration) => bindingNames(declaration.id))
	}
	if (statement.type === "FunctionDeclaration" || statement.type === "ClassDeclaration") {
		return bindingNames(statement.id)
	}
	return []
}
function bindingNames(pattern: unknown): string[] {
	if (!node(pattern)) {
		return []
	}
	if (pattern.type === "Identifier" && pattern.name) {
		return [pattern.name]
	}
	if (pattern.type === "ObjectProperty") {
		return bindingNames(pattern.value)
	}
	return childNodes(pattern).flatMap(bindingNames)
}
function walk(entry: Syntax, parent: Bindings): void {
	const scope = entry.type === "BlockStatement" || Array.isArray(entry.params) ? nestedScope(entry, parent) : parent
	const { dependency, names, add } = scope
	recordImport({ entry, dependency, names, add })
	if (entry.type === "ImportExpression" && node(entry.source) && entry.source.value === dependency) {
		add(entry, "dynamic import")
	}

	if (isRequiredModule(entry, dependency)) {
		add(entry, "require")
		if (node(entry.id) && entry.id.name) {
			names.set(entry.id.name, "*")
		}
	}

	if (entry.type === "ImportExpression" && node(entry.source) && entry.source.type !== "StringLiteral") {
		scope.unresolved()
	}
	recordUse(entry, scope)
	for (const child of childNodes(entry)) {
		walk(child, scope)
	}
}
function recordUse(entry: Syntax, { names, add }: Bindings): void {
	if (
		entry.type === "MemberExpression" &&
		node(entry.object) &&
		names.has(entry.object.name ?? "") &&
		node(entry.property)
	) {
		add(entry, entry.property.name ?? "unresolved")
	}
	if (entry.type === "CallExpression" && node(entry.callee) && names.has(entry.callee.name ?? "")) {
		add(entry, names.get(entry.callee.name ?? "") ?? "unresolved")
	}
}
