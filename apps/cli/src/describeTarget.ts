import { type PullRequestTarget, readPullRequestTarget } from "health-code"
import { readGithubToken } from "./readEnvironmentSettings.ts"
import { UserError } from "./userError.ts"

export const targetUsage = "Usage: health-code target <pull-request-url>"

// a pull request's repository address and number
export type PullRequestAddress = { repositoryUrl: string; pullRequest: number }

/**
 * Prints the single upgrade a dependency pull request holds as JSON, or the reason it holds none.
 */
export async function describeTarget(
	args: string[],
	{ environment, signal, request }: { environment: NodeJS.ProcessEnv; signal?: AbortSignal; request?: typeof fetch },
): Promise<string> {
	const address = args.length === 1 ? toPullRequestAddress(args[0] ?? "") : undefined
	if (!address) {
		throw new UserError(targetUsage)
	}

	// read the pull request with the token the environment holds, or without one
	const githubToken = readGithubToken(environment)
	const target: PullRequestTarget = await readPullRequestTarget({ ...address, githubToken, signal, request })
	return JSON.stringify(target, null, 2)
}

/**
 * Parses a pull request's address on github.com and rejects anything else.
 */
export function toPullRequestAddress(url: string): PullRequestAddress | undefined {
	const match = /^https:\/\/github\.com\/([a-z0-9-]{1,39}\/[a-z0-9_.-]{1,100})\/pull\/([1-9]\d{0,9})\/?$/i.exec(url)
	return match ? { repositoryUrl: `https://github.com/${match[1]}`, pullRequest: Number(match[2]) } : undefined
}
