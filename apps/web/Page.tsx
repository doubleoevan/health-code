import type { UpgradeMenuTarget } from "health-code"
import { type FormEvent, type ReactElement, useCallback, useEffect, useState } from "react"
import { Challenge } from "./Challenge.tsx"
import { Link } from "./ReportControls.tsx"
import { ReportView } from "./ReportView.tsx"
import { mcpSetupUrl, replayRepositoryUrl, type SiteEvent, type Snapshot } from "./report.ts"
import { Timeline } from "./Timeline.tsx"
import { UpgradeMenu, type UpgradeMenuView } from "./UpgradeMenu.tsx"

export type PageProps = {
	upgradeMenu?: { id: string; view: UpgradeMenuView; repositoryUrl: string; commit: string; issue?: string }
	paused?: boolean
	snapshot: Snapshot | null
	url: string
	replay: boolean
}
function Home({
	replay,
	paused,
	upgradeMenu,
}: {
	replay: boolean
	paused?: boolean
	upgradeMenu?: PageProps["upgradeMenu"]
}): ReactElement {
	const [error, setError] = useState("")
	const [verification, setVerification] = useState<{
		siteKey: string
		repositoryUrl: string
		target?: UpgradeMenuTarget
	} | null>(null)
	const [pending, setPending] = useState(false)
	const [offerMcp, setOfferMcp] = useState(false)
	const submit = useSubmit(upgradeMenu?.id, { setPending, setError, setOfferMcp, setVerification })
	const verified = useCallback(
		(token: string): void => {
			if (verification) {
				setVerification(null)
				void submit(verification.repositoryUrl, verification.target, token)
			}
		},
		[submit, verification],
	)
	const retry = useCallback((): void => {
		setVerification(null)
		setPending(false)
		setOfferMcp(true)
		setError("Verification could not finish. Retry the inspection or use the MCP.")
	}, [])
	function handleSubmit(event: FormEvent<HTMLFormElement>): void {
		event.preventDefault()
		void submit(String(new FormData(event.currentTarget).get("repositoryUrl")))
	}
	return (
		<section className="home">
			{/* inspection overview */}
			{upgradeMenu ? (
				<>
					<h1>Choose a dependency upgrade</h1>
					<p>
						{upgradeMenu.repositoryUrl.slice(19)} · {upgradeMenu.commit.slice(0, 8)}
					</p>
					<UpgradeMenu
						view={upgradeMenu.view}
						issue={upgradeMenu.issue}
						upgradeMenuId={upgradeMenu.id}
						pending={pending}
						onSelect={(target) => void submit(upgradeMenu.repositoryUrl, target)}
					/>
				</>
			) : (
				<>
					<h1>
						Inspect your
						<br />
						dependency upgrades.
					</h1>
					<p className="intro">
						AI agents try your dependency upgrades inside a Runta sandbox. The network is locked, real keys stay
						outside, and successful attempts return tested patches.
					</p>

					{/* discovery admission */}
					<p>
						Find available upgrades, then choose one to test. A fresh lookup and a fresh test each use one hosted
						inspection.
					</p>

					{/* public repository submission */}
					{paused && (
						<p role="status">
							The hosted budget is reserved or temporarily unavailable. The daily allowance resets at 00:00 UTC. Cached
							reports remain available. <Link href={mcpSetupUrl}>Use the MCP with your Runta account</Link>.
						</p>
					)}
					<form onSubmit={handleSubmit}>
						<label htmlFor="repository">Public GitHub repository</label>
						<div className="field">
							<input
								id="repository"
								name="repositoryUrl"
								type="url"
								required
								maxLength={200}
								autoComplete="off"
								spellCheck={false}
								placeholder="https://github.com/owner/repository"
								readOnly={pending}
								onChange={() => {
									setVerification(null)
									setError("")
									setOfferMcp(false)
								}}
								defaultValue={replay ? replayRepositoryUrl : ""}
							/>
							<button type="submit" disabled={pending}>
								{pending ? "Finding upgrades…" : "Find upgrades"}
							</button>
						</div>
					</form>
				</>
			)}
			{verification && <Challenge siteKey={verification.siteKey} onToken={verified} onFailure={retry} />}

			{/* submission error */}
			{error && (
				<p role="alert">
					{error} {offerMcp && <Link href={mcpSetupUrl}>MCP setup</Link>}
				</p>
			)}
		</section>
	)
}
type Verification = { siteKey: string; repositoryUrl: string; target?: UpgradeMenuTarget }
function useSubmit(
	upgradeMenuId: string | undefined,
	{
		setPending,
		setError,
		setOfferMcp,
		setVerification,
	}: {
		setPending: (pending: boolean) => void
		setError: (message: string) => void
		setOfferMcp: (offer: boolean) => void
		setVerification: (input: Verification) => void
	},
): (repositoryUrl: string, target?: UpgradeMenuTarget, challenge?: string) => Promise<void> {
	return useCallback(
		async (repositoryUrl: string, target?: UpgradeMenuTarget, challenge?: string): Promise<void> => {
			setPending(true)
			setError("")
			setOfferMcp(false)
			try {
				const response = await fetch("/api/inspections", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						repositoryUrl,
						challenge,
						action: target ? "select" : "discover",
						upgradeMenuId,
						dependency: target?.dependency,
						to: target?.to,
					}),
				})
				const body = await response.json()
				if (!response.ok) {
					// Verify only a new submission and resume the same repository after success.
					if (!challenge && body.siteKey) {
						setVerification({ siteKey: body.siteKey, repositoryUrl, target })
						return
					}
					setOfferMcp(Boolean(body.mcpSetupUrl || challenge))
					throw new Error(body.message ?? "Could not start the inspection.")
				}
				window.location.assign(`/r/${body.id}`)
			} catch (failure) {
				setError(failure instanceof Error ? failure.message : "Could not start the inspection.")
				setPending(false)
			}
		},
		[upgradeMenuId, setPending, setError, setOfferMcp, setVerification],
	)
}
function Inspection({ snapshot, url }: { snapshot: Snapshot; url: string }): ReactElement {
	const [position, setPosition] = useState(snapshot.position)
	useEffect(() => {
		if (snapshot.card && !snapshot.card.upgradeMenu) {
			void fetch(`/api/inspections/${snapshot.id}/view`, { method: "POST" }).catch(() => {})
		}
	}, [snapshot.id, snapshot.card])
	const [events, setEvents] = useState(snapshot.events)
	const [disconnected, setDisconnected] = useState(false)
	const live = snapshot.state === "running" || snapshot.state === "queued"
	useEffect(() => {
		if (!live) {
			return
		}

		// resume after the last event in the server snapshot
		const after = snapshot.events.at(-1)?.sequence ?? 0
		const stream = new EventSource(`/api/inspections/${snapshot.id}/events?after=${after}`)
		stream.addEventListener("position", (event) => setPosition(JSON.parse(event.data)))
		stream.onopen = () => setDisconnected(false)
		stream.onerror = () => setDisconnected(true)

		// append only events newer than the displayed sequence
		stream.addEventListener("inspection", (message) => {
			const event: SiteEvent = JSON.parse(message.data)
			setEvents((previous) => (event.sequence > (previous.at(-1)?.sequence ?? 0) ? [...previous, event] : previous))
		})

		// load the final report when the stream ends
		stream.addEventListener("terminal", () => {
			stream.close()
			window.location.reload()
		})
		return () => stream.close()
	}, [live, snapshot.id, snapshot.events])
	return (
		<>
			{/* published report or live inspection status */}
			{snapshot.card ? (
				<ReportView report={snapshot.card} url={url} />
			) : (
				<>
					<h1>
						{live
							? "Inspecting repository"
							: snapshot.state === "interrupted"
								? "Inspection interrupted"
								: "Inspection failed"}
					</h1>
					<p className="mono">{snapshot.repositoryUrl}</p>
					<p role="status">
						{snapshot.message ??
							(position
								? `Queue position: ${position}`
								: events.length === 0
									? "Queued for inspection"
									: "Inspection in progress")}
					</p>
				</>
			)}

			{/* connection status and event timeline */}
			{disconnected && <p role="status">Reconnecting to the inspection…</p>}
			<Timeline id={snapshot.id} events={events} live={live} />
		</>
	)
}
function Content(props: PageProps): ReactElement {
	const { snapshot } = props
	if (props.upgradeMenu) {
		return <Home replay={props.replay} upgradeMenu={props.upgradeMenu} />
	}
	return snapshot ? (
		<Inspection snapshot={snapshot} url={props.url} />
	) : (
		<Home replay={props.replay} paused={props.paused} />
	)
}
export function Page(props: PageProps): ReactElement {
	const { replay } = props
	return (
		<main>
			{/* home link and replay indicator */}
			<div className="mast">
				<Link href="/">
					<span className="mark" aria-hidden="true">
						✳
					</span>{" "}
					Health Code
				</Link>
				{replay && <small>Developer replay · example evidence</small>}
			</div>

			{/* repository form or inspection view */}
			<Content {...props} />
		</main>
	)
}
