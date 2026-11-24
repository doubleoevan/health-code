import { memo, type ReactElement, useState } from "react"
import { toPatchPath } from "./report.ts"
import { splitPatch } from "./splitPatch.ts"

export function PatchPreview({ digest }: { digest: string }): ReactElement {
	const [patchText, setPatchText] = useState<string | null>(null)
	const [hasLoadFailed, setHasLoadFailed] = useState(false)
	async function handleToggle(isOpen: boolean): Promise<void> {
		// load the patch the first time it opens
		if (!isOpen || patchText !== null) {
			return
		}

		// show the patch or a failure the reader can retry
		try {
			setHasLoadFailed(false)
			const response = await fetch(toPatchPath(digest))
			if (!response.ok) {
				throw new Error("The patch is unavailable")
			}
			setPatchText(await response.text())
		} catch {
			setHasLoadFailed(true)
		}
	}

	// describe the patch until its text arrives
	const loadStatus = hasLoadFailed ? "Patch unavailable. Close and reopen to retry." : "Loading patch…"
	return (
		<details className="patch-preview" onToggle={(event) => void handleToggle(event.currentTarget.open)}>
			{/* patch description and text */}
			<summary>Show patch</summary>
			<div className="prompt-box">
				{/* biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users scroll the patch. */}
				<pre tabIndex={0}>{patchText === null ? loadStatus : <PatchText patch={patchText} />}</pre>
			</div>
		</details>
	)
}

const PatchText = memo(function PatchText({ patch }: { patch: string }): ReactElement {
	// choose a color for each shown line
	const lines = splitPatch(patch).flatMap(({ text, isFolded }) =>
		text
			.replace(/\n$/, "")
			.split("\n")
			.map((line) => ({ line, className: isFolded ? "folded" : toPatchLineClass(line) })),
	)
	return (
		<>
			{/* patch lines */}
			{lines.map(({ line, className }, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: Patch lines keep their order.
				<span key={index} className={className}>
					{line}
					{"\n"}
				</span>
			))}
		</>
	)
})

function toPatchLineClass(line: string): string | undefined {
	// leave file names and the closing signature uncolored
	if (/^(?:\+\+\+|---|-- $)/.test(line)) {
		return undefined
	}
	if (/^(?:diff --git |@@ )/.test(line)) {
		return "heading"
	}
	return { "+": "added", "-": "removed" }[line.charAt(0)]
}
