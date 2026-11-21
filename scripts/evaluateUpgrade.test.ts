import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import type { UpgradeReportV2 } from "health-code"
import { gradeUpgrade, sourceDiff } from "./evaluateUpgrade.ts"
import { scoreBudget } from "./scoreBudget.ts"

test("a repeated and located diagnosis is distinct from a verified repair", () => {
	const input = { withinBudget: true, repeated: true, located: true, unchanged: true, green: true }
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
	assert.equal(gradeUpgrade({ ...input, report: diagnosis, located: false }).acceptableDiagnosis, false)
	const fixed = {
		verdict: "Fixed",
		newDependencies: [],
		patches: [{ commits: [] }],
	} as unknown as UpgradeReportV2
	// require passing checks and unchanged tests within budget
	assert.equal(gradeUpgrade({ ...input, report: fixed }).budgetAcceptance, true)
	assert.equal(gradeUpgrade({ ...input, report: fixed, withinBudget: false }).budgetAcceptance, false)
	assert.equal(gradeUpgrade({ ...input, report: fixed, green: false }).budgetAcceptance, false)
	assert.equal(gradeUpgrade({ ...input, report: fixed, unchanged: false }).budgetAcceptance, false)
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
	// reject each budget violation independently
	assert.equal(scoreBudget(fixture), true)
	for (const change of [
		{ modelUsage: [{ ...receipt, outputTokens: 8193 }] },
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
