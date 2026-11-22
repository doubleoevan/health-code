import { z } from "zod"
import type { CodeFeatureMatch, Locator, UpgradeReportV2 } from "./agentContracts.ts"
import type { InspectionReport } from "./contracts.ts"
import type { ReleaseNote } from "./readReleases.ts"
import { permalink, type UsageEvidence } from "./readUpgradeEvidence.ts"

export const matchSchema = z
	.array(
		z.object({
			feature: z.string().max(1000),
			kind: z.enum(["workaround", "deprecated", "dependency", "option"]),
			source: z.string(),
			directQuote: z.string().min(1).max(800).optional(),
			symbol: z.string().min(1).optional(),
			sites: z
				.array(z.object({ file: z.string(), line: z.number().int().positive() }))
				.max(32)
				.default([]),
			file: z.string(),
			line: z.number().int().positive(),
		}),
	)
	.max(30)
export function verifyMatch({
	match,
	usage,
	notes,
	repository,
}: {
	match: z.infer<typeof matchSchema>[number]
	usage: UsageEvidence
	notes: ReleaseNote[]
	repository: InspectionReport["repository"]
}): CodeFeatureMatch | undefined {
	// match the cited location and symbol against observed usage
	const candidates = usage.usage.filter((entry) => entry.file === match.file && entry.line === match.line)
	const hit = match.symbol
		? candidates.find((entry) => entry.symbol === match.symbol)
		: candidates.length === 1
			? candidates[0]
			: undefined
	const eligible = notes.filter(
		(item) => item.source === match.source && hit && item.workspaces.includes(hit.workspace),
	)

	// require both a source location and relevant release evidence
	if (!hit || !eligible.length) {
		return
	}
	const quote = match.directQuote
	const cited = eligible.filter((note) => quote && note.text.includes(quote))

	// distinguish stated replacements from inferred matches
	const direct = !!quote && cited.length > 0 && statesReplacement(quote, hit.symbol, match.feature)
	const relevant = direct ? cited : eligible
	const sites = new Map<string, Locator>()
	for (const site of [hit, ...match.sites]) {
		// validate each proposed call site against pinned usage
		if (
			hit.symbol !== "import" &&
			usage.usage.some(
				(entry) =>
					entry.file === site.file &&
					entry.line === site.line &&
					entry.symbol === hit.symbol &&
					relevant.some((note) => note.workspaces.includes(entry.workspace)),
			)
		) {
			const url = permalink(repository, site.file, site.line)
			sites.set(url, { file: site.file, line: site.line, url })
		}
	}
	return {
		feature: match.feature,
		kind: match.kind,
		source: match.source,
		location: { file: hit.file, line: hit.line, url: permalink(repository, hit.file, hit.line) },
		replacement: direct ? "direct" : "inferred",
		directQuote: direct ? quote : undefined,
		callSites: [...sites.values()],
		disposition: "ranked",
	}
}

function statesReplacement(quote: string, symbol: string, feature: string): boolean {
	const sentence = quote.toLowerCase()

	// exclude negated or uncertain replacement language
	if (symbol === "import" || /\b(not|never|unchanged|cannot|might|could|if|no replacement)\b|n['’]t\b/.test(sentence)) {
		return false
	}
	const old = symbol.toLowerCase()
	const terms = (text: string): string[] => text.split(/[^\w$]+/).filter(Boolean)

	// find meaningful feature names in the quoted sentence
	const names = terms(feature.toLowerCase()).filter(
		(word) =>
			word !== old &&
			word.length > 2 &&
			!["use", "the", "with", "new", "instead", "replace", "replacement"].includes(word),
	)
	const connects = (from: string, to: string): boolean =>
		terms(from).includes(old) && names.some((name) => terms(to).includes(name))

	// recognize directed replacement instructions in the release text
	const imperative = /\b(?:replace|replacing|migrate from)\s+([^.;!?]+?)\s+(?:with|to|by)\s+([^.;!?]+)/.exec(sentence)
	if (imperative && connects(imperative[1] ?? "", imperative[2] ?? "")) {
		return true
	}
	const passive = /([^.;!?]+?)\s+(?:is |was )?(?:replaced|superseded) by\s+([^.;!?]+)/.exec(sentence)

	// check passive and active replacement wording separately
	if (passive && connects(passive[1] ?? "", passive[2] ?? "")) {
		return true
	}
	const active = /([^.;!?]+?)\s+(?:replaces?|supersedes?|instead of|in place of)\s+([^.;!?]+)/.exec(sentence)
	return !!active && connects(active[2] ?? "", active[1] ?? "")
}

export function selectFeatureMatches<T extends { report: UpgradeReportV2 }>(
	candidates: T[],
	limit: number,
): { candidate: T; match: CodeFeatureMatch }[] {
	// rank matches by evidence strength and affected locations
	const ordered = candidates
		.flatMap((candidate) => candidate.report.featureMatches.map((match) => ({ candidate, match })))
		.sort(
			(a, b) =>
				Number(b.match.replacement === "direct") - Number(a.match.replacement === "direct") ||
				(b.match.callSites?.length ?? 0) - (a.match.callSites?.length ?? 0) ||
				// break ties by dependency, source location and release citation
				a.candidate.report.dependency.localeCompare(b.candidate.report.dependency) ||
				a.match.location.file.localeCompare(b.match.location.file) ||
				(a.match.location.line ?? 0) - (b.match.location.line ?? 0) ||
				a.match.feature.localeCompare(b.match.feature) ||
				a.match.source.localeCompare(b.match.source),
		)
	const selected: { candidate: T; match: CodeFeatureMatch }[] = []
	const tried = new Set<UpgradeReportV2>()

	// rank every match while retaining reasons for skipped attempts
	for (const [index, { candidate, match }] of ordered.entries()) {
		match.rank = index + 1
		if (!candidate.report.patches.length) {
			match.disposition = "Upgrade has no verified patch"
			continue
		}

		// allow at most one attempt per upgrade within the inspection limit
		if (tried.has(candidate.report) || selected.length >= limit) {
			match.disposition = "Feature match limit"
			continue
		}

		// reserve this upgrade's single adoption attempt
		tried.add(candidate.report)
		selected.push({ candidate, match })
	}
	return selected
}
