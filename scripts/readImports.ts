import { type Node, parseSync, Visitor } from "oxc-parser"

type SourceImport = { path: string; line: number; typeOnly: boolean }

/** Reads literal module specifiers, including types erased by the transpiler. */
export function readImports(filePath: string, text: string): SourceImport[] {
	// reject incomplete syntax trees before checking module boundaries
	const source = parseSync(filePath, text, { sourceType: "unambiguous" })
	const [error] = source.errors
	if (error) {
		throw new Error(`${filePath}: ${error.message}`)
	}

	// track source positions across successive imports
	const imports: SourceImport[] = []
	const lineBreaks = text.matchAll(/\r\n|[\r\n\u2028\u2029]/g)
	let nextBreak = lineBreaks.next()
	let line = 1

	function record(node: Node | null | undefined, typeOnly = false): void {
		if (!node) {
			return
		}
		const path = toLiteralPath(node)
		if (path === undefined) {
			return
		}

		// Follow the visitor through the source in order so each line break is counted once.
		while (!nextBreak.done && nextBreak.value.index < node.start) {
			line++
			nextBreak = lineBreaks.next()
		}
		imports.push({ path, line, typeOnly })
	}

	// classify type-only imports and re-exports
	const visitor = new Visitor({
		ImportDeclaration(node) {
			const namedTypesOnly =
				node.specifiers.length > 0 &&
				node.specifiers.every((specifier) => specifier.type === "ImportSpecifier" && specifier.importKind === "type")
			record(node.source, node.importKind === "type" || namedTypesOnly)
		},
		ExportNamedDeclaration(node) {
			const namedTypesOnly =
				node.specifiers.length > 0 && node.specifiers.every((specifier) => specifier.exportKind === "type")
			record(node.source, node.exportKind === "type" || namedTypesOnly)
		},
		ExportAllDeclaration(node) {
			record(node.source, node.exportKind === "type")
		},
		TSImportEqualsDeclaration(node) {
			if (node.moduleReference.type === "TSExternalModuleReference") {
				record(node.moduleReference.expression, node.importKind === "type")
			}
		},
		TSImportType(node) {
			record(node.source, true)
		},
		// include dynamic imports and literal require calls
		ImportExpression(node) {
			record(node.source)
		},
		CallExpression(node) {
			if (node.callee.type === "Identifier" && node.callee.name === "require") {
				record(node.arguments[0])
			}
		},
	})
	visitor.visit(source.program)
	return imports
}

function toLiteralPath(node: Node): string | undefined {
	if (node.type === "Literal" && typeof node.value === "string") {
		return node.value
	}
	if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
		return node.quasis[0]?.value.cooked ?? undefined
	}
}
