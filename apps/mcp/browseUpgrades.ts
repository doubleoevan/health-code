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
import { listPatches } from "./listPatches.ts"
import { UserError } from "./modelSettings.ts"
import { type InspectionStore, inspectionId, type SavedReport } from "./storeInspection.ts"

const target = z.object({
	dependency: z.string(),
	from: z.record(z.string(), z.string()),
	to: z.string(),
	kind: z.enum(["minor", "major"]),
})
const discovery = z.object({ eligible: z.array(target), registryLookupIssue: z.string().optional() })
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

export class UpgradeMenus {
	// Keep only compact patch references for immutable saved reports.
	private readonly indexed = new Set<string>()
	private readonly ready = new Map<string, NonNullable<UpgradeMenuTarget["patch"]>>()
	constructor(
		private readonly store: InspectionStore,
		private readonly request: typeof fetch = fetch,
	) {}

	async list(
		query: z.infer<typeof upgradeMenuQuery>,
		signal?: AbortSignal,
	): Promise<z.infer<typeof upgradeMenuOutput>> {
		const report = await this.store.load(query.upgradeMenuId)
		const parsed = discovery.safeParse(report.selection)
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
			githubToken: process.env.GITHUB_TOKEN,
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
			nextOffset: end < groups.length ? end : null,
			issue,
		}
	}

	async features(
		choice: z.infer<typeof selection> & { offset?: number },
		signal?: AbortSignal,
	): Promise<z.infer<typeof featureOutput>> {
		const report = await this.store.load(toUpgradeMenuId(choice.upgradeMenuId, choice.menuId))
		const upgrade = this.target(report, choice)
		const preview = await readUpgradeFeatures(upgrade, {
			githubToken: process.env.GITHUB_TOKEN,
			request: this.request,
			signal,
		})
		return { dependency: upgrade.dependency, to: upgrade.to, ...toFeaturePage(preview, choice.offset ?? 0) }
	}

	async select(
		url: string | undefined,
		choice: z.infer<typeof selection>,
	): Promise<{ repositoryUrl: string; revision: string; upgrade: Upgrade; patch?: UpgradeMenuTarget["patch"] }> {
		const report = await this.store.load(toUpgradeMenuId(choice.upgradeMenuId, choice.menuId))
		const upgrade = this.target(report, choice)
		if (url !== undefined && report.repository.url.toLowerCase() !== url.toLowerCase()) {
			throw new UserError("Choose a dependency and target version from this repository’s upgrade menu.")
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
		const candidates = discovery.safeParse(report.selection).data?.eligible ?? []
		const target = candidates.find((item) => item.dependency === choice.dependency && item.to === choice.to)
		if (!target) {
			throw new UserError("Choose a dependency and target version from this repository’s upgrade menu.")
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
		for (const id of await this.store.reportIds()) {
			if (this.indexed.has(id)) {
				continue
			}

			// Advertise only upgrade patches whose saved bytes verify at their digest.
			const report = await this.store.load(id).catch(() => undefined)
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
const checks = z.object({
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
	checks,
})

/**
 * Returns the selected upgrade's verified mailbox or the recorded check results.
 */
export function toSelectedResult(
	report: SavedReport,
	choice: { dependency: string; to: string },
): z.infer<typeof selectedOutput> {
	const matches = (item: { dependency: string; to?: unknown }): boolean =>
		item.dependency === choice.dependency && item.to === choice.to
	const target = report.upgrades.find(matches)
	const reference = listPatches(report).find((item) => matches(item) && item.role === "upgrade")
	const patch = reference ? fetchPatch(report, { sha256: reference.sha256, offset: 0 }) : null
	const recorded = checks.parse(target ?? {})
	const verdict = z.string().safeParse(target?.verdict).data

	// Prefer the recorded stopping reason over a generic missing-patch message.
	const diagnosis = z.object({ stopReason: z.string() }).safeParse(target?.diagnosis)
	const reason =
		diagnosis.data?.stopReason ??
		recorded.result?.detail ??
		recorded.result?.reason ??
		z.string().safeParse(report.stoppedReason).data ??
		"No verified upgrade patch was produced."

	return { inspectionId: report.inspectionId, verdict, patch, checks: recorded, reason: patch ? undefined : reason }
}
