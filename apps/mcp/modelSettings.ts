import { createHash } from "node:crypto"

export class UserError extends Error {}
export const defaultOrigin = "https://api.anthropic.com"
export const defaultModel = "claude-opus-5-5"
export const roleVariables = {
	releaseSummary: "HEALTH_CODE_SUMMARY_MODEL",
	featureMatch: "HEALTH_CODE_MATCH_MODEL",
	repair: "HEALTH_CODE_REPAIR_MODEL",
	featureAdoption: "HEALTH_CODE_ADOPTION_MODEL",
} as const
export const priceVariables = ["HEALTH_CODE_INPUT_USD_PER_MILLION", "HEALTH_CODE_OUTPUT_USD_PER_MILLION"] as const

export function toEnvironmentReference(name: string): string {
	return `\${${name}}`
}

export function credentials(environment: NodeJS.ProcessEnv): { token: string; key: string } {
	function required(name: string): string {
		const value = environment[name]
		// Claude Code can forward an unresolved environment reference verbatim.
		if (!value?.trim() || value === toEnvironmentReference(name)) {
			throw new UserError(`Supply ${name} through your environment.`)
		}
		return value
	}
	return { token: required("RUNTA_TOKEN"), key: required("ANTHROPIC_API_KEY") }
}
export function modelOrigin(environment: NodeJS.ProcessEnv): string {
	try {
		const url = new URL(environment.HEALTH_CODE_MODEL_HOST ?? defaultOrigin)
		if (
			url.protocol !== "https:" ||
			url.username ||
			url.password ||
			url.port ||
			url.search ||
			url.hash ||
			url.pathname !== "/" ||
			!/^[a-z0-9.-]+\.[a-z0-9-]+$/i.test(url.hostname)
		) {
			throw new Error()
		}
		return url.origin
	} catch {
		throw new UserError("Set HEALTH_CODE_MODEL_HOST to an HTTPS origin on the standard port.")
	}
}
export function secretName(origin: string): string {
	return `health-code-model-${createHash("sha256").update(origin).digest("hex").slice(0, 24)}`
}
