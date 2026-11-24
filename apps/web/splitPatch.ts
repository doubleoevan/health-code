// keep the browser responsive on a large patch
const maximumShownCharacters = 100_000

export type PatchSection = { text: string; filePath?: string; isFolded: boolean }

/**
 * Splits a patch into shown sections, folding text past the display limit.
 */
export function splitPatch(patch: string): PatchSection[] {
	// start a section at each commit header and changed file
	const sections = patch.split(/^(?=diff --git |From [0-9a-f]{40} Mon Sep 17 00:00:00 2001$)/m)
	let shownCharacters = 0
	return sections.filter(Boolean).map((text): PatchSection => {
		// read the changed file from the section heading
		const filePath = /^diff --git a\/.+ b\/(.+)$/m.exec(text.slice(0, text.indexOf("\n")))?.[1]

		// show sections within the display limit
		if (shownCharacters + text.length <= maximumShownCharacters) {
			shownCharacters += text.length
			return { text, filePath, isFolded: false }
		}

		// fold sections past the display limit
		const foldedText = filePath
			? `${filePath} · Download the patch to see this file.`
			: "More commits · Download the patch to see them."
		return { text: foldedText, isFolded: true }
	})
}
