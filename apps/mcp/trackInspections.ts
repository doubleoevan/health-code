import { setTimeout as delay } from "node:timers/promises"
import {
	InspectionError,
	type InspectionEvent,
	type InspectionOptions,
	type InspectionReport,
	type ModelRequestSandboxEvent,
	type ModelRequestSandboxInspectionReport,
} from "health-code"
import * as z from "zod"
import { listPatches, patchReference } from "./listPatches.ts"
import { UserError } from "./modelSettings.ts"
import {
	type Event,
	eventSchema,
	type InspectionStore,
	inspectionId,
	outcomeSchema,
	reportSchema,
	type SavedReport,
} from "./storeInspection.ts"
import { toEventLine } from "./toEventLine.ts"
import { toFailureMessage } from "./toFailureMessage.ts"

const page = z.object({ text: z.string(), nextOffset: z.number().nullable() })
export const readOutput = z.object({
	inspectionId,
	status: z.string(),
	currentStep: z.string(),
	events: z.array(eventSchema),
	pinned: z.array(z.object({ sequence: z.number(), action: z.unknown(), detail: z.unknown().optional() })),
	nextSequence: z.number(),
	hasMore: z.boolean(),
	report: page.nullable(),
	patches: z.array(patchReference),
	results: z.array(outcomeSchema),
	failure: z.string().optional(),
})

// accept either supported event and report format from the inspection engine
type Choice = Pick<InspectionOptions, "revision" | "mode" | "upgrade" | "limits" | "applicationEnvironment">
export type Inspect = (
	options: Choice & {
		repositoryUrl: string
		signal: AbortSignal
		onEvent: (event: InspectionEvent | ModelRequestSandboxEvent) => void
	},
) => Promise<InspectionReport | ModelRequestSandboxInspectionReport>

// retain live progress until the report is saved
type State = {
	events: Event[]
	step: string
	status: "running" | "failed" | "complete"
	controller: AbortController

	// Retain terminal evidence when the report cannot be saved.
	failure?: string
	eventError?: UserError
	reportText?: string
	patches?: z.infer<typeof patchReference>[]
}

// track cancellation and cursors for each read request
type ReadRequest = { progress?: (step: string) => Promise<void>; signal?: AbortSignal }
type Read = { inspectionId: string; afterSequence: number; waitMs: number; reportOffset: number }
export function textPage(text: string, offset: number): { text: string; nextOffset: number | null } {
	// reject offsets that start inside a surrogate pair
	if (offset > text.length || (offset > 0 && /[\uDC00-\uDFFF]/u.test(text.charAt(offset)))) {
		throw new UserError("Invalid text cursor. Pass 0 or the last nextOffset.")
	}

	// leave the entire surrogate pair for the next page when it crosses the boundary
	let end = Math.min(text.length, offset + 4096)
	if (end < text.length && /[\uD800-\uDBFF]/u.test(text.charAt(end - 1))) {
		end--
	}
	return { text: text.slice(offset, end), nextOffset: end < text.length ? end : null }
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
	private upgradeTests = new Map<string, { controller: AbortController; accepted: Promise<string> }>()
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

	// read a report that storage could not save from memory
	async loadReport(id: string): Promise<SavedReport> {
		const state = this.active.get(id)
		const unsaved = state?.reportText
		if (state && !unsaved) {
			throw new UserError(
				state.failure ?? "This inspection is still running. Poll read_inspection until its status is complete.",
			)
		}
		return unsaved ? reportSchema.parse(JSON.parse(unsaved)) : this.store.load(id)
	}

	// cancel one active inspection and let its sandboxes tear down
	stop(id: string): void {
		const state = this.active.get(id)
		if (state?.status !== "running") {
			throw new UserError("No active inspection has that ID. Call read_inspection for its result.")
		}
		state.controller.abort()
	}

	// keep the cause that the library replaces with a delivery error
	private screenEvent(state: State, event: object): void {
		try {
			this.store.guard(JSON.stringify(event))
		} catch (error) {
			if (error instanceof UserError) {
				state.eventError = error
			}

			// rethrow so the library stops the inspection
			throw error
		}
	}

	// return the inspection id as soon as the library announces it
	async start(repositoryUrl: string, choice?: Choice & { signal?: AbortSignal }): Promise<string> {
		// join a running test of the same upgrade
		const upgradeKey = choice?.upgrade && JSON.stringify([repositoryUrl.toLowerCase(), choice.revision, choice.upgrade])
		const running = upgradeKey ? this.upgradeTests.get(upgradeKey) : undefined
		if (running && !running.controller.signal.aborted) {
			return running.accepted
		}

		// prepare separate promises for acceptance and completion
		const controller = new AbortController()
		const state: State = { events: [], step: "Starting inspection", status: "running", controller }
		let id: string | undefined
		const accepted = Promise.withResolvers<string>()

		// share only a test that no single request can cancel
		const upgradeTest = { controller, accepted: accepted.promise }
		if (upgradeKey && !choice?.signal) {
			this.upgradeTests.set(upgradeKey, upgradeTest)
		}

		// run the inspection in the background
		const operation = Promise.resolve()
			.then(() =>
				this.inspect({
					...choice,
					repositoryUrl,
					signal: choice?.signal ? AbortSignal.any([choice.signal, controller.signal]) : controller.signal,
					onEvent: (input) => {
						// Validate before publishing an event or waking a polling client.
						this.screenEvent(state, input)
						const event = eventSchema.parse(input)

						// publish the inspection id as soon as the library announces it
						if (!id && event.type === "inspection.started") {
							id = event.inspectionId
							this.active.set(id, state)
							accepted.resolve(id)
						}

						// bind all subsequent events to the accepted inspection
						if (event.inspectionId !== id) {
							throw new UserError("Inspection event identity mismatch. Start a new inspection.")
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
			.then(async (report) => {
				// verify that the finished report belongs to this job
				if (!id || report.inspectionId !== id) {
					throw new UserError("Inspection identity mismatch. Start a new inspection.")
				}
				this.store.guard(JSON.stringify(report))
				const saved = reportSchema.parse(report)

				// retry storage writes without repeating the inspection
				for (let attempt = 0; ; attempt++) {
					try {
						await this.store.save(saved)
						break
					} catch {
						// retain the report in memory if every write fails
						if (attempt === 2) {
							state.reportText = JSON.stringify(saved)
							state.patches = listPatches(saved)
							throw new UserError(
								"Inspection Report is available in memory only. Check disk space and permissions for ~/.health-code.",
							)
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
				const isDelivery = error instanceof InspectionError && error.code === "event-delivery" && !error.cleanupIds
				state.failure = toFailureMessage(isDelivery ? (state.eventError ?? error) : error)

				// screen the failure message before delivery
				try {
					this.store.guard(state.failure)
				} catch {
					state.failure = "The failure text contained a credential and was withheld. Start a new inspection."
				}
				accepted.reject(new UserError(state.failure))
			})

			// release the cancellation handle when the job settles
			.finally(() => {
				this.jobs.delete(controller)

				// let the next request start a new test
				if (upgradeKey && this.upgradeTests.get(upgradeKey) === upgradeTest) {
					this.upgradeTests.delete(upgradeKey)
				}
			})
		this.jobs.set(controller, operation)
		return accepted.promise
	}
	async run({
		repositoryUrl,
		choice,
		request,
	}: {
		repositoryUrl: string
		choice: Choice
		request: ReadRequest
	}): Promise<string> {
		// Bind cancellation to this call’s inspection.
		request.signal?.throwIfAborted()
		const id = await this.start(repositoryUrl, { ...choice, signal: request.signal })

		// Deliver the durable identity before waiting on long sandbox checks.
		await request.progress?.(`Inspection ${id}`)
		let afterSequence = 0
		for (;;) {
			request.signal?.throwIfAborted()
			const result = await this.read(
				{ inspectionId: id, afterSequence, waitMs: 5000, reportOffset: 0 },
				{ signal: request.signal },
			)
			for (const event of result.events) {
				if (event.type !== "detail") {
					await request.progress?.(`#${event.sequence} · ${toEventLine(event)}`)
				}
			}

			// Drain the last events even if the inspection finished between reads.
			afterSequence = result.nextSequence
			if (result.failure && !result.hasMore) {
				throw new UserError(`Inspection ${id}: ${result.failure}`)
			}

			if (result.status === "complete" && !result.hasMore) {
				break
			}
		}
		return id
	}

	private async waitForEvents(input: Read, request: ReadRequest): Promise<void> {
		// establish the deadline and report the current step before waiting
		const { progress, signal } = request
		let state = this.active.get(input.inspectionId)
		const deadline = Date.now() + input.waitMs
		let step = state?.step ?? "Reading saved Inspection Report"
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
		const timeline = state?.events ?? saved?.report.timeline ?? []

		// page events while pinning sandbox activity across the whole timeline
		const events = timeline.filter((event) => event.sequence > input.afterSequence).slice(0, 8)
		const pinned = timeline
			.filter((event) => event.type === "sandbox.event")
			.map((event) => ({ sequence: event.sequence, action: event.action, detail: event.detail }))

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
			patches: saved ? listPatches(saved.report) : (state?.patches ?? []),
			results,
		}
	}
}
