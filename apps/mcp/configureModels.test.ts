import assert from "node:assert/strict"
import { test } from "node:test"
import { configureModels } from "./configureModels.ts"
import { setupAccount } from "./setupAccount.ts"

test("all four roles use origin-bound routes and ignore an inherited model key", async () => {
	const environment = { RUNTA_TOKEN: "synthetic-sandbox-token", ANTHROPIC_API_KEY: "synthetic-model-key" }
	const models = configureModels(environment)
	assert.deepEqual(models, configureModels({ RUNTA_TOKEN: environment.RUNTA_TOKEN }))

	// capture the secret name registered by setup
	let registered = ""
	await setupAccount(environment, {
		version: "1.2.3",
		client: {
			check: async () => {},
			probe: async () => {},
			store: async ({ name }) => {
				registered = name
			},
		},
	})

	// compare both guest routes with the registered secret reference
	for (const route of Object.values(models)) {
		assert.equal(route.credential.name, registered)
		assert.equal(route.modelId, "claude-opus-5-5")
		assert.ok(!JSON.stringify(route).includes(environment.ANTHROPIC_API_KEY))
	}

	// require explicit pricing for a custom model route
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
