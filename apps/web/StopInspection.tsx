import { type ReactElement, useState } from "react"

export function StopInspection({ id, canStop }: { id: string; canStop?: boolean }): ReactElement | null {
	const [stopStep, setStopStep] = useState<"idle" | "confirming" | "stopping">("idle")
	const [errorMessage, setErrorMessage] = useState("")
	async function handleStop(): Promise<void> {
		// show progress until the stream reports the stop
		setStopStep("stopping")
		setErrorMessage("")
		try {
			const response = await fetch(`/api/inspections/${id}/stop`, { method: "POST" })

			// show the reason a stop was refused
			if (!response.ok) {
				const { message } = await response.json()
				throw new Error(message)
			}
		} catch (failure) {
			setErrorMessage(failure instanceof Error && failure.message ? failure.message : "Could not stop the inspection.")
			setStopStep("idle")
		}
	}
	if (!canStop) {
		return null
	}
	if (stopStep === "stopping") {
		return <p role="status">Stopping the inspection and deleting its sandbox…</p>
	}
	return (
		<div className="stop-inspection">
			{/* stop request and its confirmation */}
			{stopStep === "idle" ? (
				<button type="button" className="secondary" onClick={() => setStopStep("confirming")}>
					Stop inspection
				</button>
			) : (
				<>
					<span role="status">Stop this inspection? Costs so far still count.</span>
					<button type="button" className="secondary" onClick={handleStop}>
						Stop inspection
					</button>
					<button type="button" className="secondary" onClick={() => setStopStep("idle")}>
						Keep running
					</button>
				</>
			)}
			{errorMessage && <p role="alert">{errorMessage}</p>}
		</div>
	)
}
