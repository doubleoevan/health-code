import { gt, major, minor, prerelease, rcompare, valid } from "semver"
import type { Project, Upgrade } from "./contracts.ts"

/** Selects stable targets that advance every declaring workspace. */
export function selectUpgrades(
	project: Project,
	registry: Record<string, string[]>,
	limit: number,
): { eligible: Upgrade[]; selected: Upgrade[]; omitted: Upgrade[]; skipped: string[] } {
	const eligible: Upgrade[] = []
	const skipped = [...project.skipped]
	for (const dependency of Object.keys(project.sources).sort()) {
		const from = project.sources[dependency] ?? {}
		// compare registry targets with the highest installed workspace version
		const highest = Object.values(from)
			.filter((v) => valid(v))
			.sort(rcompare)[0]
		const versions = registry[dependency]
		if (!highest || !versions) {
			skipped.push(`${dependency}: registry or lockfile evidence unavailable`)
			continue
		}
		// choose stable minor and major upgrades that advance every workspace
		const newer = versions.filter((v) => valid(v) && !prerelease(v) && gt(v, highest)).sort(rcompare)
		for (const kind of ["minor", "major"] as const) {
			const to = newer.find((v) =>
				kind === "major" ? major(v) > major(highest) : major(v) === major(highest) && minor(v) > minor(highest),
			)
			if (to) {
				eligible.push({ dependency, from, to, kind })
			}
		}
	}
	// select minor upgrades first within the requested limit
	eligible.sort((a, b) => Number(a.kind === "major") - Number(b.kind === "major"))
	return { eligible, selected: eligible.slice(0, limit), omitted: eligible.slice(limit), skipped }
}
