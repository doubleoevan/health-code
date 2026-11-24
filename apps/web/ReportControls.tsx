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
export function CommitLink({ commit, repositoryUrl }: { commit: string; repositoryUrl?: string }): ReactElement {
	return (
		<Link href={repositoryUrl && `${repositoryUrl}/commit/${commit}`}>
			<code title={commit}>{commit.slice(0, 8)}</code>
		</Link>
	)
}
export function UpgradeMenuLink({ id, repositoryUrl }: { id?: string; repositoryUrl: string }): ReactElement | null {
	if (!id) {
		return null
	}
	return (
		<nav className="mono" aria-label="Back to upgrades">
			<Link href={`/r/${id}`}>
				{/* arrow and repository */}
				<span aria-hidden="true">← </span>
				{repositoryUrl.slice(19)} upgrades
			</Link>
		</nav>
	)
}
export function Copy({ text, label }: { text: string; label: string }): ReactElement {
	const [status, setStatus] = useState("")
	async function handleClick(): Promise<void> {
		try {
			await navigator.clipboard.writeText(text)
			setStatus("Copied")
		} catch {
			// offer selectable text when copying fails
			setStatus("Copy unavailable. Select the text below.")
		}
	}
	return (
		<span>
			<button type="button" className="secondary quiet" onClick={handleClick}>
				{label}
			</button>{" "}
			{/* copy status and manual fallback */}
			<small role="status">{status}</small>
			{status.startsWith("Copy unavailable") && <textarea readOnly value={text} aria-label={label} />}
		</span>
	)
}
