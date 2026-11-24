import { Fragment, memo, type ReactElement, useState } from "react"
import { HighlightedLine } from "./HighlightedLine.tsx"
import { Link } from "./ReportControls.tsx"

// Destinations keyed by the exact prompt text they link.
export type PromptLinks = Record<string, string>

export function TroubleshootingPrompt({ text }: { text: string }): ReactElement {
	return <PromptBox title="Troubleshooting prompt for your coding agent" text={text} />
}

export function PromptBox({ title, text, links }: { title: string; text: string; links?: PromptLinks }): ReactElement {
	const [status, setStatus] = useState("")
	async function handleCopy(): Promise<void> {
		// keep the visible prompt selectable when copying fails
		try {
			await navigator.clipboard.writeText(text)
			setStatus("Copied")
		} catch {
			setStatus("Select to copy")
		}
	}
	return (
		<section className="prompt" aria-label={title}>
			{/* prompt heading */}
			<h2>{title}</h2>

			{/* scrollable prompt and copy control */}
			<div className="prompt-box">
				{/* biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users scroll the prompt. */}
				<pre tabIndex={0}>
					<HighlightedText text={text} links={links} />
				</pre>
				<button type="button" className="secondary" aria-live="polite" onClick={handleCopy}>
					{status || "Copy"}
				</button>
			</div>
		</section>
	)
}

const noLinks: PromptLinks = {}

// Keep the highlighted text when only the copy status changes.
const HighlightedText = memo(function HighlightedText({
	text,
	links = noLinks,
}: {
	text: string
	links?: PromptLinks
}): ReactElement {
	// Show long prompts as plain text.
	if (text.length > 8192) {
		return <>{text}</>
	}
	return (
		<>
			{/* highlighted prompt lines */}
			{text.split("\n").map((line, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: Prompt text keeps its order.
				<Fragment key={`${index}:${line}`}>
					{index > 0 && "\n"}
					<LinkedLine line={line} links={links} />
				</Fragment>
			))}
		</>
	)
})

function LinkedLine({ line, links }: { line: string; links: PromptLinks }): ReactElement {
	// Match a patch URL before the digest inside it.
	const linked = Object.keys(links).sort((left, right) => right.length - left.length)
	const escaped = linked.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
	const parts = escaped.length ? line.split(new RegExp(`(${escaped.join("|")})`)) : [line]
	const language = toLanguage(line)
	return (
		<>
			{/* linked values and highlighted text */}
			{parts.map((part, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: Prompt text keeps its order.
				<Fragment key={`${index}:${part}`}>
					{index % 2 ? <Link href={links[part]}>{part}</Link> : <HighlightedLine line={part} language={language} />}
				</Fragment>
			))}
		</>
	)
}

function toLanguage(line: string): string {
	if (/^\s*["{}[\]]/.test(line)) {
		return "json"
	}
	if (/^<\/?untrusted-data-/.test(line)) {
		return "markup"
	}

	// Highlight labeled patch details as key and value pairs.
	return /^[A-Z][\w -]{0,30}: /.test(line) ? "yaml" : "markdown"
}
