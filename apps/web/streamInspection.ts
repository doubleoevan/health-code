import type { Inspections } from "./executeInspection.ts"

export function streamInspection(options: {
	inspections: Inspections
	id: string
	after: number
	signal: AbortSignal
}): Response {
	// resume from the client's last delivered event
	const { inspections, id, signal } = options
	let cursor = options.after
	let wake: (() => void) | undefined
	let closed = false
	const notify = (): void => wake?.()
	// wake idle subscribers periodically to send keepalives
	const encoder = new TextEncoder()
	const pageSize = 32
	const heartbeat = setInterval(notify, 15000)
	const close = (): void => {
		// release the heartbeat and wake any outstanding read on disconnect
		closed = true
		clearInterval(heartbeat)
		inspections.changes.off(id, notify)
		signal.removeEventListener("abort", close)
		notify()
	}
	// Subscribe before the first read. SQLite remains the source of order on every wake.
	inspections.changes.on(id, notify)
	signal.addEventListener("abort", close, { once: true })
	if (signal.aborted) {
		close()
	}
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			// finish a pending pull when the client has already disconnected
			if (closed) {
				controller.close()
				return
			}
			try {
				// arm the wakeup before reading the next persisted page
				const change = Promise.withResolvers<void>()
				wake = change.resolve
				const events = inspections.store.publicEvents(id, cursor, pageSize)
				const frames = events.map(
					(event) => `id: ${event.sequence}\nevent: inspection\ndata: ${JSON.stringify(event)}\n\n`,
				)
				cursor = events.at(-1)?.sequence ?? cursor
				// Send the terminal signal only after publication is durable.
				const state = inspections.store.state(id)
				if (events.length < pageSize && state !== "queued" && state !== "running") {
					frames.push(`event: terminal\ndata: ${state}\n\n`)
					controller.enqueue(encoder.encode(frames.join("")))
					controller.close()
					close()
					return
				}
				// send available events immediately so a full backlog drains in pages
				if (frames.length) {
					controller.enqueue(encoder.encode(frames.join("")))
					return
				}
				// wait for a change or heartbeat after an empty read
				controller.enqueue(encoder.encode(": heartbeat\n\n"))
				await change.promise
			} catch (error) {
				close()
				throw error
			} finally {
				wake = undefined
			}
		},
		cancel: close,
	})
	return new Response(body, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			"X-Accel-Buffering": "no",
		},
	})
}
