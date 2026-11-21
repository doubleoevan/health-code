import { z } from "zod"
import { checkOperation, type InspectionContext, redact } from "./collectEvents.ts"
import { untested } from "./confirmCheck.ts"
import type {
	Baseline,
	CheckResult,
	CommandResult,
	EcosystemAdapter,
	Evidence,
	Observation,
	Operation,
	Project,
	Sandbox,
	Upgrade,
	UpgradeReport,
} from "./contracts.ts"
import { InspectionError } from "./contracts.ts"
import { selectUpgrades } from "./selectUpgrades.ts"
import { testInventorySummarySchema } from "./testInventorySummary.ts"

const projectSchema = z.object({
	manager: z.enum(["npm", "bun", "pnpm", "yarn"]),
	version: z.string(),
	sources: z.record(z.string(), z.record(z.string(), z.string())),
	skipped: z.array(z.string()),
	typecheck: z.enum(["build", "check", "none"]),
	testScript: z.string().optional(),
	environment: z.array(z.string()),
})
const testReport = z.object({
	complete: z.boolean(),
	granularity: z.enum(["case", "exit"]),
	failures: z.array(z.object({ file: z.string(), workspace: z.string(), name: z.string().optional() })),
})
const guest = ["node", "/opt/health-code/project.mjs"]
export function pending(reason: string): Baseline {
	const result = untested(reason)
	return { install: result, typecheck: result, tests: result }
}
// supply incomplete evidence for upgrades skipped before installation
const unobserved: Observation = { complete: false, findings: [], reason: "Installation has not been observed" }
export function skippedUpgrade(upgrade: Upgrade, reason: string): UpgradeReport {
	return { ...upgrade, ...pending(reason), result: untested(reason), observation: unobserved }
}

export class NodeAdapter implements EcosystemAdapter {
	project?: Project
	lastObservation?: Observation
	watchChecks = false
	constructor(
		private readonly context: InspectionContext,
		private readonly sandbox: Sandbox,
	) {}
	async resetProject(): Promise<void> {
		await this.context.step("setup", "Restore pinned project", (options) =>
			this.context.options.sandboxProvider.resetProject(this.sandbox, options),
		)
	}
	// collect guest metadata within its stage timeout
	async data(args: string[]): Promise<unknown> {
		const stage = args[0] === "detect" || args[0] === "registry" ? "detect" : "setup"
		return this.context.step(stage, args[0] ?? "Read project", async (options) => {
			const result = await this.call(args, options)
			if (result.exitCode || result.stdoutTruncated) {
				throw new ProjectEvidenceError(redact(result.stderr).slice(-512) || "Incomplete project metadata")
			}
			// reject malformed metadata before using it as project evidence
			try {
				return JSON.parse(result.stdout)
			} catch {
				throw new ProjectEvidenceError("Invalid project metadata")
			}
		})
	}
	// validate the detected project against the adapter schema
	async detectProject(): Promise<Project> {
		const result = projectSchema.safeParse(await this.data(["detect"]))
		if (!result.success) {
			throw new ProjectEvidenceError("Unsupported project metadata")
		}
		this.project = result.data
		return result.data
	}
	// return the full skipped list for an empty selection
	async listUpgrades(project: Project, limit: number): Promise<ReturnType<typeof selectUpgrades>> {
		if (limit === 0) {
			return { eligible: [], selected: [], omitted: [], skipped: [...project.skipped] }
		}
		const target = this.context.options.upgrade
		if (target) {
			// require the pinned source version in every declaring workspace
			const versions = Object.values(project.sources[target.dependency] ?? {})
			if (!versions.length || versions.some((locked) => locked !== target.from)) {
				throw new ProjectEvidenceError("Pinned dependency source version differs")
			}
			const selection = selectUpgrades(project, { [target.dependency]: [target.to] }, limit)
			// reject a pinned target that fails upgrade selection
			if (!selection.selected.length) {
				throw new InspectionError("invalid-upgrade", "The pinned target must be a newer stable minor or major version")
			}
			return selection
		}
		try {
			// discover eligible versions from registry evidence
			return selectUpgrades(project, await this.registry(), limit)
		} catch (error) {
			if (!(error instanceof ProjectEvidenceError)) {
				throw error
			}
			return selectUpgrades(project, {}, limit)
		}
	}
	// fetch versions only for the requested package names
	async registry(lookup?: string[]): Promise<Record<string, string[]>> {
		const names = lookup ?? Object.keys(this.project?.sources ?? {})
		if (!names.length) {
			return {}
		}
		const result = z
			.record(z.string(), z.array(z.string()))
			.safeParse(await this.data([lookup ? "lookup" : "registry", ...names]))
		// reject registry records outside the expected schema
		if (!result.success) {
			throw new ProjectEvidenceError("Invalid registry metadata")
		}
		return result.data
	}
	private async call(args: string[], options: Operation, observe: boolean | "network" = false): Promise<CommandResult> {
		// enforce cancellation before dispatching a guest command
		checkOperation(options.signal)
		return this.context.options.sandboxProvider.executeCommand(this.sandbox, {
			...options,
			argv: [...guest, ...args],
			environment: this.context.options.applicationEnvironment === "empty" ? [] : this.project?.environment,
			observe,
		})
	}
	async install(): Promise<CheckResult> {
		return (await this.check(["install"], this.watchChecks)).check
	}
	// observe lockfile resolution separately from installation
	async resolveLock(): Promise<{ check: CheckResult; observation: Observation }> {
		return this.check(["install", "--resolve-lock"], true)
	}
	async refreshInstallation(): Promise<{ check: CheckResult; observation: Observation }> {
		return this.check(["install", "--update-lock"], true)
	}
	// observe installation of the requested upgrade
	async bumpDependency(upgrade: Upgrade): Promise<{ check: CheckResult; observation: Observation }> {
		return this.check(["install", upgrade.dependency, upgrade.to], true)
	}
	private async check(
		args: string[],
		observe: boolean | "network" = false,
	): Promise<{ check: CheckResult; observation: Observation }> {
		const stage = args[0] as "install" | "typecheck" | "tests"
		return this.context.step(
			stage,
			stage,
			async (options, stepId) => {
				const raw = await this.call(args, options, observe)
				checkOperation(options.signal)
				// attach redacted output and optional installation observations
				const evidence = await this.recordOutput(raw, stepId, options.signal)
				const observation = observe
					? await this.observe(raw.observationId, options.signal, observe === "network")
					: unobserved
				this.lastObservation = observation
				// derive an initial check status from command completion
				let check: CheckResult =
					raw.exitCode === 0
						? { status: "passed", evidence: [evidence] }
						: { status: "failed", evidence: [evidence], failingTests: [] }
				if (raw.timedOut) {
					check = untested("command-timeout", [evidence])
				} else if (stage === "tests") {
					// reconcile test failures with the runner's structured report
					check = await this.testResult(check, options)
					if (args.includes("--inventory")) {
						check = withInventory(check, raw, evidence)
					}
				}
				return { check, observation }
			},
			(value) => value.check.status,
		)
	}
	private async recordOutput(raw: CommandResult, stepId: string, signal?: AbortSignal): Promise<Evidence> {
		const evidence: Evidence = {
			stdout: redact(raw.stdout).slice(0, 65536),
			stderr: redact(raw.stderr).slice(0, 65536),
			exitCode: raw.exitCode,
			durationMs: raw.durationMs,
			stdoutTruncated: raw.stdoutTruncated || raw.stdout.length > 65536,
			stderrTruncated: raw.stderrTruncated || raw.stderr.length > 65536,
		}
		for (const stream of ["stdout", "stderr"] as const) {
			checkOperation(signal)
			if (evidence[stream]) {
				await this.context.emit({
					type: "detail",
					stepId,
					stream,
					text: evidence[stream],
					truncated: evidence[`${stream}Truncated` as "stdoutTruncated" | "stderrTruncated"],
				})
			}
		}
		return evidence
	}
	// retain incomplete test evidence when the reporter failed
	private async testResult(result: CheckResult, options: Operation): Promise<CheckResult> {
		const raw = await this.call(["report"], options)
		if (raw.exitCode || raw.stdoutTruncated) {
			return untested("incomplete-test-report", result.evidence)
		}
		try {
			// validate the runner's reported coverage
			const report = testReport.parse(JSON.parse(raw.stdout))
			if (!report.complete) {
				return untested("incomplete-test-report", result.evidence)
			}
			if (this.context.options.includeTestInventory && report.granularity === "exit") {
				result.inventoryUnavailable = "Test command reports only an exit status"
			}
			// retain named failures and flag unexplained failing exits
			if (report.failures.length) {
				return { status: "failed", evidence: result.evidence, failingTests: report.failures }
			}
			if (result.status === "failed" && report.granularity === "case") {
				return untested("unidentified-test-failure", result.evidence)
			}
			return result
		} catch {
			// classify malformed reports as untested
			return untested("invalid-test-report", result.evidence)
		}
	}
	private async observe(id?: string, signal?: AbortSignal, networkOnly = false): Promise<Observation> {
		if (!id) {
			return unobserved
		}
		// combine network and filesystem observations
		const provider = this.context.options.sandboxProvider
		const [network, files] = await Promise.all([
			provider.readAttemptedConnections(this.sandbox, id),
			networkOnly ? { complete: true, findings: [], reason: undefined } : provider.readFileChanges(this.sandbox, id),
		])
		checkOperation(signal)
		// emit a sandbox event for each blocked connection
		const findings = [...network.findings, ...files.findings]
		for (const finding of findings) {
			checkOperation(signal)
			if (finding.kind === "connection" && finding.outcome === "blocked") {
				await this.context.emit({
					type: "sandbox.event",
					action: "connection-blocked",
					sandboxId: this.sandbox.id,
					detail: finding.destination,
				})
			}
		}
		// report coverage across the requested observation channels
		return {
			complete: network.complete && files.complete,
			findings,
			reason: network.reason ?? files.reason,
			...(network.destinations ? { destinations: network.destinations } : {}),
		}
	}
	// select the typecheck mode detected in the project
	async typecheck(): Promise<CheckResult> {
		return this.project?.typecheck === "none"
			? untested("no-tsconfig")
			: (await this.check(["typecheck", this.project?.typecheck ?? "check"])).check
	}
	// run the declared test script with the selected inventory policy
	async test(): Promise<CheckResult> {
		return this.project?.testScript
			? (
					await this.check(
						this.context.options.includeTestInventory ? ["tests", "--inventory"] : ["tests"],
						this.watchChecks && "network",
					)
				).check
			: untested("missing-test-script")
	}
}
export class ProjectEvidenceError extends Error {}

function parseInventory(text: string): unknown {
	try {
		return JSON.parse(text)
	} catch {
		return undefined
	}
}
// merge inventory failures only when a complete summary is available
function withInventory(check: CheckResult, raw: CommandResult, evidence: Evidence): CheckResult {
	if (check.inventoryUnavailable) {
		return check
	}
	const summary = raw.stdoutTruncated ? undefined : testInventorySummarySchema.safeParse(parseInventory(raw.stdout))
	if (!summary?.success) {
		return untested("incomplete-test-report", [evidence])
	}
	// represent file loading errors as additional test failures
	const failures = summary.data.testFileErrors.map(({ file }) => ({ workspace: ".", file }))
	if (failures.length) {
		check = {
			status: "failed",
			evidence: [evidence],
			failingTests: [...(check.status === "failed" ? check.failingTests : []), ...failures],
		}
	}
	check.inventory = summary.data
	return check
}
