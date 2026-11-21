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

export function accountToken(environment: NodeJS.ProcessEnv): string {
	const token = environment.RUNTA_TOKEN
	if (!token?.trim() || token === toEnvironmentReference("RUNTA_TOKEN")) {
		throw new UserError("Supply RUNTA_TOKEN through your environment.")
	}
	return token
}

export function setupKey(environment: NodeJS.ProcessEnv): string | undefined {
	const key = environment.ANTHROPIC_API_KEY
	if (key !== undefined && (!key.trim() || key === toEnvironmentReference("ANTHROPIC_API_KEY"))) {
		throw new UserError("Supply ANTHROPIC_API_KEY only when registering a key.")
	}
	return key
}

export function modelOrigin(environment: NodeJS.ProcessEnv): string {
	try {
		// parse the configured origin before binding credentials
		const url = new URL(environment.HEALTH_CODE_MODEL_HOST ?? defaultOrigin)
		if (
			url.protocol !== "https:" ||
			url.username ||
			url.password ||
			url.port ||
			// reject endpoint-specific paths and noncanonical hosts
			url.search ||
			url.hash ||
			url.pathname !== "/" ||
			!/^[a-z0-9.-]+\.[a-z0-9-]+$/i.test(url.hostname)
		) {
			throw new Error()
		}

		// return the normalized origin used to scope model credentials
		return url.origin
	} catch {
		throw new UserError("Set HEALTH_CODE_MODEL_HOST to an HTTPS origin on the standard port.")
	}
}

// derive a stable secret name unique to this origin
export function secretName(origin: string): string {
	return `health-code-model-${createHash("sha256").update(origin).digest("hex").slice(0, 24)}`
}
