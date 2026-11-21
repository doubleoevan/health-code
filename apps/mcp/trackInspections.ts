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
export type Inspect = (options: {
	repositoryUrl: string
	signal: AbortSignal
	onEvent: (event: InspectionEvent | InspectionEventV2) => void
}) => Promise<ReportCard | ReportCardV2>
type State = {
	events: Event[]
	step: string
	status: "running" | "failed" | "complete"
	failure?: string
	reportText?: string
}
type ReadRequest = { progress?: (step: string) => Promise<void>; signal?: AbortSignal }
type Read = { inspectionId: string; afterSequence: number; waitMs: number; reportOffset: number }
export function textPage(text: string, offset: number): { text: string; nextOffset: number | null } {
	if (offset > text.length || (offset > 0 && /[\uDC00-\uDFFF]/u.test(text.charAt(offset)))) {
		throw new UserError("Invalid text cursor.")
	}
	let end = Math.min(text.length, offset + 4096)
	if (end < text.length && /[\uD800-\uDBFF]/u.test(text.charAt(end - 1))) {
		end--
	}
	return { text: text.slice(offset, end), nextOffset: end < text.length ? end : null }
}
export function toEventLine(event: Event): string {
	switch (event.type) {
		case "sandbox.event":
			return `◆ Runta · ${event.action}`
		case "step.started":
			return `Starting · ${event.label}`
		case "step.finished":
			return String(event.summary)
		case "detail":
			return `${event.stream} · ${event.text}`
		case "inspection.started":
			return "Inspection started"
		case "inspection.failed":
			return `Inspection failed · ${event.message}`
		case "inspection.finished":
			return "Inspection finished"
	}
}
function toPreview(event: Event): Event {
	if (event.type === "detail" && typeof event.text === "string" && event.text.length > 1024) {
		return { ...event, text: event.text.slice(0, 1024), truncated: true }
	}
	return event
}
export class Inspections {
	private active = new Map<string, State>()
	currentStep(id: string): string {
		return this.active.get(id)?.step ?? "Finished"
	}
	private jobs = new Map<AbortController, Promise<void>>()
	constructor(
		readonly store: InspectionStore,
		private inspect: Inspect,
	) {}
	async close(): Promise<void> {
		for (const controller of this.jobs.keys()) {
			controller.abort()
		}
		await Promise.all(this.jobs.values())
	}
	async start(repositoryUrl: string): Promise<string> {
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
						if (!id && event.type === "inspection.started") {
							id = event.inspectionId
							this.active.set(id, state)
							accepted.resolve(id)
						}
						if (event.inspectionId !== id) {
							throw new UserError("Inspection event identity mismatch.")
						}
						state.events.push(event)
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
				if (!id || card.inspectionId !== id) {
					throw new UserError("Inspection identity mismatch.")
				}
				this.store.guard(JSON.stringify(card))
				const saved = cardSchema.parse(card)
				for (let attempt = 0; ; attempt++) {
					try {
						await this.store.save(saved)
						break
					} catch {
						if (attempt === 2) {
							state.reportText = JSON.stringify(saved)
							throw new UserError("Report Card is available in memory only. Check local storage.")
						}
						await delay(100)
					}
				}
				state.status = "complete"
				this.active.delete(id)
			})
			.catch((error: unknown) => {
				state.status = "failed"
				state.step = "Finished"
				state.failure =
					error instanceof UserError
						? error.message
						: error instanceof InspectionError
							? `Inspection failed (${error.code}).`
							: "Inspection failed."
				try {
					this.store.guard(state.failure)
				} catch {
					state.failure = "Inspection evidence withheld."
				}
				accepted.reject(new UserError(state.failure))
			})
			.finally(() => {
				this.jobs.delete(controller)
			})
		this.jobs.set(controller, operation)
		return accepted.promise
	}
	private async waitForEvents(input: Read, request: ReadRequest): Promise<void> {
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
			state = this.active.get(input.inspectionId)
			if (state && state.step !== step) {
				step = state.step
				await progress?.(step)
			}
		}
	}
	async read(input: Read, request: ReadRequest = {}): Promise<z.infer<typeof readOutput>> {
		await this.waitForEvents(input, request)
		const state = this.active.get(input.inspectionId)
		const saved = state ? undefined : await this.store.snapshot(input.inspectionId)
		const report = saved?.text ?? state?.reportText
		const timeline = state?.events ?? saved?.card.timeline ?? []
		const events = timeline.filter((event) => event.sequence > input.afterSequence).slice(0, 8)
		const pinned = timeline
			.filter((event) => event.type === "sandbox.event")
			.map((event) => ({ sequence: event.sequence, action: event.action }))
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
