import type { DependencyChoice, ReleaseFeaturePage, UpgradeMenuOrder, UpgradeMenuTarget } from "health-code"
import { type ReactElement, useEffect, useRef, useState } from "react"
import { Link } from "./ReportControls.tsx"

export type UpgradeMenuView = {
	choices: DependencyChoice[]
	order: UpgradeMenuOrder
	search: string
	readyOnly: boolean
	available: boolean
	page: number
	pages: number
}

export function UpgradeMenu({
	upgradeMenuId,
	view,
	issue,
	pending,
	onSelect,
}: {
	view: UpgradeMenuView
	issue?: string
	upgradeMenuId: string
	pending: boolean
	onSelect: (target: UpgradeMenuTarget) => void
}): ReactElement {
	const { choices, order, search, readyOnly, available } = view
	function pageUrl(page: number): string {
		const query = new URLSearchParams({ page: String(page), order, search })
		if (readyOnly) {
			query.set("ready", "on")
		}
		return `/r/${upgradeMenuId}?${query}`
	}
	return (
		<section>
			{issue && <p role="status">{issue}</p>}

			{/* dependency filters */}
			<form method="get" className="upgrade-menu-filters">
				<label>
					Search dependencies <input type="search" name="search" defaultValue={search} maxLength={256} />
				</label>
				<label>
					Sort by{" "}
					<select name="order" defaultValue={order}>
						<option value="minor">Minor upgrades first</option>
						<option value="alphabetical">Alphabetical</option>
						<option value="workspaces">Most workspaces first</option>
					</select>
				</label>
				<label>
					<input type="checkbox" name="ready" defaultChecked={readyOnly} /> Patch ready
				</label>

				<button type="submit" className="secondary">
					Filter
				</button>
			</form>

			{/* one choice per dependency with each available target version */}
			{choices.map((group) => (
				<DependencyVersions
					key={group.dependency}
					group={group}
					upgradeMenuId={upgradeMenuId}
					pending={pending}
					onSelect={onSelect}
				/>
			))}
			{choices.length === 0 && (available || !issue) && (
				<p role="status">{available ? "No upgrades match these filters." : "No eligible upgrades were found."}</p>
			)}
			{view.pages > 1 && (
				<nav className="buttons" aria-label="Dependency pages">
					{view.page > 1 && <Link href={pageUrl(view.page - 1)}>Previous dependencies</Link>}
					<span>
						Page {view.page} of {view.pages}
					</span>
					{view.page < view.pages && <Link href={pageUrl(view.page + 1)}>Next dependencies</Link>}
				</nav>
			)}
		</section>
	)
}

function DependencyVersions({
	group,
	upgradeMenuId,
	pending,
	onSelect,
}: {
	group: DependencyChoice
	upgradeMenuId: string
	pending: boolean
	onSelect: (target: UpgradeMenuTarget) => void
}): ReactElement {
	return (
		<article>
			<h2>{group.dependency}</h2>
			<p>
				{group.workspaces} {group.workspaces === 1 ? "workspace" : "workspaces"}
			</p>
			<ul>
				{group.targets.map((target) => (
					<li key={target.to}>
						{[...new Set(Object.values(target.from))].join(", ")} → {target.to} · {target.kind}{" "}
						{target.patch ? (
							<Link href={`/r/${target.patch.inspectionId}#patch-${target.patch.sha256}`}>View tested patch</Link>
						) : (
							<button type="button" disabled={pending} onClick={() => onSelect(target)}>
								Get upgrade
							</button>
						)}
						<ReleaseFeatures upgradeMenuId={upgradeMenuId} target={target} />
					</li>
				))}
			</ul>
		</article>
	)
}

function ReleaseFeatures({
	upgradeMenuId,
	target,
}: {
	upgradeMenuId: string
	target: UpgradeMenuTarget
}): ReactElement {
	const [preview, setPreview] = useState<ReleaseFeaturePage>()
	const [error, setError] = useState(false)
	const [loadedOffset, setLoadedOffset] = useState(0)
	const pageStatus = useRef<HTMLSpanElement>(null)
	const previous = useRef<HTMLButtonElement>(null)
	const next = useRef<HTMLButtonElement>(null)
	const [attempt, setAttempt] = useState(0)
	const [offset, setOffset] = useState(0)
	useEffect(() => {
		const controller = new AbortController()
		const parameters = new URLSearchParams({ dependency: target.dependency, to: target.to, offset: String(offset) })
		const cache = attempt ? "reload" : "default"
		let timer: ReturnType<typeof setTimeout> | undefined
		let retries = 0
		function start(): void {
			void load().catch(() => {
				if (!controller.signal.aborted) {
					setError(true)
				}
			})
		}

		async function load(): Promise<void> {
			setError(false)
			const response = await fetch(`/api/inspections/${upgradeMenuId}/features?${parameters}`, {
				signal: controller.signal,
				cache,
			})
			controller.signal.throwIfAborted()

			// Back off briefly when another visitor is using the available release lookups.
			if (response.status === 503 && retries < 2) {
				timer = setTimeout(start, 1000 * 2 ** retries)
				retries++
				return
			}
			if (!response.ok) {
				throw new Error("Release request failed")
			}
			const result: ReleaseFeaturePage = await response.json()
			controller.signal.throwIfAborted()
			setPreview(result)
			setLoadedOffset(offset)
		}

		// Cancel obsolete requests when navigating away from this upgrade menu.
		start()
		return () => {
			clearTimeout(timer)
			controller.abort()
		}
	}, [upgradeMenuId, target.dependency, target.to, attempt, offset])

	// Keep keyboard focus in the pager when the selected action reaches the last page.
	useEffect(() => {
		const atStart = loadedOffset === 0 && document.activeElement === previous.current
		const atEnd = preview?.nextOffset === null && document.activeElement === next.current
		if (atStart || atEnd) {
			pageStatus.current?.focus()
		}
	}, [loadedOffset, preview])

	const message = error ? (
		<p role="status">
			Release notes could not be loaded.{" "}
			<button type="button" onClick={() => setAttempt(attempt + 1)}>
				Retry
			</button>
		</p>
	) : null
	if (!preview) {
		return message ?? <p role="status">Reading release notes…</p>
	}

	return (
		<div>
			{message}
			{/* documented features for the selected version range */}
			<strong>What’s new</strong>
			{preview.features.length > 0 ? (
				<ul>
					{preview.features.map((feature) => (
						<li key={JSON.stringify([feature.source, feature.text])}>
							{feature.text} <Link href={feature.source}>Release notes</Link>
							{feature.workspaces.length < Object.keys(target.from).length && (
								<small> · {feature.workspaces.join(", ")}</small>
							)}
						</li>
					))}
				</ul>
			) : (
				<p>
					{preview.sources.length
						? "No feature entries identified in the available release notes."
						: "Release notes unavailable for this upgrade."}
				</p>
			)}

			{/* navigation for this version's release features */}
			{(loadedOffset > 0 || preview.nextOffset !== null) && (
				<nav className="buttons" aria-label={`Features for ${target.dependency} ${target.to}`}>
					<button
						type="button"
						className="secondary"
						ref={previous}
						aria-disabled={loadedOffset === 0 || (offset !== loadedOffset && !error)}
						onClick={() => {
							const destination = Math.max(0, loadedOffset - preview.pageSize)
							if (error && destination === offset) {
								setAttempt((previousAttempt) => previousAttempt + 1)
							} else if (offset === loadedOffset || error) {
								setOffset(destination)
							}
						}}
					>
						Previous
					</button>
					<span ref={pageStatus} tabIndex={-1} role="status">
						{offset !== loadedOffset && !error
							? "Reading release notes…"
							: `Features ${loadedOffset + 1}–${loadedOffset + preview.features.length} of ${preview.total}`}
					</span>
					<button
						type="button"
						className="secondary"
						ref={next}
						aria-disabled={preview.nextOffset === null || offset !== loadedOffset}
						onClick={() => {
							if (offset === loadedOffset && preview.nextOffset !== null) {
								setOffset(preview.nextOffset)
							}
						}}
					>
						Next
					</button>
				</nav>
			)}

			{/* release sources and coverage */}
			{!preview.features.length &&
				preview.sources.slice(0, 3).map((source) => (
					<p key={source}>
						<Link href={source}>{source.split("/").at(-1)} release notes</Link>
					</p>
				))}
			{preview.gaps.length > 0 && preview.sources.length > 0 && <p>Release note coverage is incomplete.</p>}
		</div>
	)
}
