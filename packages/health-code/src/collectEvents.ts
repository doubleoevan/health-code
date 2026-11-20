import { randomUUID } from "node:crypto"
import {
	type EventPayload,
	InspectionError,
	type InspectionEvent,
	type InspectionOptions,
	type Operation,
	type Stage,
} from "./contracts.ts"

const defaults = { setup: 300000, detect: 60000, install: 180000, typecheck: 120000, tests: 180000 }

/** Redacts credentials before evidence crosses the library boundary. */
export function redact(text: string): string {
	return text
		.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
		.replace(
			/\b(?:Bearer\s+[A-Za-z0-9._~+/=-]+|(?:gh[pousr]_|github_pat_|sk-|rt_|npm_)[A-Za-z0-9_-]{8,})/gi,
			"[redacted]",
		)
		.replace(/("(?:[^"\\]*(?:token|password|secret|api[_-]?key))"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[redacted]"')
		.replace(/((?:token|password|secret|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, "$1[redacted]")
}

/** Scrubs repository-controlled identifiers as well as output before publishing JSON. */
export function redactEvidence<T>(value: T): T {
	if (typeof value === "string") {
		return redact(value) as T
	}
	if (Array.isArray(value)) {
		return value.map(redactEvidence) as T
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), redactEvidence(item)])) as T
	}
	return value
}

export function checkOperation(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new InspectionError("deadline", "Inspection interrupted")
	}
}

/** Bounds promises even when a callback or transport ignores cancellation. */
export async function bounded<T>(work: (signal: AbortSignal) => Promise<T>, options: Operation): Promise<T> {
	const timeout = AbortSignal.timeout(Math.max(1, Math.min(2147483647, Math.floor(options.timeoutMs))))
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
	const reason = (): InspectionError =>
		new InspectionError(options.signal?.aborted ? "cancelled" : "deadline", "Inspection interrupted")
	if (signal.aborted || options.timeoutMs <= 0) {
		throw reason()
	}
	let rejectAbort: () => void = () => {}
	const interrupted = new Promise<never>((_, reject) => {
		rejectAbort = () => reject(reason())
		signal.addEventListener("abort", rejectAbort, { once: true })
	})
	try {
		return await Promise.race([work(signal), interrupted])
	} finally {
		signal.removeEventListener("abort", rejectAbort)
	}
}

export class InspectionContext {
	readonly id = randomUUID()
	readonly timeline: InspectionEvent[] = []
	readonly started = Date.now()
	readonly cleanupMs: number
	readonly end: number
	readonly maximum: number
	private readonly timeouts: Record<Stage, number>
	private deliver = true
	private detectionEnd?: number
	cleaningUp = false
	setupComplete = false
	upgradeId?: string
	constructor(readonly options: InspectionOptions) {
		const limits = options.limits ?? {}
		const duration = limits.maxDurationMs ?? 1800000
		const cost = limits.maxCostUsd ?? 0.25
		this.maximum = limits.maxUpgrades ?? 6
		this.timeouts = { ...defaults, ...limits.timeouts }
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
			const middle = Math.ceil((low + high) / 2)
			const estimate = options.sandboxProvider.estimateMaxCost(middle)
			if (Number.isFinite(estimate) && estimate >= 0 && Math.ceil(estimate * 1000000) <= budgetMicros) {
				low = middle
			} else {
				high = middle - 1
			}
		}
		this.cleanupMs = Math.min(60000, Math.max(1, Math.floor(low / 4)))
		this.end = this.started + low
	}
	operation(stage: Stage): Operation {
		if (stage === "detect") {
			this.detectionEnd ??= Date.now() + this.timeouts.detect
		}
		return {
			timeoutMs: Math.min(
				this.timeouts[stage],
				stage === "detect" ? (this.detectionEnd ?? this.end) - Date.now() : Infinity,
				this.end - Date.now() - this.cleanupMs,
				stage === "setup" && !this.setupComplete ? this.started + this.timeouts.setup - Date.now() : Infinity,
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
		const callback = this.options.onEvent
		if (!callback || !this.deliver) {
			return
		}
		try {
			const remaining = this.end - Date.now() - (this.cleaningUp ? 0 : this.cleanupMs)
			await bounded(async () => callback(structuredClone(event)), {
				timeoutMs: Math.min(10000, remaining),
				signal: this.cleaningUp ? undefined : this.options.signal,
			})
		} catch (error) {
			if (this.options.signal?.aborted && error instanceof InspectionError && error.code === "cancelled") {
				throw error
			}
			this.deliver = false
			throw new InspectionError("event-delivery", "Inspection event callback failed")
		}
	}
	async step<T>(
		stage: Stage,
		label: string,
		work: (options: Operation, stepId: string) => Promise<T>,
		status?: (value: T) => "passed" | "failed" | "untested",
	): Promise<T> {
		const start = Date.now()
		const stepId = String(this.timeline.length + 1)
		const finish = (result: "passed" | "failed" | "untested"): Promise<void> =>
			this.emit({ type: "step.finished", stepId, status: result, summary: label, durationMs: Date.now() - start })
		let value: T
		try {
			await this.emit({ type: "step.started", stepId, label })
			const operation = this.operation(stage)
			value = await bounded((signal) => work({ ...operation, signal }, stepId), operation)
		} catch (error) {
			// Keep the work error if its failure event also cannot be delivered.
			await finish("failed").catch(() => undefined)
			throw error
		}
		await finish(status?.(value) ?? "passed")
		return value
	}
}
