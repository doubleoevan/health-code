import { major, prerelease, rcompare, valid } from "semver"

/** Keeps stable alternatives available when a repository has a minimum release age. */
export function selectRegistryVersions(versions: string[], includePrevious: boolean): string[] {
	const groups = new Map<number, string[]>()
	// collect stable releases by major in descending version order
	for (const version of versions.filter((value) => valid(value) && !prerelease(value)).sort(rcompare)) {
		const key = major(version)
		const group = groups.get(key) ?? []
		group.push(version)
		groups.set(key, group)
	}
	// return the newest release or a sample of older alternatives
	if (!includePrevious) {
		return [...groups.values()].flatMap((group) => group.slice(0, 1))
	}
	return [...groups.values()]
		.slice(0, 6)
		.flatMap((group) => [0, 1, 3, 8].flatMap((index) => (group[index] ? [group[index]] : [])))
}
