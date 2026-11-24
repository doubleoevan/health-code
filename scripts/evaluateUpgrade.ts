import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	createHostModel,
	createSandboxProvider,
	type InspectionModels,
	inspectRepository,
	readModelRoutes,
	type UpgradeReportV2,
} from "health-code"
import { z } from "zod"
import { scoreBudget } from "./scoreBudget.ts"

const commit = z.string().regex(/^[a-f0-9]{40}$/)

/**
 * Lists the IDs of the pinned upgrade cases.
 */
export const upgradeCaseIds = [
	"removed-apis",
	"linked-dependencies",
	"matching-versions",
	"mocked-import-path",
	"existing-failures",
] as const
export type UpgradeCaseId = (typeof upgradeCaseIds)[number]

export const upgradeCaseSchema = z.object({
	version: z.literal(1),
	id: z.enum(upgradeCaseIds),
	kind: z.literal("upgrade"),
	repositoryUrl: z.string().url(),
	commit,
	upgrade: z.object({ dependency: z.string(), from: z.string(), to: z.string() }),
	expected: z.object({
		check: z.literal("failed"),
		confirmed: z.literal(true),
		verdict: z.enum(["Fixed", "Fixed with test changes"]),
		existingTestChanges: z.boolean(),

		// the optional expectations
		locator: z.string().optional(),
		linkedDependencies: z.array(z.string()).default([]),
		diagnosisPatterns: z.array(z.string()).default([]),
	}),
	memoryMib: z.union([z.literal(4096), z.literal(8192)]).optional(),
	reference: z.object({ parent: commit, commit }).optional(),
})

/**
 * Scores one pinned upgrade using the public version 2 defaults.
 */
export async function evaluateUpgrade(upgradeCaseId: UpgradeCaseId, signal?: AbortSignal): Promise<void> {
	// load the pinned upgrade and require both accounts
	const fixture = upgradeCaseSchema.parse(
		JSON.parse(await readFile(new URL(`../evals/${upgradeCaseId}.json`, import.meta.url), "utf8")),
	)
	const { MODEL_API_KEY: apiKey, RUNTA_TOKEN: token } = process.env
	if (!apiKey || !token) {
		throw new Error("Upgrade evaluation requires a host model credential and a sandbox account")
	}

	// inspect the exact repository revision and dependency upgrade
	const provider = createSandboxProvider({ revision: fixture.commit, memoryMib: fixture.memoryMib })
	const started = Date.now()
	const inspectionReport = await inspectRepository({
		repositoryUrl: fixture.repositoryUrl,
		signal,
		upgrade: fixture.upgrade,
		sandboxProvider: provider,
		models: toEvaluationModels(process.env, apiKey),
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
	const isBreakConfirmed = [report.install, report.typecheck, report.tests].some(
		(check) =>
			check.status === "failed" &&
			check.attempts?.length === 2 &&
			check.attempts.every((attempt) => attempt.status === "failed"),
	)

	// match source evidence and look for edits to tests
	const hasExpectedLocator = matchesExpectedLocator(report, fixture)
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
		isBreakConfirmed,
		hasExpectedLocator,
		expected: fixture.expected,
		hasExpectedTestChanges: testChanges.length > 0 === fixture.expected.existingTestChanges,
		isPatchVerified:
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
	const filename = `${fixture.id}-${inspectionReport.inspectionId}.patch`
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
		confirmed: isBreakConfirmed,
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
		sourceDiff: upgradePatch && fixture.reference ? await sourceDiff(upgradePatch, fixture.reference) : null,
	}

	// write the full comparison and print a compact summary
	await writeFile(
		new URL(`${fixture.id}-${inspectionReport.inspectionId}.json`, directory),
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

// match the pinned source location when the case names one
function matchesExpectedLocator(report: UpgradeReportV2, fixture: z.infer<typeof upgradeCaseSchema>): boolean {
	const { locator } = fixture.expected
	return (
		locator === undefined ||
		report.locators.some((entry) => entry.file === locator && entry.url?.includes(fixture.commit))
	)
}

/**
 * Binds each role to its configured model with the evaluation's input bound.
 */
export function toEvaluationModels(environment: NodeJS.ProcessEnv, apiKey: string): InspectionModels {
	const { repair, releaseSummary, featureMatch, featureAdoption } = readModelRoutes(environment)
	const pricing = { ...repair.pricing, maxInputTokens: 96000 }
	const effort = "medium" as const
	return {
		releaseSummary: { model: createHostModel(releaseSummary, apiKey), pricing },
		featureMatch: { model: createHostModel(featureMatch, apiKey), pricing },
		repair: { ...repair, effort, pricing },
		featureAdoption: { ...featureAdoption, effort, pricing },
	}
}

export function gradeUpgrade({
	withinBudget,
	report,
	isBreakConfirmed,
	hasExpectedLocator,
	expected,
	hasExpectedTestChanges,
	isPatchVerified,
}: {
	report: UpgradeReportV2
	expected: Pick<z.infer<typeof upgradeCaseSchema>["expected"], "verdict" | "linkedDependencies" | "diagnosisPatterns">

	// the measured results
	isBreakConfirmed: boolean
	hasExpectedLocator: boolean
	hasExpectedTestChanges: boolean
	isPatchVerified: boolean
	withinBudget: boolean
}): { budgetAcceptance: boolean; acceptableDiagnosis: boolean } {
	// match each dependency to a flagged commit. linked dependencies share one commit
	const diagnosis = JSON.stringify(report.diagnosis ?? {})
	const dependencyCommits = report.patches.flatMap((patch) =>
		patch.commits.filter((commit) => commit.flag === "dependency"),
	)
	const { newDependencies } = report
	const dependenciesReviewed =
		dependencyCommits.every((commit) => newDependencies.some((dependency) => dependency.commit === commit.sha)) &&
		newDependencies.every(
			(dependency) =>
				dependency.reason.trim() &&
				dependencyCommits.some(
					(commit) => commit.sha === dependency.commit && commit.reason?.includes(dependency.reason),
				),
		)

	// score repair acceptance separately from a located diagnosis
	return {
		budgetAcceptance:
			withinBudget &&
			dependenciesReviewed &&
			isBreakConfirmed &&
			// require the source location, test changes and linked dependencies
			hasExpectedLocator &&
			hasExpectedTestChanges &&
			expected.linkedDependencies.every((name) =>
				newDependencies.some((dependency) => dependency.name === name && dependency.from),
			) &&
			// require passing final checks and the expected Verdict
			isPatchVerified &&
			report.verdict === expected.verdict &&
			report.patches.length > 0,

		// credit a diagnosis that identifies the expected migration
		acceptableDiagnosis:
			isBreakConfirmed &&
			hasExpectedLocator &&
			report.verdict === "Can't fix" &&
			!report.patches.length &&
			expected.diagnosisPatterns.length > 0 &&
			expected.diagnosisPatterns.every((pattern) => new RegExp(pattern).test(diagnosis)),
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
