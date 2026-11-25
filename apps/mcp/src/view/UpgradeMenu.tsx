import { type ChangeEvent, type FormEvent, type ReactElement, useEffect, useRef, useState } from "react"
import type { z } from "zod"
import type { upgradeMenuOutput, upgradeMenuQuery } from "../browseUpgrades.ts"
import { CurrentStep } from "./CurrentStep.tsx"
import { callQuickTool, type Host, toFailureText, UndeliveredError } from "./connectHost.ts"
import { toRepositoryName, toVersionChange } from "./labels.ts"
import { ReleaseFeatures } from "./ReleaseFeatures.tsx"

export type Menu = z.infer<typeof upgradeMenuOutput>
type Target = Menu["dependencies"][number]["targets"][number]
type Query = Pick<z.infer<typeof upgradeMenuQuery>, "order" | "search" | "readyOnly">
type StartProgress = { key: string } & ({ kind: "starting" | "sent" } | { kind: "failed"; text: string })
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
	const [startProgress, setStartProgress] = useState<StartProgress>()
	async function handleTest(target: Target): Promise<void> {
		const key = toTargetKey(target)
		setIsPending(true)
		setStartProgress({ key, kind: "starting" })

		// ask the coding agent first. a client accepts one request for each press
		const request = toTryRequest(menu.upgradeMenuId, target)
		const isSent =
			request !== undefined &&
			host.canMessage() &&
			(await host.sendMessage(request).then(
				() => true,
				() => false,
			))
		setStartProgress(isSent ? { key, kind: "sent" } : await startInspection(target, request))
		setIsPending(false)
	}

	// start the inspection from the page and follow it here
	async function startInspection(target: Target, request?: string): Promise<StartProgress | undefined> {
		const key = toTargetKey(target)
		try {
			const selection = { upgradeMenuId: menu.upgradeMenuId, dependency: target.dependency, to: target.to }
			const input = { repositoryUrl: menu.repository.url, selection }
			const { inspectionId } = await callQuickTool<{ inspectionId: string }>(host, "start_inspection", input)
			setStartedIds((earlier) => ({ ...earlier, [key]: inspectionId }))
			onInspect(inspectionId)
			return undefined
		} catch (error) {
			const isDropped = error instanceof UndeliveredError && request
			return { key, kind: "failed", text: isDropped ? `Tell your coding agent · ${request}` : toFailureText(error) }
		}
	}

	// show every upgrade again as soon as the search is cleared
	function handleSearchChange(event: ChangeEvent<HTMLInputElement>): void {
		if (event.currentTarget.value === "") {
			event.currentTarget.form?.requestSubmit()
		}
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
			{/* repository and inspected commit */}
			<header>
				<h1>Try an upgrade</h1>
				<p className="digest">
					<button type="button" className="link" onClick={() => host.openLink(menu.repository.url)}>
						{toRepositoryName(menu.repository.url)}
					</button>{" "}
					· {menu.repository.commit.slice(0, 8)}
				</p>
			</header>

			{/* dependency filters */}
			<form className="filters" onSubmit={handleSubmit}>
				<label>
					Search dependencies{" "}
					<input
						type="search"
						name="search"
						defaultValue={query.search}
						maxLength={256}
						onChange={handleSearchChange}
					/>
				</label>
				<label>
					Sort by{" "}
					<span className="sort-select">
						<select
							name="order"
							defaultValue={query.order}
							onChange={(event) => event.currentTarget.form?.requestSubmit()}
						>
							<option value="workspaces">Most workspaces first</option>
							<option value="minor">Minor upgrades first</option>
							<option value="alphabetical">Alphabetical</option>
						</select>
					</span>
				</label>
				<button type="submit" className="secondary" disabled={isPending}>
					Search
				</button>
				{menu.hasTestedPatch && (
					<label>
						<input
							type="checkbox"
							name="ready"
							defaultChecked={query.readyOnly}
							onChange={(event) => event.currentTarget.form?.requestSubmit()}
						/>{" "}
						Patch available
					</label>
				)}
			</form>
			{menu.issue && <p role="status">{menu.issue}</p>}
			{failure && <p role="alert">{failure}</p>}

			{/* one choice per dependency with each available target version */}
			{menu.dependencies.map((group, index) => (
				<article key={group.dependency}>
					<div className="dependency-heading">
						<span>{`${firstDependencyNumber + index}.`}</span>
						<h2>{group.dependency}</h2>
						<p>
							{group.workspaces} {group.workspaces === 1 ? "workspace" : "workspaces"}
						</p>
					</div>
					<ul>
						{group.targets.map((target) => (
							<TargetVersion
								key={target.to}
								host={host}
								upgradeMenuId={menu.upgradeMenuId}
								target={target}
								startedId={startedIds[toTargetKey(target)]}
								isPending={isPending}
								progress={startProgress?.key === toTargetKey(target) ? startProgress : undefined}
								onInspect={onInspect}
								onTest={handleTest}
							/>
						))}
					</ul>
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
		order: order === "minor" || order === "alphabetical" ? order : "workspaces",
		search: typeof search === "string" ? search : "",
		readyOnly: readyOnly === true,
	}
}

function toTargetKey({ dependency, to }: Target): string {
	return `${dependency} ${to}`
}

function TargetVersion({
	host,
	upgradeMenuId,
	target,
	startedId,
	isPending,
	progress,
	onInspect,
	onTest,
}: MenuActions & {
	upgradeMenuId: string
	target: Target
	startedId?: string
	isPending: boolean
	progress?: StartProgress
	onTest: (target: Target) => void
}): ReactElement {
	const { patch } = target
	return (
		<li>
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

			{/* answer to the last click on this version */}
			{progress?.kind === "starting" && <CurrentStep text="Starting inspection…" />}
			{progress?.kind === "sent" && <p role="status">Sent to your coding agent. The inspection starts in the chat.</p>}
			{progress?.kind === "failed" && <p role="alert">{progress.text}</p>}

			{/* release features for this version */}
			<ReleaseFeatures host={host} upgradeMenuId={upgradeMenuId} target={target} />
		</li>
	)
}

// name the upgrade only by values with a checked format
function toTryRequest(upgradeMenuId: string, { dependency, to }: Target): string | undefined {
	const isPackageName = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/i.test(dependency)
	const isVersion = /^\d+\.\d+\.\d+(?:[-+][0-9a-z.+-]+)?$/i.test(to)
	return isPackageName && isVersion
		? `Try the ${dependency} upgrade to ${to}. Call the Health Code get_upgrade tool with upgradeMenuId ${upgradeMenuId}, dependency ${dependency} and to ${to}.`
		: undefined
}
