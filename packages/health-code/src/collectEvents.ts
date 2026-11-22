import { randomUUID } from "node:crypto"
import {
	type EventPayload,
	InspectionError,
	type InspectionEvent,
	type InspectionOptions,
	type Operation,
	type Stage,
} from "./contracts.ts"
import { InspectionPrompts } from "./readPrompt.ts"

export const defaultMaxCostUsd = 0.25
export const defaultDurationMs = 1800000
const defaults = { setup: 300000, detect: 60000, registry: 180000, install: 180000, typecheck: 120000, tests: 180000 }

/**
 * Redacts credentials before evidence crosses the library boundary.
 */
export function redact(text: string): string {
	return text
		.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
		.replace(
			/\b(?:(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+|(?:gh[pousr]_|github_pat_|sk-|rt_|npm_)[A-Za-z0-9_-]{8,})/gi,
			"[redacted]",
		)
		.replace(/("(?:[^"\\]*(?:token|password|secret|api[_-]?key))"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[redacted]"')
		.replace(
			/((?:token|password|secret|api[_-]?key)["']?\s*[=:]\s*)(["'])(?:\\[\s\S]|(?!\2)[^\\])*?\2/gi,
			"$1[redacted]",
		)
		.replace(/((?:token|password|secret|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, "$1[redacted]")
}

/**
 * Scrubs repository-controlled identifiers as well as output before publishing JSON.
 */
export function redactEvidence<T>(value: T): T {
	if (typeof value === "string") {
		return redact(value) as T
	}

	// redact strings recursively inside arrays and objects
	if (Array.isArray(value)) {
		return value.map(redactEvidence) as T
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [
				redact(key),
				typeof item === "string" && /(?:token|password|secret|api[_-]?key)$/i.test(key)
					? "[redacted]"
					: redactEvidence(item),
			]),
		) as T
	}
	return value
}

export function checkOperation(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new InspectionError("deadline", "Inspection interrupted")
	}
}

/**
 * Bounds promises even when a callback or transport ignores cancellation.
 */
export async function bounded<T>(work: (signal: AbortSignal) => Promise<T>, options: Operation): Promise<T> {
	// combine the command deadline with caller cancellation
	const timeout = AbortSignal.timeout(Math.max(1, Math.min(2147483647, Math.floor(options.timeoutMs))))
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
	const reason = (): InspectionError =>
		new InspectionError(options.signal?.aborted ? "cancelled" : "deadline", "Inspection interrupted")
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
		readonly options: InspectionOptions,
		private readonly observe?: (event: InspectionEvent) => () => Promise<void>,
		reserveCleanupGrace = false,
	) {
		this.prompts = new InspectionPrompts(options.prompts)
		const limits = options.limits ?? {}
		const duration = limits.maxDurationMs ?? defaultDurationMs
		const cost = limits.maxCostUsd ?? defaultMaxCostUsd
		this.maximum = limits.maxUpgrades ?? 6
		this.timeouts = { ...defaults, ...limits.timeouts }

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
				(this.groupEnd ?? Infinity) - Date.now(),
				(this.attemptEnd ?? this.end) - Date.now(),
				stage === "detect" ? (this.detectionEnd ?? this.end) - Date.now() : Infinity,
				this.end - Date.now() - this.cleanupMs,
				stage === "setup" && !this.setupComplete ? this.setupStarted + this.timeouts.setup - Date.now() : Infinity,
			),
			signal: this.options.signal,
		}
	}
	async emit(payload: EventPayload): Promise<void> {
		const previous = this.timeline.at(-1)?.type
		if (previous === "inspection.finished" || previous === "inspection.failed") {
			return
		}
		const event: InspectionEvent = redactEvidence<InspectionEvent>({
			...payload,
			version: 1,
			inspectionId: this.id,
			sequence: this.timeline.length + 1,
			timestamp: new Date().toISOString(),
			...(this.upgradeId ? { upgradeId: this.upgradeId } : {}),
		})
		this.timeline.push(event)

		// deliver the event after appending it to the timeline
		const callback = this.observe?.(event) ?? (() => this.options.onEvent?.(structuredClone(event)))
		await this.deliver(callback)
	}
	assertActive(): void {
		if (this.deliveryFailed) {
			throw new InspectionError("event-delivery", "Inspection event callback failed")
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
			throw new InspectionError("event-delivery", "Inspection event callback failed")
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

	// track each stage with a bounded operation
	async step<T>(
		stage: Stage,
		label: string,
		work: (options: Operation, stepId: string) => Promise<T>,
		status?: (value: T) => "passed" | "failed" | "untested",
	): Promise<T> {
		return this.track(
			label,
			async (stepId) => {
				const operation = this.operation(stage)
				return bounded((signal) => work({ ...operation, signal }, stepId), operation)
			},
			status,
		)
	}
	private async track<T>(
		label: string,
		work: (stepId: string) => Promise<T>,
		status?: (value: T) => "passed" | "failed" | "untested",
	): Promise<T> {
		this.assertActive()
		const start = Date.now()
		const stepId = String(this.timeline.length + 1)

		// bind the completion event to this step's start
		const finish = (result: "passed" | "failed" | "untested"): Promise<void> =>
			this.emit({ type: "step.finished", stepId, status: result, summary: label, durationMs: Date.now() - start })
		let value: T
		try {
			// emit the start before executing the step
			await this.emit({ type: "step.started", stepId, label })
			value = await work(stepId)
		} catch (error) {
			// Keep the work error if its failure event also cannot be delivered.
			await finish("failed").catch(() => undefined)
			throw error
		}

		// publish the result before enforcing the outer deadline
		await finish(status?.(value) ?? "passed")
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
