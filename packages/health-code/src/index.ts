export type { PromptName, PromptOverrides, PromptReference } from "./readPrompt.ts"

import { readFileSync } from "node:fs"

// Include the installed release in hosted inspection cache keys.
export const libraryVersion: string = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version

export type {
	/**
	 * @deprecated Use InspectionEventV2.
	 */
	InspectionEventV2 as EnrichedInspectionEvent,
	/**
	 * @deprecated Use InspectionReportV2.
	 */
	InspectionReportV2 as EnrichedReportCard,
	/**
	 * @deprecated Use UpgradeReportV2.
	 */
	UpgradeReportV2 as EnrichedUpgradeReport,
} from "./agentContracts.ts"

/**
 * @deprecated Use InspectionOptionsV2 with repair and featureAdoption.
 */
export type EnrichedInspectionOptions =
	| import("./agentContracts.ts").PreviousInspectionOptions
	| import("./agentContracts.ts").InspectionOptionsV2
export type {
	CodeFeatureMatch,
	/**
	 * @deprecated Use CodeFeatureMatch.
	 */
	CodeFeatureMatch as FeatureMatch,
	InspectionEventV2,
	InspectionModels,
	InspectionOptionsV2,
	InspectionReportV2,
	/**
	 * @deprecated Use InspectionReportV2.
	 */
	InspectionReportV2 as ReportCardV2,
	ModelRoute,
	ModelUsage,
	Patch,
	Pricing,
	UpgradeReportV2,
	Verdict,
} from "./agentContracts.ts"
export { testInventorySummarySchema } from "./checks/testInventorySummary.ts"
export type {
	Baseline,
	CheckResult,
	Command,
	CommandResult,
	EcosystemAdapter,
	Evidence,
	InspectionEvent,
	InspectionLimits,
	InspectionOptions,
	InspectionReport,
	/**
	 * @deprecated Use InspectionReport.
	 */
	InspectionReport as ReportCard,
	InstallationFinding,
	Observation,
	Operation,
	PackageManager,
	Sandbox,
	SandboxProvider,
	TestFailure,
	Upgrade,
	UpgradeReport,
} from "./contracts.ts"
export { InspectionError, SandboxUnavailableError } from "./contracts.ts"
export { inspectRepository } from "./inspection/inspectRepository.ts"
export {
	getUpgrade,
	listUpgrades,
	readUpgradeMenuFeatures,
	readUpgradeMenuFeatures as readMenuFeatures,
} from "./inspection/listUpgrades.ts"
export { buildInvestigationPrompt } from "./models/buildPrompt.ts"
export type {
	ModelRequestSandbox,
	ModelRequestSandboxEvent,
	ModelRequestSandboxInspectionReport,
	/**
	 * @deprecated Use ModelRequestSandboxInspectionReport.
	 */
	ModelRequestSandboxInspectionReport as ModelRequestSandboxReportCard,
	ModelRequestSandboxOptions,
	RuntimeUsage,
	SandboxModelRequest,
	SandboxModelRoutes,
} from "./models/modelRequestSandbox.ts"
export { isModelRequestSandboxName, toModelRequestSandboxName } from "./models/modelRequestSandbox.ts"
export {
	createHostModel,
	modelSettingNames,
	readModelOrigin,
	readModelRoutes,
	toModelSecretName,
} from "./models/readModelRoutes.ts"
export {
	createFakeSandboxProvider,
	type FixtureCommand,
	type SandboxFixture,
} from "./sandbox/createFakeSandboxProvider.ts"
export { createSandboxProvider, type ProviderOptions } from "./sandbox/createSandboxProvider.ts"
export { reconcileSandboxes } from "./sandbox/reconcileSandboxes.ts"
export { type InspectionMode, toInspectionMode } from "./toInspectionMode.ts"
export { toRepositoryUrl } from "./toRepositoryUrl.ts"
export {
	type ReleaseFeaturePage,
	readUpgradeFeatures,
	toFeaturePage,
	type UpgradeFeatures,
} from "./upgrades/readUpgradeFeatures.ts"
export {
	type DependencyChoice,
	dependenciesPerPage,
	toUpgradeMenu,
	toUpgradeTargetKey,
	type UpgradeMenuOrder,
	type UpgradeMenuOrder as MenuOrder,
	type UpgradeMenuTarget,
	type UpgradeMenuTarget as MenuTarget,
} from "./upgrades/toUpgradeMenu.ts"
