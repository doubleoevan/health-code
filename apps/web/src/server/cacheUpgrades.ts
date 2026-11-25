import type { Database } from "bun:sqlite"
import type {
	InspectionOptionsV2,
	InspectionReport,
	ModelRequestSandboxInspectionReport,
	UpgradeReportV2,
} from "health-code"
import { toInspectionMode, toUpgradeTargetKey } from "health-code"

import type { PublishedReport } from "../report.ts"

/**
 * Stores references to completed upgrades in immutable inspection reports.
 */
export class UpgradeCache {
	constructor(private readonly database: Database) {
		database.exec(`CREATE TABLE IF NOT EXISTS cached_upgrades(
			scope TEXT NOT NULL, target TEXT NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL,
			PRIMARY KEY(scope,target))`)
	}

	private scope(id: string): string | null {
		// Share exact targets across selection limits within the same deployed revision.
		return (
			this.database
				.query<{ scope: string | null }, [string]>(
					`SELECT CASE WHEN json_valid(cacheKey) THEN json_array(json_extract(cacheKey,'$[0]'),
						json_extract(cacheKey,'$[1]'),json_extract(cacheKey,'$[2]'),json_extract(cacheKey,'$[3]'))
						ELSE cacheKey END scope FROM admissions WHERE id=?`,
				)
				.get(id)?.scope ?? null
		)
	}

	attachPatches(id: string, report: PublishedReport): void {
		// Match immutable public upgrade patches within the upgrade menu's checkout and release.
		const scope = this.scope(id) ?? JSON.stringify(report.repository)
		const ready = this.patches(scope)
		for (const target of report.upgradeMenu ?? []) {
			target.patch = ready.get(toUpgradeTargetKey(target))
		}
	}

	readyReport(scope: string, upgrade?: InspectionOptionsV2["upgrade"]): string | undefined {
		if (!upgrade || typeof upgrade.from === "string") {
			return undefined
		}
		const target = toUpgradeTargetKey({ dependency: upgrade.dependency, from: upgrade.from, to: upgrade.to })
		return this.patches(scope, target).get(target)?.inspectionId
	}

	private patches(scope: string, target?: string): Map<string, { inspectionId: string; sha256: string }> {
		const rows = this.database
			.query<{ target: string; id: string; sha256: string }, [string, string | null, string | null]>(`
			SELECT c.target,c.id,json_extract(p.value,'$.digest') sha256
			FROM cached_upgrades c JOIN inspections i ON i.id=c.id,
			json_each(i.report,'$.upgrades[' || c.position || '].patches') p
			WHERE c.scope=? AND (? IS NULL OR c.target=?) AND json_extract(p.value,'$.role')='upgrade'`)
			.all(scope, target ?? null, target ?? null)
		return new Map(rows.map((row) => [row.target, { inspectionId: row.id, sha256: row.sha256 }]))
	}

	save({
		id,
		report,
		published,
	}: {
		id: string
		report: ModelRequestSandboxInspectionReport
		published: PublishedReport
	}): void {
		const scope = this.scope(id) ?? JSON.stringify(report.repository)

		// Keep the original proof for every conclusive upgrade.
		const insert = this.database.query("INSERT OR REPLACE INTO cached_upgrades VALUES(?,?,?,?)")
		for (const [position, upgrade] of report.upgrades.entries()) {
			const pendingAdoption = upgrade.featureMatches.some((match) => match.disposition === "ranked")
			const reused = upgrade.reusedFromInspectionId ?? upgrade.reusedFrom
			if (reused || upgrade.coverage || upgrade.verdict === "Untested" || pendingAdoption) {
				continue
			}

			// Index the source upgrade without copying patch bytes.
			const target = toUpgradeTargetKey(upgrade)
			const publishesPatch = published.upgrades[position]?.patches.some((patch) => patch.role === "upgrade")
			if (publishesPatch || !this.patches(scope, target).has(target)) {
				insert.run(scope, target, id, position)
			}
		}
	}

	reader(id: string): NonNullable<InspectionOptionsV2["reuseUpgrade"]> {
		const scope = this.scope(id)
		return (repository, upgrade) => {
			if (!scope) {
				return undefined
			}

			// Read a single upgrade from the report that originally verified it.
			const row = this.database
				.query<{ id: string; payload: string }, [string, string, string, string]>(`
				SELECT c.id, json_extract(s.payload,'$.upgrades[' || c.position || ']') payload
				FROM cached_upgrades c JOIN source_reports s ON s.id=c.id
				WHERE scope=? AND target=? AND json_extract(s.payload,'$.repository.commit')=?
				AND json_extract(s.payload,'$.repository.url')=?`)
				.get(scope, toUpgradeTargetKey(upgrade), repository.commit, repository.url)

			// Attach the original public report ID only to exact matches.
			if (!row) {
				return undefined
			}
			const cached: UpgradeReportV2 = JSON.parse(row.payload)
			return { ...cached, reusedFromInspectionId: row.id }
		}
	}
}

export function isReusableReport(report: InspectionReport | ModelRequestSandboxInspectionReport): boolean {
	if (toInspectionMode(report.selection) === "listUpgrades") {
		return !report.stoppedReason && !report.selection.registryLookupIssue && !("reason" in report.packageManager)
	}

	// Require comparable checks for a complete inspection cache hit.
	const incompleteBaseline =
		report.baseline.install.status !== "passed" ||
		(report.baseline.typecheck.status === "failed" && !report.baseline.typecheck.failingTests.length) ||
		(report.baseline.typecheck.status === "untested" && report.baseline.typecheck.reason !== "no-tsconfig") ||
		(report.baseline.tests.status === "untested" && report.baseline.tests.reason !== "missing-test-script")

	// Use the final verdict after any repair attempt.
	const untestedUpgrade =
		report.version === 2
			? report.upgrades.some((upgrade) => upgrade.verdict === "Untested")
			: report.upgrades.some((upgrade) => upgrade.result.status === "untested")

	// Release only the lookup key after a partial inspection.
	const incompleteUpgradeMenu = "reason" in report.packageManager || Boolean(report.selection.registryLookupIssue)
	const incompleteSelection = report.selection.limit === 0 || report.selection.skipped.includes("inspection-deadline")
	const incompleteUpgrade = untestedUpgrade || report.upgrades.some((upgrade) => upgrade.coverage)

	// Preserve accounting and immutable reports when another submission must retry.
	const partial = report.stoppedReason || incompleteUpgrade || incompleteBaseline
	return !(partial || incompleteUpgradeMenu || incompleteSelection)
}
