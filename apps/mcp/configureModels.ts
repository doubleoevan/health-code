import { createAnthropic } from "@ai-sdk/anthropic"
import type { InspectionModels, Pricing } from "health-code"
import {
	credentials,
	defaultModel,
	defaultOrigin,
	modelOrigin,
	priceVariables,
	roleVariables,
	secretName,
	UserError,
} from "./modelSettings.ts"

function priceBound(setting: string | undefined, fallback: number | undefined): number {
	const price = setting?.trim() ? Number(setting) : fallback
	if (price === undefined || !Number.isFinite(price) || price < 0) {
		throw new UserError("Supply nonnegative input and output USD-per-million bounds for custom model routes.")
	}
	return price
}
export function configureModels(
	environment: NodeJS.ProcessEnv,
	request: typeof globalThis.fetch = globalThis.fetch,
): InspectionModels {
	// bind the host client to the configured model origin
	const { key } = credentials(environment)
	const origin = modelOrigin(environment)
	const baseUrl = `${origin}/v1`
	const provider = createAnthropic({
		baseURL: baseUrl,
		apiKey: key,
		fetch: (url, init) => request(url, { ...init, redirect: "error" }),
	})
	// apply built-in pricing only to the default model and origin
	function pricing(modelId: string): Pricing {
		const known = modelId === defaultModel && origin === defaultOrigin
		return {
			inputUsdPerMillion: priceBound(environment[priceVariables[0]], known ? 4 : undefined),
			outputUsdPerMillion: priceBound(environment[priceVariables[1]], known ? 20 : undefined),
			maxInputTokens: 65536,
		}
	}
	// build authenticated handles for the two host roles
	function host(role: "releaseSummary" | "featureMatch"): InspectionModels["releaseSummary"] {
		const modelId = environment[roleVariables[role]] || defaultModel
		return { model: provider(modelId), pricing: pricing(modelId) }
	}
	// give guest roles a reference to the registered secret
	function guest(role: "repair" | "featureAdoption"): InspectionModels["repair"] {
		const modelId = environment[roleVariables[role]] || defaultModel
		return {
			modelId,
			pricing: pricing(modelId),
			protocol: "anthropic",
			baseUrl,
			credential: { name: secretName(origin), header: "x-api-key", valueTemplate: `\${credential}` },
		}
	}
	return {
		releaseSummary: host("releaseSummary"),
		featureMatch: host("featureMatch"),
		repair: guest("repair"),
		featureAdoption: guest("featureAdoption"),
	}
}
