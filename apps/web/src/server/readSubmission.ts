import { toRepositoryUrl } from "health-code"
import type { Context } from "hono"
import type { Inspections } from "./executeInspection.ts"
import { type InspectionChoice, SiteError } from "./inspectionSource.ts"

type Submission = {
	repositoryUrl: string
	challenge?: unknown

	// Describe the requested work, including the older menuId name.
	action?: unknown
	upgradeMenuId?: unknown
	menuId?: unknown
	dependency?: unknown
	to?: unknown
}

/**
 * Reads a submission body that names a repository, or null for any other body.
 */
export async function readSubmission(context: Context): Promise<Submission | null> {
	const body: unknown = await context.req.json().catch(() => null)
	if (!body || typeof body !== "object" || !("repositoryUrl" in body) || typeof body.repositoryUrl !== "string") {
		return null
	}
	return { ...body, repositoryUrl: body.repositoryUrl }
}

/**
 * Resolves a submission to the work it requests against the saved upgrade menu.
 */
export function resolveChoice(input: Submission, inspections: Inspections): InspectionChoice & { readyId?: string } {
	if (input.action === undefined) {
		return {}
	}
	if (input.action === "discover") {
		return { mode: "listUpgrades" }
	}

	// Accept the older menuId field when it agrees with upgradeMenuId.
	const upgradeMenuId = input.upgradeMenuId ?? input.menuId
	if (
		input.action !== "select" ||
		typeof upgradeMenuId !== "string" ||
		(input.menuId !== undefined && input.menuId !== upgradeMenuId)
	) {
		throw new SiteError("Choose an upgrade from the upgrade menu.")
	}

	// Resolve the exact version against the server's saved upgrade menu.
	const report = inspections.store.snapshot(upgradeMenuId)?.card
	const target = report?.upgradeMenu?.find((item) => item.dependency === input.dependency && item.to === input.to)

	// Reject a target missing from the menu or saved for another repository.
	if (
		!report ||
		!target ||
		report.repository.url.toLowerCase() !== toRepositoryUrl(input.repositoryUrl).toLowerCase()
	) {
		throw new SiteError("Choose an available dependency and version from this repository’s upgrade menu.")
	}

	// Reopen a tested patch locally and send hosted requests through admission.
	return {
		readyId: inspections.launch ? undefined : target.patch?.inspectionId,
		revision: report.repository.commit,
		upgrade: { dependency: target.dependency, from: target.from, to: target.to },
	}
}
