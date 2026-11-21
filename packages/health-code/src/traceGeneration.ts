import { randomUUID } from "node:crypto"
import type { Span, Tracer } from "@opentelemetry/api"
import type { generateText } from "ai"

import type { ModelReply, ModelRole } from "./agentContracts.ts"
import type { PromptReference } from "./readPrompt.ts"

export type GenerationTelemetry = NonNullable<Parameters<typeof generateText>[0]["telemetry"]>
type TelemetryIntegration = Exclude<NonNullable<GenerationTelemetry["integrations"]>, readonly unknown[]>

/** Tracks one model dispatch using the caller's tracer and bounded attributes. */
export function traceGeneration(options: { tracer?: Tracer; role: ModelRole; prompt: PromptReference }):
	| {
			modelCallId: string
			start: () => void
			integration: TelemetryIntegration
			finish: (
				status: "complete" | "failed" | "cancelled",
				usage?: Pick<ModelReply, "inputTokens" | "outputTokens" | "timing">,
			) => void
	  }
	| undefined {
	if (!options.tracer) {
		return
	}

	const modelCallId = randomUUID()
	let attempted = false
	let span: Span | undefined
	const { tracer, role, prompt } = options
	// Keep raw requests, provider headers, responses and errors outside the trace.
	function start(): void {
		if (attempted) {
			return
		}
		attempted = true
		try {
			span = tracer?.startSpan("health-code.generate", {
				attributes: {
					"health-code.role": role,
					"health-code.call.id": modelCallId,
					"health-code.prompt.name": prompt.name,
					"health-code.prompt.version": prompt.version,
					"health-code.prompt.sha256": prompt.sha256,
				},
			})
		} catch {
			/* Let inspection continue when a caller's tracer fails. */
		}
	}
	function finish(
		status: "complete" | "failed" | "cancelled",
		usage?: Pick<ModelReply, "inputTokens" | "outputTokens" | "timing">,
	): void {
		const current = span
		span = undefined
		if (!current) {
			return
		}
		try {
			for (const [key, count] of [
				["input", usage?.inputTokens],
				["output", usage?.outputTokens],
			] as const) {
				if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) {
					current.setAttribute(`gen_ai.usage.${key}_tokens`, count)
				}
			}
			recordRemoteDuration(current, modelCallId, usage?.timing)
			current.setStatus({ code: status === "complete" ? 1 : 2, message: status })
		} catch {
			/* Preserve the model outcome if recording fails. */
		} finally {
			try {
				current.end()
			} catch {
				/* Isolate failures from the caller's exporter. */
			}
		}
	}
	return { modelCallId, start, integration: { onStart: start }, finish }
}

function recordRemoteDuration(span: Span, modelCallId: string, timing?: ModelReply["timing"]): void {
	if (
		timing?.modelCallId === modelCallId &&
		// Bound timing supplied by the remote runtime before export.
		Number.isSafeInteger(timing.durationMs) &&
		timing.durationMs >= 0 &&
		timing.durationMs <= 3600000
	) {
		span.setAttribute("health-code.remote.duration_ms", timing.durationMs)
	}
}
