import {
	createHostModel,
	createSandboxProvider,
	type InspectionOptionsV2,
	type InspectionReportV2,
	inspectRepository,
	readModelRoutes,
	readUpgradeFeatures,
	reconcileSandboxes,
} from "health-code"
import { buildUpgradeMenuInProcess } from "./buildUpgradeMenu.ts"
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
	const key = environment.MODEL_API_KEY
	const deployment = environment.HEALTH_CODE_DEPLOYMENT
	if (!deployment || !token || !key) {
		throw new Error("Configure HEALTH_CODE_DEPLOYMENT, RUNTA_TOKEN and MODEL_API_KEY before starting the live site")
	}

	// bind each role to the configured models and stored credential
	const { releaseSummary, featureMatch, repair, featureAdoption } = readModelRoutes(environment)
	const models = {
		releaseSummary: { model: createHostModel(releaseSummary, key), pricing: releaseSummary.pricing },
		featureMatch: { model: createHostModel(featureMatch, key), pricing: featureMatch.pricing },
		repair,
		featureAdoption,
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

	// require a GitHub token in production. the server builds upgrade menus from GitHub
	const githubToken = environment.GITHUB_TOKEN
	if (environment.NODE_ENV === "production" && !githubToken) {
		throw new Error("Configure GITHUB_TOKEN before starting the live site")
	}

	// bind github lookup and sandbox recovery to the hosted deployment
	const firstSeen = new Map<string, number>()
	return {
		...createRepositoryLookup(githubToken),
		features: (upgrade) => readUpgradeFeatures(upgrade, { githubToken }),
		upgradeMenu: (repositoryUrl, { onEvent, ...upgradeMenuOptions }) =>
			buildUpgradeMenuInProcess({ request: { repositoryUrl, githubToken, ...upgradeMenuOptions }, onEvent }),
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
				models,
			})
			return { report }
		},
	}
}
