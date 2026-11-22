import { generateText } from "ai"
import { buildPrompt, parseAnswer } from "./buildPrompt.ts"
import type { InspectionContext } from "./collectEvents.ts"
import { InspectionError } from "./contracts.ts"
import type { ModelInspection } from "./inspectModels.ts"
import { paidRequest, reserveCost } from "./modelBudget.ts"
import { callerOutputTokens, type ModelRequestSandboxEvent } from "./modelRequestSandbox.ts"

export async function requestHostModel({
	engine,
	role,
	evidence,
	context,
}: {
	engine: ModelInspection
	role: "releaseSummary" | "featureMatch"
	evidence: unknown
	context: InspectionContext
}): Promise<unknown> {
	const configured = engine.options.models[role]
	const { pricing } = configured

	// build a bounded prompt for the selected host role
	const prompt = await buildPrompt(role, evidence, context.prompts)
	const output = callerOutputTokens
	const reserve = reserveCost({ pricing, prompt, output })
	if (engine.modelRequestSandbox && "credential" in configured) {
		const modelRequestSandbox = engine.modelRequestSandbox
		await modelRequestSandbox.ready({
			context,
			ledger: engine.ledger,
			requestMicros: reserve,
			start: async (name) => {
				const options = engine.options
				if (options.callerModelExecution !== "modelRequestSandbox") {
					throw new InspectionError("model-request-sandbox", "Invalid model request sandbox configuration")
				}
				const event: ModelRequestSandboxEvent = {
					version: 2,
					type: "sandbox.event",
					action: "model-request-sandbox-started",
					sandboxId: name,
					inspectionId: context.id,
					sequence: engine.timeline.length + 1,
					timestamp: new Date().toISOString(),
					detail:
						"Model request sandbox started. The sandbox provider supplies the model key. This machine doesn’t need it.",
				}
				engine.timeline.push(event)
				await context.deliver(() => options.onEvent?.(structuredClone(event)))
			},
			route: configured,
			allocated: (name, reservedUsd) =>
				engine.meter.start(
					"modelRequestSandbox",
					name,
					(ms) => modelRequestSandbox.provider.estimateMaxCost(ms),
					reservedUsd,
				),
		})
	}
	const text = await context.step("setup", role, (operation) =>
		paidRequest({
			ledger: engine.ledger,
			context,
			execution: engine.modelRequestSandbox ? "modelRequestSandbox" : undefined,
			role,
			step: role,
			pricing,
			modelId: "model" in configured ? configured.model.modelId : configured.modelId,
			prompt,
			output,
			signal: operation.signal,
			send: async (budget, telemetry) => {
				if ("credential" in configured && engine.modelRequestSandbox) {
					return engine.modelRequestSandbox.send({ role, route: configured, prompt, output }, budget)
				}
				if (!("model" in configured)) {
					throw new InspectionError("invalid-model", "Missing caller model")
				}

				// Dispatch local handles through the caller’s model client.
				const { model } = configured
				const reply = await generateText({
					model,
					prompt,
					maxRetries: 0,
					maxOutputTokens: output,
					abortSignal: budget.signal,
					telemetry,
				})
				return {
					text: reply.text,
					modelId: model.modelId,
					inputTokens: reply.usage.inputTokens,
					outputTokens: reply.usage.outputTokens,
					requestId: reply.response.id,
				}
			},
		}),
	)
	return parseAnswer(text)
}
