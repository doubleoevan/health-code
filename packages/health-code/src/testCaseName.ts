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
		return !assertion.title ||
			assertion.ancestorTitles.length ||
			assertion.title.startsWith("[") ||
			assertion.title.includes(" > ")
			? JSON.stringify([...assertion.ancestorTitles, assertion.title])
			: assertion.title
	}
	if (typeof assertion.fullName !== "string") {
		throw new Error("Missing test identity")
	}
	return assertion.fullName.startsWith("[") ? JSON.stringify([assertion.fullName]) : assertion.fullName
}

export function caseMatchesTitle(identity: string | undefined, title: string): boolean {
	if (!identity) {
		return false
	}
	if (!identity.startsWith("[")) {
		return identity === title || identity.endsWith(` > ${title}`)
	}
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
