import { buildInvestigationPrompt } from "health-code"
import type { Snapshot } from "./report.ts"

export function buildReportInvestigationPrompt(snapshot: Snapshot, url: string): string | undefined {
	const report = snapshot.card
	if (report?.upgradeMenu || report?.upgrades.some((upgrade) => upgrade.patches.length)) {
		return undefined
	}

	// Include skipped and inconclusive upgrades in the diagnostic evidence.
	const unfinished = report?.upgrades.filter(
		(upgrade) =>
			upgrade.coverage === "partial" ||
			upgrade.coverage === "skipped" ||
			upgrade.verdict === "Untested" ||
			upgrade.verdict === "Can't fix",
	)

	// Keep early failures eligible even when the report contains no upgrade cards.
	const stoppedEarly = snapshot.state === "failed" || snapshot.state === "interrupted"
	if (!unfinished?.length && !report?.stoppedReason && !report?.registryLookupIssue && !stoppedEarly) {
		return undefined
	}

	// Fall back to the submitted target when the checks stopped before producing a card.
	return buildInvestigationPrompt({
		reportUrl: url,
		repository: report?.repository ?? snapshot.repositoryUrl,
		baseline: report?.baseline,
		reason: report?.stoppedReason ?? report?.registryLookupIssue ?? snapshot.message,
		upgrades: unfinished?.length
			? unfinished.map(({ dependency, from, to, checks, reason, untestedReason }) => ({
					dependency,
					from,
					to,
					checks,
					reason,
					untestedReason,
				}))
			: snapshot.selectedDependencyUpgrade,
	})
}
