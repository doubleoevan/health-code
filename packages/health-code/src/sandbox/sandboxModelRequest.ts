import { setTimeout as delay } from "node:timers/promises"
import { z } from "zod"
import type { ModelReply, ModelRoute } from "../agentContracts.ts"
import { InspectionError, type Operation } from "../contracts.ts"
import type { SandboxModelRequest } from "../modelRequestSandbox.ts"
import { type Runtime, remainingOperation } from "./requestRuntime.ts"
import { credentialTarget } from "./setCredentialBinding.ts"

const tokens = z.number().int().nonnegative().optional()
const anthropic = z.object({
	id: z.string(),
	content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
	usage: z.object({ input_tokens: tokens, output_tokens: tokens }),
})
const compatible = z.object({
	id: z.string(),
	choices: z.tuple([z.object({ message: z.object({ content: z.string() }) })]).rest(z.unknown()),
	usage: z.object({ prompt_tokens: tokens, completion_tokens: tokens }),
})

type PostOptions = { runtime: Runtime; route: ModelRoute; body: object; operation: Operation }

type ConfirmGatewayOptions = {
	runtime: Runtime
	route: ModelRoute
	isCredentialAttached: boolean
	operation: Operation
}
type SendSandboxModelRequestOptions = { runtime: Runtime; request: SandboxModelRequest; operation: Operation }

// Send request data to the trusted image’s HTTPS client on stdin.
async function post({
	runtime,
	route,
	body,
	operation,
}: PostOptions): Promise<{ status: number; text: string; timing?: ModelReply["timing"] }> {
	const seconds = Math.max(1, Math.ceil(operation.timeoutMs / 1000))
	const header = route.credential.valueTemplate.replace(`\${credential}`, "runta-secret-stub")
	const argv = [
		"/usr/bin/env",
		"-i",
		"/usr/bin/curl",
		"-q",
		"--globoff",
		"--silent",
		"--proto",
		"=https",
		"--max-time",
		String(seconds),
		"--max-filesize",
		"65536",
		"--write-out",
		operation.modelCallId ? "\n%{time_total} %{http_code}" : "\n%{http_code}",
		"--data-binary",
		"@-",
		"-H",
		"Content-Type: application/json",
		"-H",
		`${route.credential.header}: ${header}`,
	]
	if (route.protocol === "anthropic") {
		argv.push("-H", "anthropic-version: 2023-06-01")
	}
	// Limit the response body before reading the trailing HTTP status.
	const result = await runtime.exec([...argv, "--", credentialTarget(route).href], {
		stdin: JSON.stringify(body),
		timeoutSecs: seconds,
		maxOutputBytes: 65536 + 32,
	})
	if (result.exitCode || result.stdoutTruncated) {
		throw new InspectionError("model-request-sandbox", "Model request sandbox HTTPS request failed")
	}
	// Read the optional curl timing locally without passing trace headers to the model.
	const boundary = result.stdoutText.lastIndexOf("\n")
	const trailer = result.stdoutText.slice(boundary + 1).split(" ")
	const status = Number(trailer.pop())
	// Accept a duration only when curl returned the timing field.
	const secondsElapsed = Number(trailer[0])
	const timing =
		operation.modelCallId && Number.isFinite(secondsElapsed)
			? { modelCallId: operation.modelCallId, durationMs: Math.round(secondsElapsed * 1000) }
			: undefined
	return { status, text: result.stdoutText.slice(0, boundary), timing }
}

/**
 * Verifies the credential state with an unpaid request to the model host.
 */
export async function confirmGateway({
	runtime,
	route,
	isCredentialAttached,
	operation,
}: ConfirmGatewayOptions): Promise<void> {
	const remaining = remainingOperation(operation)
	for (let wait = 250; ; wait = Math.min(2000, wait * 2)) {
		const probe = remaining()
		const { status } = await post({
			runtime,
			route,
			body: {},
			operation: { ...probe, timeoutMs: Math.min(8000, probe.timeoutMs) },
		}).catch(() => ({ status: 0 }))
		// An empty body gets 401 before binding and a validation error after authentication.
		if (isCredentialAttached ? [400, 422].includes(status) : status === 401) {
			return
		}
		if (![0, 401, 403, 400, 422, 429, 502, 503, 504].includes(status)) {
			throw new InspectionError("credential-binding", `Model gateway rejected verification (HTTP ${status})`)
		}
		// Back off only for the unpaid readiness request.
		await delay(Math.min(wait, remaining().timeoutMs), undefined, { signal: operation.signal })
	}
}

/**
 * Sends one bounded model request and returns the provider’s usage receipt.
 */
export async function sendSandboxModelRequest({
	runtime,
	request,
	operation,
}: SendSandboxModelRequestOptions): Promise<ModelReply> {
	const { route, prompt, output } = request
	const body = {
		model: route.modelId,
		max_tokens: output,
		messages: [{ role: "user", content: prompt }],
		...(route.protocol === "anthropic" && route.effort ? { output_config: { effort: route.effort } } : {}),
	}
	const { status, text, timing } = await post({ runtime, route, body, operation })
	if (status !== 200) {
		throw new InspectionError("model-request-sandbox", `Model gateway returned HTTP ${status}`)
	}
	// Decode the same usage fields for each protocol without exporting raw headers.
	if (route.protocol === "anthropic") {
		const reply = anthropic.parse(JSON.parse(text))
		return {
			text: reply.content
				.filter((item) => item.type === "text")
				.map((item) => item.text ?? "")
				.join(""),
			...(timing && { timing }),
			modelId: route.modelId,
			requestId: reply.id,
			inputTokens: reply.usage.input_tokens,
			outputTokens: reply.usage.output_tokens,
		}
	}
	const reply = compatible.parse(JSON.parse(text))
	return {
		text: reply.choices[0].message.content,
		...(timing && { timing }),
		modelId: route.modelId,
		requestId: reply.id,
		inputTokens: reply.usage.prompt_tokens,
		outputTokens: reply.usage.completion_tokens,
	}
}
