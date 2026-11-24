import { type ReactElement, useState } from "react"

export function StopInspection({ id, canStop }: { id: string; canStop?: boolean }): ReactElement | null {
	const [isStopping, setIsStopping] = useState(false)
	const [errorMessage, setErrorMessage] = useState("")
	async function handleStop(): Promise<void> {
		// show progress until the stream reports the stop
		setIsStopping(true)
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
			setIsStopping(false)
		}
	}
	if (!canStop) {
		return null
	}
	if (isStopping) {
		return <p role="status">Stopping the inspection and deleting its sandbox…</p>
	}
	return (
		<div className="stop-inspection">
			{/* stop control and refusal message */}
			<button type="button" className="secondary" onClick={handleStop}>
				Stop inspection
			</button>
			{errorMessage && <p role="alert">{errorMessage}</p>}
		</div>
	)
}
