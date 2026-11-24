import type { ReactElement } from "react"

export function CurrentStep({ text }: { text: string }): ReactElement {
	return (
		<p className="current" role="status">
			<span className="spinner" />
			{text}
		</p>
	)
}
