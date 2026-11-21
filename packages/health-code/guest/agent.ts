import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { generateText, tool } from "ai"
import type { ModelRoute } from "../src/agentContracts.ts"
import { decision } from "../src/proposeEdits.ts"

type Input = {
	// describe the model route and request payload
	route: ModelRoute
	url: string
	prompt: string
	maxOutputTokens: number
	stub: string
	// Enable the edit tool only on full Agent Attempt turns.
	editTool?: boolean
	denyOnly?: boolean
	modelCallId?: string
}
// report the gateway status and billed model usage
type Receipt = {
	timing?: { modelCallId: string; durationMs: number }
	status: number
	errorCode?: string
	text?: string
	modelId?: string
	inputTokens?: number
	outputTokens?: number
	// retain the provider request id for reconciliation
	requestId?: string
}
export async function infer(
	{ route, url, prompt, maxOutputTokens, stub, denyOnly, editTool, modelCallId }: Input,
	send = requestModel,
): Promise<Receipt> {
	// probe the gateway before sending the full prompt
	if (denyOnly) {
		return probeGateway({ route, url, stub }, send)
	}
	let status = 0
	let errorCode = "before-request"
	// Limit every SDK request to the single authenticated route. Discard any redirect.
	const transport: typeof globalThis.fetch = async (
		input: string | Request | URL,
		init?: RequestInit,
	): Promise<Response> => {
		const destination = input instanceof Request ? input.url : String(input)
		errorCode = "route-mismatch"
		if (destination !== url || init?.method?.toUpperCase() !== "POST") {
			throw new Error("Unexpected model route")
		}
		// replace sdk credentials with the scoped gateway stub
		const headers = new Headers(init?.headers)
		headers.delete("authorization")
		headers.delete("x-api-key")
		headers.set(route.credential.header, route.credential.valueTemplate.replace(`\${credential}`, stub))
		errorCode = "transport"
		// record the status before handing the response back to the sdk
		const response = send(url, headers, init.body)
		status = response.status
		errorCode = "model-response"
		return response
	}
	// select the sdk matching the configured wire protocol
	const settings = { baseURL: route.baseUrl, apiKey: "placeholder", fetch: transport }
	const provider =
		route.protocol === "anthropic" ? createAnthropic(settings) : createOpenAICompatible({ ...settings, name: "caller" })
	try {
		let started: number | undefined
		const reply = await generateText({
			telemetry: modelCallId
				? {
						isEnabled: true,
						recordInputs: false,
						recordOutputs: false,
						integrations: {
							onStart: () => {
								started = performance.now()
							},
						},
					}
				: undefined,
			model: provider(route.modelId),
			prompt,
			maxRetries: 0,
			maxOutputTokens,
			tools: editTool
				? {
						proposeEdits: tool({
							description:
								"Submit one bounded repair step, a registry lookup, or a diagnosis for independent review. Source and test checks happen after credentials are revoked.",
							inputSchema: decision,
						}),
					}
				: undefined,
			providerOptions:
				route.protocol === "anthropic" && route.effort ? { anthropic: { effort: route.effort } } : undefined,
		})
		// extract the bounded edit proposal and its usage
		const action = reply.toolCalls.find((call) => call.toolName === "proposeEdits")
		return {
			status,
			text: editTool ? encodeDecision(action?.input, reply.finishReason) : reply.text,
			modelId: route.modelId,
			inputTokens: reply.usage.inputTokens,
			outputTokens: reply.usage.outputTokens,
			requestId: reply.response.id,
			timing: toCallTiming(modelCallId, started),
		}
	} catch (error) {
		// expose only a short transport code on failure
		const cause = error instanceof Error ? error.cause : undefined
		const code = cause && typeof cause === "object" && "code" in cause ? String(cause.code) : ""
		return { status, errorCode: /^[A-Z_]{3,50}$/.test(code) ? code : errorCode }
	}
}
// Return a local receipt only when the caller enabled tracing.
function toCallTiming(modelCallId?: string, started?: number): Receipt["timing"] {
	if (modelCallId && started !== undefined) {
		return { modelCallId, durationMs: Math.round(performance.now() - started) }
	}
}

// translate incomplete tool replies into retry decisions
function encodeDecision(input: unknown, finish: string): string {
	if (finish === "length") {
		return JSON.stringify({ retry: "output-limit" })
	}
	if (input === undefined) {
		return JSON.stringify({ retry: "missing-tool" })
	}
	// preserve an already serialized tool argument
	return typeof input === "string" ? input : JSON.stringify(input)
}
function probeGateway({ route, url, stub }: Pick<Input, "route" | "url" | "stub">, send: typeof requestModel): Receipt {
	// prepare a minimal authenticated gateway probe
	const headers = new Headers({ "content-type": "application/json" })
	if (route.protocol === "anthropic") {
		headers.set("anthropic-version", "2023-06-01")
	}
	headers.set(route.credential.header, route.credential.valueTemplate.replace(`\${credential}`, stub))
	let status = 0
	// capture the denial status without interpreting the body
	try {
		status = send(url, headers, "{}").status
	} catch {
		// A transport failure supplies no authentication evidence.
	}
	return { status }
}
function requestModel(url: string, headers: Headers, body: unknown): Response {
	if (typeof body !== "string") {
		throw new Error("Expected JSON model request")
	}
	// bound the guest transport's duration and response size
	const args = [
		"-q",
		"--silent",
		"--show-error",
		"--proto",
		"=https",
		"--connect-timeout",
		"8",
		"--max-time",
		body === "{}" ? "10" : "110",
		"--max-filesize",
		"2097152",
		"--write-out",
		"\n%{http_code}",
		"--data-binary",
		"@-",
	]
	// forward the validated model request headers
	for (const [name, value] of headers) {
		args.push("--header", `${name}: ${value}`)
	}
	const curl = spawnSync("/usr/bin/curl", [...args, "--", url], {
		encoding: "utf8",
		input: body,
		maxBuffer: 2 * 1024 * 1024,
		timeout: 115000,
	})
	if (curl.status !== 0) {
		throw new Error("Model transport unavailable")
	}
	// split curl's trailing status from the response body
	const boundary = curl.stdout.lastIndexOf("\n")
	const status = Number(curl.stdout.slice(boundary + 1))
	return new Response(curl.stdout.slice(0, boundary), { status, headers: { "content-type": "application/json" } })
}
// serve a single model request from standard input
if (process.argv[1] === "/opt/health-code/agent.mjs") {
	try {
		console.log(JSON.stringify(await infer(JSON.parse(readFileSync(0, "utf8")))))
	} catch {
		process.exitCode = 1
	}
}
