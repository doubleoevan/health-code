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
export { createSandboxProvider, type ProviderOptions } from "./sandbox/createSandboxProvider.ts"
