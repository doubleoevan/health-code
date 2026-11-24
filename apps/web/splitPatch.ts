// the lockfiles shown as one line
const lockfilePattern = /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/

// keep the browser responsive on a large patch
const maximumShownCharacters = 100_000

export type PatchSection = { text: string; isFolded: boolean }

/**
 * Splits a patch into shown sections, folding lockfiles and text past the display limit.
 */
export function splitPatch(patch: string): PatchSection[] {
	// start a section at each commit header and changed file
	const sections = patch.split(/^(?=diff --git |From [0-9a-f]{40} Mon Sep 17 00:00:00 2001$)/m)
	let shownCharacters = 0
	return sections.filter(Boolean).map((text): PatchSection => {
		// fold lockfile changes
		const filePath = /^diff --git a\/.+ b\/(.+)$/m.exec(text.slice(0, text.indexOf("\n")))?.[1]
		if (filePath && lockfilePattern.test(filePath)) {
			const changedLineCount = text.slice(text.indexOf("\n@@")).match(/^[+-](?!- $)/gm)?.length ?? 0

			// describe the fold on one line
			const foldedText = `${filePath} · ${changedLineCount} changed lines. Download the patch to see them.`
			return { text: foldedText, isFolded: true }
		}

		// show sections within the display limit
		shownCharacters += text.length
		if (shownCharacters <= maximumShownCharacters) {
			return { text, isFolded: false }
		}

		// fold sections past the display limit
		const foldedText = filePath
			? `${filePath} · Download the patch to see this file.`
			: "More commits · Download the patch to see them."
		return { text: foldedText, isFolded: true }
	})
}
