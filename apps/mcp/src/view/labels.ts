/**
 * Describes the installed versions and the target version.
 */
export function toVersionChange(from: Record<string, string>, to: string): string {
	return `${[...new Set(Object.values(from))].join(", ")} → ${to}`
}

/**
 * Returns the owner and repository of a GitHub URL.
 */
export function toRepositoryName(url: string): string {
	return url.replace("https://github.com/", "")
}
