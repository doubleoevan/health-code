import type { Pricing, SandboxModelRoutes } from "health-code"
import {
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

export function configureModels(environment: NodeJS.ProcessEnv): SandboxModelRoutes {
	const origin = modelOrigin(environment)
	const baseUrl = `${origin}/v1`

	// apply built-in pricing only to the default model and origin
	function pricing(modelId: string): Pricing {
		const known = modelId === defaultModel && origin === defaultOrigin
		return {
			inputUsdPerMillion: priceBound(environment[priceVariables[0]], known ? 4 : undefined),
			outputUsdPerMillion: priceBound(environment[priceVariables[1]], known ? 20 : undefined),
			maxInputTokens: 65536,
		}
	}

	// All four roles refer to the stored credential for this origin.
	function route(role: keyof SandboxModelRoutes): SandboxModelRoutes["repair"] {
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
		releaseSummary: route("releaseSummary"),
		featureMatch: route("featureMatch"),
		repair: route("repair"),
		featureAdoption: route("featureAdoption"),
	}
}
