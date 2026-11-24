import { posix } from "node:path"
import { isSyntax, parseStatements, readPropertyName, type Syntax } from "../src/patches/readSyntax.ts"

export type ViteAlias = { directory: string; name: string; target: string }

/**
 * Reads alias targets from a Vite configuration and rejects settings it cannot resolve statically.
 */
export function readViteAliases(file: string, text: string): ViteAlias[] {
	const aliases: ViteAlias[] = []

	// walk every nested setting in the configuration
	function visit(value: unknown): void {
		if (Array.isArray(value)) {
			value.forEach(visit)
			return
		}
		if (!isSyntax(value)) {
			return
		}

		// check each setting that can redirect or inject modules
		const name = value.type === "ObjectProperty" ? readPropertyName(value) : undefined
		if (name === "alias") {
			aliases.push(...toAliases(file, value.value))
			return
		}

		// require readable settings where modules can be injected
		if (name === "resolve") {
			toStaticProperties(value.value)
		}

		// require plugins imported by the configuration
		if (name === "plugins") {
			requirePluginCalls(value.value)
			return
		}

		// continue into nested settings
		Object.values(value).forEach(visit)
	}
	visit(parseStatements(text))
	return aliases
}

/**
 * Orders aliases by the nearest configuration and then the most specific name.
 */
export function compareAliases(left: ViteAlias, right: ViteAlias): number {
	const toDepth = (directory: string): number => (directory === "." ? 0 : directory.split("/").length)
	return toDepth(right.directory) - toDepth(left.directory) || right.name.length - left.name.length
}

// require named properties without spreads or computed keys
function toStaticProperties(value: unknown): Syntax[] {
	if (!isSyntax(value) || value.type !== "ObjectExpression" || !Array.isArray(value.properties)) {
		throw new Error("Dynamic test path aliases")
	}

	// reject spreads and computed keys
	const properties: Syntax[] = value.properties
	if (properties.some((property) => property.type !== "ObjectProperty" || property.computed)) {
		throw new Error("Dynamic test path aliases")
	}
	return properties
}

// require plugins created by calls to imported functions
function requirePluginCalls(value: unknown): void {
	const elements = isSyntax(value) && value.type === "ArrayExpression" ? value.elements : undefined
	const isImportedCall = (element: unknown): boolean =>
		isSyntax(element) &&
		element.type === "CallExpression" &&
		isSyntax(element.callee) &&
		element.callee.type === "Identifier"

	// reject inline plugins and dynamic lists
	if (!Array.isArray(elements) || !elements.every(isImportedCall)) {
		throw new Error("Unresolved test configuration plugin")
	}
}

function toAliases(file: string, value: unknown): ViteAlias[] {
	const directory = posix.dirname(file)
	return toStaticProperties(value).map((property) => {
		const name = readPropertyName(property)
		const segments = toLiteralSegments(property.value)

		// reject an alias whose name or target is computed
		if (typeof name !== "string" || !segments.length) {
			throw new Error("Dynamic test path aliases")
		}
		return { directory, name, target: posix.join(directory, ...segments) }
	})
}

// read a literal path or a call that resolves one beside the configuration
function toLiteralSegments(value: unknown): string[] {
	if (isSyntax(value) && value.type === "StringLiteral") {
		return [String(value.value)]
	}
	if (!isSyntax(value) || value.type !== "CallExpression" || !Array.isArray(value.arguments)) {
		throw new Error("Dynamic test path aliases")
	}

	// read a path call such as resolve(__dirname, "src")
	const name = toMemberPath(value.callee)
	if (["resolve", "join", "path.resolve", "path.join"].includes(name)) {
		return toPathSegments(value.arguments)
	}

	// read fileURLToPath(new URL("./src", import.meta.url))
	const [location] = value.arguments
	const isUrl = isSyntax(location) && location.type === "NewExpression" && toMemberPath(location.callee) === "URL"
	if (!["fileURLToPath", "url.fileURLToPath"].includes(name) || !isUrl || !Array.isArray(location.arguments)) {
		throw new Error("Dynamic test path aliases")
	}

	// require a path relative to the configuration
	const [path, base] = location.arguments
	if (toMemberPath(base) !== "import.meta.url") {
		throw new Error("Dynamic test path aliases")
	}
	return toPathSegments([path])
}

// read literal segments after an optional configuration directory
function toPathSegments(paths: unknown[]): string[] {
	// omit the directory that aliases already start from
	const isDirectory = ["__dirname", "import.meta.dirname"].includes(toMemberPath(paths[0]))
	return paths.slice(isDirectory ? 1 : 0).map((path) => {
		if (!isSyntax(path) || path.type !== "StringLiteral") {
			throw new Error("Dynamic test path aliases")
		}

		// keep the literal segment
		return String(path.value)
	})
}

// name an identifier or a plain member chain
function toMemberPath(value: unknown): string {
	if (!isSyntax(value) || value.computed) {
		return ""
	}

	// return the name that starts the chain
	if (value.type === "Identifier") {
		return String(value.name)
	}

	if (value.type === "MetaProperty") {
		return "import.meta"
	}

	// join each member to the object it belongs to
	return value.type === "MemberExpression" ? `${toMemberPath(value.object)}.${toMemberPath(value.property)}` : ""
}
