import type { AgentCapability, PatchOperation } from "./agentContracts.ts"
import type { InspectionModeOptions } from "./toInspectionMode.ts"
export type Stage = "setup" | "detect" | "registry" | "install" | "typecheck" | "tests"
export type Evidence = {
	// retain bounded output alongside exit status and timing
	stdout: string
	stderr: string
	exitCode: number
	durationMs: number
	stdoutTruncated: boolean
	stderrTruncated: boolean
}

// distinguish observed network attempts from filesystem writes
export type InstallationFinding =
	| {
			kind: "connection"
			destination: string
			source?: "dns" | "socket" | "gateway"
			outcome: "attempted" | "blocked" | "unknown"
	  }
	| { kind: "write"; path: string }

// report coverage and destinations alongside installation findings
export type Observation = {
	complete: boolean
	findings: InstallationFinding[]
	reason?: string
	destinations?: string[]
}

export type TestCounts = Record<"passed" | "failed" | "skipped" | "todo", number>
export type TestCase = { file: string; name: string; status: keyof TestCounts }

// group discovered tests and file loading errors
export type TestInventory = {
	discoveredFiles?: string[]
	counts: TestCounts
	cases: TestCase[]
	testFileErrors: { file: string; reason: string }[]
}

export type TestFailure = { file: string; name?: string; workspace: string }

// represent check outcomes with their evidence
export type CheckResult = (
	| { status: "passed"; evidence: Evidence[] }
	| { status: "failed"; evidence: Evidence[]; failingTests: TestFailure[] }
	| { status: "untested"; reason: string; detail?: string; evidence: Evidence[] }
) & {
	installScriptsSkipped?: true
	inventory?: Omit<TestInventory, "cases">
	inventoryUnavailable?: string

	// distinguish baseline exclusions from unconfirmed failures
	excluded?: TestFailure[]
	unconfirmedTests?: TestFailure[]
	attempts?: { status: "passed" | "failed" | "untested"; failingTests: TestFailure[] }[]
}

export type Upgrade = {
	dependency: string
	from: Record<string, string>
	to: string
	kind: "minor" | "major" | "patch"
}
export type PackageManager = "npm" | "bun" | "pnpm" | "yarn"

// describe the detected manager and workspace dependencies
export type Project = {
	manager: PackageManager
	version: string
	sources: Record<string, Record<string, string>>
	skipped: string[]

	// record available checks and required environment names
	typecheck: "build" | "check" | "none"
	testScript?: string
	environment: string[]
}

// the tool the sandbox runs for a package manager. yarn-modern is yarn 2 and later
export type ToolName = PackageManager | "yarn-modern"

// an exact version of one package manager's official package
export type PackageManagerInstall = {
	tool: ToolName
	version: string
	hash?: string
}

export type Sandbox = { id: string }
type SandboxAction = "created" | "credentials-withheld" | "network-locked" | "connection-blocked" | "deleted"

// distinguish inspection lifecycle, sandbox and check events
export type EventPayload =
	| { type: "inspection.started"; repositoryUrl: string }
	| { type: "step.started"; stepId: string; label: string }
	| {
			type: "step.finished"
			stepId: string
			summary: string

			// capture the duration and status of a completed step
			durationMs: number
			status: "passed" | "failed" | "untested"
	  }
	| { type: "detail"; stepId: string; stream: "stdout" | "stderr"; text: string; truncated: boolean }
	| {
			// identify the sandbox boundary that produced this event
			type: "sandbox.event"
			sandboxId: string
			action: SandboxAction
			detail?: string

			// report measured counts without exposing credential or variable names
			storedModelKeyCount?: number
			placeholderVariableCount?: number
	  }
	| { type: "inspection.finished"; inspected: number; durationMs: number }
	| { type: "inspection.failed"; code: string; message: string; cleanupId?: string }

// assign each event a stable inspection id and sequence
export type InspectionEvent = EventPayload & {
	version: 1
	inspectionId: string
	sequence: number
	timestamp: string
	upgradeId?: string
}

// specify the command, its deadline and observation mode
export type Command = {
	argv: string[]
	timeoutMs: number
	observe?: boolean | "network"
	environment?: string[]
	environmentValues?: Readonly<Record<string, string>>
	signal?: AbortSignal
}

// attach capture metadata to a command's evidence
export type CommandResult = Evidence & { observationId?: string; timedOut?: boolean; placeholderVariableCount?: number }
export type Operation = { timeoutMs: number; signal?: AbortSignal; modelCallId?: string }
export interface SandboxProvider {
	modelRequestSandbox?: import("./models/modelRequestSandbox.ts").ModelRequestSandbox
	openCredentialSession?: AgentCapability
	patchWorkspace?(sandbox: Sandbox, request: PatchOperation, operation: Operation): Promise<string | null>

	// install a verified package manager version before repository code runs
	installPackageManager?(sandbox: Sandbox, request: PackageManagerInstall, operation: Operation): Promise<void>

	// the availability check and the cost estimate for a duration
	checkAvailability(options?: Operation): Promise<void>
	estimateMaxCost(durationMs: number): number

	// bind repository and policy operations to an allocated sandbox
	createSandbox(name: string, options: Operation): Promise<Sandbox>
	prepareRepository(
		sandbox: Sandbox,
		repositoryUrl: string,
		options: Operation & { revision?: string },
	): Promise<string>
	setNetworkPolicy(sandbox: Sandbox, hosts: readonly string[], options: Operation): Promise<void>
	resetProject(sandbox: Sandbox, options: Operation): Promise<void>
	executeCommand(sandbox: Sandbox, command: Command): Promise<CommandResult>
	readFile(sandbox: Sandbox, path: string, options: Operation): Promise<string>
	writeFile(sandbox: Sandbox, path: string, contents: string, options: Operation): Promise<void>

	// read captured evidence and release the sandbox
	readAttemptedConnections(sandbox: Sandbox, evidenceId: string): Promise<Observation>
	readFileChanges(sandbox: Sandbox, evidenceId: string): Promise<Observation>
	destroySandbox(sandbox: Sandbox, options: Operation): Promise<void>
}

// bound inspections by upgrade count, time and cost
export type InspectionLimits = {
	maxUpgrades?: number
	maxDurationMs?: number
	maxCostUsd?: number
	timeouts?: Partial<Record<Stage, number>>
}

export type InspectionOptions = InspectionModeOptions & {
	callerModelExecution?: "local"

	// select a public repository and its execution provider
	repositoryUrl: string
	revision?: string
	prompts?: import("./readPrompt.ts").PromptOverrides
	telemetry?: import("@opentelemetry/api").Tracer
	sandboxProvider?: SandboxProvider

	// Caller-supplied presentation and execution settings.
	limits?: InspectionLimits
	onEvent?: (event: InspectionEvent) => void | Promise<void>
	includeTestInventory?: boolean
	applicationEnvironment?: "empty" | "placeholders" | Readonly<Record<string, string>>

	// optionally select an upgrade and supply role configuration
	upgrade?: { dependency: string; from?: string | Record<string, string>; to: string }
	models?: Readonly<Record<string, string>>
	signal?: AbortSignal
}

export type WithSandboxProvider = { sandboxProvider: SandboxProvider }

export type Baseline = { install: CheckResult; typecheck: CheckResult; tests: CheckResult }

// associate upgrade checks with their installation observations
export type UpgradeReport = Upgrade & {
	coverage?: "partial" | "skipped"
	install: CheckResult
	observation: Observation
	typecheck: CheckResult
	tests: CheckResult
	result: CheckResult
}

/**
 * Supplies the project-specific operations used by the inspection engine.
 */
export interface EcosystemAdapter {
	readonly project?: Project
	resetProject(): Promise<void>
	detectProject(): Promise<Project>
	listUpgrades(project: Project, limit: number): Promise<InspectionReport["selection"]>

	// run the package manager's install and verification checks
	install(): Promise<CheckResult>
	bumpDependency(upgrade: Upgrade): Promise<{ check: CheckResult; observation: Observation }>
	typecheck(): Promise<CheckResult>
	test(): Promise<CheckResult>
}

// identify the inspected repository and its baseline
export type InspectionReport = {
	stoppedReason?: string
	sandboxUnavailable?: boolean
	interruptedUpgrade?: string

	// Record the templates used throughout the inspection.
	promptVersions?: {
		model: import("./readPrompt.ts").PromptReference[]
		handoff: import("./readPrompt.ts").PromptReference[]
	}
	version: 1

	// Identify the revision associated with the Inspection Report.
	inspectionId: string
	repository: { url: string; commit: string }
	packageManager:
		| {
				name: PackageManager
				version: string

				// where the version that ran came from, and why a declared version did not run
				source?: "declared" | "bundled"
				declared?: { version: string; file: string }
				fallbackReason?: string
		  }
		| { reason: string }
	baseline: Baseline

	// retain selected upgrades and their ordered timeline
	selection: InspectionModeOptions & {
		// Explain an incomplete registry lookup even when no upgrades were selected.
		registryLookupIssue?: string
		limit?: number
		eligible: Upgrade[]
		selected: Upgrade[]
		omitted: Upgrade[]
		skipped: string[]
	}

	upgrades: UpgradeReport[]
	timeline: InspectionEvent[]
}

export class InspectionError extends Error {
	promptVersions?: InspectionReport["promptVersions"]
	timeline: InspectionEvent[] | import("./models/modelRequestSandbox.ts").ModelRequestSandboxEvent[] = []

	// preserve cleanup state on typed inspection failures
	cleanupId?: string
	cleanupIds?: string[]

	// when a rate limit lifts, and the versions a rejected target could have been
	retryAt?: string
	eligibleDependencyVersions?: string[]
	runtimeUsage?: import("./models/modelRequestSandbox.ts").RuntimeUsage
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message)
		this.name = "InspectionError"
	}
}

// the error codes whose message names the next step
export const explainedErrorCodes: ReadonlySet<string> = new Set([
	"github-rate-limit",
	"github-unavailable",
	"registry-unavailable",
	"repository-unavailable",
	"revision-unavailable",
	"unsupported-project",
])

// distinguish provider availability errors by reason
export class SandboxUnavailableError extends InspectionError {
	constructor(readonly reason: "authentication" | "permission" | "unavailable") {
		super("sandbox-unavailable", `Sandbox provider ${reason}`)
		this.name = "SandboxUnavailableError"
	}
}
