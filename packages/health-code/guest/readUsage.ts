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
// recognize syntax nodes before reading their bindings
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
	// scan bounded javascript and typescript source files
	for (const file of filesUnder(".")) {
		if (!/\.[cm]?[jt]sx?$/.test(file) || lstatSync(file).size > 512_000) {
			continue
		}
		const text = readText(file)
		// skip generated code and files without possible imports
		if (/@generated\b/i.test(text.slice(0, 512)) || /(?:^|\/)(?:dist|build|generated)\//.test(file)) {
			continue
		}
		if (!text.includes(dependency) && !/\bimport\s*\(/.test(text)) {
			continue
		}
		// parse candidate files with location information
		try {
			const ast = parse(text, {
				sourceType: "unambiguous",
				createImportExpressions: true,
				plugins: ["jsx", "typescript", "decorators-legacy"],
			})
			const names = new Map<string, string>()
			const lines = text.split("\n")
			const workspace = workspaces.find((name) => file.startsWith(`${name}/`)) ?? "."
			// retain bounded source evidence for each observed use
			function add(entry: Syntax, symbol: string): void {
				const line = entry.loc?.start.line
				if (!line || usage.length >= 128) {
					if (!unresolved.includes(file)) {
						unresolved.push(file)
					}
					return
				}
				// record the original source line with its workspace
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
// use the installed package's own changelog as evidence
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
	// walk regular files beneath each dependency tree
	function visit(path: string): void {
		for (const entry of readdirSync(path, { withFileTypes: true })) {
			const child = join(path, entry.name)
			if (entry.isDirectory()) {
				visit(child)
				continue
			}
			// skip entries that cannot contribute installed file bytes
			if (!entry.isFile()) {
				continue
			}
			const stat = lstatSync(child)
			const key = [stat.dev, stat.ino].join("/")
			// count hard-linked files once across workspaces
			if (!seen.has(key)) {
				seen.add(key)
				bytes += stat.size
			}
		}
	}
	// include workspace-local dependency installations
	for (const dir of [".", ...workspaceDirectories()]) {
		const root = join(dir, "node_modules")
		if (existsSync(root) && lstatSync(root).isDirectory()) {
			visit(root)
		}
	}
	return bytes
}
// recognize dependency loads through a literal require call
function isRequiredModule(entry: Syntax, dependency: string): boolean {
	return (
		entry.type === "VariableDeclarator" &&
		node(entry.init) &&
		entry.init.type === "CallExpression" &&
		node(entry.init.callee) &&
		// check the callee name and the required package
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
	// match import declarations for the selected dependency
	if (
		entry.type === "ImportDeclaration" &&
		node(entry.source) &&
		entry.source.value === dependency &&
		Array.isArray(entry.specifiers)
	) {
		add(entry, "import")
		// map local import names to dependency symbols
		for (const specifier of entry.specifiers) {
			if (node(specifier) && node(specifier.local) && specifier.local.name) {
				names.set(specifier.local.name, node(specifier.imported) ? (specifier.imported.name ?? "*") : "*")
			}
		}
	}
}
// carry verified import bindings through the syntax walk
type Bindings = {
	unresolved: () => void
	dependency: string
	names: Map<string, string>
	add: (entry: Syntax, symbol: string) => void
}
function nestedScope(entry: Syntax, scope: Bindings): Bindings {
	// discard bindings shadowed by parameters
	const names = new Map(scope.names)
	for (const param of Array.isArray(entry.params) ? entry.params : []) {
		for (const name of bindingNames(param)) {
			names.delete(name)
		}
	}
	// remove local declarations that mask imported names
	for (const item of Array.isArray(entry.body) ? entry.body : []) {
		for (const name of declaredNames(item)) {
			names.delete(name)
		}
	}
	return { ...scope, names }
}
// identify names introduced by declarations
function declaredNames(statement: Syntax): string[] {
	if (statement.type === "VariableDeclaration" && Array.isArray(statement.declarations)) {
		return statement.declarations.flatMap((declaration) => bindingNames(declaration.id))
	}
	// include named function and class bindings in the scope
	if (statement.type === "FunctionDeclaration" || statement.type === "ClassDeclaration") {
		return bindingNames(statement.id)
	}
	return []
}
// recover bound names from nested binding patterns
function bindingNames(pattern: unknown): string[] {
	if (!node(pattern)) {
		return []
	}
	if (pattern.type === "Identifier" && pattern.name) {
		return [pattern.name]
	}
	// follow the bound side of an object pattern
	if (pattern.type === "ObjectProperty") {
		return bindingNames(pattern.value)
	}
	return childNodes(pattern).flatMap(bindingNames)
}
function walk(entry: Syntax, parent: Bindings): void {
	// track imports and uses within the entry's lexical scope
	const scope = entry.type === "BlockStatement" || Array.isArray(entry.params) ? nestedScope(entry, parent) : parent
	const { dependency, names, add } = scope
	recordImport({ entry, dependency, names, add })
	if (entry.type === "ImportExpression" && node(entry.source) && entry.source.value === dependency) {
		add(entry, "dynamic import")
	}

	// register each literal require binding
	if (isRequiredModule(entry, dependency)) {
		add(entry, "require")
		if (node(entry.id) && entry.id.name) {
			names.set(entry.id.name, "*")
		}
	}

	if (entry.type === "ImportExpression" && node(entry.source) && entry.source.type !== "StringLiteral") {
		scope.unresolved()
	}
	// visit each child with the current scope
	recordUse(entry, scope)
	for (const child of childNodes(entry)) {
		walk(child, scope)
	}
}
function recordUse(entry: Syntax, { names, add }: Bindings): void {
	// recognize accesses through a bound dependency namespace
	if (
		entry.type === "MemberExpression" &&
		node(entry.object) &&
		names.has(entry.object.name ?? "") &&
		node(entry.property)
	) {
		add(entry, entry.property.name ?? "unresolved")
	}
	// record calls made directly through an imported name
	if (entry.type === "CallExpression" && node(entry.callee) && names.has(entry.callee.name ?? "")) {
		add(entry, names.get(entry.callee.name ?? "") ?? "unresolved")
	}
}
