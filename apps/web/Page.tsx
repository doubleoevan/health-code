import { type FormEvent, type ReactElement, useCallback, useEffect, useState } from "react"
import { Challenge } from "./Challenge.tsx"
import { Link, ReportView } from "./ReportView.tsx"
import { mcpSetupUrl, replayRepositoryUrl, type SiteEvent, type Snapshot } from "./report.ts"
import { Timeline } from "./Timeline.tsx"

export type PageProps = { paused?: boolean; snapshot: Snapshot | null; url: string; replay: boolean }
function Home({ replay, paused }: { replay: boolean; paused?: boolean }): ReactElement {
	const [error, setError] = useState("")
	const [verification, setVerification] = useState<{ siteKey: string; repositoryUrl: string } | null>(null)
	const [pending, setPending] = useState(false)
	const [offerMcp, setOfferMcp] = useState(false)
	const submit = useCallback(async (repositoryUrl: string, challenge?: string): Promise<void> => {
		setPending(true)
		setError("")
		setOfferMcp(false)
		try {
			const response = await fetch("/api/inspections", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ repositoryUrl, challenge }),
			})
			const body = await response.json()
			if (!response.ok) {
				// Verify only a new submission and resume the same repository after success.
				if (!challenge && body.siteKey) {
					setVerification({ siteKey: body.siteKey, repositoryUrl })
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
	}, [])
	const verified = useCallback(
		(token: string): void => {
			if (verification) {
				setVerification(null)
				void submit(verification.repositoryUrl, token)
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
			<h1>
				Inspect your
				<br />
				dependency upgrades.
			</h1>
			<p className="intro">
				AI agents try your dependency upgrades inside a Runta sandbox. The network is locked, real keys stay outside,
				and successful attempts return tested patches.
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
						{verification ? "Verifying…" : pending ? "Starting…" : error ? "Retry inspection" : "Inspect repository"}
					</button>
				</div>
				{verification && <Challenge siteKey={verification.siteKey} onToken={verified} onFailure={retry} />}

				{/* submission error */}
				{error && (
					<p role="alert">
						{error} {offerMcp && <Link href={mcpSetupUrl}>MCP setup</Link>}
					</p>
				)}
			</form>
		</section>
	)
}
function Inspection({ snapshot, url }: { snapshot: Snapshot; url: string }): ReactElement {
	const [position, setPosition] = useState(snapshot.position)
	useEffect(() => {
		if (snapshot.card) {
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
export function Page({ snapshot, url, replay, paused }: PageProps): ReactElement {
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
			{snapshot ? <Inspection snapshot={snapshot} url={url} /> : <Home replay={replay} paused={paused} />}
		</main>
	)
}
