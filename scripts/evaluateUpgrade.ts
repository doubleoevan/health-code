import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createSandboxProvider, inspectRepository, type UpgradeReportV2 } from "health-code"
import { z } from "zod"
import { scoreBudget } from "./scoreBudget.ts"

const commit = z.string().regex(/^[a-f0-9]{40}$/)
const schema = z.object({
	version: z.literal(1),
	id: z.literal("typescript-7"),
	kind: z.literal("upgrade"),
	repositoryUrl: z.string().url(),
	commit,
	upgrade: z.object({ dependency: z.string(), from: z.string(), to: z.string() }),
	expected: z.object({
		check: z.literal("failed"),
		confirmed: z.literal(true),
		locator: z.string(),
		verdict: z.literal("Fixed"),
		existingTestChanges: z.literal(false),
	}),
	reference: z.object({ parent: commit, commit }),
})

/**
 * Scores the historical TypeScript regression using the public version 2 defaults.
 */
export async function evaluateUpgrade(signal?: AbortSignal): Promise<void> {
	// load the pinned upgrade and require both accounts
	const fixture = schema.parse(
		JSON.parse(await readFile(new URL("../evals/typescript-7.json", import.meta.url), "utf8")),
	)
	if (!process.env.ANTHROPIC_API_KEY || !process.env.RUNTA_TOKEN) {
		throw new Error("TypeScript evaluation requires a host model credential and a sandbox account")
	}

	// configure the host model and its token prices
	const modelId = "claude-opus-5-5"
	const baseUrl = "https://api.anthropic.com/v1"
	const model = createAnthropic({ baseURL: baseUrl, apiKey: process.env.ANTHROPIC_API_KEY })(modelId)
	const pricing = { inputUsdPerMillion: 4, outputUsdPerMillion: 20, maxInputTokens: 96000 }

	// bind sandbox requests to the registered model credential
	const route = {
		protocol: "anthropic" as const,
		effort: "medium" as const,
		baseUrl,
		modelId,
		credential: {
			name: process.env.HEALTH_CODE_STORED_CREDENTIAL ?? "anthropic-api-key",
			header: "x-api-key",
			valueTemplate: `\${credential}`,
		},
		pricing,
	}

	// inspect the exact repository revision and dependency upgrade
	const provider = createSandboxProvider({ revision: fixture.commit })
	const started = Date.now()
	const inspectionReport = await inspectRepository({
		repositoryUrl: fixture.repositoryUrl,
		signal,
		upgrade: fixture.upgrade,
		sandboxProvider: provider,
		models: {
			releaseSummary: { model, pricing },
			featureMatch: { model, pricing },
			repair: route,
			featureAdoption: route,
		},
		onEvent(event) {
			// show step progress and elapsed time
			if (event.type === "step.started") {
				console.error(event.label)
			}
			if (event.type === "step.finished") {
				console.error(event.status, `${Math.round(event.durationMs / 1000)}s`)
			}

			// show agent turns and sandbox lifecycle events
			if (event.type === "detail" && event.text.startsWith("Agent turn ")) {
				console.error(event.text)
			}
			if (event.type === "sandbox.event") {
				console.error(event.action, event.sandboxId)
			}
		},
	})

	// require evidence from the pinned commit
	const report = inspectionReport.upgrades[0]
	if (!report || inspectionReport.repository.commit !== fixture.commit) {
		throw new Error(
			"Pinned upgrade did not produce evidence: " +
				JSON.stringify({
					manager: inspectionReport.packageManager,
					selection: inspectionReport.selection,
					baseline: inspectionReport.baseline.tests.status,
				}),
		)
	}

	// check that the failure reproduced on both attempts
	const repeated = [report.typecheck, report.tests].some(
		(check) =>
			check.status === "failed" &&
			check.attempts?.length === 2 &&
			check.attempts.every((attempt) => attempt.status === "failed"),
	)

	// match source evidence and look for edits to tests
	const located = report.locators.some(
		(loc) => loc.file === fixture.expected.locator && loc.url?.includes(fixture.commit),
	)
	const testChanges = report.patches.flatMap((patch) => patch.commits.filter((entry) => entry.flag === "test"))
	const upgradePatch = report.patches.find((patch) => patch.role === "upgrade")
	const verified = upgradePatch?.verification

	// score model usage and sandbox time against the shared budget
	const durationMs = Date.now() - started
	const sandboxCostUpperBoundUsd =
		inspectionReport.runtimeUsage?.runtimes.reduce((sum, runtime) => sum + runtime.upperBoundUsd, 0) ??
		provider.estimateMaxCost(durationMs)
	const withinBudget = scoreBudget({
		limits: inspectionReport.limits,
		modelUsage: report.modelUsage,
		attemptDurationMs: report.attemptDurationMs,
		durationMs,
		sandboxCostUpperBoundUsd,
	})

	// grade the repair using the final patch checks
	const score = gradeUpgrade({
		withinBudget,
		report,
		repeated,
		located,
		unchanged: !testChanges.length,
		green:
			verified?.install.status === "passed" &&
			verified.typecheck.status === "passed" &&
			verified.tests.status === "passed",
	})
	const deleted = inspectionReport.timeline.some(
		(event) => event.type === "sandbox.event" && event.action === "deleted",
	)
	const passed = score.budgetAcceptance && deleted

	// save the tested mailbox beside the evaluation report
	const directory = new URL("../logs/", import.meta.url)
	await mkdir(directory, { recursive: true })
	const filename = `typescript-7-${inspectionReport.inspectionId}.patch`
	if (upgradePatch) {
		await writeFile(new URL(filename, directory), upgradePatch.mailbox)
	}

	// collect the evaluation result and supporting evidence
	const outcome = {
		case: fixture.id,
		status: passed ? "passed" : "failed",
		...score,
		finalChecks: verified
			? {
					install: verified.install.status,
					typecheck: verified.typecheck.status,
					tests: verified.tests.status,
					addedCases: verified.addedCases,
				}
			: null,
		patch: upgradePatch && {
			filename,
			base: upgradePatch.base,
			testedTip: upgradePatch.testedTip,
			digest: upgradePatch.digest,
		},
		deleted,
		effectiveLimits: inspectionReport.limits,
		promptVersions: inspectionReport.promptVersions,
		commit: inspectionReport.repository.commit,
		verdict: report.verdict,
		confirmed: repeated,
		locators: report.locators,
		testChanges,
		dependencies: report.newDependencies,
		diagnosis: report.diagnosis,
		attemptTurns: report.modelUsage.filter((item) => item.step === "repair").length,
		modelUsage: report.modelUsage,
		modelCostUsd: report.modelUsage.reduce((sum, item) => sum + (item.costUsd ?? item.reservedUsd ?? 0), 0),
		durationMs,
		withinBudget,
		attemptDurationMs: report.attemptDurationMs,
		sandboxCostUpperBoundUsd,
		sourceDiff: upgradePatch ? await sourceDiff(upgradePatch, fixture.reference) : null,
	}

	// write the full comparison and print a compact summary
	await writeFile(
		new URL(`typescript-7-${inspectionReport.inspectionId}.json`, directory),
		`${JSON.stringify(outcome, null, 2)}\n`,
	)
	console.log(
		JSON.stringify(
			{
				...outcome,
				sourceDiff: outcome.sourceDiff === null ? null : "See evaluation report",
				sourceEvidence: {
					baseline: inspectionReport.baseline.tests.status,
					result: report.result.status,
					observation: report.observation.reason,
				},
			},
			null,
			2,
		),
	)
	if (!passed) {
		process.exitCode = 1
	}
}

export function gradeUpgrade({
	withinBudget,
	report,
	repeated,
	located,
	unchanged,
	green,
}: {
	report: UpgradeReportV2
	repeated: boolean
	located: boolean
	unchanged: boolean
	green: boolean
	withinBudget: boolean
}): { budgetAcceptance: boolean; acceptableDiagnosis: boolean } {
	// match each declared dependency to a justified patch commit
	const diagnosis = JSON.stringify(report.diagnosis ?? {})
	const flagged = report.patches.flatMap((patch) => patch.commits.filter((commit) => commit.flag === "dependency"))
	const declared = report.newDependencies
	const dependenciesReviewed =
		declared.length === flagged.length &&
		declared.every(
			(dep) => dep.reason.trim() && flagged.some((commit) => commit.sha === dep.commit && commit.reason === dep.reason),
		)

	// score repair acceptance separately from a located diagnosis
	return {
		budgetAcceptance:
			withinBudget &&
			dependenciesReviewed &&
			repeated &&
			// require the tested repair to preserve existing tests
			located &&
			unchanged &&
			green &&
			report.verdict === "Fixed" &&
			report.patches.length > 0,

		// credit a diagnosis that identifies the expected migration
		acceptableDiagnosis:
			repeated &&
			located &&
			report.verdict === "Can't fix" &&
			!report.patches.length &&
			/readConfigFile/.test(diagnosis) &&
			/(?:\bsys\b|parseJsonConfigFileContent)/.test(diagnosis),
	}
}

export async function sourceDiff(
	patch: UpgradeReportV2["patches"][number],
	reference: { parent: string; commit: string },
	repository = process.cwd(),
): Promise<string> {
	// isolate git configuration and the index used for scoring
	const directory = await mkdtemp(join(tmpdir(), "health-code-score-"))
	const env = {
		PATH: process.env.PATH,
		LANG: "C",
		GIT_CONFIG_SYSTEM: "/dev/null",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_INDEX_FILE: join(directory, "index"),
	}
	const git = (args: string[], input?: string): string =>
		execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", directory, ...args], {
			encoding: "utf8",
			env,
			input,
			maxBuffer: 4 * 1024 * 1024,
		})
	try {
		// Use an isolated index and object store. Never check out or execute candidate source on the host.
		git(["clone", "--bare", "--shared", "--", repository, "."])
		git(["read-tree", patch.base])

		// split the mailbox and apply each change to the temporary index
		await mkdir(join(directory, "messages"))
		git(["mailsplit", "-omessages"], patch.mailbox)
		for (const name of (await readdir(join(directory, "messages"))).sort()) {
			git(["mailinfo", "message", "change"], await readFile(join(directory, "messages", name), "utf8"))
			git(["apply", "--cached", "--binary", "--whitespace=nowarn", "change"])
		}

		// collect source paths changed by either repair
		const referencePaths = git(["diff", "--name-only", "-z", reference.parent, reference.commit, "--", "*.ts", "*.js"])
			.split("\0")
			.filter(Boolean)
		const candidatePaths = git(["diff", "--cached", "--name-only", "-z", patch.base, "--", "*.ts", "*.js"])
			.split("\0")
			.filter(Boolean)

		// compare the candidate index with the reference commit
		const paths = [...new Set([...referencePaths, ...candidatePaths])]
		return paths.length
			? git(["diff", "--cached", "--no-ext-diff", "--no-textconv", reference.commit, "--", ...paths])
			: ""
	} finally {
		await rm(directory, { recursive: true, force: true })
	}
}
