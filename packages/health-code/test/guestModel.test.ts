import assert from "node:assert/strict"
import { test } from "node:test"
import { infer } from "../guest/agent.ts"
import { credentialTarget } from "../src/sandbox/setCredentialBinding.ts"

for (const protocol of ["anthropic", "openai-compatible"] as const) {
	test(`trusted guest uses ${protocol} through the caller's exact proxy path`, async () => {
		const route = {
			protocol,
			baseUrl: "https://proxy.example/account/v1",
			modelId: "fixture",
			credential: { name: "stored", header: "x-fixture", valueTemplate: `Bearer \${credential}` },
		}
		// route both wire protocols through the caller's proxy
		const url = credentialTarget(route).href
		const result = await infer(
			{ route, url, stub: "inert", editTool: true, prompt: "hi", maxOutputTokens: 4 },
			(destination, headers, body): Response => {
				// verify the exact destination and caller-selected credential header
				assert.equal(destination, url)
				assert.equal(headers.get("x-fixture"), "Bearer inert")
				assert.equal(headers.has("authorization"), false)
				assert.equal(headers.has("x-api-key"), false)
				assert.equal(JSON.parse(String(body)).model, "fixture")
				// construct the same edit proposal for both response formats
				const action = {
					reason: "Update one call",
					edits: [{ file: "index.ts", search: "old()", replacement: "updated()" }],
				}
				assert.equal(JSON.parse(String(body)).tools.length, 1)
				// encode the tool call and usage in the selected protocol
				const response =
					protocol === "anthropic"
						? {
								id: "id",
								model: "fixture",
								type: "message",
								role: "assistant",
								content: [
									{ type: "text", text: "I will update the call." },
									{ type: "tool_use", id: "call_1", name: "proposeEdits", input: action },
								],
								stop_reason: "tool_use",
								usage: { input_tokens: 12, output_tokens: 1 },
							}
						: {
								id: "id",
								model: "fixture",
								created: 0,
								object: "chat.completion",
								choices: [
									{
										index: 0,
										finish_reason: "tool_calls",
										message: {
											role: "assistant",
											content: null,
											tool_calls: [
												{
													id: "call_1",
													type: "function",
													function: { name: "proposeEdits", arguments: JSON.stringify(action) },
												},
											],
										},
									},
								],
								usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 },
							}
				return Response.json(response)
			},
		)
		// verify the normalized edit and token counts
		assert.equal(JSON.parse(result.text ?? "{}").edits[0].file, "index.ts")
		assert.equal(result.inputTokens, 12)
		assert.equal(result.outputTokens, 1)
	})
}
