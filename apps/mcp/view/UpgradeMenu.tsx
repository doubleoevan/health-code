import { type FormEvent, type ReactElement, useEffect, useRef, useState } from "react"
import type { z } from "zod"
import type { featureOutput, upgradeMenuOutput, upgradeMenuQuery } from "../browseUpgrades.ts"
import { type Host, toFailureText } from "./connectHost.ts"
import { toRepositoryName, toVersionChange } from "./labels.ts"

export type Menu = z.infer<typeof upgradeMenuOutput>
type Target = Menu["dependencies"][number]["targets"][number]
type Query = Pick<z.infer<typeof upgradeMenuQuery>, "order" | "search" | "readyOnly">
type MenuActions = { host: Host; onInspect: (inspectionId: string) => void }

export function UpgradeMenu({
	host,
	firstPage,
	input,
	isHidden,
	onInspect,
}: MenuActions & { firstPage: Menu; input: Record<string, unknown>; isHidden: boolean }): ReactElement {
	const [menu, setMenu] = useState(firstPage)
	const [query, setQuery] = useState(() => toQuery(input))
	const [offsets, setOffsets] = useState(() => (input.offset ? [0, Number(input.offset)] : [0]))
	const [isPending, setIsPending] = useState(false)
	const [failure, setFailure] = useState<string>()

	// ignore a page that a later request replaced
	const lastRequest = useRef(0)
	async function loadPage(nextQuery: Query, nextOffsets: number[]): Promise<void> {
		const request = ++lastRequest.current
		setIsPending(true)
		setFailure(undefined)
		try {
			const input = { ...nextQuery, upgradeMenuId: menu.upgradeMenuId, offset: nextOffsets.at(-1) ?? 0 }
			const nextMenu = await host.callTool<Menu>("list_upgrades", input)
			if (request !== lastRequest.current) {
				return
			}
			setMenu(nextMenu)
			setQuery(nextQuery)
			setOffsets(nextOffsets)
		} catch (error) {
			if (request === lastRequest.current) {
				setFailure(toFailureText(error))
			}
		}

		// keep the controls disabled for a later request
		if (request === lastRequest.current) {
			setIsPending(false)
		}
	}

	// reload the page when the reader returns
	const wasHidden = useRef(false)
	// biome-ignore lint/correctness/useExhaustiveDependencies: Only a return to this screen reloads the releaseFeaturePage.
	useEffect(() => {
		if (wasHidden.current && !isHidden) {
			void loadPage(query, offsets)
		}
		wasHidden.current = isHidden
	}, [isHidden])

	// reopen an inspection started from this menu
	const [startedIds, setStartedIds] = useState<Record<string, string>>({})
	async function handleTest({ dependency, to }: Target): Promise<void> {
		setIsPending(true)
		setFailure(undefined)
		try {
			const selection = { upgradeMenuId: menu.upgradeMenuId, dependency, to }
			const input = { repositoryUrl: menu.repository.url, selection }
			const { inspectionId } = await host.callTool<{ inspectionId: string }>("start_inspection", input)
			setStartedIds((earlier) => ({ ...earlier, [`${dependency} ${to}`]: inspectionId }))
			onInspect(inspectionId)
		} catch (error) {
			setFailure(toFailureText(error))
		}
		setIsPending(false)
	}

	function handleSubmit(event: FormEvent<HTMLFormElement>): void {
		event.preventDefault()
		const form = new FormData(event.currentTarget)
		const order = form.get("order") as Query["order"]
		void loadPage({ order, search: String(form.get("search")), readyOnly: form.has("ready") }, [0])
	}

	// number dependencies across pages
	const firstDependencyNumber = (offsets.at(-1) ?? 0) + 1
	const lastDependencyNumber = firstDependencyNumber + menu.dependencies.length - 1
	return (
		<section>
			<h1>{toRepositoryName(menu.repository.url)}</h1>
			<p className="muted">{"The health inspector tests each upgrade with your Runta account and model key."}</p>

			{/* dependency filters */}
			<form className="filters" onSubmit={handleSubmit}>
				<label>
					Search dependencies <input type="search" name="search" defaultValue={query.search} maxLength={256} />
				</label>
				<label>
					Sort by{" "}
					<select
						name="order"
						defaultValue={query.order}
						onChange={(event) => event.currentTarget.form?.requestSubmit()}
					>
						<option value="minor">Minor upgrades first</option>
						<option value="workspaces">Most workspaces first</option>
						<option value="alphabetical">Alphabetical</option>
					</select>
				</label>
				<label>
					<input
						type="checkbox"
						name="ready"
						defaultChecked={query.readyOnly}
						onChange={(event) => event.currentTarget.form?.requestSubmit()}
					/>{" "}
					Patch available
				</label>
				<button type="submit" className="secondary" disabled={isPending}>
					Search
				</button>
			</form>
			{menu.issue && <p role="status">{menu.issue}</p>}
			{failure && <p role="alert">{failure}</p>}

			{/* one choice per dependency with each available target version */}
			{menu.dependencies.map((group, index) => (
				<article key={group.dependency}>
					<div className="dependency-heading">
						<span>{`${firstDependencyNumber + index}.`}</span>
						<h2>{group.dependency}</h2>
					</div>
					{group.targets.map((target) => (
						<TargetVersion
							key={target.to}
							host={host}
							upgradeMenuId={menu.upgradeMenuId}
							target={target}
							startedId={startedIds[`${target.dependency} ${target.to}`]}
							isPending={isPending}
							onInspect={onInspect}
							onTest={handleTest}
						/>
					))}
				</article>
			))}
			{menu.dependencies.length === 0 && <p role="status">No upgrades match these filters.</p>}

			{/* dependency pages */}
			{(menu.dependencies.length > 0 || offsets.length > 1) && (
				<nav className="button-row" aria-label="Dependency pages">
					<button
						type="button"
						className="secondary"
						disabled={isPending || offsets.length === 1}
						onClick={() => loadPage(query, offsets.slice(0, -1))}
					>
						Previous
					</button>
					{menu.dependencies.length > 0 && (
						<span>{`Dependencies ${firstDependencyNumber}–${lastDependencyNumber} of ${menu.totalDependencies}`}</span>
					)}
					<button
						type="button"
						className="secondary"
						disabled={isPending || menu.nextOffset === null}
						onClick={() => menu.nextOffset !== null && loadPage(query, [...offsets, menu.nextOffset])}
					>
						Next
					</button>
				</nav>
			)}
		</section>
	)
}

function toQuery({ order, search, readyOnly }: Record<string, unknown>): Query {
	return {
		order: order === "workspaces" || order === "alphabetical" ? order : "minor",
		search: typeof search === "string" ? search : "",
		readyOnly: readyOnly === true,
	}
}

function TargetVersion({
	host,
	upgradeMenuId,
	target,
	startedId,
	isPending,
	onInspect,
	onTest,
}: MenuActions & {
	upgradeMenuId: string
	target: Target
	startedId?: string
	isPending: boolean
	onTest: (target: Target) => void
}): ReactElement {
	const [releaseFeaturePage, setReleaseFeaturePage] = useState(target.releaseFeatures)
	const [isLoadingMore, setIsLoadingMore] = useState(false)
	const [failure, setFailure] = useState<string>()
	const { patch } = target

	// add the next features below the ones already shown
	async function handleMore(): Promise<void> {
		const input = { upgradeMenuId, dependency: target.dependency, to: target.to, offset: releaseFeaturePage.nextOffset }
		setIsLoadingMore(true)
		setFailure(undefined)
		try {
			const next = await host.callTool<z.infer<typeof featureOutput>>("get_upgrade_features", input)
			setReleaseFeaturePage({ ...next, features: [...releaseFeaturePage.features, ...next.features] })
		} catch {
			setFailure("Release notes could not be loaded.")
		}
		setIsLoadingMore(false)
	}
	return (
		<div className="target">
			{/* version change and its action */}
			<div className="button-row">
				<span>
					<code>{toVersionChange(target.from, target.to)}</code> · {target.kind}
				</span>
				{patch ? (
					<button type="button" disabled={isPending} onClick={() => onInspect(patch.inspectionId)}>
						See patch
					</button>
				) : (
					<button type="button" disabled={isPending} onClick={() => onTest(target)}>
						Try upgrade
					</button>
				)}
				{startedId && !patch && (
					<button type="button" className="secondary" disabled={isPending} onClick={() => onInspect(startedId)}>
						View inspection
					</button>
				)}
			</div>

			{/* documented release features */}
			{releaseFeaturePage.features.length > 0 && <strong>What’s new</strong>}
			<ul>
				{releaseFeaturePage.features.map((feature) => (
					<li key={JSON.stringify([feature.source, feature.text])}>
						{feature.text}{" "}
						<button type="button" className="link" onClick={() => host.openLink(feature.source)}>
							Release notes
						</button>
					</li>
				))}
			</ul>
			{releaseFeaturePage.features.length === 0 && (
				<p className="muted">
					{releaseFeaturePage.sources.length
						? "No feature entries identified in the available release notes."
						: "Release notes unavailable for this upgrade."}
				</p>
			)}
			{releaseFeaturePage.nextOffset !== null && (
				<button type="button" className="secondary" disabled={isLoadingMore} onClick={handleMore}>
					Show more
				</button>
			)}
			{failure && <p role="alert">{failure}</p>}
		</div>
	)
}
