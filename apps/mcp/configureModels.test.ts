import assert from "node:assert/strict"
import { test } from "node:test"
import { configureModels } from "./configureModels.ts"
import { setupAccount } from "./setupAccount.ts"

test("only the host model handles send the environment key", async () => {
	const environment = { RUNTA_TOKEN: "synthetic-sandbox-token", ANTHROPIC_API_KEY: "synthetic-model-key" }
	const hits: string[] = []
	const models = configureModels(environment, async (url, init) => {
		assert.equal(init?.redirect, "error")
		assert.equal(new Headers(init?.headers).get("x-api-key"), environment.ANTHROPIC_API_KEY)
		hits.push(String(url))
		return Response.json({
			type: "message",
			role: "assistant",
			id: "test",
			model: "claude-opus-5-5",
			content: [{ type: "text", text: "example" }],
			stop_reason: "end_turn",
			stop_sequence: null,
			usage: { input_tokens: 1, output_tokens: 1 },
		})
	})
	for (const role of [models.releaseSummary, models.featureMatch]) {
		await role.model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "fixture" }] }] })
	}
	assert.deepEqual(hits, ["https://api.anthropic.com/v1/messages", "https://api.anthropic.com/v1/messages"])
	let registered = ""
	await setupAccount(environment, {
		version: "1.2.3",
		client: {
			check: async () => {},
			store: async ({ name }) => {
				registered = name
			},
		},
	})
	for (const route of [models.repair, models.featureAdoption]) {
		assert.equal(route.credential.name, registered)
		assert.equal(route.modelId, "claude-opus-5-5")
		assert.ok(!JSON.stringify(route).includes(environment.ANTHROPIC_API_KEY))
	}
	assert.throws(() => configureModels({ ...environment, HEALTH_CODE_REPAIR_MODEL: "custom" }), /bounds/)
	const custom = configureModels({
		...environment,
		HEALTH_CODE_MODEL_HOST: "https://models.example.org",
		HEALTH_CODE_REPAIR_MODEL: "custom",
		HEALTH_CODE_INPUT_USD_PER_MILLION: "3",
		HEALTH_CODE_OUTPUT_USD_PER_MILLION: "16",
	})
	assert.equal(custom.repair.modelId, "custom")
	assert.notEqual(custom.repair.credential.name, registered)
	assert.equal(custom.repair.pricing.outputUsdPerMillion, 16)
})
