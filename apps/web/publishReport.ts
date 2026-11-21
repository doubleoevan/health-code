import { createHash } from "node:crypto"
import type { Baseline, ReportCard, ReportCardV2, UpgradeReportV2 } from "health-code"
import { testInventorySummarySchema } from "health-code"
import { type Citation, type PatchLink, type PublishedCard, toCheckText, type UpgradeCard } from "./report.ts"

export type InspectionOutput = { report: ReportCard | ReportCardV2 }
export type Publication = { original: InspectionOutput["report"]; card: PublishedCard; blobs: Map<string, Uint8Array> }

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
	function collectPatches(sources: UpgradeReportV2["patches"]): PatchLink[] {
		const patches: PatchLink[] = []
		for (const patch of sources) {
			const bytes = new TextEncoder().encode(patch.mailbox)
			const digest = createHash("sha256").update(bytes).digest("hex")
			if (digest !== patch.digest) {
				throw new Error("Patch verification failed")
			}
			if (patch.role === "feature") {
				featureDigests.add(digest)
			}
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
			testChanges: upgradeV2?.patches.flatMap((patch) =>
				patch.commits.filter((commit) => commit.flag === "test").map((commit) => commit.reason ?? commit.subject),
			),
			summary: upgradeV2?.releaseSummary.text,
			matches:
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
	return {
		original: report,
		blobs,
		card: {
			version: 1,
			repository: report.repository,
			baseline: toChecks(report.baseline),
			baselineTestFileErrors: toTestFileErrors(report.baseline.tests),
			turnLimits:
				agent?.repair?.maxTurns !== undefined && agent.featureAdoption?.maxTurns !== undefined
					? { repair: agent.repair.maxTurns, featureAdoption: agent.featureAdoption.maxTurns }
					: undefined,
			detection: "reason" in report.packageManager ? report.packageManager.reason : undefined,
			license,
			upgrades,
			featureCount: featureDigests.size,
		},
	}
}
