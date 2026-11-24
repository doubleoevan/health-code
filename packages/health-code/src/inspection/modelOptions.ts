import type { InspectionOptionsV2, ModelRole, PreviousInspectionOptions } from "../agentContracts.ts"
import { InspectionError, type InspectionOptions, type WithSandboxProvider } from "../contracts.ts"
import type { ModelRequestSandboxOptions } from "../models/modelRequestSandbox.ts"
import { credentialTarget } from "../sandbox/setCredentialBinding.ts"

/**
 * Validates model routes and pricing before allocating any runtime.
 */
export function validateModels(options: InspectionOptionsV2 | ModelRequestSandboxOptions): void {
	const { models } = options

	// validate price bounds for each required model role
	for (const role of ["releaseSummary", "featureMatch", "repair", "featureAdoption"] as const) {
		const model = models?.[role]
		if (
			!model?.pricing ||
			!Number.isSafeInteger(model.pricing.maxInputTokens) ||
			model.pricing.maxInputTokens < 1 ||
			![model.pricing.inputUsdPerMillion, model.pricing.outputUsdPerMillion, model.pricing.fixedUsd ?? 0].every(
				(rate) => Number.isFinite(rate) && rate >= 0,
			)
		) {
			throw new InspectionError("pricing", "Four model roles require explicit price bounds")
		}
		validateRole(options, role)
	}
}

/**
 * Recognizes structured model roles on current and legacy inspection options.
 */
export function hasModels(
	options: InspectionOptions | InspectionOptionsV2 | PreviousInspectionOptions,
): options is InspectionOptionsV2 | PreviousInspectionOptions {
	// distinguish configured model roles from legacy model ids
	const models = options.models
	if (models === undefined) {
		return false
	}
	if (models === null || typeof models !== "object" || Array.isArray(models)) {
		throw new InspectionError("invalid-model", "Expected a dictionary of model roles")
	}

	// select model-backed inspection for structured role settings
	return Object.values(models).some((value) => typeof value !== "string")
}

/**
 * Maps legacy role names to the current local model options.
 */
export function toModelOptions(
	options: (InspectionOptionsV2 | PreviousInspectionOptions) & WithSandboxProvider,
): InspectionOptionsV2 & WithSandboxProvider {
	const { models, limits } = options
	const agent: NonNullable<PreviousInspectionOptions["limits"]>["agent"] = limits?.agent

	// map older model and limit names to current roles
	return {
		...options,
		models: {
			releaseSummary: models.releaseSummary,
			featureMatch: models.featureMatch,
			repair: "repair" in models ? models.repair : models.fix,
			featureAdoption: "featureAdoption" in models ? models.featureAdoption : models.adoption,
		},
		limits: {
			...limits,
			agent: {
				repair: toTurnLimits(agent?.repair, agent?.fix),
				featureAdoption: toTurnLimits(agent?.featureAdoption, agent?.adoption),
			},
		},
	}
}

type CurrentLimits = NonNullable<NonNullable<InspectionOptionsV2["limits"]>["agent"]>["repair"]
type PreviousLimits = NonNullable<NonNullable<PreviousInspectionOptions["limits"]>["agent"]>["fix"]
function toTurnLimits(current: PreviousLimits, previous: PreviousLimits): CurrentLimits {
	if (!current && !previous) {
		return undefined
	}
	return {
		maxTurns: lowestLimit(current?.maxTurns, current?.maxIterations, previous?.maxTurns, previous?.maxIterations),
		maxDurationMs: lowestLimit(current?.maxDurationMs, previous?.maxDurationMs),
		maxCostUsd: lowestLimit(current?.maxCostUsd, previous?.maxCostUsd),
	}
}

// apply the lowest supplied limit across compatible option names
function lowestLimit(...values: (number | undefined)[]): number | undefined {
	const specified = values.filter((value) => value !== undefined)
	return specified.length ? Math.min(...specified) : undefined
}

function validateRole(options: InspectionOptionsV2 | ModelRequestSandboxOptions, role: ModelRole): void {
	const model = options.models[role]
	if (options.callerModelExecution === "modelRequestSandbox") {
		if (!("credential" in model) || "model" in model) {
			throw new InspectionError("invalid-model", "Expected a credentialed model request sandbox route")
		}

		// Validate the complete endpoint before runtime allocation.
		credentialTarget(model)
		return
	}

	// verify that host roles supply a configured model handle
	if (
		(role === "releaseSummary" || role === "featureMatch") &&
		(!("model" in model) ||
			!model.model ||
			typeof model.model !== "object" ||
			typeof model.model.doGenerate !== "function")
	) {
		// reject an unusable host model before starting work
		throw new InspectionError("invalid-model", "Expected a configured host model")
	}
}
