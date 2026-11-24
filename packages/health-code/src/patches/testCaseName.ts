type Assertion = { fullName?: string; title?: string; ancestorTitles?: string[] }

/**
 * Preserves runner title boundaries, including titles that contain the display separator.
 */
export function jsonCaseName(assertion: Assertion): string {
	if (
		typeof assertion.title === "string" &&
		Array.isArray(assertion.ancestorTitles) &&
		assertion.ancestorTitles.every((part) => typeof part === "string")
	) {
		// preserve title boundaries for nested or ambiguous display names
		return !assertion.title ||
			assertion.ancestorTitles.length ||
			assertion.title.startsWith("[") ||
			assertion.title.includes(" > ")
			? JSON.stringify([...assertion.ancestorTitles, assertion.title])
			: assertion.title
	}

	// fall back to the runner's full name when no title parts are available
	if (typeof assertion.fullName !== "string") {
		throw new Error("Missing test identity")
	}
	return assertion.fullName.startsWith("[") ? JSON.stringify([assertion.fullName]) : assertion.fullName
}

export function caseMatchesTitle(identity: string | undefined, title: string): boolean {
	if (!identity) {
		return false
	}

	// compare plain titles directly and decode structured identities separately
	if (!identity.startsWith("[")) {
		return identity === title || identity.endsWith(` > ${title}`)
	}

	// compare the leaf title in an encoded suite path
	try {
		const parts: unknown = JSON.parse(identity)
		return Array.isArray(parts) && parts.at(-1) === title
	} catch {
		return false
	}
}

export function xmlCaseName(name: string, classname?: string): string {
	return jsonCaseName({ title: name, ancestorTitles: classname ? [classname] : [] })
}
