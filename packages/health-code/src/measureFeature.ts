import { parse } from "@babel/parser"
import type { FeatureMatch } from "./agentContracts.ts"

type Scope = { files: Map<string, string>; tests: Set<string>; symbol?: string }
function measure({ files, tests, symbol }: Scope): { lines: number; nodes: number; calls: number } {
	let lines = 0,
		nodes = 0,
		calls = 0
	for (const [file, text] of files) {
		if (tests.has(file)) {
			continue
		}
		const ast = parse(text, {
			sourceType: "unambiguous",
			plugins: ["jsx", "typescript", "decorators-legacy"],
			tokens: true,
		})
		const occupied = new Set<number>()
		for (const token of ast.tokens ?? []) {
			if (typeof token.type !== "string" && token.type.label !== "eof") {
				occupied.add(token.loc.start.line)
			}
		}
		lines += occupied.size
		JSON.stringify(ast.program, (_, value) => {
			if (value && typeof value === "object" && typeof value.type === "string") {
				nodes++
			}
			if (
				value?.type === "CallExpression" &&
				symbol &&
				(value.callee.name === symbol || value.callee.property?.name === symbol)
			) {
				calls++
			}
			return value
		})
	}
	return { lines, nodes, calls }
}
/** Measures an adoption against the accepted upgrade's production source. */
export function measureFeature(options: {
	before: Map<string, string>
	after: Map<string, string>
	tests: Set<string>
	symbol?: string
	removedDependency?: string
}): NonNullable<FeatureMatch["benefit"]> {
	if (options.removedDependency) {
		return { kind: "direct-dependency", before: 1, after: 0, name: options.removedDependency }
	}
	const before = measure({ files: options.before, tests: options.tests, symbol: options.symbol })
	const after = measure({ files: options.after, tests: options.tests, symbol: options.symbol })
	if (before.calls > after.calls && options.symbol) {
		return { kind: "deprecated-call", before: before.calls, after: after.calls, name: options.symbol }
	}
	if (before.lines > after.lines && before.nodes > after.nodes) {
		return { kind: "production-lines", before: before.lines, after: after.lines }
	}
	throw new Error("Feature did not reduce production code, a deprecated call or a direct dependency")
}
