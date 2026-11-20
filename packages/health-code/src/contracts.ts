export type Stage = "setup" | "detect" | "install" | "typecheck" | "tests"
export type Evidence = {
	stdout: string
	stderr: string
	exitCode: number
	durationMs: number
	stdoutTruncated: boolean
	stderrTruncated: boolean
}
export type InstallationFinding =
	| {
			kind: "connection"
			destination: string
			source?: "dns" | "socket" | "gateway"
			outcome: "attempted" | "blocked" | "unknown"
	  }
	| { kind: "write"; path: string }
export type Observation = { complete: boolean; findings: InstallationFinding[]; reason?: string }
export type TestFailure = { file: string; name?: string; workspace: string }
export type CheckResult = (
	| { status: "passed"; evidence: Evidence[] }
	| { status: "failed"; evidence: Evidence[]; failingTests: TestFailure[] }
	| { status: "untested"; reason: string; detail?: string; evidence: Evidence[] }
) & {
	excluded?: TestFailure[]
	unconfirmedTests?: TestFailure[]
	attempts?: { status: "passed" | "failed" | "untested"; failingTests: TestFailure[] }[]
}
export type Upgrade = { dependency: string; from: Record<string, string>; to: string; kind: "minor" | "major" }
export type PackageManager = "npm" | "bun" | "pnpm" | "yarn"
export type Project = {
	manager: PackageManager
	version: string
	sources: Record<string, Record<string, string>>
	skipped: string[]
	typecheck: "build" | "check" | "none"
	testScript?: string
	environment: string[]
}
export type Sandbox = { id: string }
type SandboxAction = "created" | "credentials-withheld" | "network-locked" | "connection-blocked" | "deleted"
export type EventPayload =
	| { type: "inspection.started"; repositoryUrl: string }
	| { type: "step.started"; stepId: string; label: string }
	| {
			type: "step.finished"
			stepId: string
			summary: string
			durationMs: number
			status: "passed" | "failed" | "untested"
	  }
	| { type: "detail"; stepId: string; stream: "stdout" | "stderr"; text: string; truncated: boolean }
	| { type: "sandbox.event"; sandboxId: string; action: SandboxAction; detail?: string }
	| { type: "inspection.finished"; inspected: number; durationMs: number }
	| { type: "inspection.failed"; code: string; message: string; cleanupId?: string }
export type InspectionEvent = EventPayload & {
	version: 1
	inspectionId: string
	sequence: number
	timestamp: string
	upgradeId?: string
}
export type Command = {
	argv: string[]
	timeoutMs: number
	observe?: boolean
	environment?: string[]
	signal?: AbortSignal
}
export type CommandResult = Evidence & { observationId?: string; timedOut?: boolean }
export type Operation = { timeoutMs: number; signal?: AbortSignal }
export interface SandboxProvider {
	checkAvailability(options?: Operation): Promise<void>
	estimateMaxCost(durationMs: number): number
	createSandbox(name: string, options: Operation): Promise<Sandbox>
	prepareRepository(sandbox: Sandbox, repositoryUrl: string, options: Operation): Promise<string>
	setNetworkPolicy(sandbox: Sandbox, hosts: readonly string[], options: Operation): Promise<void>
	resetProject(sandbox: Sandbox, options: Operation): Promise<void>
	executeCommand(sandbox: Sandbox, command: Command): Promise<CommandResult>
	readFile(sandbox: Sandbox, path: string, options: Operation): Promise<string>
	writeFile(sandbox: Sandbox, path: string, contents: string, options: Operation): Promise<void>
	readAttemptedConnections(sandbox: Sandbox, evidenceId: string): Promise<Observation>
	readFileChanges(sandbox: Sandbox, evidenceId: string): Promise<Observation>
	destroySandbox(sandbox: Sandbox, options: Operation): Promise<void>
}
export type InspectionLimits = {
	maxUpgrades?: number
	maxDurationMs?: number
	maxCostUsd?: number
	timeouts?: Partial<Record<Stage, number>>
}
export type InspectionOptions = {
	repositoryUrl: string
	sandboxProvider: SandboxProvider
	limits?: InspectionLimits
	onEvent?: (event: InspectionEvent) => void | Promise<void>
	models?: Readonly<Record<string, string>>
	signal?: AbortSignal
}
export type Baseline = { install: CheckResult; typecheck: CheckResult; tests: CheckResult }
export type UpgradeReport = Upgrade & {
	install: CheckResult
	observation: Observation
	typecheck: CheckResult
	tests: CheckResult
	result: CheckResult
}
/** Supplies the project-specific operations used by the inspection engine. */
export interface EcosystemAdapter {
	readonly project?: Project
	resetProject(): Promise<void>
	detectProject(): Promise<Project>
	listUpgrades(project: Project, limit: number): Promise<ReportCard["selection"]>
	install(): Promise<CheckResult>
	bumpDependency(upgrade: Upgrade): Promise<{ check: CheckResult; observation: Observation }>
	typecheck(): Promise<CheckResult>
	test(): Promise<CheckResult>
}
export type ReportCard = {
	version: 1
	inspectionId: string
	repository: { url: string; commit: string }
	packageManager: { name: PackageManager; version: string } | { reason: string }
	baseline: Baseline
	selection: { limit?: number; eligible: Upgrade[]; selected: Upgrade[]; omitted: Upgrade[]; skipped: string[] }
	upgrades: UpgradeReport[]
	timeline: InspectionEvent[]
}
export class InspectionError extends Error {
	timeline: InspectionEvent[] = []
	cleanupId?: string
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message)
		this.name = "InspectionError"
	}
}
export class SandboxUnavailableError extends InspectionError {
	constructor(readonly reason: "authentication" | "permission" | "unavailable") {
		super("sandbox-unavailable", `Sandbox provider ${reason}`)
		this.name = "SandboxUnavailableError"
	}
}
