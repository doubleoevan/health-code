import { posix } from "node:path"
import { parse } from "@babel/parser"
import { parse as parseToml } from "smol-toml"
import { createTestAliasResolver } from "./readTestAliases.ts"

type Syntax = { type: string; [key: string]: unknown }
const moduleSuffixes = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", ".cjs", ".cts"]
const sourceFile = /\.[cm]?[jt]sx?$/
const runnerConfig = /(?:^|\/)(?:vitest(?:\.workspace)?|vite|jest)\.config\.[cm]?[jt]s$/
const supportDirectory =
	/(?:^|\/)(?:__mocks__|__fixtures__|__snapshots__|fixtures|snapshots|test-support|test-utils)(?:\/|\.)/i
function syntax(value: unknown): value is Syntax {
	return !!value && typeof value === "object" && "type" in value && typeof value.type === "string"
}
function ast(text: string): ReturnType<typeof parse>["program"]["body"] {
	return parse(text, {
		sourceType: "unambiguous",
		createImportExpressions: true,
		plugins: ["typescript", "jsx", "decorators-legacy"],
	}).program.body
}
function configValue(node: unknown): unknown {
	if (!syntax(node)) {
		throw new Error("Unresolved test configuration")
	}
	if (node.type === "ObjectExpression" && Array.isArray(node.properties)) {
		const config: Record<string, unknown> = Object.create(null)
		for (const field of node.properties) {
			if (field.type !== "ObjectProperty" || field.computed) {
				throw new Error("Dynamic test configuration")
			}
			config[field.key.name ?? field.key.value] = configValue(field.value)
		}
		return config
	}
	if (node.type === "ArrayExpression" && Array.isArray(node.elements)) {
		return node.elements.map(configValue)
	}
	if (["StringLiteral", "NumericLiteral", "BooleanLiteral", "RegExpLiteral", "NullLiteral"].includes(node.type)) {
		return node.value
	}
	if (
		node.type === "CallExpression" &&
		syntax(node.callee) &&
		node.callee.name === "defineConfig" &&
		Array.isArray(node.arguments) &&
		node.arguments.length === 1
	) {
		return configValue(node.arguments[0])
	}
	throw new Error("Dynamic test configuration")
}

function readConfig(file: string, text: string): unknown {
	if (file.endsWith("bunfig.toml")) {
		return parseToml(text)
	}
	if (file.endsWith("package.json")) {
		return JSON.parse(text).jest
	}
	if (file.endsWith(".json")) {
		return JSON.parse(text)
	}
	const statements = ast(text).filter(
		(statement) =>
			statement.type !== "ImportDeclaration" ||
			!["vite", "vitest/config", "jest", "jest/config"].includes(statement.source.value),
	)
	const declaration = statements[0]
	if (statements.length === 1 && declaration?.type === "ExportDefaultDeclaration") {
		return configValue(declaration.declaration)
	}
	if (
		statements.length === 1 &&
		declaration?.type === "ExpressionStatement" &&
		declaration.expression.type === "AssignmentExpression" &&
		declaration.expression.operator === "=" &&
		declaration.expression.left.type === "MemberExpression" &&
		declaration.expression.left.object.type === "Identifier" &&
		declaration.expression.left.object.name === "module" &&
		declaration.expression.left.property.type === "Identifier" &&
		declaration.expression.left.property.name === "exports"
	) {
		return configValue(declaration.expression.right)
	}
	throw new Error("Dynamic test configuration")
}

function setupPaths(config: unknown): string[] {
	if (!config || typeof config !== "object") {
		return []
	}
	const paths: string[] = []
	for (const [key, value] of Object.entries(config)) {
		if (
			[
				"preload",
				"setupFiles",
				"setupFilesAfterEnv",
				"globalSetup",
				"globalTeardown",
				"snapshotSerializers",
				"testEnvironment",
				"testRunner",
				"runner",
				"resolver",
				"reporters",
				"preset",
				"projects",
				"transform",
			].includes(key)
		) {
			const entries = Array.isArray(value) ? value : [value]
			if (!entries.every((entry) => typeof entry === "string")) {
				throw new Error("Unresolved test runner modules")
			}
			paths.push(...entries)
		} else if (key === "test") {
			paths.push(...setupPaths(value))
		}
	}
	return paths
}

function collectImport(entry: Syntax, paths: string[]): void {
	if (syntax(entry.source) && typeof entry.source.value === "string") {
		paths.push(entry.source.value)
	}
	if (
		entry.type === "CallExpression" &&
		syntax(entry.callee) &&
		entry.callee.name === "require" &&
		Array.isArray(entry.arguments) &&
		typeof entry.arguments[0]?.value === "string"
	) {
		paths.push(entry.arguments[0].value)
	}
}
function moduleImports(text: string): string[] {
	const paths: string[] = []
	function visit(value: unknown): void {
		if (Array.isArray(value)) {
			for (const item of value) {
				visit(item)
			}
		} else if (syntax(value)) {
			collectImport(value, paths)
			for (const child of Object.values(value)) {
				visit(child)
			}
		}
	}
	visit(ast(text))
	return paths
}

export function protectedTestFiles(files: string[], discovered: string[], read: (file: string) => string): Set<string> {
	const known = new Set(files)
	const configured = new Set<string>()
	const edges = new Map<string, string[]>()
	const resolve = (file: string, specifier: string): string | undefined => {
		const path = posix.join(posix.dirname(file), specifier.replace(/^<rootDir>\//, ""))
		return [
			path,
			...moduleSuffixes.flatMap((suffix) => [
				path + suffix,
				path.replace(/\.[cm]?jsx?$/, "") + suffix,
				posix.join(path, "index" + suffix),
			]),
		].find((candidate) => known.has(candidate))
	}
	const aliases = createTestAliasResolver(known, read)
	function collectConfig(file: string, config: unknown): void {
		const rootDir: unknown = config && typeof config === "object" && "rootDir" in config ? config.rootDir : undefined
		const base =
			typeof rootDir === "string"
				? posix.join(posix.dirname(file), rootDir.replace(/^<rootDir>\/?/, ""), "package.json")
				: file
		for (const path of setupPaths(config)) {
			const target = resolve(base, path)
			if (target) {
				configured.add(target)
			} else if (!["node", "jsdom"].includes(path)) {
				throw new Error("Unresolved test runner module")
			}
		}
	}
	function collectConfigured(file: string): void {
		if (!runnerConfig.test(file) && !/(?:^|\/)(?:package\.json|bunfig\.toml|jest\.config\.json)$/.test(file)) {
			return
		}
		const text = read(file)
		collectConfig(file, readConfig(file, text))
		if (!file.endsWith("package.json")) {
			return
		}
		collectCommand(file, text)
	}
	function collectCommand(file: string, text: string): void {
		const command: string = JSON.parse(text).scripts?.test ?? ""
		for (const match of command.matchAll(/(?:^|\s)(?:--config|-c|--preload|--require)(?:=|\s+)([^\s]+)/g)) {
			const name = match[1] ?? ""
			const selected = posix.join(posix.dirname(file), name)
			if (!known.has(selected)) {
				throw new Error("Unresolved test command configuration")
			}
			configured.add(selected)
			if (!/^--(?:preload|require)/.test(match[0].trim())) {
				collectConfig(selected, readConfig(selected, read(selected)))
			}
		}
	}
	for (const file of files) {
		collectConfigured(file)
		if (sourceFile.test(file)) {
			if (supportDirectory.test(file)) {
				configured.add(file)
			}
			edges.set(
				file,
				moduleImports(read(file)).flatMap((path) => {
					const locations = path.startsWith(".")
						? [resolve(file, path)]
						: aliases(file, path).map((name) => resolve("package.json", name))
					const selected = locations.find((name) => name !== undefined)
					return selected ? [selected] : []
				}),
			)
		}
	}
	function reachable(roots: Iterable<string>): Set<string> {
		const seen = new Set(roots)
		for (const file of seen) {
			for (const dependency of edges.get(file) ?? []) {
				seen.add(dependency)
			}
		}
		return seen
	}
	const testGraph = reachable(discovered)
	const production = reachable(
		[...edges.keys()].filter((file) => !testGraph.has(file) && !configured.has(file) && !runnerConfig.test(file)),
	)
	return new Set([...reachable(configured), ...[...testGraph].filter((file) => !production.has(file))])
}
