import { setTimeout as delay } from "node:timers/promises"
import {
	InspectionError,
	type InspectionEvent,
	type InspectionEventV2,
	type ReportCard,
	type ReportCardV2,
} from "health-code"
import * as z from "zod"
import { UserError } from "./modelSettings.ts"
import {
	cardSchema,
	type Event,
	eventSchema,
	type InspectionStore,
	inspectionId,
	outcomeSchema,
} from "./storeInspection.ts"

const page = z.object({ text: z.string(), nextOffset: z.number().nullable() })
export const readOutput = z.object({
	inspectionId,
	status: z.string(),
	currentStep: z.string(),
	events: z.array(eventSchema),
	pinned: z.array(z.object({ sequence: z.number(), action: z.unknown() })),
	nextSequence: z.number(),
	hasMore: z.boolean(),
	report: page.nullable(),
	results: z.array(outcomeSchema),
	failure: z.string().optional(),
})
// accept either supported event and report format from the inspection engine
export type Inspect = (options: {
	repositoryUrl: string
	signal: AbortSignal
	onEvent: (event: InspectionEvent | InspectionEventV2) => void
}) => Promise<ReportCard | ReportCardV2>
// retain live progress until the report is saved
type State = {
	events: Event[]
	step: string
	status: "running" | "failed" | "complete"
	failure?: string
	reportText?: string
}
// track cancellation and cursors for each read request
type ReadRequest = { progress?: (step: string) => Promise<void>; signal?: AbortSignal }
type Read = { inspectionId: string; afterSequence: number; waitMs: number; reportOffset: number }
export function textPage(text: string, offset: number): { text: string; nextOffset: number | null } {
	// reject offsets that start inside a surrogate pair
	if (offset > text.length || (offset > 0 && /[\uDC00-\uDFFF]/u.test(text.charAt(offset)))) {
		throw new UserError("Invalid text cursor.")
	}
	// leave the entire surrogate pair for the next page when it crosses the boundary
	let end = Math.min(text.length, offset + 4096)
	if (end < text.length && /[\uD800-\uDBFF]/u.test(text.charAt(end - 1))) {
		end--
	}
	return { text: text.slice(offset, end), nextOffset: end < text.length ? end : null }
}
export function toEventLine(event: Event): string {
	switch (event.type) {
		// highlight sandbox activity in the terminal timeline
		case "sandbox.event":
			return `◆ Runta · ${event.action}`
		case "step.started":
			return `Starting · ${event.label}`
		case "step.finished":
			return String(event.summary)
		// show detail output with its source stream
		case "detail":
			return `${event.stream} · ${event.text}`
		// label inspection lifecycle events separately from individual steps
		case "inspection.started":
			return "Inspection started"
		case "inspection.failed":
			return `Inspection failed · ${event.message}`
		case "inspection.finished":
			return "Inspection finished"
	}
}
// truncate long detail text only in event previews
function toPreview(event: Event): Event {
	// bound detail previews while preserving the original event
	if (event.type === "detail" && typeof event.text === "string" && event.text.length > 1024) {
		return { ...event, text: event.text.slice(0, 1024), truncated: true }
	}
	return event
}
export class Inspections {
	// track live state separately from work that shutdown must drain
	private active = new Map<string, State>()
	currentStep(id: string): string {
		return this.active.get(id)?.step ?? "Finished"
	}
	private jobs = new Map<AbortController, Promise<void>>()
	constructor(
		readonly store: InspectionStore,
		private inspect: Inspect,
	) {}
	// cancel every active job and await sandbox teardown
	async close(): Promise<void> {
		for (const controller of this.jobs.keys()) {
			controller.abort()
		}
		await Promise.all(this.jobs.values())
	}
	async start(repositoryUrl: string): Promise<string> {
		// prepare separate promises for acceptance and completion
		const controller = new AbortController()
		const state: State = { events: [], step: "Starting inspection", status: "running" }
		let id: string | undefined
		const accepted = Promise.withResolvers<string>()
		const operation = Promise.resolve()
			.then(() =>
				this.inspect({
					repositoryUrl,
					signal: controller.signal,
					onEvent: (input) => {
						// Validate before publishing an event or waking a polling client.
						this.store.guard(JSON.stringify(input))
						const event = eventSchema.parse(input)
						// publish the inspection id as soon as the library announces it
						if (!id && event.type === "inspection.started") {
							id = event.inspectionId
							this.active.set(id, state)
							accepted.resolve(id)
						}
						// bind all subsequent events to the accepted inspection
						if (event.inspectionId !== id) {
							throw new UserError("Inspection event identity mismatch.")
						}
						state.events.push(event)
						// expose the latest step while the inspection is running
						if (event.type === "step.started") {
							state.step = String(event.label)
						}
						if (event.type === "step.finished") {
							state.step = "Awaiting next step"
						}
					},
				}),
			)
			.then(async (card) => {
				// verify that the finished card belongs to this job
				if (!id || card.inspectionId !== id) {
					throw new UserError("Inspection identity mismatch.")
				}
				this.store.guard(JSON.stringify(card))
				const saved = cardSchema.parse(card)
				// retry storage writes without repeating the inspection
				for (let attempt = 0; ; attempt++) {
					try {
						await this.store.save(saved)
						break
					} catch {
						// retain the report in memory if every write fails
						if (attempt === 2) {
							state.reportText = JSON.stringify(saved)
							throw new UserError("Report Card is available in memory only. Check local storage.")
						}
						await delay(100)
					}
				}
				// switch readers to persistent storage after publication
				state.status = "complete"
				this.active.delete(id)
			})
			.catch((error: unknown) => {
				state.status = "failed"
				state.step = "Finished"
				// expose only recognized errors in the terminal state
				state.failure =
					error instanceof UserError
						? error.message
						: error instanceof InspectionError
							? `Inspection failed (${error.code}).`
							: "Inspection failed."
				// screen the failure message before delivery
				try {
					this.store.guard(state.failure)
				} catch {
					state.failure = "Inspection evidence withheld."
				}
				accepted.reject(new UserError(state.failure))
			})
			// release the cancellation handle when the job settles
			.finally(() => {
				this.jobs.delete(controller)
			})
		this.jobs.set(controller, operation)
		return accepted.promise
	}
	private async waitForEvents(input: Read, request: ReadRequest): Promise<void> {
		// establish the deadline and report the current step before waiting
		const { progress, signal } = request
		let state = this.active.get(input.inspectionId)
		const deadline = Date.now() + input.waitMs
		let step = state?.step ?? "Reading saved Report Card"
		await progress?.(step)
		// Wait only while the reader has caught up to the live event sequence.
		while (
			state?.status === "running" &&
			(state.events.at(-1)?.sequence ?? 0) <= input.afterSequence &&
			Date.now() < deadline
		) {
			await delay(Math.min(50, deadline - Date.now()), undefined, { signal })
			// notify the waiting client when the active step changes
			state = this.active.get(input.inspectionId)
			if (state && state.step !== step) {
				step = state.step
				await progress?.(step)
			}
		}
	}
	async read(input: Read, request: ReadRequest = {}): Promise<z.infer<typeof readOutput>> {
		// look up the inspection again after the wait to capture completion
		await this.waitForEvents(input, request)
		const state = this.active.get(input.inspectionId)
		const saved = state ? undefined : await this.store.snapshot(input.inspectionId)
		const report = saved?.text ?? state?.reportText
		const timeline = state?.events ?? saved?.card.timeline ?? []
		// page events while pinning sandbox activity across the whole timeline
		const events = timeline.filter((event) => event.sequence > input.afterSequence).slice(0, 8)
		const pinned = timeline
			.filter((event) => event.type === "sandbox.event")
			.map((event) => ({ sequence: event.sequence, action: event.action }))
		// return recorded outcomes alongside the next event cursor
		const nextSequence = events.at(-1)?.sequence ?? input.afterSequence
		const results = state ? [] : await this.store.outcomes(input.inspectionId)
		return {
			inspectionId: input.inspectionId,
			status: state?.status ?? "complete",
			currentStep: state?.step ?? "Finished",
			failure: state?.failure,
			events: events.map(toPreview),
			pinned,
			nextSequence,
			hasMore: nextSequence < (timeline.at(-1)?.sequence ?? 0),
			report: report ? textPage(report, input.reportOffset) : null,
			results,
		}
	}
}
