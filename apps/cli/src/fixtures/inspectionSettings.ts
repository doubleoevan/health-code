export const modelSettings = {
	HEALTH_CODE_MODEL_HOST: "https://api.anthropic.com",
	HEALTH_CODE_MODEL: "claude-opus-5-5",
	HEALTH_CODE_INPUT_USD_PER_MILLION: "4",
	HEALTH_CODE_OUTPUT_USD_PER_MILLION: "20",
}
export const recordedProjectsUrl = new URL("../../../../packages/health-code/test/fixtures/recorded/", import.meta.url)
export const inspectionFixtureUrl = new URL("npm/sandbox.json", recordedProjectsUrl)
