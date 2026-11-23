import { type ReactElement, type ReactNode, useState } from "react"

export function Link({ href, children }: { href?: string; children: ReactNode }): ReactElement {
	// allow secure external links and root-relative paths
	const external = href?.startsWith("https://")
	if (!href || (!external && !/^\/(?!\/)/.test(href))) {
		return <span>{children}</span>
	}
	return (
		<a href={href} target={external ? "_blank" : undefined} rel={external ? "noopener noreferrer" : undefined}>
			{children}
		</a>
	)
}
export function Copy({ text, label, share = false }: { text: string; label: string; share?: boolean }): ReactElement {
	const [status, setStatus] = useState("")
	async function handleClick(): Promise<void> {
		try {
			// prefer the native share dialog for report links
			if (share && navigator.share) {
				await navigator.share({ url: text })
				return
			}

			// copy the supplied link or patch instructions
			await navigator.clipboard.writeText(text)
			setStatus("Copied")
		} catch (error) {
			// offer selectable text when copying fails
			if (!(error instanceof DOMException && error.name === "AbortError")) {
				setStatus("Copy unavailable. Select the text below.")
			}
		}
	}
	return (
		<span>
			<button type="button" className="secondary" onClick={handleClick}>
				{label}
			</button>{" "}
			{/* copy status and manual fallback */}
			<small role="status">{status}</small>
			{status.startsWith("Copy unavailable") && <textarea readOnly value={text} aria-label={label} />}
		</span>
	)
}

export function CopyInvestigationPrompt({ text }: { text: string }): ReactElement {
	return <Copy label="Copy prompt to investigate" text={text} />
}
