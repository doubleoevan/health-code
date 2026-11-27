import { randomUUID } from "node:crypto"
import {
	type EventPayload,
	InspectionError,
	type InspectionEvent,
	type InspectionOptions,
	type Operation,
	SandboxUnavailableError,
	type Stage,
	type WithSandboxProvider,
} from "./contracts.ts"
import { InspectionPrompts } from "./readPrompt.ts"
import { redactSecretsIn } from "./redactSecrets.ts"

export const defaultMaxCostUsd = 0.25
const defaultDurationMs = 1800000

// the time each stage gets when the caller sets none
export const defaultStageTimeouts = {
	setup: 300000,
	detect: 60000,
	registry: 180000,
	install: 600000,
	typecheck: 120000,
	tests: 600000,
}
export type StepStatus = "passed" | "failed" | "untested"

// the check stages whose own time limit ends the step without ending the inspection
const checkStages: ReadonlySet<Stage> = new Set(["install", "typecheck", "tests"])

/**
 * Reports a check step that reached its own time limit before the inspection's.
 */
export class CheckTimeoutError extends InspectionError {
	constructor(
		readonly stage: Stage,
		readonly limitMs: number,
	) {
		super("check-timeout", `The ${stage} step reached its ${toLimitText(limitMs)} limit.`)
		this.name = "CheckTimeoutError"
	}
}

// name a limit in whole minutes when it has no leftover seconds
function toLimitText(limitMs: number): string {
	const seconds = Math.round(limitMs / 1000)
	return seconds > 0 && seconds % 60 === 0 ? `${seconds / 60}-minute` : `${seconds}-second`
}

type TrackStepOptions<T> = {
	emit: (payload: EventPayload) => Promise<void>
	stepId: string
	label: string
	work: (stepId: string) => Promise<T>
	toStatus?: (value: T) => StepStatus
}

export function checkOperation(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new InspectionError("deadline", "Inspection interrupted")
	}
}

/**
 * Bounds promises even when a callback or transport ignores cancellation.
 */
export async function bounded<T>(
	work: (signal: AbortSignal) => Promise<T>,
	options: Operation,
	toTimeoutError: () => InspectionError = () => new InspectionError("deadline", "Inspection interrupted"),
): Promise<T> {
	// combine the command deadline with caller cancellation
	const timeout = AbortSignal.timeout(Math.max(1, Math.min(2147483647, Math.floor(options.timeoutMs))))
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
	const reason = (): InspectionError =>
		options.signal?.aborted ? new InspectionError("cancelled", "Inspection interrupted") : toTimeoutError()
	if (signal.aborted || options.timeoutMs <= 0) {
		throw reason()
	}

	// arrange for cancellation to reject pending work
	let rejectAbort: () => void = () => {}
	const interrupted = new Promise<never>((_, reject) => {
		rejectAbort = () => reject(reason())
		signal.addEventListener("abort", rejectAbort, { once: true })
	})
	try {
		// race execution with the deadline and remove the listener afterward
		return await Promise.race([work(signal), interrupted])
	} finally {
		signal.removeEventListener("abort", rejectAbort)
	}
}

/**
 * Builds a redacted Inspection Event from a payload and its place in the timeline.
 */
export function toInspectionEvent(
	payload: EventPayload,
	{ inspectionId, sequence, upgradeId }: { inspectionId: string; sequence: number; upgradeId?: string },
): InspectionEvent {
	return redactSecretsIn<InspectionEvent>({
		...payload,
		version: 1,
		inspectionId,
		sequence,
		timestamp: new Date().toISOString(),
		...(upgradeId ? { upgradeId } : {}),
	})
}

/**
 * Builds the error for an event callback that failed.
 */
export function toEventDeliveryError(): InspectionError {
	return new InspectionError("event-delivery", "Inspection event callback failed")
}

/**
 * Emits a step's started event, performs its work and emits the finished event with its status.
 */
export async function trackStep<T>({ emit, stepId, label, work, toStatus }: TrackStepOptions<T>): Promise<T> {
	// bind the completion event to this step's start
	const start = Date.now()
	const finish = (status: StepStatus): Promise<void> =>
		emit({ type: "step.finished", stepId, status, summary: label, durationMs: Date.now() - start })
	let value: T
	try {
		// emit the start before executing the step
		await emit({ type: "step.started", stepId, label })
		value = await work(stepId)
	} catch (error) {
		// keep the work error when its failure event also cannot be delivered
		await finish("failed").catch(() => undefined)
		throw error
	}
	await finish(toStatus?.(value) ?? "passed")
	return value
}

/**
 * Reserves teardown time for each possibly allocated runtime.
 */
export function cleanupAllowance(durationMs: number): number {
	return Math.min(60000, Math.max(1, Math.floor(durationMs / 4)))
}

export class InspectionContext {
	readonly id = randomUUID()
	readonly timeline: InspectionEvent[] = []
	readonly prompts: InspectionPrompts
	readonly started = Date.now()
	readonly cleanupMs: number
	readonly end: number
	readonly maximum: number

	// track nested deadlines and delivery failures
	private readonly timeouts: Record<Stage, number>
	private deliveryFailed = false
	private groupEnd?: number
	private detectionEnd?: number
	private setupStarted = this.started
	attemptEnd?: number

	// retain teardown and upgrade state for event delivery
	cleaningUp = false
	setupComplete = false
	upgradeId?: string
	constructor(
		readonly options: InspectionOptions & WithSandboxProvider,
		private readonly observe?: (event: InspectionEvent) => () => Promise<void>,
		reserveCleanupGrace = false,
	) {
		this.prompts = new InspectionPrompts(options.prompts)
		const limits = options.limits ?? {}
		const duration = limits.maxDurationMs ?? defaultDurationMs
		const cost = limits.maxCostUsd ?? defaultMaxCostUsd
		this.maximum = limits.maxUpgrades ?? 6
		this.timeouts = { ...defaultStageTimeouts, ...limits.timeouts }

		// validate numeric limits before admitting work
		if (
			!Number.isSafeInteger(this.maximum) ||
			this.maximum < 0 ||
			![duration, cost, ...Object.values(this.timeouts)].every((value) => Number.isFinite(value) && value >= 0) ||
			duration > 2147483647
		) {
			throw new InspectionError("invalid-limits", "Invalid inspection limits")
		}

		// Reserve teardown time before admitting any paid work.
		const budgetMicros = Math.floor(cost * 1000000)
		let low = 0
		let high = Math.floor(duration)
		while (low < high) {
			// search for the longest duration affordable within the sandbox budget
			const middle = Math.ceil((low + high) / 2)
			const estimate = options.sandboxProvider.estimateMaxCost(
				middle + (reserveCleanupGrace ? cleanupAllowance(middle) : 0),
			)
			if (Number.isFinite(estimate) && estimate >= 0 && Math.ceil(estimate * 1000000) <= budgetMicros) {
				low = middle
			} else {
				high = middle - 1
			}
		}

		// reserve a portion of the affordable window for cleanup
		this.cleanupMs = cleanupAllowance(low)
		this.end = this.started + low
	}
	cleanupWindow(): number {
		const remaining = this.end - Date.now()
		return remaining > 0 ? Math.min(this.cleanupMs, remaining) : this.cleanupMs
	}

	// Give the replacement checkout fresh stage deadlines within the original inspection window.
	restartSetup(): void {
		this.setupStarted = Date.now()
		this.setupComplete = false
		this.detectionEnd = undefined
	}

	// share the detection deadline across detection operations
	operation(stage: Stage): Operation {
		if (stage === "detect") {
			this.detectionEnd ??= Date.now() + this.timeouts.detect
		}
		return {
			timeoutMs: Math.min(
				this.timeouts[stage],
				stage === "detect" ? (this.detectionEnd ?? this.end) - Date.now() : Infinity,
				stage === "setup" && !this.setupComplete ? this.setupStarted + this.timeouts.setup - Date.now() : Infinity,
				this.remainingInspectionMs(),
			),
			signal: this.options.signal,
		}
	}

	// the milliseconds left before the patch group, the attempt or the inspection ends
	private remainingInspectionMs(): number {
		return Math.min(
			(this.groupEnd ?? Infinity) - Date.now(),
			(this.attemptEnd ?? this.end) - Date.now(),
			this.end - Date.now() - this.cleanupMs,
		)
	}
	async emit(payload: EventPayload): Promise<void> {
		const previous = this.timeline.at(-1)?.type
		if (previous === "inspection.finished" || previous === "inspection.failed") {
			return
		}
		const event = toInspectionEvent(payload, {
			inspectionId: this.id,
			sequence: this.timeline.length + 1,
			upgradeId: this.upgradeId,
		})
		this.timeline.push(event)

		// deliver the event after appending it to the timeline
		const callback = this.observe?.(event) ?? (() => this.options.onEvent?.(structuredClone(event)))
		await this.deliver(callback)
	}
	assertActive(): void {
		if (this.deliveryFailed) {
			throw toEventDeliveryError()
		}

		// surface caller cancellation before the next operation
		if (this.options.signal?.aborted) {
			throw new InspectionError("cancelled", "Inspection interrupted")
		}
	}
	async deliver(callback: () => void | Promise<void>): Promise<void> {
		if (this.deliveryFailed || (!this.options.onEvent && !this.observe)) {
			return
		}

		// bound event delivery by the remaining inspection window
		try {
			const remaining = this.end - Date.now() - (this.cleaningUp ? 0 : this.cleanupMs)
			await bounded(async () => callback(), {
				timeoutMs: Math.min(10000, remaining),
				signal: this.cleaningUp ? undefined : this.options.signal,
			})
		} catch (error) {
			// preserve cancellation and flag other delivery failures
			if (this.options.signal?.aborted && error instanceof InspectionError && error.code === "cancelled") {
				throw error
			}
			this.deliveryFailed = true
			throw toEventDeliveryError()
		}
	}

	/**
	 * Applies a shared deadline to a group of inspection operations.
	 */
	async group<T>(stage: Stage, label: string, work: () => Promise<T>): Promise<T> {
		// restrict nested work to the enclosing group's deadline
		const previous = this.groupEnd
		this.groupEnd = Date.now() + this.operation(stage).timeoutMs
		try {
			return await this.track(label, async () => {
				const result = await work()
				this.assertActive()

				// recheck the group deadline after its work returns
				if (this.operation(stage).timeoutMs <= 0) {
					throw new InspectionError("deadline", "Patch verification deadline reached")
				}
				return result
			})
		} finally {
			// restore the enclosing deadline when the group exits
			this.groupEnd = previous
		}
	}

	// track each stage with a bounded operation. a check stage that reaches its own limit resolves through onCheckTimeout
	async step<T>(
		stage: Stage,
		label: string,
		work: (options: Operation, stepId: string) => Promise<T>,
		status?: (value: T) => StepStatus,
		onCheckTimeout?: (error: CheckTimeoutError) => T,
	): Promise<T> {
		return this.track(
			label,
			async (stepId) => {
				// name the check's own limit when it ends before the inspection window
				const operation = this.operation(stage)
				const limitMs = this.timeouts[stage]
				const isCheckLimited = checkStages.has(stage) && limitMs < this.remainingInspectionMs()
				const toTimeoutError = isCheckLimited ? () => new CheckTimeoutError(stage, limitMs) : undefined

				// keep the started work so a timed-out step can wait for it
				let pendingWork: Promise<T> | undefined
				const startWork = (signal: AbortSignal): Promise<T> => {
					pendingWork = work({ ...operation, signal }, stepId)
					return pendingWork
				}

				// record a timed-out check step through its handler and rethrow everything else
				try {
					return await bounded(startWork, operation, toTimeoutError)
				} catch (error) {
					if (!onCheckTimeout || !(error instanceof CheckTimeoutError)) {
						throw error
					}

					// wait for the sandbox to end the abandoned command, which frees the sandbox for the next check. keep a lost sandbox for recovery
					const settledWork = pendingWork?.catch((lateError: unknown) => {
						if (lateError instanceof SandboxUnavailableError) {
							throw lateError
						}
					})
					await bounded(async () => settledWork, {
						timeoutMs: this.remainingInspectionMs(),
						signal: this.options.signal,
					})
					return onCheckTimeout(error)
				}
			},
			status,
		)
	}
	private async track<T>(
		label: string,
		work: (stepId: string) => Promise<T>,
		toStatus?: (value: T) => StepStatus,
	): Promise<T> {
		this.assertActive()
		const stepId = String(this.timeline.length + 1)
		const emit = (payload: EventPayload): Promise<void> => this.emit(payload)
		const value = await trackStep({ emit, stepId, label, work, toStatus })

		// enforce the outer deadline after the result is published
		this.assertActive()
		if (this.groupEnd && Date.now() >= this.groupEnd) {
			throw new InspectionError("deadline", "Patch verification deadline reached")
		}
		return value
	}
}

export function rethrowInspectionFailure(error: unknown, context: InspectionContext): void {
	context.assertActive()
	if (error instanceof InspectionError && ["cancelled", "event-delivery"].includes(error.code)) {
		throw error
	}
}
