import { Highlight } from "prism-react-renderer"
import { Fragment, memo, type ReactElement, useState } from "react"

// Leave token colors to the stylesheet so they follow the page theme.
const theme = { plain: {}, styles: [] }

export function TroubleshootingPrompt({ text }: { text: string }): ReactElement {
	return <PromptBox title="Troubleshooting prompt for your coding agent" text={text} />
}

export function PromptBox({ title, text }: { title: string; text: string }): ReactElement {
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
					<HighlightedText text={text} />
				</pre>
				<button type="button" className="secondary" aria-live="polite" onClick={handleCopy}>
					{status || "Copy"}
				</button>
			</div>
		</section>
	)
}

// Keep the highlighted text when only the copy status changes.
const HighlightedText = memo(function HighlightedText({ text }: { text: string }): ReactElement {
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
					<HighlightedLine line={line} />
				</Fragment>
			))}
		</>
	)
})

function HighlightedLine({ line }: { line: string }): ReactElement {
	return (
		<Highlight code={line} language={toLanguage(line)} theme={theme}>
			{({ tokens, getTokenProps }) => (
				<>
					{tokens.flat().map((token, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: Prompt text keeps its order.
						<span key={`${index}:${token.content}`} className={getTokenProps({ token }).className}>
							{token.empty ? "" : token.content}
						</span>
					))}
				</>
			)}
		</Highlight>
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
