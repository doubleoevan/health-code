import { type ReactElement, useId, useRef, useState } from "react"
import { PatchText } from "./PatchText.tsx"
import { Link } from "./ReportControls.tsx"
import { toPatchPath } from "./report.ts"

export function PatchPreview({ digest, title }: { digest: string; title: string }): ReactElement {
	const dialog = useRef<HTMLDialogElement>(null)
	const titleId = useId()
	const [patchText, setPatchText] = useState<string | null>(null)
	const [hasLoadFailed, setHasLoadFailed] = useState(false)
	async function handleOpen(): Promise<void> {
		dialog.current?.showModal()

		// load the patch the first time it opens
		if (patchText !== null) {
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
	function handleClose(): void {
		dialog.current?.close()
	}

	// describe the patch until its text arrives
	const loadStatus = hasLoadFailed ? "Patch unavailable. Close and reopen to retry." : "Loading patch…"
	return (
		<>
			<button type="button" className="secondary" onClick={handleOpen}>
				Show patch
			</button>
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes a modal dialog. */}
			<dialog
				ref={dialog}
				className="patch-preview"
				aria-labelledby={titleId}
				onClick={(event) => event.target === dialog.current && handleClose()}
			>
				<div className="patch-preview-content">
					{/* patch name, download and close control */}
					<header>
						<h2 id={titleId}>{title}</h2>
						<span className="button-link">
							<Link href={toPatchPath(digest)}>Download patch</Link>
						</span>
						<button type="button" className="close" aria-label="Close" onClick={handleClose}>
							×
						</button>
					</header>

					{/* patch text */}
					<div className="prompt-box">
						{/* biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users scroll the patch. */}
						<pre tabIndex={0}>{patchText === null ? loadStatus : <PatchText patch={patchText} />}</pre>
					</div>
				</div>
			</dialog>
		</>
	)
}
