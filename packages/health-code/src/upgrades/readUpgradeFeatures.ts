import type { Upgrade } from "../contracts.ts"
import { readReleases } from "./readReleases.ts"

export type UpgradeFeatures = {
	features: { text: string; source: string; workspaces: string[] }[]
	sources: string[]
	gaps: string[]
}

const featuresPerPage = 5
export type ReleaseFeaturePage = UpgradeFeatures & { pageSize: number; total: number; nextOffset: number | null }

/**
 * Pages release features for interactive consumers.
 */
export function toFeaturePage(preview: UpgradeFeatures, offset: number): ReleaseFeaturePage {
	const end = offset + featuresPerPage
	return {
		...preview,
		pageSize: featuresPerPage,
		features: preview.features.slice(offset, end),
		total: preview.features.length,
		nextOffset: end < preview.features.length ? end : null,
	}
}

/**
 * Previews additions documented between each workspace's installed version and the target.
 */
export async function readUpgradeFeatures(
	upgrade: Upgrade,
	options: { githubToken?: string; signal?: AbortSignal; request?: typeof fetch } = {},
): Promise<UpgradeFeatures> {
	const { notes, gaps } = await readReleases({ ...options, upgrade, changelog: "" })

	// Attribute each entry to the release and workspace versions that introduced it.
	const features = notes.flatMap((note) =>
		toFeatureLines(note.text).map((text) => ({ text, source: note.source, workspaces: note.workspaces })),
	)
	return { features, sources: [...new Set(notes.map((note) => note.source))], gaps }
}

function toFeatureLines(text: string): string[] {
	const lines = new Set<string>()
	let featureDepth: number | undefined
	let fence: string | undefined
	for (const raw of text.split(/\r?\n/)) {
		// Ignore code examples that resemble headings or feature entries.
		const line = raw.trim()
		const marker = /^(`{3,}|~{3,})/.exec(line)?.[1]
		if (marker && (!fence || (marker.startsWith(fence) && line === marker))) {
			fence = fence ? undefined : marker
			continue
		}

		// Skip the contents until the closing fence.
		if (fence) {
			continue
		}

		// Recognize Markdown headings and standalone bold section labels.
		const heading = /^(?:(#{1,6})\s+(.+)|\*\*(.+?)\*\*:?\s*)$/.exec(line)
		if (heading) {
			featureDepth = toFeatureDepth(heading, featureDepth)
			continue
		}

		// Keep one copy of each feature entry within its release.
		const entry = toFeatureEntry(line, featureDepth !== undefined)
		if (entry) {
			lines.add(entry)
		}
	}
	return [...lines]
}

function toFeatureDepth(heading: RegExpExecArray, current?: number): number | undefined {
	const depth = heading[1]?.length ?? 7
	const label = (heading[2] ?? heading[3] ?? "").replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
	if (/^(?:(?:new\s+)?features?|added|enhancements?)$/i.test(label)) {
		return Math.min(depth, current ?? depth)
	}

	// Bold labels commonly introduce a peer section without a Markdown heading.
	if (!heading[1] && /^(?:bug fixes|fixes|breaking changes|removed|deprecated|security|changed)$/i.test(label)) {
		return undefined
	}

	// A peer or parent heading ends the enclosing feature section.
	return current !== undefined && depth > current ? current : undefined
}

function toFeatureEntry(line: string, featureSection: boolean): string | undefined {
	// Recognize bullets within feature sections and explicitly labeled additions elsewhere.
	const bullet = /^(?:[-*+]\s+|\d+\.\s+)(.+)$/.exec(line)?.[1]
	const conventional = /^(?:\*\*)?feat(?:ure)?(?:\([^)]*\))?!?:(?:\*\*)?\s*(.+)$/i.exec(bullet ?? line)?.[1]
	const entry = conventional ?? (featureSection && bullet)
	if (!entry) {
		return undefined
	}

	// Show plain text with a separate release citation.
	return entry
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/\*\*|`/g, "")
		.trim()
}
