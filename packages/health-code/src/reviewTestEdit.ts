import { parse } from "@babel/parser"

type Node = { type: string; [key: string]: unknown }
type Review = { kind: "coverage"; names: string[] } | { kind: "expectation"; name: string }
function isNode(value: unknown): value is Node {
	return !!value && typeof value === "object" && "type" in value && typeof value.type === "string"
}
function toTree(text: string): Node[] {
	const program = parse(text, {
		sourceType: "unambiguous",
		plugins: ["jsx", "typescript", "decorators-legacy"],
	}).program
	return JSON.parse(
		JSON.stringify([...program.directives, ...program.body], (key, value) =>
			["loc", "start", "end", "extra", "leadingComments", "innerComments", "trailingComments"].includes(key)
				? undefined
				: value,
		),
	)
}
function testName(statement: Node): string | undefined {
	// identify direct named test declarations
	const call = statement.expression

	// require a direct call to test or it
	if (
		!isNode(call) ||
		call.type !== "CallExpression" ||
		!isNode(call.callee) ||
		!["test", "it"].includes(String(call.callee.name))
	) {
		return
	}

	// require a literal title and a separate test body
	if (!Array.isArray(call.arguments) || call.arguments.length !== 2) {
		return
	}
	const [title, fn] = call.arguments
	if (title?.type === "StringLiteral" && ["ArrowFunctionExpression", "FunctionExpression"].includes(fn?.type)) {
		return title.value
	}
}

// trace matcher members back to an expect call
function expectReceiver(node: unknown): boolean {
	if (!isNode(node)) {
		return false
	}

	// follow the receiver through chained matcher properties
	if (node.type === "MemberExpression") {
		return expectReceiver(node.object)
	}
	return node.type === "CallExpression" && isNode(node.callee) && node.callee.name === "expect"
}

// locate the changed literal in the cited release text
function citedValue(quote: string, value: unknown): boolean {
	const text = String(value)
	if (!text) {
		return quote.includes('""') || quote.includes("''")
	}
	const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

	// preserve token boundaries when matching expected values
	const boundary = typeof value === "number" ? "[\\w.]" : "[\\w]"
	return new RegExp(`(?<!${boundary})${escaped}(?!${boundary})`, "i").test(quote)
}
function documentsExpectedValue(citation: Citation, value: unknown): boolean {
	const statement = citation.quote.toLowerCase().split(/,\s*not\b/)[0] ?? ""
	const symbolAt = statement.indexOf(citation.symbol.toLowerCase())

	// reject conditional or negated claims about the symbol
	if (symbolAt < 0 || /\b(not|never|cannot|unless|if|might|may|could|sometimes)\b|n['’]t\b/.test(statement)) {
		return false
	}
	const result = /\b(?:now\s+)?(?:returns?|yields?|produces?|resolves? to|defaults? to)\s+(.+)/.exec(
		statement.slice(symbolAt),
	)
	return (
		!!result?.[1] && citedValue(result[1].split(/\b(?:instead of|rather than|previously|formerly)\b/)[0] ?? "", value)
	)
}

function assertionCall(expression: unknown): boolean {
	// unwrap awaited assertions before checking the call
	const value = isNode(expression) && expression.type === "AwaitExpression" ? expression.argument : expression
	if (!isNode(value) || value.type !== "CallExpression" || !isNode(value.callee)) {
		return false
	}
	const target = value.callee

	// recognize supported assertion methods on their owning object
	if (
		target.name === "assert" ||
		(isNode(target.object) &&
			target.object.name === "assert" &&
			isNode(target.property) &&
			[
				"ok",
				"equal",
				"strictEqual",
				"notEqual",
				"notStrictEqual",
				"deepEqual",
				"deepStrictEqual",
				"notDeepEqual",
				"notDeepStrictEqual",
				"throws",
				"rejects",
				"doesNotThrow",
				"doesNotReject",
				"match",
				"doesNotMatch",
				"ifError",
			].includes(String(target.property.name)))
	) {
		return true
	}
	return isNode(target.property) && /^to[A-Z]/.test(String(target.property.name)) && expectReceiver(target.object)
}

function containsAssertion(statement: Node): boolean {
	const expression = statement.expression
	if (!isNode(expression) || !Array.isArray(expression.arguments)) {
		return false
	}

	// locate assertions inside the proposed test callback
	const body = expression.arguments[1]?.body
	if (!isNode(body)) {
		return false
	}
	if (assertionCall(body)) {
		return true
	}

	// require a block or a direct assertion expression
	if (body.type !== "BlockStatement" || !Array.isArray(body.body)) {
		return false
	}
	for (const line of body.body) {
		const value = line.expression ?? line.argument

		// recognize assertions returned or executed within the body
		if (assertionCall(value)) {
			return true
		}
		if (
			[
				"ReturnStatement",
				"ThrowStatement",
				"IfStatement",
				"TryStatement",
				"SwitchStatement",
				"ForStatement",
				"WhileStatement",
				"DoWhileStatement",
			].includes(line.type)
		) {
			return false
		}
	}
	return false
}

function expectation(value: Node): Node | undefined {
	if (value.type !== "CallExpression" || !Array.isArray(value.arguments) || !isNode(value.callee)) {
		return
	}
	const member = value.callee

	// require an ordinary method call for an editable expectation
	if (member.type !== "MemberExpression" || member.computed || !isNode(member.property) || !isNode(member.object)) {
		return
	}
	const method = member.property.name
	const receiver = member.object
	if (receiver.name === "assert" && ["equal", "strictEqual", "deepEqual", "deepStrictEqual"].includes(String(method))) {
		// identify the expected argument in a supported equality assertion
		return value.arguments[1]
	}
	if (
		receiver.type === "CallExpression" &&
		isNode(receiver.callee) &&
		receiver.callee.name === "expect" &&
		// restrict expect matchers to their expected-value argument
		["toBe", "toEqual", "toStrictEqual"].includes(String(method))
	) {
		return value.arguments[0]
	}
}
function containsSymbol(tree: unknown, symbol: string): boolean {
	// search nested syntax for the cited api symbol
	if (Array.isArray(tree)) {
		return tree.some((child) => containsSymbol(child, symbol))
	}
	if (!isNode(tree)) {
		return false
	}

	// compare node identifiers and descend into children
	return (
		(tree.type === "Identifier" && tree.name === symbol) ||
		Object.values(tree).some((child) => containsSymbol(child, symbol))
	)
}
type Citation = { symbol: string; quote: string }
function maskValues(statement: Node, citation?: Citation): { shape: string; values: string[]; cited: boolean[] } {
	// mask eligible expected literals while preserving the surrounding test
	const cited: boolean[] = []
	const values: string[] = []
	const shape = JSON.stringify(statement, (_, value) => {
		if (isNode(value)) {
			const literal = expectation(value)

			// collect the original literals and their release citations
			if (literal && ["NumericLiteral", "StringLiteral", "BooleanLiteral"].includes(literal.type)) {
				values.push(JSON.stringify(literal.value))
				cited.push(
					!!citation && containsSymbol(value, citation.symbol) && documentsExpectedValue(citation, literal.value),
				)
				literal.value = null
			}
		}

		// preserve all other syntax for structural comparison
		return value
	})
	return { shape, values, cited }
}
export function reviewNewTest(contents: string): { kind: "coverage"; names: string[] } {
	const statements = toTree(contents).filter((statement) => statement.type !== "ImportDeclaration")

	// require new top-level cases to have distinct names and assertions
	const names = statements.map((statement) => containsAssertion(statement) && testName(statement))
	if (
		!names.length ||
		!names.every((name): name is string => typeof name === "string" && !!name) ||
		new Set(names).size !== names.length
	) {
		throw new Error("New test files require named cases with assertions")
	}

	// return the names to verify in the final inventory
	return { kind: "coverage", names }
}

function reviewAddedCases(previous: Node[], next: Node[]): Review {
	let index = 0
	const names: string[] = []
	for (const statement of next) {
		// retain existing statements in their original order
		if (index < previous.length && JSON.stringify(statement) === JSON.stringify(previous[index])) {
			index++
			continue
		}
		const name = containsAssertion(statement) && testName(statement)

		// reject additions without a named test and an assertion
		if (!name) {
			throw new Error("Added coverage must contain a named assertion")
		}
		names.push(name)
	}
	if (index !== previous.length) {
		// reject omissions from the original test file
		throw new Error("Existing test structure changed")
	}
	return { kind: "coverage", names }
}

/**
 * Accepts added test cases or one expected literal in an otherwise identical named test.
 */
export function reviewTestEdit(before: string, after: string, citation?: Citation): Review {
	const previous = toTree(before)
	const next = toTree(after)
	if (next.length > previous.length) {
		return reviewAddedCases(previous, next)
	}

	const changed = next.filter((item, index) => JSON.stringify(item) !== JSON.stringify(previous[index]))
	if (next.length !== previous.length || changed.length !== 1 || !changed[0]) {
		throw new Error("Existing test structure changed")
	}
	const index = next.indexOf(changed[0])
	const old = previous[index],
		proposed = next[index]
	if (!old || !proposed) {
		throw new Error("Unattributed test edit")
	}
	const name = testName(old)
	const left = maskValues(old),
		right = maskValues(proposed, citation)
	if (!name || left.shape !== right.shape || left.values.filter((value, i) => value !== right.values[i]).length !== 1) {
		throw new Error("Test edit changed more than one literal expectation")
	}

	// verify that the changed expectation matches the quoted behavior
	const change = left.values.findIndex((value, i) => value !== right.values[i])
	if (citation && !right.cited[change]) {
		throw new Error("Release citation must document the changed assertion’s API and expected value")
	}
	return { kind: "expectation", name }
}
