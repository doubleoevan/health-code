import { InspectionError } from "./contracts.ts"

export function toRepositoryUrl(input: string): string {
	// normalize the optional git suffix on a public github repository url
	const match = /^https:\/\/github\.com\/([a-z0-9-]{1,39})\/([a-z0-9_.-]{1,104})\/?$/i.exec(input)
	const name = match?.[2]?.replace(/\.git$/i, "")
	if (!match || match[0] !== input || !name || name === "." || name === ".." || name.length > 100) {
		throw new InspectionError("invalid-repository", "Expected a public GitHub repository URL")
	}
	return `https://github.com/${match[1]}/${name}`
}
