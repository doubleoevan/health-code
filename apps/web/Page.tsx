import { type FormEvent, type ReactElement, useEffect, useState } from "react"
import { Link, ReportView } from "./ReportView.tsx"
import { replayRepositoryUrl, type SiteEvent, type Snapshot } from "./report.ts"
import { Timeline } from "./Timeline.tsx"

export type PageProps = { snapshot: Snapshot | null; url: string; replay: boolean }
function Home({ replay }: { replay: boolean }): ReactElement {
	const [error, setError] = useState("")
	const [pending, setPending] = useState(false)
	async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
		// read the submitted repository and clear the previous error
		event.preventDefault()
		const input = new FormData(event.currentTarget).get("repositoryUrl")
		setPending(true)
		setError("")
		try {
			// request an inspection and open its report page
			const response = await fetch("/api/inspections", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ repositoryUrl: input }),
			})
			const body = await response.json()
			if (!response.ok) {
				throw new Error(body.message ?? "Could not start the inspection.")
			}
			window.location.assign(`/r/${body.id}`)
		} catch (failure) {
			// let the developer correct and resubmit the form
			setError(failure instanceof Error ? failure.message : "Could not start the inspection.")
			setPending(false)
		}
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
						defaultValue={replay ? replayRepositoryUrl : ""}
					/>
					<button type="submit" disabled={pending}>
						{pending ? "Starting…" : "Inspect repository"}
					</button>
				</div>
				{/* submission error */}
				{error && <p role="alert">{error}</p>}
			</form>
		</section>
	)
}
function Inspection({ snapshot, url }: { snapshot: Snapshot; url: string }): ReactElement {
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
				<ReportView card={snapshot.card} url={url} />
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
						{snapshot.message ?? (events.length === 0 ? "Queued for inspection" : "Inspection in progress")}
					</p>
				</>
			)}
			{/* connection status and event timeline */}
			{disconnected && <p role="status">Reconnecting to the inspection…</p>}
			<Timeline id={snapshot.id} events={events} live={live} />
		</>
	)
}
export function Page({ snapshot, url, replay }: PageProps): ReactElement {
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
			{snapshot ? <Inspection snapshot={snapshot} url={url} /> : <Home replay={replay} />}
		</main>
	)
}
