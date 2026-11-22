import { createAnthropic } from "@ai-sdk/anthropic"
import {
	createSandboxProvider,
	type InspectionOptionsV2,
	type InspectionReportV2,
	inspectRepository,
	readUpgradeFeatures,
	reconcileSandboxes,
} from "health-code"
import type { InspectionSource } from "./inspectionSource.ts"

import { createRepositoryLookup } from "./verifyRepository.ts"

function toInspectionLimit(value: string | undefined, fallback: number): number {
	const parsed = value === undefined ? fallback : Number(value)
	if (value?.trim() === "" || !Number.isFinite(parsed) || parsed < 0) {
		throw new Error("Expected a nonnegative inspection limit")
	}
	return parsed
}

export function isReplayEnabled(environment: NodeJS.ProcessEnv): boolean {
	const replay = environment.HEALTH_CODE_REPLAY === "1"
	if (replay && environment.NODE_ENV === "production") {
		throw new Error("Replay is available only in development and tests")
	}
	return replay
}

export function createLiveSource(
	environment: NodeJS.ProcessEnv,
	inspect: (options: InspectionOptionsV2) => Promise<InspectionReportV2> = inspectRepository,
): InspectionSource<{ report: InspectionReportV2 }> {
	// require live credentials and a deployment namespace before accepting work
	const token = environment.RUNTA_TOKEN
	const key = environment.ANTHROPIC_API_KEY
	const name = environment.HEALTH_CODE_STORED_CREDENTIAL
	const deployment = environment.HEALTH_CODE_DEPLOYMENT
	if (!deployment || !token || !key || !name?.trim()) {
		throw new Error(
			"Configure HEALTH_CODE_DEPLOYMENT, RUNTA_TOKEN, ANTHROPIC_API_KEY and HEALTH_CODE_STORED_CREDENTIAL before starting the live site",
		)
	}

	// restrict the hosted service to its budgeted model
	const hostedModel = "claude-opus-5-5"
	const modelId = environment.HEALTH_CODE_MODEL ?? hostedModel
	if (modelId !== hostedModel) {
		throw new Error("HEALTH_CODE_MODEL must be claude-opus-5-5 for hosted release summaries and feature matching")
	}

	// bind host requests to the fixed endpoint and reject redirects
	const baseUrl = "https://api.anthropic.com/v1"
	const provider = createAnthropic({
		baseURL: baseUrl,
		apiKey: key,
		fetch: Object.assign(
			(url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
				fetch(url, { ...init, redirect: "error" }),
			{ preconnect: fetch.preconnect },
		),
	})

	// Price host analysis and credential-bound batch requests at the Opus rate.
	const pricing = { inputUsdPerMillion: 4, outputUsdPerMillion: 20, maxInputTokens: 65536 }
	const host = { model: provider(modelId), pricing }
	const guest = {
		modelId,
		protocol: "anthropic" as const,
		baseUrl,
		credential: { name, header: "x-api-key", valueTemplate: `\${credential}` },
		pricing,
	}

	// Price selected patch attempts at the pinned Fable rate.
	const patchAgent = {
		...guest,
		modelId: "claude-fable-5-2",
		pricing: { ...pricing, inputUsdPerMillion: 8, outputUsdPerMillion: 40 },
	}

	// configure per-inspection spend, duration and upgrade limits
	const sandboxProvider = createSandboxProvider({ deployment, token, memoryMib: 8192 })
	const limits = {
		maxUpgrades: toInspectionLimit(environment.HEALTH_CODE_MAX_UPGRADES, 2),
		maxDurationMs: toInspectionLimit(environment.HEALTH_CODE_MAX_DURATION_MS, 1800000),
		maxCostUsd: toInspectionLimit(environment.HEALTH_CODE_MAX_COST_USD, 5),
		agent: { repair: { maxCostUsd: 2 }, featureAdoption: { maxCostUsd: 1 } },
	}
	if (!Number.isSafeInteger(limits.maxUpgrades)) {
		throw new Error("Expected a whole-number upgrade limit")
	}

	// bind github lookup and sandbox recovery to the hosted deployment
	const githubToken = environment.GITHUB_TOKEN
	const firstSeen = new Map<string, number>()
	return {
		...createRepositoryLookup(githubToken),
		features: (upgrade) => readUpgradeFeatures(upgrade, { githubToken }),
		maxDurationMs: limits.maxDurationMs,
		async recover(options): Promise<number> {
			await reconcileSandboxes({ deployment, token, liveInspectionIds: new Set(), firstSeen, ...options })
			return firstSeen.size
		},
		async inspect(
			repositoryUrl,
			onEvent,
			{ revision, settings, signal, reuseUpgrade, mode, upgrade } = {},
		): Promise<{ report: InspectionReportV2 }> {
			const agent = upgrade ? patchAgent : guest
			const report = await inspect({
				repositoryUrl,
				sandboxProvider,
				githubToken,
				signal,
				revision,
				reuseUpgrade,
				mode,
				upgrade,
				limits: settings
					? {
							...limits,
							maxUpgrades: settings.maxUpgrades,
							maxCostUsd: settings.maxCostUsd,
							agent: {
								repair: { maxCostUsd: settings.repairUsd },
								featureAdoption: { maxCostUsd: settings.adoptionUsd },
							},
						}
					: limits,
				onEvent,
				models: { releaseSummary: host, featureMatch: host, repair: agent, featureAdoption: agent },
			})
			return { report }
		},
	}
}
