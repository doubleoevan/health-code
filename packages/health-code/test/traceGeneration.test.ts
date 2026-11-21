import assert from "node:assert/strict"
import { test } from "node:test"
import { createAnthropic } from "@ai-sdk/anthropic"
import type { Tracer } from "@opentelemetry/api"
import { generateText } from "ai"
import { traceGeneration } from "../src/traceGeneration.ts"

test("per-call SDK telemetry is isolated and excludes raw content", async () => {
	const payload = "fixture-private-user-text"
	const provider = createAnthropic({
		apiKey: "fixture",
		fetch: async () =>
			Response.json({
				id: "msg_example",
				type: "message",
				role: "assistant",
				model: "fixture",
				content: [{ type: "text", text: payload }],
				stop_reason: "end_turn",
				stop_sequence: null,
				usage: { input_tokens: 5, output_tokens: 1 },
			}),
	})
	const prompt = { name: "repair" as const, version: 1, sha256: "a".repeat(64) }

	// Capture only what the caller's tracer receives from each dispatch.
	const run = async (events: unknown[], fails: boolean): Promise<void> => {
		const tracer = {
			startSpan(name: string, options: unknown): unknown {
				events.push({ name, options })
				if (fails) {
					throw Error("fixture exporter failure")
				}
				return {
					setAttribute: (key: string, value: number) => events.push({ key, value }),
					setStatus: () => {},
					end: () => events.push("ended"),
				}
			},
		} as unknown as Tracer

		// Exercise the SDK callback with a local provider response.
		const traced = traceGeneration({ tracer, role: "repair", prompt })
		const result = await generateText({
			model: provider("fixture"),
			maxOutputTokens: 1,
			prompt: payload,
			telemetry: { isEnabled: true, recordInputs: false, recordOutputs: false, integrations: traced?.integration },
		})
		traced?.finish("complete", result.usage)
		assert.equal(result.text, payload)
	}

	// Compare independent caller traces after both promises settle.
	const left: unknown[] = [],
		right: unknown[] = []
	await Promise.all([run(left, false), run(right, true)])
	assert.ok(left.includes("ended"))
	assert.equal(right.length, 1)
	assert.ok(!JSON.stringify(left).includes(payload))
	assert.ok(JSON.stringify(left).includes("health-code.prompt.sha256"))
	assert.equal(traceGeneration({ role: "repair", prompt }), undefined)
})

test("a cancelled paid request closes only its caller span and records the dispatched prompt", async () => {
	const { paidRequest } = await import("../src/modelBudget.ts")
	const { InspectionContext } = await import("../src/collectEvents.ts")
	const { createFakeSandboxProvider } = await import("../src/index.ts")
	const events: string[] = []
	const telemetry = {
		startSpan: () => ({
			setStatus: ({ message }: { message: string }) => events.push(message),
			end: () => events.push("ended"),
		}),
	} as unknown as Tracer
	const context = new InspectionContext({
		repositoryUrl: "https://github.com/example/project",
		sandboxProvider: createFakeSandboxProvider({ commit: "", commands: [] }),
		telemetry,
	})
	const controller = new AbortController()

	// Cancel after entering the guest transport so the receipt remains outstanding.
	await assert.rejects(
		paidRequest({
			context,
			ledger: { end: Date.now() + 30000, remainingMicros: 100000, usage: [] },
			role: "repair",
			step: "repair",
			modelId: "fixture",
			prompt: "fixture",
			output: 1,
			pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 1, maxInputTokens: 2048 },
			signal: controller.signal,
			send: async (operation) => {
				assert.ok(operation.modelCallId)
				controller.abort()
				throw Error("cancelled fixture")
			},
		}),
	)
	assert.deepEqual(events, ["cancelled", "ended"])
	assert.deepEqual(context.prompts.references.model, [context.prompts.template("repair").reference])
})
