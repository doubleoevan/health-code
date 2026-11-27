import { UserError } from "../userError.ts"
import { inspectPullRequest } from "./inspectPullRequest.ts"
import { reportPullRequest } from "./reportPullRequest.ts"
import { selectPullRequest, writeDecision } from "./selectPullRequest.ts"

const pullRequestStepUsage = "Usage: health-code dependency-pull-request <select|inspect|report>"

/**
 * Runs one step of the dependency pull request workflow and returns the process exit code.
 */
export async function runPullRequestStep(
	args: string[],
	{ environment, signal }: { environment: NodeJS.ProcessEnv; signal: AbortSignal },
): Promise<number> {
	const [step, ...extra] = args
	if (extra.length) {
		throw new UserError(pullRequestStepUsage)
	}

	// decide from the event and hand the decision to the next job
	if (step === "select") {
		await writeDecision(await selectPullRequest({ environment, signal }), environment)
		return 0
	}

	// fail the step when the inspection stopped early
	if (step === "inspect") {
		const { isComplete } = await inspectPullRequest({ environment, signal })
		return isComplete ? 0 : 1
	}

	// end the decision on the pull request whatever the earlier steps did
	if (step === "report") {
		await reportPullRequest({ environment, signal })
		return 0
	}
	throw new UserError(pullRequestStepUsage)
}
