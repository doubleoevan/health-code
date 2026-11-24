import { createHash } from "node:crypto"
import type { Baseline, InspectionReport, ModelRequestSandboxInspectionReport, UpgradeReportV2 } from "health-code"
import { testInventorySummarySchema, toInspectionMode } from "health-code"
import { type Citation, type PatchLink, type PublishedReport, toCheckText, type UpgradeCard } from "../report.ts"

// replace repository output in a report without a verified license
export const withheldReason = "Output withheld because no open source license was verified."

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

function toUntestedReason(upgrade: InspectionReport["upgrades"][number]): string | undefined {
	if (upgrade.result.status !== "untested") {
		return undefined
	}

	// Explain skipped checks only when neither has recorded an execution.
	const install = upgrade.install
	if (install.status === "untested" && ["interrupted", "command-timeout"].includes(install.reason)) {
		const checksDidNotRun = [upgrade.typecheck, upgrade.tests].every(
			(check) =>
				check.status === "untested" &&
				check.evidence.length === 0 &&
				["not-run", "install-failed", "incomplete-observation"].includes(check.reason),
		)
		if (checksDidNotRun) {
			const detail = install.reason === "interrupted" ? upgrade.result.detail : install.detail
			return [detail ?? "The upgrade install did not finish.", "The upgraded typecheck and tests did not run."].join(
				" ",
			)
		}
	}
	return upgrade.result.detail ?? upgrade.result.reason
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

// withhold repository output from an unlicensed report
function toTestFileErrors(check: Baseline["tests"], license: string | null): UpgradeCard["testFileErrors"] {
	const inventory = testInventorySummarySchema.safeParse(check.inventory)
	return inventory.data?.testFileErrors.map((error) => (license ? error : { ...error, reason: withheldReason }))
}

export function publishReport(output: InspectionOutput, license: string | null): Publication {
	const { report } = output
	const blobs = new Map<string, Uint8Array>()

	// collect links and bytes from the same verified patch series
	function collectPatches(sources: UpgradeReportV2["patches"]): PatchLink[] {
		const patches: PatchLink[] = []
		const byId = new Map(sources.map((patch) => [patch.id, patch.digest]))
		for (const patch of sources) {
			// recompute the digest from the mailbox before publication
			const bytes = new TextEncoder().encode(patch.mailbox)
			const digest = createHash("sha256").update(bytes).digest("hex")
			if (digest !== patch.digest) {
				throw new Error("Patch verification failed")
			}

			// publish downloadable bytes and prompts only for licensed repositories
			if (license) {
				// Publish each prerequisite at its content-addressed URL.
				blobs.set(digest, bytes)
				patches.push({
					digest,
					role: patch.role,
					base: patch.base,
					prompt: patch.prompt,
					testedTip: patch.testedTip,
					prerequisite: toPrerequisiteDigest(patch.prerequisite, byId),
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
			coverage: upgrade.coverage,
			reusedFromInspectionId: upgradeV2?.reusedFromInspectionId ?? upgradeV2?.reusedFrom,
			from: upgrade.from,
			to: upgrade.to,
			checks: toChecks(upgrade),
			testFileErrors: toTestFileErrors(upgrade.tests, license),
			observation: upgrade.observation,
			verdict: upgradeV2?.verdict,
			reason: upgradeV2?.diagnosis?.stopReason,
			untestedReason: toUntestedReason(upgrade),
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
			upgradeMenu: toInspectionMode(report.selection) === "listUpgrades" ? report.selection.eligible : undefined,
			promptVersions: report.promptVersions,
			repository: report.repository,
			baseline: toChecks(report.baseline),
			stoppedReason: report.stoppedReason,
			omitted: report.selection.omitted.map((upgrade) => `${upgrade.dependency}@${upgrade.to}`),
			baselineTestFileErrors: toTestFileErrors(report.baseline.tests, license),
			registryLookupIssue: report.selection.registryLookupIssue,
			detection: "reason" in report.packageManager ? report.packageManager.reason : undefined,
			license,
			upgrades,
		},
	}
}

function toPrerequisiteDigest(id: string | undefined, byId: Map<string, string>): string | undefined {
	if (!id) {
		return undefined
	}

	// Resolve the stored patch identity before handing out its URL.
	const digest = byId.get(id)
	if (!digest) {
		throw new Error("Missing patch prerequisite")
	}
	return digest
}

/**
 * Reads a stored report and restores the fields that older reports named differently.
 */
export function readPublishedReport(json: string): PublishedReport {
	const report: PublishedReport & { menu?: PublishedReport["upgradeMenu"] } = JSON.parse(json)
	if (report.menu) {
		report.upgradeMenu ??= report.menu
		delete report.menu
	}

	// Preserve source links in reports published with the original field name.
	for (const upgrade of report.upgrades) {
		if ("reusedFrom" in upgrade && typeof upgrade.reusedFrom === "string") {
			upgrade.reusedFromInspectionId ??= upgrade.reusedFrom
			delete upgrade.reusedFrom
		}
	}
	return report
}
