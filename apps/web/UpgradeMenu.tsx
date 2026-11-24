import type { DependencyChoice, ReleaseFeaturePage, UpgradeMenuOrder, UpgradeMenuTarget } from "health-code"
import { type ChangeEvent, type ReactElement, useEffect, useRef, useState } from "react"
import { Link } from "./ReportControls.tsx"
import { toVersionChange } from "./report.ts"

export type UpgradeMenuView = {
	dependenciesOnPage: DependencyChoice[]
	order: UpgradeMenuOrder
	search: string
	hasTestedPatch: boolean
	readyOnly: boolean
	available: boolean
	page: number
	totalDependencies: number
	firstDependencyNumber: number
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
	const { dependenciesOnPage, order, search, hasTestedPatch, readyOnly, available } = view

	// Apply sort and patch availability as soon as either control changes.
	function handleFilterChange(event: ChangeEvent<HTMLInputElement | HTMLSelectElement>): void {
		event.currentTarget.form?.requestSubmit()
	}
	return (
		<section>
			{/* dependency filters */}
			<form method="get" className="upgrade-menu-filters">
				<label>
					Search dependencies <input type="search" name="search" defaultValue={search} maxLength={256} />
				</label>
				<label>
					Sort by{" "}
					<span className="sort-select">
						<select name="order" defaultValue={order} onChange={handleFilterChange}>
							<option value="workspaces">Most workspaces first</option>
							<option value="minor">Minor upgrades first</option>
							<option value="alphabetical">Alphabetical</option>
						</select>
					</span>
				</label>
				<button type="submit" className="secondary">
					Search
				</button>
				{hasTestedPatch && (
					<label>
						<input type="checkbox" name="ready" defaultChecked={readyOnly} onChange={handleFilterChange} /> Tested patch
						available
					</label>
				)}
			</form>
			{issue && (
				<p className="upgrade-menu-warning" role="status">
					{issue}
				</p>
			)}

			{/* one choice per dependency with each available target version */}
			{dependenciesOnPage.map((group, index) => (
				<DependencyVersions
					key={group.dependency}
					group={group}
					dependencyNumber={view.firstDependencyNumber + index}
					upgradeMenuId={upgradeMenuId}
					pending={pending}
					onSelect={onSelect}
				/>
			))}
			{dependenciesOnPage.length === 0 && (available || !issue) && (
				<p role="status">{available ? "No upgrades match these filters." : "No eligible upgrades were found."}</p>
			)}

			{/* dependency pagination */}
			{view.totalDependencies > 0 && (
				<nav aria-label="Dependency pages">
					<form method="get" className="pager">
						<input type="hidden" name="search" value={search} />
						<input type="hidden" name="order" value={order} />
						{readyOnly && <input type="hidden" name="ready" value="on" />}
						<button className="secondary" type="submit" name="page" value={view.page - 1} disabled={view.page === 1}>
							Previous
						</button>
						<span>{`Dependencies ${view.firstDependencyNumber}–${view.firstDependencyNumber + dependenciesOnPage.length - 1} of ${view.totalDependencies}`}</span>
						<button
							className="secondary"
							type="submit"
							name="page"
							value={view.page + 1}
							disabled={view.page === view.pages}
						>
							Next
						</button>
					</form>
				</nav>
			)}
		</section>
	)
}

function DependencyVersions({
	group,
	dependencyNumber,
	upgradeMenuId,
	pending,
	onSelect,
}: {
	group: DependencyChoice
	dependencyNumber: number
	upgradeMenuId: string
	pending: boolean
	onSelect: (target: UpgradeMenuTarget) => void
}): ReactElement {
	return (
		<article>
			{/* dependency number, name and workspace count */}
			<div className="dependency-heading">
				<span>{`${dependencyNumber}.`}</span>
				<h2>{group.dependency}</h2>
				<p>
					{group.workspaces} {group.workspaces === 1 ? "workspace" : "workspaces"}
				</p>
			</div>

			{/* available target versions */}
			<ul>
				{group.targets.map((target) => (
					<li key={target.to}>
						{/* version change and its upgrade action */}
						<div className="button-row">
							<span>
								<code>{toVersionChange(target)}</code> · {target.kind}
							</span>
							{target.patch ? (
								<span className="button-link">
									<Link href={`/r/${target.patch.inspectionId}#patch-${target.patch.sha256}`}>View tested patch</Link>
								</span>
							) : (
								<button type="button" disabled={pending} onClick={() => onSelect(target)}>
									Try upgrade
								</button>
							)}
						</div>

						{/* release features for this version */}
						<ReleaseFeatures upgradeMenuId={upgradeMenuId} target={target} />
					</li>
				))}
			</ul>
		</article>
	)
}

// Give other visitors room in the server's eight concurrent release lookups.
const releaseLookups = Array.from({ length: 4 }, () => Promise.resolve())

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
			const available = releaseLookups.shift()!
			releaseLookups.push(
				available.then(load).catch(() => {
					if (!controller.signal.aborted) {
						setError(true)
					}
				}),
			)
		}

		async function load(): Promise<void> {
			controller.signal.throwIfAborted()
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
		<p className="button-row" role="status">
			<span>Release notes could not be loaded.</span>
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
				<nav className="pager" aria-label={`Features for ${target.dependency} ${target.to}`}>
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
