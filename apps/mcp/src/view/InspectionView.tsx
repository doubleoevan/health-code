import { type ReactElement, useEffect, useRef, useState } from "react"
import type { Event } from "../storeInspection.ts"
import { toEventLine, toSandboxEventLabel } from "../toEventLine.ts"
import { CurrentStep } from "./CurrentStep.tsx"
import { type Host, toFailureText } from "./connectHost.ts"
import { type Progress, readEvents } from "./readEvents.ts"
import { UpgradeResults } from "./UpgradeResults.tsx"

export function InspectionView({
	host,
	inspectionId,
	onBack,
}: {
	host: Host
	inspectionId: string
	onBack?: () => void
}): ReactElement {
	const [progress, setProgress] = useState<Progress>()
	const [events, setEvents] = useState<Event[]>([])
	const [failure, setFailure] = useState<string>()
	const [attempt, setAttempt] = useState(0)
	const [shouldReadSavedLog, setShouldReadSavedLog] = useState(false)
	const [wasRunning, setWasRunning] = useState(false)
	const [isStopping, setIsStopping] = useState(false)

	// follow the inspection until it ends or the screen closes
	// biome-ignore lint/correctness/useExhaustiveDependencies: A retry reads the inspection again.
	useEffect(() => {
		const controller = new AbortController()
		const { signal } = controller
		setEvents([])
		setFailure(undefined)
		setWasRunning(false)
		function handleProgress(next: Progress): void {
			setProgress(next)
			setWasRunning((earlier) => earlier || next.status === "running")
			setEvents((earlier) => [...earlier, ...next.events])
		}
		readEvents({ host, inspectionId, signal, shouldReadSavedLog, onProgress: handleProgress }).catch((error) => {
			if (!signal.aborted) {
				setFailure(toFailureText(error))
			}
		})
		return () => controller.abort()
	}, [host, inspectionId, shouldReadSavedLog, attempt])

	async function handleStop(): Promise<void> {
		setIsStopping(true)
		await host.callTool("stop_inspection", { inspectionId }).catch((error) => {
			setIsStopping(false)
			setFailure(toFailureText(error))
		})
	}

	const isRunning = progress?.status === "running"
	const isSavedLogHidden = !isRunning && !wasRunning && progress?.hasMore && !shouldReadSavedLog
	return (
		<section>
			{/* navigation and stop control */}
			<div className="button-row">
				{onBack && (
					<button type="button" className="secondary" onClick={onBack}>
						Back to upgrades
					</button>
				)}
				{isRunning && (
					<button type="button" className="secondary" disabled={isStopping} onClick={handleStop}>
						{isStopping ? "Stopping…" : "Stop inspection"}
					</button>
				)}
			</div>

			{/* current step or failure */}
			{(isRunning || !progress) && !failure && <CurrentStep text={progress?.currentStep ?? "Reading inspection…"} />}
			{progress?.failure && <p role="alert">{progress.failure}</p>}
			{failure && (
				<p className="button-row" role="alert">
					{failure}
					<button type="button" className="secondary" onClick={() => setAttempt(attempt + 1)}>
						Retry
					</button>
				</p>
			)}

			{/* pinned sandbox events */}
			{progress && progress.pinned.length > 0 && (
				<aside>
					<h2>Runta sandbox</h2>
					<ul>
						{progress.pinned.map((event) => (
							<li key={event.sequence}>{toSandboxEventLabel(event)}</li>
						))}
					</ul>
				</aside>
			)}

			{/* verdicts and patches */}
			{progress?.status === "complete" && <UpgradeResults host={host} inspectionId={inspectionId} />}

			{/* inspection log */}
			{isSavedLogHidden ? (
				<button type="button" className="secondary" onClick={() => setShouldReadSavedLog(true)}>
					Show inspection log
				</button>
			) : (
				<InspectionLog events={events} isRunning={isRunning} />
			)}
		</section>
	)
}

// keep the page responsive on a long inspection
const maximumShownEvents = 500

function InspectionLog({ events, isRunning }: { events: Event[]; isRunning: boolean }): ReactElement | null {
	const list = useRef<HTMLOListElement>(null)
	const followsTail = useRef(true)
	const lastSequence = events.at(-1)?.sequence

	// follow the latest event while the reader stays at the bottom
	useEffect(() => {
		if (isRunning && lastSequence && list.current && followsTail.current) {
			list.current.scrollTop = list.current.scrollHeight
		}
	}, [isRunning, lastSequence])

	if (!events.length) {
		return null
	}

	return (
		<>
			{/* rolling log */}
			<h2>Inspection log</h2>
			<ol
				className="log"
				ref={list}
				onScroll={({ currentTarget: element }) => {
					followsTail.current = element.scrollHeight - element.scrollTop - element.clientHeight < 8
				}}
			>
				{events.slice(-maximumShownEvents).map((event) => (
					<li key={event.sequence} className={event.type === "sandbox.event" ? "sandbox" : undefined}>
						{toEventLine(event)}
					</li>
				))}
			</ol>
		</>
	)
}
