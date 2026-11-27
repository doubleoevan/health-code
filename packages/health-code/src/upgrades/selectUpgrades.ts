import { rcompare } from "semver"
import type { Project, Upgrade } from "../contracts.ts"
import { readOwnProperty } from "../readOwnProperty.ts"
import { isNewerStable, toHighestVersion, toUpgradeKind } from "./checkUpgradeTarget.ts"

/**
 * Selects stable targets that advance every declaring workspace.
 */
export function selectUpgrades(
	project: Pick<Project, "sources" | "skipped">,
	registry: Record<string, string[]>,
	limit: number,
): { eligible: Upgrade[]; selected: Upgrade[]; omitted: Upgrade[]; skipped: string[] } {
	const eligible: Upgrade[] = []
	const skipped = [...project.skipped]
	for (const dependency of Object.keys(project.sources).sort()) {
		const from = project.sources[dependency] ?? {}

		// compare registry targets with the highest locked workspace version
		const lockedVersions = Object.values(from)
		const highestLockedVersion = toHighestVersion(lockedVersions)
		const versions = readOwnProperty(registry, dependency)
		if (!highestLockedVersion || !versions) {
			skipped.push(`${dependency}: registry or lockfile evidence unavailable`)
			continue
		}

		// choose stable minor and major upgrades that advance every workspace
		const newerVersions = versions.filter((version) => isNewerStable(version, highestLockedVersion)).sort(rcompare)
		for (const kind of ["minor", "major"] as const) {
			const to = newerVersions.find((version) => toUpgradeKind(lockedVersions, version) === kind)
			if (to) {
				eligible.push({ dependency, from, to, kind })
			}
		}
	}

	// select minor upgrades first within the requested limit
	eligible.sort((a, b) => Number(a.kind === "major") - Number(b.kind === "major"))
	return { eligible, selected: eligible.slice(0, limit), omitted: eligible.slice(limit), skipped }
}

export function toUpgradeKey(upgrade: Pick<Upgrade, "dependency" | "to">): string {
	return `${upgrade.dependency}@${upgrade.to}`
}
