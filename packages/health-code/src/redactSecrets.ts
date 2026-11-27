/**
 * Redacts credentials before evidence crosses the library boundary.
 */
export function redactSecrets(text: string): string {
	return text
		.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
		.replace(
			/\b(?:(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+|(?:gh[pousr]_|github_pat_|sk-|rt_|npm_)[A-Za-z0-9_-]{8,})/gi,
			"[redacted]",
		)
		.replace(/("(?:[^"\\]*(?:token|password|secret|api[_-]?key))"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[redacted]"')
		.replace(
			/((?:token|password|secret|api[_-]?key)["']?\s*[=:]\s*)(["'])(?:\\[\s\S]|(?!\2)[^\\])*?\2/gi,
			"$1[redacted]",
		)
		.replace(/((?:token|password|secret|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, "$1[redacted]")
}

/**
 * Scrubs repository-controlled identifiers as well as output before publishing JSON.
 */
export function redactSecretsIn<T>(value: T): T {
	if (typeof value === "string") {
		return redactSecrets(value) as T
	}

	// redact strings recursively inside arrays and objects
	if (Array.isArray(value)) {
		return value.map(redactSecretsIn) as T
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [
				redactSecrets(key),
				typeof item === "string" && /(?:token|password|secret|api[_-]?key)$/i.test(key)
					? "[redacted]"
					: redactSecretsIn(item),
			]),
		) as T
	}
	return value
}

/**
 * Reports whether text holds a value that redaction would mask.
 */
export function hasSecret(text: string): boolean {
	return redactSecrets(text) !== text
}
