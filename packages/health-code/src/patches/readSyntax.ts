import { type ParserOptions, parse } from "@babel/parser"

export type Syntax = { type: string; [key: string]: unknown }

// the parser settings every source reader shares
export const syntaxOptions = {
	sourceType: "unambiguous",
	plugins: ["jsx", "typescript", "decorators-legacy"],
} satisfies ParserOptions

/**
 * Recognizes a syntax node before its fields are traversed.
 */
export function isSyntax(value: unknown): value is Syntax {
	return !!value && typeof value === "object" && "type" in value && typeof value.type === "string"
}

/**
 * Parses a source file into its top-level statements.
 */
export function parseStatements(text: string): ReturnType<typeof parse>["program"]["body"] {
	return parse(text, { ...syntaxOptions, createImportExpressions: true }).program.body
}

/**
 * Reads the static name of an object property.
 */
export function readPropertyName(property: Syntax): unknown {
	return isSyntax(property.key) && !property.computed ? (property.key.name ?? property.key.value) : undefined
}
