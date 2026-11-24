import {
	dependenciesPerPage,
	readUpgradeFeatures,
	readUpgradeMenuFeatures,
	toFeaturePage,
	toUpgradeMenu,
	type Upgrade,
	type UpgradeMenuTarget,
} from "health-code"
import * as z from "zod"
import { fetchPatch, patchOutput } from "./fetchPatch.ts"
import { listPatches, patchReference } from "./listPatches.ts"
import { readGithubToken } from "./readEnvironmentSettings.ts"
import { inspectionId, type SavedReport } from "./storeInspection.ts"
import type { Inspections } from "./trackInspections.ts"
import { UserError } from "./userError.ts"

const target = z.object({
	dependency: z.string(),
	from: z.record(z.string(), z.string()),
	to: z.string(),
	kind: z.enum(["minor", "major"]),
})
const menuSelection = z.object({ eligible: z.array(target), registryLookupIssue: z.string().optional() })
export const selection = z.object({
	upgradeMenuId: inspectionId.optional().describe("The upgradeMenuId returned by list_upgrades."),
	menuId: inspectionId.optional().describe("Deprecated alias for upgradeMenuId."),
	dependency: z.string().min(1).max(214),
	to: z.string().min(1).max(256),
})
export const upgradeMenuQuery = z.object({
	upgradeMenuId: inspectionId,
	order: z.enum(["minor", "alphabetical", "workspaces"]).default("minor"),
	search: z.string().max(256).default(""),
	readyOnly: z.boolean().default(false),
	offset: z.number().int().nonnegative().default(0),
})
const releaseFeatures = z.object({
	total: z.number(),
	nextOffset: z.number().nullable(),
	features: z.array(z.object({ text: z.string(), source: z.string(), workspaces: z.array(z.string()) })),
	sources: z.array(z.string()),
	gaps: z.array(z.string()),
})
export const featureOutput = releaseFeatures.extend({ dependency: z.string(), to: z.string() })
export const upgradeMenuOutput = z.object({
	upgradeMenuId: inspectionId,
	menuId: inspectionId.describe("Deprecated alias for upgradeMenuId."),
	repository: z.object({ url: z.string(), commit: z.string() }),
	dependencies: z.array(
		z.object({
			dependency: z.string(),
			workspaces: z.number(),
			targets: z.array(
				target.extend({
					patch: z.object({ inspectionId, sha256: z.string() }).optional(),
					releaseFeatures,
				}),
			),
		}),
	),
	totalDependencies: z.number().describe("Dependencies that match the search and filters, across every page."),
	nextOffset: z.number().nullable(),
	issue: z.string().optional(),
})

export function toUpgradeMenuId(id: string | undefined, previous: string | undefined): string {
	if (id && previous && id !== previous) {
		throw new UserError("Supply one upgrade menu ID.")
	}

	// Accept the saved ID from clients using either spelling.
	const upgradeMenuId = id ?? previous
	if (!upgradeMenuId) {
		throw new UserError("Supply the upgradeMenuId returned by list_upgrades.")
	}
	return upgradeMenuId
}

const unknownTarget =
	"Choose a dependency and target version from this repository’s upgrade menu. Call list_upgrades to see it."

export class UpgradeMenus {
	// Keep only compact patch references for immutable saved reports.
	private readonly indexed = new Set<string>()
	private readonly ready = new Map<string, NonNullable<UpgradeMenuTarget["patch"]>>()
	constructor(
		private readonly inspections: Pick<Inspections, "store" | "loadReport">,
		private readonly request: typeof fetch = fetch,
	) {}

	async list(
		query: z.infer<typeof upgradeMenuQuery>,
		signal?: AbortSignal,
	): Promise<z.infer<typeof upgradeMenuOutput>> {
		const report = await this.inspections.loadReport(query.upgradeMenuId)
		const parsed = menuSelection.safeParse(report.selection)
		if (!parsed.success) {
			throw new UserError("This report has no upgrade list. Call list_upgrades with the repository URL.")
		}

		// Reopen saved patches across server restarts and refresh newly completed inspections.
		await this.indexReports()
		const targets = parsed.data.eligible.map((item) => ({ ...item, patch: this.ready.get(this.key(report, item)) }))
		const groups = toUpgradeMenu(targets, query)
		const end = query.offset + dependenciesPerPage
		const issue =
			parsed.data.registryLookupIssue ?? (typeof report.stoppedReason === "string" ? report.stoppedReason : undefined)
		const rows = await readUpgradeMenuFeatures(groups.slice(query.offset, end), {
			githubToken: readGithubToken(process.env),
			request: this.request,
			signal,
		})
		return {
			upgradeMenuId: report.inspectionId,
			menuId: report.inspectionId,
			repository: report.repository,
			dependencies: rows.map((group) => ({
				...group,
				targets: group.targets.map((target) => ({
					...target,
					releaseFeatures: toFeaturePage(target.releaseFeatures, 0),
				})),
			})),
			totalDependencies: groups.length,
			nextOffset: end < groups.length ? end : null,
			issue,
		}
	}

	async features(
		choice: z.infer<typeof selection> & { offset?: number },
		signal?: AbortSignal,
	): Promise<z.infer<typeof featureOutput>> {
		const report = await this.inspections.loadReport(toUpgradeMenuId(choice.upgradeMenuId, choice.menuId))
		const upgrade = this.target(report, choice)
		const preview = await readUpgradeFeatures(upgrade, {
			githubToken: readGithubToken(process.env),
			request: this.request,
			signal,
		})
		return { dependency: upgrade.dependency, to: upgrade.to, ...toFeaturePage(preview, choice.offset ?? 0) }
	}

	async select(
		url: string | undefined,
		choice: z.infer<typeof selection>,
	): Promise<{ repositoryUrl: string; revision: string; upgrade: Upgrade; patch?: UpgradeMenuTarget["patch"] }> {
		const report = await this.inspections.loadReport(toUpgradeMenuId(choice.upgradeMenuId, choice.menuId))
		const upgrade = this.target(report, choice)
		if (url !== undefined && report.repository.url.toLowerCase() !== url.toLowerCase()) {
			throw new UserError(unknownTarget)
		}

		// Link a matching patch before admitting any fresh work.
		await this.indexReports()
		return {
			repositoryUrl: report.repository.url,
			revision: report.repository.commit,
			upgrade,
			patch: this.ready.get(this.key(report, upgrade)),
		}
	}

	private target(report: SavedReport, choice: z.infer<typeof selection>): Upgrade {
		const targets = menuSelection.safeParse(report.selection).data?.eligible ?? []
		const target = targets.find((item) => item.dependency === choice.dependency && item.to === choice.to)
		if (!target) {
			throw new UserError(unknownTarget)
		}
		return target
	}

	private key(report: SavedReport, upgrade: Pick<Upgrade, "dependency" | "to">): string {
		return JSON.stringify([
			report.repository.url.toLowerCase(),
			report.repository.commit,
			upgrade.dependency,
			upgrade.to,
		])
	}

	private async indexReports(): Promise<void> {
		for (const id of await this.inspections.store.reportIds()) {
			if (this.indexed.has(id)) {
				continue
			}

			// Advertise only upgrade patches whose saved bytes verify at their digest.
			const report = await this.inspections.store.load(id).catch(() => undefined)
			if (!report) {
				continue
			}

			for (const patch of listPatches(report)) {
				if (patch.role !== "upgrade" || !patch.to) {
					continue
				}

				try {
					fetchPatch(report, { sha256: patch.sha256, offset: 0 })
				} catch {
					continue
				}

				this.ready.set(this.key(report, { dependency: patch.dependency, to: patch.to }), {
					inspectionId: id,
					sha256: patch.sha256,
				})
			}
			this.indexed.add(id)
		}
	}
}

const check = z.object({ status: z.string(), detail: z.string().optional(), reason: z.string().optional() })
const checksSchema = z.object({
	install: check.optional(),
	typecheck: check.optional(),
	tests: check.optional(),
	result: check.optional(),
})
export const selectedOutput = z.object({
	inspectionId,
	patch: patchOutput.nullable(),
	verdict: z.string().optional(),
	reason: z.string().optional(),
	checks: checksSchema,
})
export const upgradeResultsOutput = z.object({
	inspectionId,
	repository: z.object({ url: z.string(), commit: z.string() }),
	upgrades: z.array(
		z.object({
			dependency: z.string(),
			from: z.record(z.string(), z.string()).optional(),
			to: z.string().optional(),
			verdict: z.string().optional(),
			reason: z.string().optional(),
			checks: checksSchema,
			patches: z.array(patchReference),
		}),
	),
	stoppedReason: z.string().optional(),
})

/**
 * Returns the selected upgrade's verified mailbox or the recorded check results.
 */
export function toSelectedResult(
	report: SavedReport,
	choice: { dependency: string; to: string },
): z.infer<typeof selectedOutput> {
	// match the chosen dependency and version
	const matches = (item: { dependency: string; to?: unknown }): boolean =>
		item.dependency === choice.dependency && item.to === choice.to
	const target = report.upgrades.find(matches) ?? { dependency: choice.dependency }
	const reference = listPatches(report).find((item) => matches(item) && item.role === "upgrade")
	const patch = reference ? fetchPatch(report, { sha256: reference.sha256, offset: 0 }) : null

	// explain a missing patch only
	const { verdict, reason, checks } = toOutcome(report, target)
	return { inspectionId: report.inspectionId, verdict, patch, checks, reason: patch ? undefined : reason }
}

// describe one upgrade for both result shapes
function toOutcome(
	report: SavedReport,
	upgrade: SavedReport["upgrades"][number],
): { verdict?: string; reason: string; checks: z.infer<typeof checksSchema> } {
	// read the recorded checks and verdict
	const recorded = checksSchema.parse(upgrade)
	const verdict = z.string().safeParse(upgrade.verdict).data

	// Prefer the recorded stopping reason over a generic missing-patch message.
	const diagnosis = z.object({ stopReason: z.string() }).safeParse(upgrade.diagnosis)
	const reason =
		diagnosis.data?.stopReason ??
		recorded.result?.detail ??
		recorded.result?.reason ??
		// fall back to why the whole inspection stopped
		z.string().safeParse(report.stoppedReason).data ??
		"No verified upgrade patch was produced."
	return { verdict, reason, checks: recorded }
}

/**
 * Returns every upgrade's verdict, checks and patch references without mailbox text.
 */
export function toUpgradeResults(report: SavedReport): z.infer<typeof upgradeResultsOutput> {
	const references = listPatches(report)
	return {
		inspectionId: report.inspectionId,
		repository: { url: report.repository.url, commit: report.repository.commit },
		upgrades: report.upgrades.map((upgrade) => {
			// match patches to the same dependency and target version
			const to = z.string().safeParse(upgrade.to).data
			const patches = references.filter((item) => item.dependency === upgrade.dependency && item.to === to)
			const { verdict, reason, checks } = toOutcome(report, upgrade)
			return {
				dependency: upgrade.dependency,
				from: z.record(z.string(), z.string()).safeParse(upgrade.from).data,
				to,
				verdict,
				reason: patches.length ? undefined : reason,
				checks,
				patches,
			}
		}),
		stoppedReason: z.string().safeParse(report.stoppedReason).data,
	}
}
