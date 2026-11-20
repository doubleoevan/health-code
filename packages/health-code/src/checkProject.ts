import { z } from "zod"
import { checkOperation, type InspectionContext, redact } from "./collectEvents.ts"
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
	TestFailure,
	Upgrade,
	UpgradeReport,
} from "./contracts.ts"
import { InspectionError } from "./contracts.ts"
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
const reasonDetails: Readonly<Record<string, string>> = {
	"no-tsconfig": "The project has no TypeScript configuration.",
	"missing-test-script": "The project has no test script.",
	"command-timeout": "The command reached its time limit.",
	"inspection-deadline": "The inspection reached its time limit.",
	"baseline-unavailable": "The Baseline could not establish a comparison.",
	"installation-finding": "The installation attempted an unexpected connection or filesystem change.",
	"incomplete-observation": "Installation observation was incomplete.",
	"install-failed": "The upgrade could not be installed.",
	"confirmation-install-unavailable": "The confirmation install could not establish a usable checkout.",
	"confirmation-build-unavailable": "The confirmation build could not establish a comparable test environment.",
	"incomplete-test-report": "The test report is incomplete.",
	"invalid-test-report": "The test report could not be read.",
	"unidentified-test-failure": "The test command failed without identifying a failed test.",
	"opaque-baseline": "The Baseline test failure could not be attributed to a specific test.",
	"unconfirmed-failure": "The second attempt did not confirm the first failure.",
}
export function untested(reason: string, evidence: Evidence[] = []): CheckResult {
	return { status: "untested", reason, detail: reasonDetails[reason] ?? reason, evidence }
}
export function pending(reason: string): Baseline {
	const result = untested(reason)
	return { install: result, typecheck: result, tests: result }
}
const unobserved: Observation = { complete: false, findings: [], reason: "Installation has not been observed" }
export function skippedUpgrade(upgrade: Upgrade, reason: string): UpgradeReport {
	return { ...upgrade, ...pending(reason), result: untested(reason), observation: unobserved }
}

export class NodeAdapter implements EcosystemAdapter {
	project?: Project
	constructor(
		private readonly context: InspectionContext,
		private readonly sandbox: Sandbox,
	) {}
	async resetProject(): Promise<void> {
		await this.context.step("setup", "Restore pinned project", (options) =>
			this.context.options.sandboxProvider.resetProject(this.sandbox, options),
		)
	}
	async data(args: string[]): Promise<unknown> {
		return this.context.step("detect", args[0] ?? "Read project", async (options) => {
			const result = await this.call(args, options)
			if (result.exitCode || result.stdoutTruncated) {
				throw new ProjectEvidenceError(redact(result.stderr).slice(-512) || "Incomplete project metadata")
			}
			try {
				return JSON.parse(result.stdout)
			} catch {
				throw new ProjectEvidenceError("Invalid project metadata")
			}
		})
	}
	async detectProject(): Promise<Project> {
		const result = projectSchema.safeParse(await this.data(["detect"]))
		if (!result.success) {
			throw new ProjectEvidenceError("Unsupported project metadata")
		}
		this.project = result.data
		return result.data
	}
	async listUpgrades(project: Project, limit: number): Promise<ReturnType<typeof selectUpgrades>> {
		if (limit === 0) {
			return { eligible: [], selected: [], omitted: [], skipped: [...project.skipped] }
		}
		try {
			return selectUpgrades(project, await this.registry(), limit)
		} catch (error) {
			if (!(error instanceof ProjectEvidenceError)) {
				throw error
			}
			return selectUpgrades(project, {}, limit)
		}
	}
	async registry(): Promise<Record<string, string[]>> {
		const names = Object.keys(this.project?.sources ?? {})
		if (!names.length) {
			return {}
		}
		const result = z.record(z.string(), z.array(z.string())).safeParse(await this.data(["registry", ...names]))
		if (!result.success) {
			throw new ProjectEvidenceError("Invalid registry metadata")
		}
		return result.data
	}
	private async call(args: string[], options: Operation, observe = false): Promise<CommandResult> {
		checkOperation(options.signal)
		return this.context.options.sandboxProvider.executeCommand(this.sandbox, {
			...options,
			argv: [...guest, ...args],
			environment: this.project?.environment,
			observe,
		})
	}
	async install(): Promise<CheckResult> {
		return (await this.check(["install"])).check
	}
	async bumpDependency(upgrade: Upgrade): Promise<{ check: CheckResult; observation: Observation }> {
		return this.check(["install", upgrade.dependency, upgrade.to], true)
	}
	private async check(args: string[], observe = false): Promise<{ check: CheckResult; observation: Observation }> {
		const stage = args[0] as "install" | "typecheck" | "tests"
		return this.context.step(
			stage,
			stage,
			async (options, stepId) => {
				const raw = await this.call(args, options, observe)
				checkOperation(options.signal)
				const evidence = await this.recordOutput(raw, stepId, options.signal)
				const observation = observe ? await this.observe(raw.observationId, options.signal) : unobserved
				let check: CheckResult =
					raw.exitCode === 0
						? { status: "passed", evidence: [evidence] }
						: { status: "failed", evidence: [evidence], failingTests: [] }
				if (raw.timedOut) {
					check = untested("command-timeout", [evidence])
				} else if (stage === "tests") {
					check = await this.testResult(check, options)
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
	private async testResult(result: CheckResult, options: Operation): Promise<CheckResult> {
		const raw = await this.call(["report"], options)
		if (raw.exitCode || raw.stdoutTruncated) {
			return untested("incomplete-test-report", result.evidence)
		}
		try {
			const report = testReport.parse(JSON.parse(raw.stdout))
			if (!report.complete) {
				return untested("incomplete-test-report", result.evidence)
			}
			if (report.failures.length) {
				return { status: "failed", evidence: result.evidence, failingTests: report.failures }
			}
			if (result.status === "failed" && report.granularity === "case") {
				return untested("unidentified-test-failure", result.evidence)
			}
			return result
		} catch {
			return untested("invalid-test-report", result.evidence)
		}
	}
	private async observe(id?: string, signal?: AbortSignal): Promise<Observation> {
		if (!id) {
			return unobserved
		}
		const provider = this.context.options.sandboxProvider
		const [network, files] = await Promise.all([
			provider.readAttemptedConnections(this.sandbox, id),
			provider.readFileChanges(this.sandbox, id),
		])
		checkOperation(signal)
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
		return { complete: network.complete && files.complete, findings, reason: network.reason ?? files.reason }
	}
	async typecheck(): Promise<CheckResult> {
		return this.project?.typecheck === "none"
			? untested("no-tsconfig")
			: (await this.check(["typecheck", this.project?.typecheck ?? "check"])).check
	}
	async test(): Promise<CheckResult> {
		return this.project?.testScript ? (await this.check(["tests"])).check : untested("missing-test-script")
	}
}
export class ProjectEvidenceError extends Error {}

function toTestFailureKey(test: TestFailure): string {
	return JSON.stringify([test.workspace, test.file, test.name ?? null])
}
function toFailureSignature(result: CheckResult): string {
	const evidence = result.evidence[0]
	const output = (evidence?.stderr || evidence?.stdout || "").trim()
	const diagnostics = output
		.split("\n")
		.filter((line) => /error|failed/i.test(line))
		.join("\n")
	return `${String(evidence?.exitCode)}:${(diagnostics || output).replace(/\d+ms|\d+\.\d+s/g, "")}`
}
export async function confirm(
	first: CheckResult,
	baseline: CheckResult,
	retry: () => Promise<CheckResult>,
): Promise<CheckResult> {
	if (baseline.status === "untested") {
		return untested(baseline.reason, first.evidence)
	}
	if (first.status !== "failed") {
		return first
	}
	const known = new Set(baseline.status === "failed" ? baseline.failingTests.map(toTestFailureKey) : [])
	const added = first.failingTests.filter((test) => !known.has(toTestFailureKey(test)))
	if (baseline.status === "failed" && (!first.failingTests.length || !known.size)) {
		return untested("opaque-baseline", first.evidence)
	}
	if (first.failingTests.length && !added.length) {
		return { status: "passed", evidence: first.evidence, excluded: first.failingTests }
	}
	let second: CheckResult
	try {
		second = await retry()
	} catch (error) {
		if (!isDeadline(error)) {
			throw error
		}
		return {
			...untested("inspection-deadline", first.evidence),
			attempts: [toAttempt(first)],
			unconfirmedTests: added,
			excluded: first.failingTests.filter((test) => known.has(toTestFailureKey(test))),
		}
	}
	return compareAttempts({ first, second, known, added })
}
type FailedCheck = Extract<CheckResult, { status: "failed" }>
function compareAttempts({
	first,
	second,
	known,
	added,
}: {
	first: FailedCheck
	second: CheckResult
	known: Set<string>
	added: TestFailure[]
}): CheckResult {
	const evidence = [...first.evidence, ...second.evidence]
	const attempts = [first, second].map(toAttempt)
	const excluded = first.failingTests.filter((test) => known.has(toTestFailureKey(test)))
	const observed = { attempts, excluded }
	if (second.status !== "failed") {
		return {
			...untested(second.status === "untested" ? second.reason : "unconfirmed-failure", evidence),
			...observed,
			unconfirmedTests: added,
		}
	}
	const repeated = new Set(second.failingTests.map(toTestFailureKey))
	const failingTests = added.filter((test) => repeated.has(toTestFailureKey(test)))
	if (failingTests.length || repeatedOpaqueFailure(first, second)) {
		return {
			status: "failed",
			evidence,
			failingTests,
			...observed,
			unconfirmedTests: added.filter((test) => !repeated.has(toTestFailureKey(test))),
		}
	}
	return { ...untested("unconfirmed-failure", evidence), ...observed, unconfirmedTests: added }
}

function isDeadline(error: unknown): boolean {
	return error instanceof InspectionError && error.code === "deadline"
}

function repeatedOpaqueFailure(
	first: Extract<CheckResult, { status: "failed" }>,
	second: Extract<CheckResult, { status: "failed" }>,
): boolean {
	return (
		!first.failingTests.length &&
		!second.failingTests.length &&
		toFailureSignature(first) === toFailureSignature(second)
	)
}

function toAttempt(result: CheckResult): NonNullable<CheckResult["attempts"]>[number] {
	return { status: result.status, failingTests: result.status === "failed" ? result.failingTests : [] }
}
