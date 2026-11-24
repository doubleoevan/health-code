import { createHash } from "node:crypto"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import type { InspectionModels, ModelRoute, Pricing } from "../agentContracts.ts"
import { InspectionError } from "../contracts.ts"
import type { SandboxModelRoutes } from "./modelRequestSandbox.ts"

const modelVariable = "HEALTH_CODE_MODEL"
const hostVariable = "HEALTH_CODE_MODEL_HOST"
const protocolVariable = "HEALTH_CODE_MODEL_PROTOCOL"
const roleVariables = {
	releaseSummary: "HEALTH_CODE_SUMMARY_MODEL",
	featureMatch: "HEALTH_CODE_MATCH_MODEL",
	repair: "HEALTH_CODE_REPAIR_MODEL",
	featureAdoption: "HEALTH_CODE_ADOPTION_MODEL",
} as const
const priceVariables = ["HEALTH_CODE_INPUT_USD_PER_MILLION", "HEALTH_CODE_OUTPUT_USD_PER_MILLION"] as const

// high price bounds that keep spend limits in force without price settings
const defaultPrices = {
	HEALTH_CODE_INPUT_USD_PER_MILLION: 10,
	HEALTH_CODE_OUTPUT_USD_PER_MILLION: 50,
} as const

// list the required settings before the optional overrides
export const modelSettingNames = [
	hostVariable,
	modelVariable,
	...priceVariables,
	protocolVariable,
	...Object.values(roleVariables),
]

/**
 * Reads model routes for all four roles from the environment without choosing a model.
 */
export function readModelRoutes(environment: NodeJS.ProcessEnv): SandboxModelRoutes {
	const address = readModelAddress(environment)
	const { origin } = address
	const protocol = readModelProtocol(environment, origin)
	const pricing: Pricing = {
		inputUsdPerMillion: readPriceBound(environment, priceVariables[0]),
		outputUsdPerMillion: readPriceBound(environment, priceVariables[1]),
		maxInputTokens: 65536,
	}

	// default to /v1 when the address has no path
	const path = address.pathname.replace(/\/$/, "") || "/v1"

	// All four roles refer to the stored credential for this origin.
	const header = protocol === "anthropic" ? "x-api-key" : "authorization"
	const valueTemplate = protocol === "anthropic" ? `\${credential}` : `Bearer \${credential}`
	function route(role: keyof SandboxModelRoutes): SandboxModelRoutes["repair"] {
		const modelId = environment[roleVariables[role]]?.trim() || environment[modelVariable]?.trim()
		if (!modelId) {
			throw new InspectionError("invalid-model-settings", `Set ${modelVariable} to the model ID to use.`)
		}
		return {
			modelId,
			pricing,
			protocol,
			baseUrl: `${origin}${path}`,
			credential: { name: toModelSecretName(origin), header, valueTemplate },
		}
	}
	return {
		releaseSummary: route("releaseSummary"),
		featureMatch: route("featureMatch"),
		repair: route("repair"),
		featureAdoption: route("featureAdoption"),
	}
}

function readPriceBound(environment: NodeJS.ProcessEnv, name: (typeof priceVariables)[number]): number {
	const setting = environment[name]?.trim()
	const price = setting ? Number(setting) : defaultPrices[name]
	if (!Number.isFinite(price) || price <= 0) {
		throw new InspectionError("invalid-model-settings", `Set ${name} to the model's price in USD per million tokens.`)
	}
	return price
}

/**
 * Reads the HTTPS origin that scopes model credentials.
 */
export function readModelOrigin(environment: NodeJS.ProcessEnv): string {
	return readModelAddress(environment).origin
}

// read the model host with its optional API path
function readModelAddress(environment: NodeJS.ProcessEnv): URL {
	try {
		// parse the configured address before binding credentials
		const url = new URL(environment[hostVariable] ?? "")
		if (
			url.protocol !== "https:" ||
			url.username ||
			url.password ||
			url.port ||
			// reject queries, unusual path characters and noncanonical hosts
			url.search ||
			url.hash ||
			!/^(?:\/[\w.~-]+)*\/?$/.test(url.pathname) ||
			!/^[a-z0-9.-]+\.[a-z0-9-]+$/i.test(url.hostname)
		) {
			throw new Error()
		}

		// return the normalized address
		return url
	} catch {
		throw new InspectionError(
			"invalid-model-settings",
			"Set HEALTH_CODE_MODEL_HOST to an HTTPS address on the standard port, with an API path when it isn't /v1.",
		)
	}
}

// follow the host unless the caller sets a protocol
function readModelProtocol(environment: NodeJS.ProcessEnv, origin: string): "anthropic" | "openai-compatible" {
	const protocol = environment[protocolVariable]?.trim()
	if (!protocol) {
		return origin === "https://api.anthropic.com" ? "anthropic" : "openai-compatible"
	}

	// reject any other wire protocol
	if (protocol !== "anthropic" && protocol !== "openai-compatible") {
		throw new InspectionError(
			"invalid-model-settings",
			"Set HEALTH_CODE_MODEL_PROTOCOL to anthropic or openai-compatible.",
		)
	}
	return protocol
}

/**
 * Returns the Runta secret name that holds the model key for an origin.
 */
export function toModelSecretName(origin: string): string {
	return `health-code-model-${createHash("sha256").update(origin).digest("hex").slice(0, 24)}`
}

/**
 * Creates a caller-owned model from a route and rejects redirects that could forward its key.
 */
export function createHostModel(
	{ protocol, baseUrl, modelId }: Pick<ModelRoute, "protocol" | "baseUrl" | "modelId">,
	apiKey: string,
): InspectionModels["releaseSummary"]["model"] {
	const rejectRedirects: typeof fetch = (url, init) => fetch(url, { ...init, redirect: "error" })

	// select the SDK for the route's wire protocol
	const settings = { baseURL: baseUrl, apiKey, fetch: rejectRedirects }
	return protocol === "anthropic"
		? createAnthropic(settings)(modelId)
		: createOpenAICompatible({ ...settings, name: "caller" })(modelId)
}
