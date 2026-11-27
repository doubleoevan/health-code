export const maxGlobPatterns = 256
const maxPatternLength = 256
const maxBraceGroups = 2
const maxAlternatives = 16
const maxWildcardsPerSegment = 2

/**
 * Checks that a list holds a bounded number of glob patterns that each match in bounded time.
 */
export function isBoundedGlobList(patterns: unknown): patterns is string[] {
	return Array.isArray(patterns) && patterns.length <= maxGlobPatterns && patterns.every(isBoundedGlob)
}

/**
 * Checks one glob for the shapes that make a backtracking matcher slow.
 */
export function isBoundedGlob(pattern: unknown): pattern is string {
	if (typeof pattern !== "string" || pattern.length > maxPatternLength) {
		return false
	}

	// reject an extended glob, whose repeated groups a matcher retries exponentially
	if (pattern.includes("(")) {
		return false
	}

	// reject a brace range such as {1..20}, which expands without a comma
	if (pattern.includes("{") && pattern.includes("..")) {
		return false
	}

	// reject too many brace groups or alternatives
	const braceGroupCount = pattern.split("{").length - 1
	const alternativeCount = pattern.split(",").length - 1
	if (braceGroupCount > maxBraceGroups || alternativeCount > maxAlternatives) {
		return false
	}

	// reject several wildcards in one path segment
	return pattern.split("/").every((segment) => {
		const wildcardCount = segment === "**" ? 0 : segment.replace(/[^*?]/g, "").length
		return wildcardCount <= maxWildcardsPerSegment
	})
}
