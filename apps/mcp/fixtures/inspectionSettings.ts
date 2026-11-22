export const key = "synthetic-model-key-for-tests"
export const environment = {
	RUNTA_TOKEN: "synthetic-sandbox-token",
	ANTHROPIC_API_KEY: key,
	HEALTH_CODE_SUMMARY_MODEL: "claude-opus-5-5",
}

export const repo = "https://github.com/example/project"
export const inspectionFixtureUrl = new URL("../../../scripts/fixtures/recorded/inspection.json", import.meta.url)
