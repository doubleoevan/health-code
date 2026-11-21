export type { PromptName, PromptOverrides, PromptReference } from "./readPrompt.ts"

import { readFileSync } from "node:fs"

// Include the installed release in hosted inspection cache keys.
export const libraryVersion: string = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version

export type {
	/** @deprecated Use InspectionEventV2. */
	InspectionEventV2 as EnrichedInspectionEvent,
	/** @deprecated Use ReportCardV2. */
	ReportCardV2 as EnrichedReportCard,
	/** @deprecated Use UpgradeReportV2. */
	UpgradeReportV2 as EnrichedUpgradeReport,
} from "./agentContracts.ts"
/** @deprecated Use InspectionOptionsV2 with repair and featureAdoption. */
export type EnrichedInspectionOptions =
	| import("./agentContracts.ts").PreviousInspectionOptions
	| import("./agentContracts.ts").InspectionOptionsV2
export type {
	FeatureMatch,
	InspectionEventV2,
	InspectionModels,
	InspectionOptionsV2,
	ModelRoute,
	ModelUsage,
	Patch,
	Pricing,
	ReportCardV2,
	UpgradeReportV2,
	Verdict,
} from "./agentContracts.ts"
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
	InstallationFinding,
	Observation,
	Operation,
	PackageManager,
	ReportCard,
	Sandbox,
	SandboxProvider,
	TestFailure,
	Upgrade,
	UpgradeReport,
} from "./contracts.ts"
export { InspectionError, SandboxUnavailableError } from "./contracts.ts"
export { createFakeSandboxProvider, type FixtureCommand, type SandboxFixture } from "./createFakeSandboxProvider.ts"
export { inspectRepository } from "./inspectRepository.ts"
export type {
	ModelRequestSandbox,
	ModelRequestSandboxEvent,
	ModelRequestSandboxOptions,
	ModelRequestSandboxReportCard,
	RuntimeUsage,
	SandboxModelRequest,
	SandboxModelRoutes,
} from "./modelRequestSandbox.ts"
export { isModelRequestSandboxName, toModelRequestSandboxName } from "./modelRequestSandbox.ts"
export { createSandboxProvider, type ProviderOptions } from "./sandbox/createSandboxProvider.ts"
export { reconcileSandboxes } from "./sandbox/reconcileSandboxes.ts"
export { testInventorySummarySchema } from "./testInventorySummary.ts"
export { toRepositoryUrl } from "./toRepositoryUrl.ts"
