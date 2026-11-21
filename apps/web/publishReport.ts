import { createHash } from "node:crypto"
import type { Baseline, InspectionReport, ModelRequestSandboxInspectionReport, UpgradeReportV2 } from "health-code"
import { testInventorySummarySchema } from "health-code"
import { type Citation, type PatchLink, type PublishedReport, toCheckText, type UpgradeCard } from "./report.ts"

export type InspectionOutput = { report: InspectionReport | ModelRequestSandboxInspectionReport }
export type Publication = {
	original: InspectionOutput["report"]
	card: PublishedReport
	blobs: Map<string, Uint8Array>
}

function toChecks(checks: Baseline): UpgradeCard["checks"] {
	return {
		install: toCheckText(checks.install),
		typecheck: toCheckText(checks.typecheck),
		tests: toCheckText(checks.tests),
	}
}

function toCitation(locator: UpgradeReportV2["locators"][number]): Citation {
	return { label: [locator.file, locator.line, locator.reason].filter(Boolean).join(" · "), url: locator.url }
}

function toUsage(receipts: UpgradeReportV2["modelUsage"]): UpgradeCard["usage"] {
	if (!receipts.length) {
		return undefined
	}

	// total only the usage measurements supplied by the model
	const sum = (field: "costUsd" | "reservedUsd" | "outputTokens"): number | undefined => {
		const values = receipts.flatMap((receipt) => receipt[field] ?? [])
		return values.length ? values.reduce((total, value) => total + value, 0) : undefined
	}
	return {
		modelCost: sum("costUsd"),
		reserved: sum("reservedUsd"),
		outputTokens: sum("outputTokens"),
		partialTokens: receipts.some((receipt) => receipt.outputTokens === undefined),
	}
}

function toTestFileErrors(check: Baseline["tests"]): UpgradeCard["testFileErrors"] {
	const inventory = testInventorySummarySchema.safeParse(check.inventory)
	return inventory.data?.testFileErrors
}

export function publishReport(output: InspectionOutput, license: string | null): Publication {
	const { report } = output
	const agent = report.version === 2 ? report.limits?.agent : undefined
	const blobs = new Map<string, Uint8Array>()
	const featureDigests = new Set<string>()

	// collect links and bytes from the same verified patch series
	function collectPatches(sources: UpgradeReportV2["patches"]): PatchLink[] {
		const patches: PatchLink[] = []
		for (const patch of sources) {
			// recompute the digest from the mailbox before publication
			const bytes = new TextEncoder().encode(patch.mailbox)
			const digest = createHash("sha256").update(bytes).digest("hex")
			if (digest !== patch.digest) {
				throw new Error("Patch verification failed")
			}

			// count distinct feature patches even when downloads are withheld
			if (patch.role === "feature") {
				featureDigests.add(digest)
			}

			// publish downloadable bytes and prompts only for licensed repositories
			if (license) {
				blobs.set(digest, bytes)
				patches.push({
					digest,
					role: patch.role,
					base: patch.base,
					prompt: patch.prompt,
					testedTip: patch.testedTip,
					prerequisite: patch.prerequisite,
					checks: patch.verification && toChecks(patch.verification),
				})
			}
		}
		return patches
	}

	// project both report versions into the public report format
	const upgrades = report.upgrades.map((upgrade, index): UpgradeCard => {
		const upgradeV2 = report.version === 2 ? report.upgrades[index] : undefined
		const patches = collectPatches(upgradeV2?.patches ?? [])
		return {
			dependency: upgrade.dependency,
			from: upgrade.from,
			to: upgrade.to,
			checks: toChecks(upgrade),
			testFileErrors: toTestFileErrors(upgrade.tests),
			observation: upgrade.observation,
			verdict: upgradeV2?.verdict,
			reason: upgradeV2?.diagnosis?.stopReason,
			untestedReason:
				upgrade.result.status === "untested" ? (upgrade.result.detail ?? upgrade.result.reason) : undefined,
			testChanges: upgradeV2?.patches.flatMap((patch) =>
				patch.commits.filter((commit) => commit.flag === "test").map((commit) => commit.reason ?? commit.subject),
			),
			summary: upgradeV2?.releaseSummary.text,
			matches:
				// preserve the release citation and adoption outcome for each feature match
				upgradeV2?.featureMatches.map((match) => ({
					label: match.feature,
					url: match.location.url,
					replacement: match.replacement,
					quotation: match.directQuote,
					source: match.source,
					location: toCitation(match.location),
					callSites: match.callSites?.map(toCitation),
					adoptionOutcome: match.disposition,
				})) ?? [],

			// link newly added dependencies to the patch containing their commit
			addedDependencies: upgradeV2?.newDependencies.map((dependency) => ({
				...dependency,
				patch: license
					? upgradeV2.patches.find((patch) => patch.commits.some((commit) => commit.sha === dependency.commit))?.digest
					: undefined,
			})),
			usage: upgradeV2 && toUsage(upgradeV2.modelUsage),
			diagnostics: upgradeV2?.locators.map(toCitation) ?? [],
			sizeBytes: upgradeV2?.installSize.delta,
			patches,
		}
	})

	// retain the source report separately from its public projection
	return {
		original: report,
		blobs,
		card: {
			version: 1,
			promptVersions: report.promptVersions,
			repository: report.repository,
			usageAsOf: report.version === 2 ? report.runtimeUsage?.usageAsOf : undefined,
			baseline: toChecks(report.baseline),
			baselineTestFileErrors: toTestFileErrors(report.baseline.tests),
			turnLimits:
				agent?.repair?.maxTurns !== undefined && agent.featureAdoption?.maxTurns !== undefined
					? { repair: agent.repair.maxTurns, featureAdoption: agent.featureAdoption.maxTurns }
					: undefined,
			registryLookupIssue: report.selection.registryLookupIssue,
			detection: "reason" in report.packageManager ? report.packageManager.reason : undefined,
			license,
			upgrades,
			featureCount: featureDigests.size,
		},
	}
}
