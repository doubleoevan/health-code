import { type ReactElement, useEffect, useState } from "react"
import {
	continuousIntegrationSetupUrl,
	readmeUrl,
	runtaSignupUrl,
	type SiteEvent,
	type Snapshot,
	toVersionChange,
} from "../report.ts"
import { Home, type HomeProps } from "./Home.tsx"
import { InspectionDetails } from "./InspectionDetails.tsx"
import { TroubleshootingPrompt } from "./PromptBox.tsx"
import { Copy, Link, UpgradeMenuLink } from "./ReportControls.tsx"
import { ReportView } from "./ReportView.tsx"
import { StopInspection } from "./StopInspection.tsx"
import { Timeline } from "./Timeline.tsx"

export type PageProps = HomeProps & {
	snapshot: Snapshot | null
	url: string
	demoCallsLeft?: number
}

// describe the inspection state. package names omit the scope sign
function toInspectionHeading(snapshot: Snapshot, live: boolean): string {
	if (live) {
		if (snapshot.selectedDependencyUpgrade) {
			return `Trying ${snapshot.selectedDependencyUpgrade.dependency.replace(/^@/, "")} upgrade...`
		}
		return snapshot.mode === "listUpgrades" ? "Finding upgrades..." : "Inspecting repository..."
	}
	if (snapshot.state === "stopped") {
		return "Inspection stopped"
	}
	if (snapshot.isUpgradeMenuBuild) {
		return "Couldn’t list upgrades"
	}
	return snapshot.state === "interrupted" ? "Inspection interrupted" : "Inspection failed"
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

		// return to the upgrade menu after a stop, or load the final report
		stream.addEventListener("terminal", (message) => {
			stream.close()
			if (message.data === "stopped" && snapshot.upgradeMenuId) {
				window.location.assign(`/r/${snapshot.upgradeMenuId}`)
			} else {
				window.location.reload()
			}
		})
		return () => stream.close()
	}, [live, snapshot.id, snapshot.events, snapshot.upgradeMenuId])

	// show the queue position only while the inspection waits
	const isWaiting = live && !events.length && !snapshot.isUpgradeMenuBuild
	const queueStatus = position ? `Queue position: ${position}` : "Queued for inspection"
	const status = snapshot.message ?? (isWaiting ? queueStatus : null)
	const finished = events.findLast((event) => event.type === "inspection.finished")
	const isShimmering = live && (snapshot.selectedDependencyUpgrade || snapshot.mode === "listUpgrades")
	return (
		<>
			{/* published report or live inspection status */}
			{snapshot.card ? (
				<ReportView
					report={snapshot.card}
					url={url}
					durationMs={finished?.durationMs}
					upgradeMenuId={snapshot.upgradeMenuId}
					investigationPrompt={snapshot.investigationPrompt}
				/>
			) : (
				<header className="inspection-heading">
					{/* link back after the inspection ends, and inspection title */}
					{!live && <UpgradeMenuLink id={snapshot.upgradeMenuId} repositoryUrl={snapshot.repositoryUrl} />}
					<h1 className={isShimmering ? "shimmer" : undefined}>{toInspectionHeading(snapshot, live)}</h1>

					{/* repository and stop control */}
					<div className="repository-row">
						<p className="mono">
							<Link href={snapshot.repositoryUrl}>{snapshot.repositoryUrl}</Link>
							{snapshot.selectedDependencyUpgrade && (
								<>
									{" · "}
									<span>{`${snapshot.selectedDependencyUpgrade.dependency} ${toVersionChange(snapshot.selectedDependencyUpgrade)}`}</span>
								</>
							)}
						</p>
						<StopInspection id={snapshot.id} canStop={snapshot.canStop} />
					</div>

					{/* queue status and troubleshooting prompt */}
					{status && <p role="status">{status}</p>}
					{snapshot.investigationPrompt && <TroubleshootingPrompt text={snapshot.investigationPrompt} />}
				</header>
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
		return <Home siteMode={props.siteMode} upgradeMenu={props.upgradeMenu} />
	}
	return snapshot ? (
		<>
			<Inspection snapshot={snapshot} url={props.url} />

			{/* supporting inspection details */}
			{snapshot.card && <InspectionDetails report={snapshot.card} />}
		</>
	) : (
		<Home siteMode={props.siteMode} paused={props.paused} />
	)
}
function HeaderLink({ href, children }: { href: string; children: string }): ReactElement {
	return (
		<Link href={href}>
			{children}
			<svg
				width="10"
				height="10"
				viewBox="0 0 10 10"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.5"
				aria-hidden="true"
			>
				<path d="M1 9 9 1M2.5 1H9v6.5" />
			</svg>
		</Link>
	)
}
export function Page(props: PageProps): ReactElement {
	return (
		<main>
			{/* home link, inspection mode, project links and report link */}
			<div className="mast">
				<Link href="/">
					<svg width="40" height="40" viewBox="0 0 96 96" aria-hidden="true">
						<path fill="none" stroke="currentColor" strokeWidth="5.3" d="m28 31-17 17 17 17m40-34 17 17-17 17" />
						<path
							className="logo-cross"
							d="M43 29h10q1 0 1 1v12h12q1 0 1 1v10q0 1-1 1H54v12q0 1-1 1H43q-1 0-1-1V54H30q-1 0-1-1V43q0-1 1-1h12V30q0-1 1-1Z"
						/>
					</svg>
					<span>
						<span className="wordmark-accent">Health</span>Code
					</span>
				</Link>
				{props.siteMode === "replay" && <small>Recorded example</small>}
				{props.demoCallsLeft !== undefined && (
					<small>
						{props.demoCallsLeft} demo {props.demoCallsLeft === 1 ? "call" : "calls"} left today
					</small>
				)}
				<nav aria-label="Project">
					<HeaderLink href={runtaSignupUrl}>Runta</HeaderLink>
					<HeaderLink href={continuousIntegrationSetupUrl}>CI</HeaderLink>
					<HeaderLink href={readmeUrl}>GitHub</HeaderLink>
				</nav>
				{props.snapshot?.card && !props.upgradeMenu && <Copy label="Copy report link" text={props.url} />}
			</div>

			{/* repository form or inspection view */}
			<Content {...props} />
		</main>
	)
}
