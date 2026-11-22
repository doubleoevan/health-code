import type { Upgrade } from "./contracts.ts"

export type UpgradeMenuTarget = Upgrade & { patch?: { inspectionId: string; sha256: string } }
export type UpgradeMenuOrder = "minor" | "alphabetical" | "workspaces"
export type DependencyChoice = { dependency: string; workspaces: number; targets: UpgradeMenuTarget[] }

/**
 * Groups eligible targets by dependency and orders the matching choices.
 */
export function toUpgradeMenu(
	targets: UpgradeMenuTarget[],
	options: { order?: UpgradeMenuOrder; search?: string; readyOnly?: boolean } = {},
): DependencyChoice[] {
	// Apply filters to individual versions before grouping the visible targets.
	const groups = new Map<string, DependencyChoice>()
	const search = options.search?.trim().toLowerCase() ?? ""
	for (const target of targets) {
		if (!target.dependency.toLowerCase().includes(search) || (options.readyOnly && !target.patch)) {
			continue
		}

		// Count declaring workspaces once for each dependency.
		const { dependency } = target
		const group = groups.get(dependency) ?? { dependency, workspaces: Object.keys(target.from).length, targets: [] }
		group.targets.push(target)
		groups.set(dependency, group)
	}

	// Keep the minor version first within each dependency in every sort.
	const choices = Array.from(groups.values())
	for (const group of choices) {
		group.targets.sort((a, b) => Number(a.kind === "major") - Number(b.kind === "major"))
	}

	// Rank groups using the requested order with a stable name tie-breaker.
	return choices.sort((a, b) => {
		let priority = 0
		if (options.order === "workspaces") {
			priority = b.workspaces - a.workspaces
		} else if (options.order !== "alphabetical") {
			priority = Number(a.targets[0]?.kind === "major") - Number(b.targets[0]?.kind === "major")
		}

		return priority || a.dependency.localeCompare(b.dependency, "en")
	})
}

/**
 * Identifies a target across workspace ordering differences.
 */
export function toPinnedUpgradeKey(upgrade: Pick<Upgrade, "dependency" | "from" | "to">): string {
	return JSON.stringify([
		upgrade.dependency,
		upgrade.to,
		Object.entries(upgrade.from).sort(([a], [b]) => a.localeCompare(b)),
	])
}

export const dependenciesPerPage = 4
