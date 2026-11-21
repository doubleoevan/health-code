import { posix } from "node:path"
import { type ParseError, parse } from "jsonc-parser/lib/esm/main.js"

type Config = { extends?: string | string[]; compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } }
type Rule = { prefix: string; suffix: string; wildcard: boolean; targets: string[] }

type AliasConfig = { base?: string; mapping?: { dir: string; rules: Rule[] } }

function makeRules(paths: Record<string, string[]>): Rule[] {
	return Object.entries(paths).map(([key, targets]) => {
		const [prefix = "", suffix = ""] = key.split("*")
		if (!Array.isArray(targets) || !targets.every((item) => typeof item === "string")) {
			throw new Error("Invalid test path alias")
		}
		return {
			prefix,
			suffix,
			wildcard: key.includes("*"),
			targets,
		}
	})
}
function matchRules(rules: Rule[], name: string): string[] {
	const rule =
		rules.find((entry) => !entry.wildcard && name === entry.prefix) ??
		rules
			.filter(
				(entry) =>
					entry.wildcard &&
					name.startsWith(entry.prefix) &&
					name.endsWith(entry.suffix) &&
					name.length >= entry.prefix.length + entry.suffix.length,
			)
			.sort((a, b) => b.prefix.length - a.prefix.length)[0]
	if (!rule) {
		return []
	}
	const middle = name.slice(rule.prefix.length, name.length - rule.suffix.length)
	return rule.targets.map((target) => target.replace("*", () => middle))
}
function resolveImport({ base, mapping }: AliasConfig, name: string): string[] {
	const paths = mapping ? matchRules(mapping.rules, name).map((path) => posix.join(base ?? mapping.dir, path)) : []
	return [...paths, ...(base ? [posix.join(base, name)] : [])]
}
function readConfig(contents: string): Config {
	const errors: ParseError[] = []
	const config: Config = parse(contents, errors, { allowTrailingComma: true })
	if (errors.length || !config || typeof config !== "object") {
		throw new Error("Invalid test path configuration")
	}
	return config
}

/** Resolves test imports using pinned TypeScript and JavaScript configuration. */
export function createTestAliasResolver(
	files: Set<string>,
	read: (file: string) => string,
): (importer: string, name: string) => string[] {
	const cache = new Map<string, AliasConfig>()
	function load(file: string, parents: Set<string>): AliasConfig {
		const cached = cache.get(file)
		if (cached) {
			return cached
		}
		if (parents.has(file) || !files.has(file)) {
			throw new Error("Unresolved test path aliases")
		}
		const config = readConfig(read(file))
		const result = resolve(file, parents, config)
		cache.set(file, result)
		return result
	}
	function resolve(file: string, parents: Set<string>, config: Config): AliasConfig {
		const dir = posix.dirname(file)
		let base: string | undefined
		let mapping: AliasConfig["mapping"]
		for (const parent of [config.extends ?? []].flat()) {
			if (!parent.startsWith(".")) {
				throw new Error("External test path configuration cannot be verified")
			}
			const name = posix.join(dir, parent)
			const inherited = load(files.has(name) ? name : name + ".json", new Set([...parents, file]))
			base = inherited.base ?? base
			mapping = inherited.mapping ?? mapping
		}
		if (config.compilerOptions?.baseUrl) {
			base = posix.join(dir, config.compilerOptions.baseUrl)
		}
		if (config.compilerOptions?.paths) {
			mapping = { dir, rules: makeRules(config.compilerOptions.paths) }
		}
		return { base, mapping }
	}
	return (importer, name) => {
		if (name.startsWith(".") || name.startsWith("node:") || name.startsWith("bun:")) {
			return []
		}
		let dir = posix.dirname(importer)
		for (;;) {
			const file = ["tsconfig.json", "jsconfig.json"]
				.map((name) => posix.join(dir, name))
				.find((name) => files.has(name))
			if (file) {
				return resolveImport(load(file, new Set()), name)
			}
			if (dir === ".") {
				return []
			}
			dir = posix.dirname(dir)
		}
	}
}
