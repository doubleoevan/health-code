export const key = "synthetic-model-key-for-tests"
export const modelSettings = {
	HEALTH_CODE_MODEL_HOST: "https://api.anthropic.com",
	HEALTH_CODE_MODEL: "claude-opus-5-5",
	HEALTH_CODE_INPUT_USD_PER_MILLION: "4",
	HEALTH_CODE_OUTPUT_USD_PER_MILLION: "20",
}
export const environment = {
	RUNTA_TOKEN: "synthetic-sandbox-token",
	MODEL_API_KEY: key,
	...modelSettings,
}

export const repo = "https://github.com/example/project"
export const inspectionFixtureUrl = new URL(
	"../../../../packages/health-code/test/fixtures/recorded/npm/sandbox.json",
	import.meta.url,
)
