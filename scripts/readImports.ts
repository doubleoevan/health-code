import ts from "typescript"

type SourceImport = { path: string; line: number; typeOnly: boolean }

/** Reads literal module specifiers, including types erased by the transpiler. */
export function readImports(filePath: string, text: string): SourceImport[] {
	const source = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true)
	const imports: SourceImport[] = []

	function visit(node: ts.Node): void {
		const specifier = toModuleSpecifier(node)
		if (specifier && ts.isStringLiteralLike(specifier)) {
			const { line } = source.getLineAndCharacterOfPosition(specifier.getStart(source))
			imports.push({ path: specifier.text, line: line + 1, typeOnly: isTypeOnly(node) })
		}
		ts.forEachChild(node, visit)
	}
	visit(source)
	return imports
}

function toModuleSpecifier(node: ts.Node): ts.Node | undefined {
	if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
		return node.moduleSpecifier
	}
	if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
		return node.moduleReference.expression
	}
	if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
		return node.argument.literal
	}
	if (ts.isCallExpression(node)) {
		const callee = node.expression
		if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require")) {
			return node.arguments[0]
		}
	}
	return undefined
}

function isTypeOnly(node: ts.Node): boolean {
	if (ts.isImportTypeNode(node)) {
		return true
	}
	if (ts.isImportEqualsDeclaration(node) || ts.isExportDeclaration(node)) {
		return (
			node.isTypeOnly ||
			(ts.isExportDeclaration(node) &&
				!!node.exportClause &&
				ts.isNamedExports(node.exportClause) &&
				node.exportClause.elements.length > 0 &&
				node.exportClause.elements.every((element) => element.isTypeOnly))
		)
	}
	if (!ts.isImportDeclaration(node) || !node.importClause) {
		return false
	}
	const clause = node.importClause
	const named = clause.namedBindings
	return (
		clause.isTypeOnly ||
		(!clause.name &&
			!!named &&
			ts.isNamedImports(named) &&
			named.elements.length > 0 &&
			named.elements.every((element) => element.isTypeOnly))
	)
}
