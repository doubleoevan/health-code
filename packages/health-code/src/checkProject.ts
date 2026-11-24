import { isDeepStrictEqual } from "node:util"
import { z } from "zod"
import { checkOperation, type InspectionContext, redact } from "./collectEvents.ts"
import { toUpgradeInstallTimeout, untested } from "./confirmCheck.ts"
import type {
	Baseline,
	CheckResult,
	Command,
	CommandResult,
	EcosystemAdapter,
	Evidence,
	InspectionOptions,
	InspectionReport,
	Observation,
	Operation,
	Project,
	Sandbox,
	Upgrade,
	UpgradeReport,
} from "./contracts.ts"
import { InspectionError } from "./contracts.ts"
import { mergeTestInventory } from "./mergeTestInventory.ts"
import {
	ProjectEvidenceError,
	parseRegistryVersions,
	type RegistryVersions,
	toRegistryLookupIssue,
} from "./parseRegistryVersions.ts"
import { readCheckErrors } from "./readTypeErrors.ts"
import { selectUpgrades } from "./selectUpgrades.ts"

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
export function skippedUpgrade(upgrade: Upgrade, reason: string, detail?: string): UpgradeReport {
	const result = untested(reason)
	return { ...upgrade, ...pending(reason), result: detail ? { ...result, detail } : result, observation: unobserved }
}

function toMissingActivity(activity: string, observation: Observation): string | undefined {
	if (!observation.complete) {
		return [`Could not verify all ${activity}.`, observation.reason].filter(Boolean).join(" ")
	}
}

export class NodeAdapter implements EcosystemAdapter {
	project?: Project
	lastObservation?: Observation
	watchChecks = false
	private skipsInstallScripts = false
	private reportedPlaceholders = false
	constructor(
		private readonly context: InspectionContext,
		private readonly sandbox: Sandbox,
	) {}
	async resetProject(): Promise<void> {
		await this.context.step("setup", "Restore inspected project", (options) =>
			this.context.options.sandboxProvider.resetProject(this.sandbox, options),
		)
	}

	// collect guest metadata within its stage timeout
	async data(args: string[], stage: "setup" | "detect" = "setup"): Promise<unknown> {
		return this.context.step(stage, args[0] ?? "Read project", (options) => this.readMetadata(args, options))
	}

	private async readMetadata(args: string[], options: Operation): Promise<unknown> {
		const result = await this.call(args, options)
		if (args[0] === "registry" && result.timedOut) {
			throw new InspectionError("registry-command-timeout", "Registry command timed out")
		}

		if (result.exitCode || result.stdoutTruncated) {
			throw new ProjectEvidenceError(redact(result.stderr).slice(-512) || "Incomplete project metadata")
		}

		// Reject malformed metadata before using it as project evidence.
		try {
			return JSON.parse(result.stdout)
		} catch {
			throw new ProjectEvidenceError("Invalid project metadata")
		}
	}

	// validate the detected project against the adapter schema
	async detectProject(): Promise<Project> {
		const result = projectSchema.safeParse(await this.data(["detect"], "detect"))
		if (!result.success) {
			throw new ProjectEvidenceError("Unsupported project metadata")
		}
		this.project = result.data
		return result.data
	}

	// return the full skipped list for an empty selection
	async listUpgrades(project: Project, limit: number): Promise<InspectionReport["selection"]> {
		if (limit === 0 && this.context.options.mode !== "listUpgrades") {
			return { eligible: [], selected: [], omitted: [], skipped: [...project.skipped] }
		}
		const target = this.context.options.upgrade
		if (target) {
			// require the inspected source version in every declaring workspace
			const sources = project.sources[target.dependency] ?? {}
			const versions = Object.values(sources)
			const matches =
				typeof target.from === "string"
					? versions.every((locked) => locked === target.from)
					: isDeepStrictEqual({ ...sources }, { ...target.from })

			// Reject a stale workspace pin before scheduling an install.
			if (!versions.length || !matches) {
				throw new ProjectEvidenceError("Inspected dependency source version differs")
			}
			const selection = selectUpgrades(
				{ ...project, sources: { [target.dependency]: sources } },
				{ [target.dependency]: [target.to] },
				limit,
			)

			// reject a selected target that fails upgrade selection
			if (!selection.selected.length) {
				throw new InspectionError(
					"invalid-upgrade",
					"The selected target must be a newer stable minor or major version",
				)
			}
			return selection
		}
		return this.lookUpUpgrades(project, limit)
	}

	private async lookUpUpgrades(project: Project, limit: number): Promise<InspectionReport["selection"]> {
		const names = Object.keys(project.sources)
		const seconds = Math.max(0, Math.ceil(this.context.operation("registry").timeoutMs / 1000))
		const timeoutReason = `registry lookup timed out after ${seconds}s`

		try {
			const { versions, packageTimeoutCount, hasRegistryDeadlineExpired } = await this.readRegistry("registry", names)
			const selection = selectUpgrades(project, versions, limit)
			const missing = names.length - Object.keys(versions).length
			if (!missing) {
				return selection
			}

			// Keep available upgrades when only some package requests failed.
			const scope = missing === names.length ? "" : ` for ${missing} of ${names.length} dependencies`
			const reason = hasRegistryDeadlineExpired
				? timeoutReason
				: packageTimeoutCount === missing
					? "registry requests timed out"
					: "package version information was unavailable"
			return { ...selection, registryLookupIssue: `Couldn’t list available upgrades${scope}: ${reason}.` }
		} catch (error) {
			// Preserve external cancellation and event-delivery failures.
			this.context.assertActive()
			return { ...selectUpgrades(project, {}, limit), registryLookupIssue: toRegistryLookupIssue(error, timeoutReason) }
		}
	}

	async registry(names: string[]): Promise<Record<string, string[]>> {
		return (await this.readRegistry("lookup", names)).versions
	}

	private async readRegistry(action: "lookup" | "registry", names: string[]): Promise<RegistryVersions> {
		if (!names.length) {
			return { versions: {}, packageTimeoutCount: 0, hasRegistryDeadlineExpired: false }
		}

		return this.context.step(
			action === "registry" ? "registry" : "setup",
			action,
			async (options) => parseRegistryVersions(await this.readMetadata([action, ...names], options), names),
			(result) => {
				const availablePackageCount = Object.keys(result.versions).length
				return availablePackageCount === names.length ? "passed" : availablePackageCount ? "untested" : "failed"
			},
		)
	}

	private async call(args: string[], options: Operation, observe: boolean | "network" = false): Promise<CommandResult> {
		// enforce cancellation before dispatching a guest command
		checkOperation(options.signal)
		const result = await this.context.options.sandboxProvider.executeCommand(this.sandbox, {
			...options,
			argv: [...guest, ...args],
			...toCommandEnvironment(this.context.options.applicationEnvironment, this.project?.environment),
			observe,
		})

		// Publish placeholder counts only while the stage can still accept evidence.
		checkOperation(options.signal)
		if (this.project && !this.reportedPlaceholders && result.placeholderVariableCount !== undefined) {
			this.reportedPlaceholders = true
			await this.context.emit({
				type: "sandbox.event",
				action: "credentials-withheld",
				sandboxId: this.sandbox.id,
				placeholderVariableCount: result.placeholderVariableCount,
			})
		}
		return result
	}
	async install(): Promise<CheckResult> {
		return (await this.check(["install"], this.watchChecks)).check
	}

	// install the original dependencies, skipping scripts when the locked network broke one
	async installBaseline(): Promise<CheckResult> {
		const first = (await this.check(["install"], true)).check
		const hasOffListConnection = this.lastObservation?.findings.some((finding) => finding.kind === "connection")
		if (first.status !== "failed" || !hasOffListConnection) {
			return first
		}

		// use the same install policy for every later comparison
		await this.resetProject()
		this.skipsInstallScripts = true
		const second = (await this.check(["install"], true)).check
		if (second.status === "passed") {
			return { ...second, evidence: [...first.evidence, ...second.evidence] }
		}

		// restore the normal policy when scripts were not the cause
		this.skipsInstallScripts = false
		return first
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
		const install = await this.check(["install", upgrade.dependency, upgrade.to], true)
		if (install.check.status === "untested" && install.check.reason === "command-timeout") {
			install.check.detail = toUpgradeInstallTimeout(install.check.evidence.at(-1)?.durationMs)
		}
		return install
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
				const raw = await this.call(this.withScriptPolicy(args), options, observe)
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
						: { status: "failed", evidence: [evidence], failingTests: readCheckErrors(args, raw) }
				if (raw.timedOut) {
					check = untested("command-timeout", [evidence])
				} else if (stage === "tests") {
					// reconcile test failures with the runner's structured report
					check = await this.testResult(check, options)
					if (args.includes("--inventory")) {
						check = mergeTestInventory({ check, commandResult: raw, evidence })
					}
				}
				return { check: this.withPolicyDisclosure(stage, check), observation }
			},
			(value) => value.check.status,
		)
	}

	// apply and disclose the install policy chosen for the baseline
	private withScriptPolicy(args: string[]): string[] {
		return args[0] === "install" && this.skipsInstallScripts ? [...args, "--ignore-scripts"] : args
	}
	private withPolicyDisclosure(stage: string, check: CheckResult): CheckResult {
		return stage === "install" && this.skipsInstallScripts ? { ...check, installScriptsSkipped: true } : check
	}

	// redact and publish the bounded command output
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
			reason:
				[toMissingActivity("network connections", network), toMissingActivity("filesystem changes", files)]
					.filter(Boolean)
					.join(" ") || undefined,
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
// replace placeholders with the caller's safe test values
function toCommandEnvironment(
	setting: InspectionOptions["applicationEnvironment"],
	names?: string[],
): Pick<Command, "environment" | "environmentValues"> {
	if (setting === "empty") {
		return { environment: [] }
	}
	return { environment: names, environmentValues: typeof setting === "object" ? setting : undefined }
}
