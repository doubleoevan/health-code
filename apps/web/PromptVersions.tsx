import type { ReactElement } from "react"
import type { PublishedCard } from "./report.ts"

export function PromptVersions({ versions }: { versions: PublishedCard["promptVersions"] }): ReactElement {
	return (
		<details>
			<summary>Prompt versions</summary>
			{versions ? (
				<>
					{versions.model.length === 0 && <p>No model prompts were dispatched.</p>}
					<ul>
						{versions.model.map((ref) => (
							<li key={ref.sha256}>
								{ref.name} v{ref.version} · SHA-256 <code>{ref.sha256}</code>
							</li>
						))}
					</ul>
					{versions.handoff.map((ref) => (
						<p key={ref.sha256}>
							Patch instructions · {ref.name} v{ref.version} · SHA-256 <code>{ref.sha256}</code>
						</p>
					))}
				</>
			) : (
				<p>Prompt versions unavailable for this inspection.</p>
			)}
		</details>
	)
}
