import { createAnthropic } from "@ai-sdk/anthropic"
import {
	createSandboxProvider,
	type InspectionOptionsV2,
	inspectRepository,
	type ReportCardV2,
	reconcileSandboxes,
} from "health-code"
import type { InspectionSource } from "./executeInspection.ts"
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
	inspect: (options: InspectionOptionsV2) => Promise<ReportCardV2> = inspectRepository,
): InspectionSource {
	const token = environment.RUNTA_TOKEN
	const key = environment.ANTHROPIC_API_KEY
	const name = environment.HEALTH_CODE_STORED_CREDENTIAL
	const deployment = environment.HEALTH_CODE_DEPLOYMENT
	if (!deployment || !token || !key || !name?.trim()) {
		throw new Error(
			"Configure HEALTH_CODE_DEPLOYMENT, RUNTA_TOKEN, ANTHROPIC_API_KEY and HEALTH_CODE_STORED_CREDENTIAL before starting the live site",
		)
	}
	const hostedModel = "claude-opus-5-5"
	const modelId = environment.HEALTH_CODE_MODEL ?? hostedModel
	if (modelId !== hostedModel) {
		throw new Error("The hosted inspection requires Claude Opus 5.5")
	}
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
	const pricing = { inputUsdPerMillion: 4, outputUsdPerMillion: 20, maxInputTokens: 65536 }
	const host = { model: provider(modelId), pricing }
	const guest = {
		modelId,
		protocol: "anthropic" as const,
		baseUrl,
		credential: { name, header: "x-api-key", valueTemplate: `\${credential}` },
		pricing,
	}
	const sandboxProvider = createSandboxProvider({ deployment, token })
	const limits = {
		maxUpgrades: toInspectionLimit(environment.HEALTH_CODE_MAX_UPGRADES, 6),
		maxDurationMs: toInspectionLimit(environment.HEALTH_CODE_MAX_DURATION_MS, 1800000),
		maxCostUsd: toInspectionLimit(environment.HEALTH_CODE_MAX_COST_USD, 5),
	}
	if (!Number.isSafeInteger(limits.maxUpgrades)) {
		throw new Error("Expected a whole-number upgrade limit")
	}
	const githubToken = environment.GITHUB_TOKEN
	return {
		...createRepositoryLookup(githubToken),
		recover: () => reconcileSandboxes({ deployment, token, liveInspectionIds: new Set() }),
		async inspect(repositoryUrl, onEvent): Promise<{ report: ReportCardV2 }> {
			const report = await inspect({
				repositoryUrl,
				sandboxProvider,
				githubToken,
				limits,
				onEvent,
				models: { releaseSummary: host, featureMatch: host, repair: guest, featureAdoption: guest },
			})
			return { report }
		},
	}
}
