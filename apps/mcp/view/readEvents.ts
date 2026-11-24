import type { z } from "zod"
import type { readOutput } from "../trackInspections.ts"
import type { Host } from "./connectHost.ts"

export type Progress = z.infer<typeof readOutput>
type ReadEventsOptions = {
	host: Host
	inspectionId: string
	signal: AbortSignal
	shouldReadSavedLog: boolean
	onProgress: (progress: Progress) => void
}

/**
 * Reads events in order until the inspection ends.
 */
export async function readEvents(options: ReadEventsOptions): Promise<void> {
	const { host, inspectionId, signal, shouldReadSavedLog, onProgress } = options

	// continue after the last event the page received
	let afterSequence = 0
	let isFirstRead = true
	while (!signal.aborted) {
		// wait briefly on the server for new events
		const input = { inspectionId, afterSequence, waitMs: 3000 }
		const progress = await host.callTool<Progress>("read_inspection", input)
		if (signal.aborted) {
			return
		}
		onProgress(progress)

		// leave the log of an inspection that already ended until the reader opens it
		const isSaved = isFirstRead && progress.status !== "running"
		if ((isSaved && !shouldReadSavedLog) || (progress.status !== "running" && !progress.hasMore)) {
			return
		}
		isFirstRead = false
		afterSequence = progress.nextSequence
	}
}
