import assert from "node:assert/strict"
import { test } from "node:test"
import type { UpgradeReportV2, Verdict } from "../src/agentContracts.ts"
import { selectFeatureMatches } from "../src/rankFeatureMatches.ts"
import { type PatchReplay, replayPatch } from "./replayPatch.ts"

const verdicts: Record<PatchReplay, Verdict> = {
	dependency: "Fixed",
	"install-break": "Fixed",
	"unresolved-lock": "Can't fix",
	"new-test": "Fixed",
	undeclared: "Can't fix",
	"new-hook": "Can't fix",
	passes: "Passes as is",
	repair: "Fixed",
	test: "Fixed with test changes",
	decline: "Can't fix",
	binding: "Untested",
	"new-host": "Untested",
}
for (const [mode, verdict] of Object.entries(verdicts)) {
	test(`candidate replay ${mode} yields ${verdict}`, async () => {
		// check the verdict and patch count for each replay
		const { report, starts } = await replayPatch(mode as PatchReplay)
		assert.equal(report.verdict, verdict, report.diagnosis?.stopReason ?? "")
		assert.equal(
			report.patches.length,
			["passes", "repair", "test", "new-test", "dependency", "install-break"].includes(mode) ? 1 : 0,
		)

		// verify the stop reason when lockfile recovery fails
		if (mode === "unresolved-lock") {
			assert.equal(starts, 1)
			assert.match(report.diagnosis?.stopReason ?? "", /lockfile/)
		}

		// distinguish added test coverage from edits to existing expectations
		if (mode === "new-test") {
			assert.deepEqual(report.patches[0]?.verification?.addedCases, [{ file: "added.test.ts", name: "new behavior" }])
		}
		if (mode === "test") {
			assert.equal(report.patches[0]?.commits.at(-1)?.flag, "test")
		}

		// trace newly admitted dependencies to the patch commit
		if (mode === "dependency") {
			assert.equal(report.patches[0]?.commits[1]?.flag, "dependency")
			assert.equal(report.newDependencies[0]?.commit, report.patches[0]?.commits[1]?.sha)
			assert.equal(report.newDependencies[0]?.reason, "Replace the removed module")
		}

		// check that unexpected egress and unverified credentials limit the attempt
		if (mode === "new-host") {
			assert.match(report.diagnosis?.stopReason ?? "", /Final tests contacted new destinations: registry.yarnpkg.com/)
		}
		if (mode === "binding") {
			assert.equal(starts, 0)
		}
	})
}

for (const adoption of ["simplify", "decline", "no-benefit"] as const) {
	test(`a ${adoption} feature preserves the accepted upgrade`, async () => {
		// preserve the accepted upgrade across adoption outcomes
		const { report } = await replayPatch("repair", adoption)
		assert.equal(report.verdict, "Fixed")
		const match = report.featureMatches[0]
		assert.equal(report.patches.length, adoption === "simplify" ? 2 : 1, match?.disposition ?? "")

		// verify the feature patch starts at the tested upgrade tip
		if (adoption === "simplify") {
			assert.equal(report.patches[1]?.base, report.patches[0]?.testedTip)
			assert.equal(report.patches[1]?.prerequisite, report.patches[0]?.id)
			assert.equal(match?.disposition, "adopted")
		}
	})
}
test("feature adoption ranks all four categories and shares one cap across upgrades", async () => {
	// rank one candidate from each feature category
	const { report } = await replayPatch("passes")
	const candidates: { report: UpgradeReportV2 }[] = (["option", "workaround", "deprecated", "dependency"] as const).map(
		(kind, index) => ({
			report: {
				...report,
				dependency: String(index),
				featureMatches: [
					{
						kind,
						feature: kind,
						replacement: index === 0 || index === 2 ? "direct" : "inferred",
						callSites: Array.from({ length: index + 1 }, (_, i) => ({ file: "file", line: i + 1 })),
						source: "source",
						location: { file: "file", line: 1 },
						disposition: "ranked",
					},
				],
			},
		}),
	)

	// add a competing candidate before applying the shared limit
	const first = candidates[0]?.report.featureMatches[0]
	assert.ok(first)
	candidates[0]?.report.featureMatches.push({ ...first, feature: "later option" })
	assert.deepEqual(
		selectFeatureMatches(candidates, 3).map((entry) => entry.match.kind),
		["deprecated", "option", "dependency"],
	)

	// verify that excluded matches retain their limit disposition
	assert.equal(selectFeatureMatches(candidates, 0).length, 0)
	assert.equal(candidates[1]?.report.featureMatches[0]?.disposition, "Feature match limit")
})

test("two targets of one dependency retain their own verdict, patch and charge", async () => {
	// replay a repaired target and add an untested version of the same dependency
	const { engine, report, inspectionReport } = await replayPatch("repair")
	report.modelUsage = [...engine.ledger.usage]
	const minor = { ...report, to: "1.1.0", verdict: "Untested" as const, patches: [], modelUsage: [] }
	engine.upgrades.push(minor, report)

	// verify that charges and patches stay with their original targets
	const result = engine.buildInspectionReport({ ...inspectionReport, upgrades: [report, minor] })
	assert.ok(result.upgrades[0]?.modelUsage.length)
	assert.equal(result.upgrades[1]?.modelUsage.length, 0)
	assert.deepEqual(
		result.upgrades.map((upgrade) => [upgrade.to, upgrade.verdict, upgrade.patches.length]),
		[
			["2.0.0", "Fixed", 1],
			["1.1.0", "Untested", 0],
		],
	)
})
