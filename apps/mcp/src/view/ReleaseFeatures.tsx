import { type ReactElement, useState } from "react"
import { type Host, toFailureText } from "./connectHost.ts"
import type { Menu } from "./UpgradeMenu.tsx"

type Target = Menu["dependencies"][number]["targets"][number]
type Page = Target["releaseFeatures"]

export function ReleaseFeatures({
	host,
	upgradeMenuId,
	target,
}: {
	host: Host
	upgradeMenuId: string
	target: Target
}): ReactElement {
	const [page, setPage] = useState<Page>(target.releaseFeatures)
	const [pageOffset, setPageOffset] = useState(0)
	const [isLoading, setIsLoading] = useState(false)
	const [failure, setFailure] = useState<string>()

	// replace the shown features with another page
	async function loadFeatures(offset: number): Promise<void> {
		setIsLoading(true)
		setFailure(undefined)
		try {
			const input = { upgradeMenuId, dependency: target.dependency, to: target.to, offset }
			setPage(await host.callTool<Page>("get_upgrade_features", input))
			setPageOffset(offset)
		} catch (error) {
			setFailure(`Release notes could not be loaded. ${toFailureText(error)}`)
		}
		setIsLoading(false)
	}
	return (
		<div>
			{/* documented features for the selected version range */}
			<strong>What’s new</strong>
			{page.features.length > 0 ? (
				<ul>
					{page.features.map((feature) => (
						<li key={JSON.stringify([feature.source, feature.text])}>
							{feature.text} <SourceButton host={host} source={feature.source} label="Release notes" />
							{feature.workspaces.length < Object.keys(target.from).length && (
								<small> · {feature.workspaces.join(", ")}</small>
							)}
						</li>
					))}
				</ul>
			) : (
				<p>
					{page.sources.length
						? "No feature entries identified in the available release notes."
						: "Release notes unavailable for this upgrade."}
				</p>
			)}

			{/* navigation for this version's release features */}
			{(pageOffset > 0 || page.nextOffset !== null) && (
				<nav className="button-row" aria-label={`Features for ${target.dependency} ${target.to}`}>
					<button
						type="button"
						className="secondary"
						disabled={isLoading || pageOffset === 0}
						onClick={() => loadFeatures(Math.max(0, pageOffset - page.pageSize))}
					>
						Previous
					</button>
					<span role="status">
						{isLoading
							? "Reading release notes…"
							: `Features ${pageOffset + 1}–${pageOffset + page.features.length} of ${page.total}`}
					</span>
					<button
						type="button"
						className="secondary"
						disabled={isLoading || page.nextOffset === null}
						onClick={() => page.nextOffset !== null && loadFeatures(page.nextOffset)}
					>
						Next
					</button>
				</nav>
			)}
			{failure && <p role="alert">{failure}</p>}

			{/* release sources and coverage */}
			{page.features.length === 0 &&
				page.sources.slice(0, 3).map((source) => (
					<p key={source}>
						<SourceButton host={host} source={source} label={`${source.split("/").at(-1)} release notes`} />
					</p>
				))}
			{page.gaps.length > 0 && page.sources.length > 0 && <p>Release note coverage is incomplete.</p>}
		</div>
	)
}

function SourceButton({ host, source, label }: { host: Host; source: string; label: string }): ReactElement {
	return (
		<button type="button" className="link" onClick={() => host.openLink(source)}>
			{label}
		</button>
	)
}
