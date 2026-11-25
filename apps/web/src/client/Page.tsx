import type { UpgradeMenuTarget } from "health-code"
import { type FormEvent, type KeyboardEvent, type ReactElement, useCallback, useEffect, useState } from "react"
import {
	continuousIntegrationSetupUrl,
	readmeUrl,
	replayRepositoryUrl,
	runtaSignupUrl,
	type SiteEvent,
	type Snapshot,
	toVersionChange,
} from "../report.ts"
import { Challenge } from "./Challenge.tsx"
import { InspectionDetails } from "./InspectionDetails.tsx"
import { TroubleshootingPrompt } from "./PromptBox.tsx"
import { Copy, Link, UpgradeMenuLink } from "./ReportControls.tsx"
import { ReportView } from "./ReportView.tsx"
import { StopInspection } from "./StopInspection.tsx"
import { Timeline } from "./Timeline.tsx"
import { UpgradeMenu, type UpgradeMenuView } from "./UpgradeMenu.tsx"

export type PageProps = {
	upgradeMenu?: { id: string; view: UpgradeMenuView; repositoryUrl: string; commit: string; issue?: string }
	paused?: boolean
	snapshot: Snapshot | null
	url: string
	siteMode: "local" | "hosted" | "replay"
	demoCallsLeft?: number
}
function handleRepositoryKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
	const input = event.currentTarget

	// Preserve caret navigation and text selection when a repository has been entered.
	if (
		event.key === "ArrowRight" &&
		!input.readOnly &&
		!input.value &&
		!event.shiftKey &&
		!event.altKey &&
		!event.ctrlKey &&
		!event.metaKey
	) {
		event.preventDefault()
		input.value = "https://github.com/"
	}
}

function Home({ siteMode, paused, upgradeMenu }: Pick<PageProps, "siteMode" | "paused" | "upgradeMenu">): ReactElement {
	const replay = siteMode === "replay"
	const [error, setError] = useState("")
	const [verification, setVerification] = useState<{
		siteKey: string
		repositoryUrl: string
		target?: UpgradeMenuTarget
	} | null>(null)
	const [pending, setPending] = useState(false)
	const [shouldOfferContinuousIntegration, setShouldOfferContinuousIntegration] = useState(false)
	const submit = useSubmit(upgradeMenu?.id, {
		setPending,
		setError,
		setShouldOfferContinuousIntegration,
		setVerification,
	})
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
		setShouldOfferContinuousIntegration(true)
		setError("Verification could not finish. Retry the inspection or run Health Code in CI.")
	}, [])
	function handleSubmit(event: FormEvent<HTMLFormElement>): void {
		event.preventDefault()
		void submit(String(new FormData(event.currentTarget).get("repositoryUrl")))
	}

	// Show how the server answered a submission that did not start an inspection.
	const inspectionSubmissionResponse = (
		<div className="inspection-submission-response">
			{/* visitor verification */}
			{verification && <Challenge siteKey={verification.siteKey} onToken={verified} onFailure={retry} />}

			{/* submission error */}
			{error && (
				<p role="alert">
					{error} {shouldOfferContinuousIntegration && <Link href={continuousIntegrationSetupUrl}>CI setup</Link>}
				</p>
			)}
		</div>
	)
	return (
		<section className={upgradeMenu ? "home" : "home landing"}>
			{/* inspection overview */}
			{upgradeMenu ? (
				<>
					<header className="inspection-heading">
						<h1>Try an upgrade</h1>
						<p className="mono">
							<Link href={upgradeMenu.repositoryUrl}>{upgradeMenu.repositoryUrl.slice(19)}</Link> ·{" "}
							{upgradeMenu.commit.slice(0, 8)}
						</p>
					</header>
					{inspectionSubmissionResponse}
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
						Inspect your code
						<span>for new features</span>
					</h1>
					<p className="intro">
						AI health inspectors show you new dependency features and try an upgrade on your codebase inside a Runta
						sandbox. The network is locked, model keys stay outside and successful upgrades return tested patches.
					</p>

					{/* repository inspection steps */}
					<ol className="steps">
						<li>Enter your public GitHub repo URL (Node.js or Bun) and click New features</li>
						<li>Choose a dependency and click Try upgrade to try it on your codebase in a Runta sandbox.</li>
					</ol>

					{/* public repository submission */}
					{paused && (
						<p role="status">
							The hosted budget is reserved or temporarily unavailable. The daily allowance resets at 00:00 UTC. Cached
							reports remain available.{" "}
							<Link href={continuousIntegrationSetupUrl}>Run it in CI with your Runta account</Link>.
						</p>
					)}
					<form onSubmit={handleSubmit}>
						<div className="field">
							<input
								id="repository"
								aria-label="Public GitHub repository"
								name="repositoryUrl"
								type="url"
								required
								maxLength={200}
								autoComplete="off"
								spellCheck={false}
								placeholder="https://github.com/owner/repository"
								readOnly={pending || replay}
								onKeyDown={handleRepositoryKeyDown}
								onChange={() => {
									setVerification(null)
									setError("")
									setShouldOfferContinuousIntegration(false)
								}}
								defaultValue={replay ? replayRepositoryUrl : ""}
							/>
							<button type="submit" disabled={pending}>
								{pending ? "Starting inspection…" : replay ? "Play recorded inspection" : "New features"}
							</button>
						</div>
					</form>
				</>
			)}
			{!upgradeMenu && inspectionSubmissionResponse}
		</section>
	)
}
type Verification = { siteKey: string; repositoryUrl: string; target?: UpgradeMenuTarget }
function useSubmit(
	upgradeMenuId: string | undefined,
	{
		setPending,
		setError,
		setShouldOfferContinuousIntegration,
		setVerification,
	}: {
		setPending: (pending: boolean) => void
		setError: (message: string) => void
		setShouldOfferContinuousIntegration: (offer: boolean) => void
		setVerification: (input: Verification) => void
	},
): (repositoryUrl: string, target?: UpgradeMenuTarget, challenge?: string) => Promise<void> {
	return useCallback(
		async (repositoryUrl: string, target?: UpgradeMenuTarget, challenge?: string): Promise<void> => {
			setPending(true)
			setError("")
			setShouldOfferContinuousIntegration(false)
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
					setShouldOfferContinuousIntegration(Boolean(body.continuousIntegrationSetupUrl || challenge))
					throw new Error(body.message ?? "Could not start the inspection.")
				}
				window.location.assign(`/r/${body.id}`)
			} catch (failure) {
				setError(failure instanceof Error ? failure.message : "Could not start the inspection.")
				setPending(false)
			}
		},
		[upgradeMenuId, setPending, setError, setShouldOfferContinuousIntegration, setVerification],
	)
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
	const isWaiting = live && !events.length
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
