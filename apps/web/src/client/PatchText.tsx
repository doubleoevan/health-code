import { memo, type ReactElement } from "react"
import { HighlightedLine } from "./HighlightedLine.tsx"
import { type PatchSection, splitPatch } from "./splitPatch.ts"

type PatchLine = { text: string; className?: string; language?: string }

// the highlighted languages by file extension
const languagesByExtension: Record<string, string> = {
	...{ ts: "tsx", tsx: "tsx", mts: "tsx", cts: "tsx", js: "jsx", jsx: "jsx", mjs: "jsx", cjs: "jsx" },
	...{ json: "json", md: "markdown", yml: "yaml", yaml: "yaml", html: "markup", svg: "markup", py: "python" },
	...{ go: "go", rs: "rust", graphql: "graphql", swift: "swift", kt: "kotlin" },
}

export const PatchText = memo(function PatchText({ patch }: { patch: string }): ReactElement {
	const lines = splitPatch(patch).flatMap(toPatchLines)
	return (
		<>
			{/* patch lines */}
			{lines.map(({ text, className, language }, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: Patch lines keep their order.
				<span key={index} className={className}>
					{language ? (
						<>
							{/* change marker and highlighted code */}
							<span className="change-marker">{text.charAt(0)}</span>
							<HighlightedLine line={text.slice(1)} language={language} />
						</>
					) : (
						text
					)}
					{className !== "added" && className !== "removed" && "\n"}
				</span>
			))}
		</>
	)
})

function toPatchLines({ text, filePath, isFolded }: PatchSection): PatchLine[] {
	const lines = text.replace(/\n$/, "").split("\n")
	if (isFolded) {
		return lines.map((line) => ({ text: line, className: "folded" }))
	}

	// highlight code after the first changed range
	const codeStart = lines.findIndex((line) => line.startsWith("@@ "))
	const signature = lines.lastIndexOf("-- ")
	const language = languagesByExtension[filePath?.split(".").at(-1)?.toLowerCase() ?? ""]
	return lines.map((line, index) => {
		// leave file names and the closing signature uncolored
		const isCode = codeStart >= 0 && index > codeStart && (signature < 0 || index < signature)
		if (/^(?:diff --git |@@ )/.test(line)) {
			return { text: line, className: "heading" }
		}
		return isCode && /^[ +-]/.test(line)
			? { text: line, className: { "+": "added", "-": "removed" }[line.charAt(0)], language }
			: { text: line }
	})
}
