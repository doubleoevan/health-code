import assert from "node:assert/strict"
import { test } from "node:test"
import { configureModels } from "./configureModels.ts"
import { modelSettings } from "./fixtures/inspectionSettings.ts"
import { setupAccount } from "./setupAccount.ts"

test("all four roles use origin-bound routes and ignore an inherited model key", async () => {
	const environment = {
		...modelSettings,
		RUNTA_TOKEN: "synthetic-sandbox-token",
		MODEL_API_KEY: "synthetic-model-key",
	}
	const models = configureModels(environment)
	assert.deepEqual(models, configureModels(modelSettings))

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
		assert.ok(!JSON.stringify(route).includes(environment.MODEL_API_KEY))
	}

	// name each missing setting instead of choosing a model
	for (const name of ["HEALTH_CODE_MODEL_HOST", "HEALTH_CODE_MODEL"]) {
		assert.throws(() => configureModels({ ...modelSettings, [name]: undefined }), new RegExp(`Set ${name} `))
	}

	// fall back to high price bounds and reject invalid ones
	const { HEALTH_CODE_MODEL_HOST, HEALTH_CODE_MODEL } = modelSettings
	const unpriced = configureModels({ HEALTH_CODE_MODEL_HOST, HEALTH_CODE_MODEL })
	assert.equal(unpriced.repair.pricing.inputUsdPerMillion, 10)
	assert.equal(unpriced.repair.pricing.outputUsdPerMillion, 50)
	for (const price of ["0", "-1", "abc"]) {
		assert.throws(() => configureModels({ ...modelSettings, HEALTH_CODE_INPUT_USD_PER_MILLION: price }), /INPUT_USD/)
	}

	// follow the host's protocol and accept one model override
	const custom = configureModels({
		...environment,
		HEALTH_CODE_MODEL_HOST: "https://models.example.org",
		HEALTH_CODE_REPAIR_MODEL: "custom",
		HEALTH_CODE_INPUT_USD_PER_MILLION: "3",
		HEALTH_CODE_OUTPUT_USD_PER_MILLION: "16",
	})
	assert.equal(custom.repair.modelId, "custom")
	assert.notEqual(custom.repair.credential.name, registered)
	assert.equal(custom.featureMatch.modelId, "claude-opus-5-5")
	assert.equal(custom.repair.pricing.outputUsdPerMillion, 16)
	assert.equal(models.repair.protocol, "anthropic")
	assert.equal(custom.repair.protocol, "openai-compatible")
	assert.equal(custom.repair.credential.header, "authorization")

	// accept an explicit protocol and reject an unknown one
	const proxy = { ...modelSettings, HEALTH_CODE_MODEL_HOST: "https://proxy.example.org" }
	assert.equal(configureModels({ ...proxy, HEALTH_CODE_MODEL_PROTOCOL: "anthropic" }).repair.protocol, "anthropic")
	assert.throws(() => configureModels({ ...proxy, HEALTH_CODE_MODEL_PROTOCOL: "other" }), /PROTOCOL/)
})
