import { type ReactElement, useEffect, useRef, useState } from "react"
import type { SiteEvent } from "./report.ts"

const actions = {
	created: "Sandbox created",
	"model-request-sandbox-started": "Model request sandbox started",
	"credentials-withheld": "Real keys kept outside the sandbox",
	"network-locked": "Network locked to approved destinations",
	"connection-blocked": "Connection blocked",
	"agent-started": "Agent started with its real key withheld",
	deleted: "Sandbox deleted",
}

function toActionLabel(event: Extract<SiteEvent, { type: "sandbox.event" }>): string {
	if (event.action === "credentials-withheld" && event.placeholderVariableCount !== undefined) {
		const count = event.placeholderVariableCount
		return `${count} repository environment ${count === 1 ? "variable" : "variables"} given placeholder values`
	}
	if (event.action === "credentials-withheld" && event.storedModelKeyCount !== undefined) {
		const count = event.storedModelKeyCount
		return `${count} stored model ${count === 1 ? "key" : "keys"} kept outside the sandbox`
	}

	if (event.action === "model-relay-started") {
		return (
			event.detail?.replace(/^Model relay started/, "Model request sandbox started") ||
			actions["model-request-sandbox-started"]
		)
	}
	if (event.action === "model-request-sandbox-started" && event.detail) {
		return event.detail
	}
	const label = actions[event.action] ?? event.action
	return event.detail && event.detail !== label ? `${label} ${event.detail}` : label
}
function toStepLabel(label: string): string {
	if (label === "integrity") {
		return "Read patch verification inputs"
	}
	if (label === "registry") {
		return "Find available upgrades"
	}

	// label current and historical agent steps consistently
	if (label === "fix" || label === "repair") {
		return "Repair"
	}
	if (label === "adoption" || label === "featureAdoption") {
		return "Feature adoption"
	}
	return label
}

function CurrentStep({ label, start }: { label: string; start: string }): ReactElement {
	const [now, setNow] = useState<number | null>(null)
	useEffect(() => {
		// refresh elapsed time while the step is visible
		setNow(Date.now())
		const timer = setInterval(() => setNow(Date.now()), 1000)
		return () => clearInterval(timer)
	}, [])
	const elapsed = now === null ? 0 : Math.max(0, Math.floor((now - Date.parse(start)) / 1000))
	return (
		<p className="current" role="status">
			<span className="spinner" />
			{label}
			<span className="elapsed">{elapsed}s</span>
		</p>
	)
}
function Output({ event, id }: { event: Extract<SiteEvent, { type: "detail" }>; id: string }): ReactElement {
	const [open, setOpen] = useState(false)
	const [text, setText] = useState<string | null>(null)
	const [failed, setFailed] = useState(false)
	useEffect(() => {
		// load output on expansion when it was omitted from the event
		if (!open || event.text || text !== null) {
			return
		}
		const controller = new AbortController()
		async function loadOutput(): Promise<void> {
			try {
				setFailed(false)
				const response = await fetch(`/api/inspections/${id}/details/${event.sequence}`, { signal: controller.signal })
				if (!response.ok) {
					throw new Error()
				}
				setText(await response.text())
			} catch {
				// show a retry message while the disclosure is still open
				if (!controller.signal.aborted) {
					setFailed(true)
				}
			}
		}

		// cancel the detail request when the disclosure closes
		void loadOutput()
		return () => controller.abort()
	}, [open, event.sequence, event.text, id, text])
	return (
		<details onToggle={(change) => setOpen(change.currentTarget.open)}>
			{/* command stream and captured output */}
			<summary>Show details · {event.stream}</summary>
			<pre>
				{event.text || (text ?? (failed ? "Output unavailable. Close and reopen to retry." : "Loading output…"))}
				{event.truncated ? "\n[output truncated]" : ""}
			</pre>
		</details>
	)
}
function renderEvent(event: SiteEvent, id: string): ReactElement {
	switch (event.type) {
		case "sandbox.event":
			return <strong className="control">Runta · {toActionLabel(event)}</strong>
		case "step.finished":
			return (
				<span>
					{toStepLabel(event.summary)}{" "}
					<small>
						{event.summary === "registry" && event.status === "untested" ? "Incomplete" : event.status} ·{" "}
						{(event.durationMs / 1000).toFixed(1)}s
					</small>
				</span>
			)
		case "step.started":
			return (
				<span>
					{toStepLabel(event.label)} <small>started</small>
				</span>
			)
		case "detail":
			return <Output event={event} id={id} />
		case "inspection.started":
			return <span>Inspection started</span>
		case "inspection.finished":
			return <span>Inspection finished</span>
		case "inspection.failed":
			return <span>{event.message}</span>
	}
}
export function Timeline({ events, live, id }: { events: SiteEvent[]; live: boolean; id: string }): ReactElement {
	const list = useRef<HTMLOListElement>(null)
	const followsTail = useRef(true)
	const lastSequence = events.at(-1)?.sequence

	// follow the latest event while the reader stays at the bottom
	useEffect(() => {
		if (live && lastSequence && list.current && followsTail.current) {
			list.current.scrollTop = list.current.scrollHeight
		}
	}, [live, lastSequence])

	// find the open step and collect the sandbox events
	const finished = new Set(events.flatMap((event) => (event.type === "step.finished" ? [event.stepId] : [])))
	const current = events.findLast((event) => event.type === "step.started" && !finished.has(event.stepId))
	const sandboxEvents = events.filter((event) => event.type === "sandbox.event")
	return (
		<section>
			{/* active step and elapsed time */}
			{live && current?.type === "step.started" && (
				<CurrentStep label={toStepLabel(current.label)} start={current.timestamp} />
			)}

			{/* pinned sandbox events */}
			{sandboxEvents.length > 0 && (
				<aside>
					<h2>Runta sandbox</h2>
					<ul>
						{sandboxEvents.map((event) => (
							<li key={event.sequence}>{toActionLabel(event)}</li>
						))}
					</ul>
				</aside>
			)}

			{/* chronological inspection log */}
			<h2>Inspection log</h2>
			<ol
				className={live ? "timeline rolling" : "timeline history"}
				style={{ paddingInlineStart: `${String(events.length).length + 2}ch` }}
				ref={list}
				onScroll={(event) => {
					const element = event.currentTarget
					followsTail.current = element.scrollHeight - element.scrollTop - element.clientHeight < 8
				}}
			>
				{events
					.filter((event) => !live || event.type !== "step.started")
					.map((event) => (
						<li key={event.sequence}>{renderEvent(event, id)}</li>
					))}
			</ol>
		</section>
	)
}
