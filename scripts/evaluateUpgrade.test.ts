import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import type { UpgradeReportV2 } from "health-code"
import { gradeUpgrade, sourceDiff, toEvaluationModels, upgradeCaseIds, upgradeCaseSchema } from "./evaluateUpgrade.ts"
import { scoreBudget } from "./scoreBudget.ts"

// start each grading test with every measured check passing
const passingChecks = {
	withinBudget: true,
	isBreakConfirmed: true,
	hasExpectedLocator: true,
	hasExpectedTestChanges: true,
	isPatchVerified: true,
}

test("a repeated and located diagnosis is distinct from a verified repair", () => {
	const expected = { verdict: "Fixed" as const, linkedDependencies: [], diagnosisPatterns: ["readConfigFile", "sys"] }
	const input = { ...passingChecks, expected }
	const diagnosis = {
		verdict: "Can't fix",
		patches: [],
		newDependencies: [],
		diagnosis: { actions: ["Migrate readConfigFile and sys"] },
	} as unknown as UpgradeReportV2

	// accept a located diagnosis without awarding a repair
	assert.deepEqual(gradeUpgrade({ ...input, report: diagnosis }), {
		acceptableDiagnosis: true,
		budgetAcceptance: false,
	})
	assert.equal(gradeUpgrade({ ...input, report: diagnosis, hasExpectedLocator: false }).acceptableDiagnosis, false)
	const fixed = {
		verdict: "Fixed",
		newDependencies: [],
		patches: [{ commits: [] }],
	} as unknown as UpgradeReportV2

	// require passing checks and unchanged tests within budget
	assert.equal(gradeUpgrade({ ...input, report: fixed }).budgetAcceptance, true)
	assert.equal(gradeUpgrade({ ...input, report: fixed, withinBudget: false }).budgetAcceptance, false)
	assert.equal(gradeUpgrade({ ...input, report: fixed, isPatchVerified: false }).budgetAcceptance, false)
	assert.equal(gradeUpgrade({ ...input, report: fixed, hasExpectedTestChanges: false }).budgetAcceptance, false)
})
test("an upgrade case requires its expected verdict and linked dependencies", () => {
	const expected = { verdict: "Fixed" as const, linkedDependencies: ["vite"], diagnosisPatterns: [] }
	const input = { ...passingChecks, expected }

	// build a Fixed report whose linked dependencies share one commit
	const linkedDependency = { name: "vite", reason: "Required peer", commit: "fixture", from: { ".": "7.0.0" } }
	const matchingDependency = { name: "vitest", reason: "Match vite", commit: "fixture" }
	const report = {
		verdict: "Fixed",
		newDependencies: [linkedDependency, matchingDependency],
		patches: [{ commits: [{ flag: "dependency", sha: "fixture", reason: "Required peer\nMatch vite" }] }],
	} as unknown as UpgradeReportV2

	// reject a missing linked dependency or a different verdict
	assert.equal(gradeUpgrade({ ...input, report }).budgetAcceptance, true)
	const unlinkedReport = { ...report, newDependencies: [], patches: [{ commits: [] }] } as unknown as UpgradeReportV2
	assert.equal(gradeUpgrade({ ...input, report: unlinkedReport }).budgetAcceptance, false)

	// reject a new dependency that shares the linked dependency's name
	const { from: _from, ...addedDependency } = linkedDependency
	const addedReport = { ...report, newDependencies: [addedDependency] } as unknown as UpgradeReportV2
	assert.equal(gradeUpgrade({ ...input, report: addedReport }).budgetAcceptance, false)

	// reject a flagged commit with no reported dependency
	const unreportedDependencyReport = { ...report, newDependencies: [] } as unknown as UpgradeReportV2
	assert.equal(
		gradeUpgrade({ ...input, expected: { ...expected, linkedDependencies: [] }, report: unreportedDependencyReport })
			.budgetAcceptance,
		false,
	)
	const changedTestsReport = { ...report, verdict: "Fixed with test changes" } as UpgradeReportV2
	assert.equal(gradeUpgrade({ ...input, report: changedTestsReport }).budgetAcceptance, false)
})
test("every pinned upgrade case matches the case schema", () => {
	// compare each file name with its case ID
	for (const id of upgradeCaseIds) {
		const text = readFileSync(new URL(`../evals/${id}.json`, import.meta.url), "utf8")
		assert.equal(upgradeCaseSchema.parse(JSON.parse(text)).id, id)
	}
})
test("each evaluation role uses its own configured model", () => {
	const models = toEvaluationModels(
		{
			HEALTH_CODE_MODEL_HOST: "https://api.anthropic.com",
			HEALTH_CODE_MODEL: "default-model",
			HEALTH_CODE_SUMMARY_MODEL: "summary-model",
			HEALTH_CODE_MATCH_MODEL: "match-model",
			HEALTH_CODE_ADOPTION_MODEL: "adoption-model",
		},
		"fixture-key",
	)

	// read the model ID from each bound role
	const hostIds = [models.releaseSummary.model, models.featureMatch.model].map((model) =>
		typeof model === "string" ? model : model.modelId,
	)
	assert.deepEqual(hostIds, ["summary-model", "match-model"])
	assert.deepEqual(
		[models.repair.modelId, models.featureAdoption.modelId, models.repair.pricing.maxInputTokens],
		["default-model", "adoption-model", 96000],
	)
})

test("the reference diff applies mailboxes in an isolated index", async () => {
	// build the two revisions in a disposable repository
	const repo = mkdtempSync(join(tmpdir(), "score-fixture-"))
	const git = (args: string[]): string =>
		execFileSync(
			"git",
			[
				"-C",
				repo,
				"-c",
				"core.hooksPath=/dev/null",
				"-c",
				"user.name=Fixture",
				"-c",
				"user.email=fixture@example.org",
				"-c",
				"commit.gpgSign=false",
				...args,
			],
			{ encoding: "utf8" },
		)
	try {
		// create the reference repository and its base commit
		git(["init", "-q"])
		writeFileSync(join(repo, "case.ts"), "export const value = 1\n")
		git(["add", "case.ts"])
		git(["commit", "-qm", "before"])
		const base = git(["rev-parse", "HEAD"]).trim()

		// capture a one-commit change as a mailbox
		writeFileSync(join(repo, "case.ts"), "export const value = 2\n")
		git(["commit", "-qam", "after"])
		const tip = git(["rev-parse", "HEAD"]).trim()
		const mailbox = git(["format-patch", "--stdout", `${base}..${tip}`])
		const patch = { base, mailbox } as UpgradeReportV2["patches"][number]

		// compare each reference and verify the checkout stays clean
		assert.equal(await sourceDiff(patch, { parent: base, commit: tip }, repo), "")
		assert.match(await sourceDiff(patch, { parent: base, commit: base }, repo), /export const value = 2/)
		assert.equal(git(["status", "--porcelain"]), "")
	} finally {
		rmSync(repo, { recursive: true, force: true })
	}
})

test("default budget acceptance checks measured turns, wall time, output and charges", () => {
	const receipt = {
		role: "repair" as const,
		step: "repair",
		modelId: "fixture",
		durationMs: 300,
		outputTokens: 8192,
		costUsd: 0.05,
	}
	const fixture = {
		durationMs: 3000,
		sandboxCostUpperBoundUsd: 0.01,
		modelUsage: [receipt],
		attemptDurationMs: { repair: 1000 },
		limits: {
			maxDurationMs: 3600000,
			maxCostUsd: 15,
			agent: {
				repair: { maxTurns: 40, maxDurationMs: 1200000, maxCostUsd: 4 },
				featureAdoption: { maxTurns: 25, maxDurationMs: 600000, maxCostUsd: 2 },
			},
		},
	}

	// accept a caller role at its output and time limits
	const callerReceipt = { ...receipt, role: "featureMatch" as const, durationMs: 120000, outputTokens: 4096 }
	assert.equal(scoreBudget({ ...fixture, modelUsage: [receipt, callerReceipt] }), true)

	// reject each budget violation independently
	assert.equal(scoreBudget(fixture), true)
	for (const change of [
		{ modelUsage: [{ ...receipt, outputTokens: 8193 }] },
		{ modelUsage: [receipt, { ...callerReceipt, outputTokens: 4097 }] },
		{ modelUsage: [receipt, { ...callerReceipt, durationMs: 120001 }] },
		{ modelUsage: [{ ...receipt, costUsd: 4.01 }] },
		{ modelUsage: [{ ...receipt, costUsd: undefined, reservedUsd: 4.01 }] },
		{ modelUsage: [{ ...receipt, outputTokens: undefined }] },
		{ modelUsage: Array.from({ length: 41 }, () => receipt) },
		{ durationMs: 3600001 },
		{ attemptDurationMs: { repair: 1200001 } },
		{ attemptDurationMs: {} },
		{ sandboxCostUpperBoundUsd: 14.96 },
		{ limits: { ...fixture.limits, maxCostUsd: 16 } },
	]) {
		assert.equal(scoreBudget({ ...fixture, ...change }), false)
	}
})
