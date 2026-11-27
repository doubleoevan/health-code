import { isExactVersion, isGitObjectId, readPullRequestTarget } from "health-code"
import { readGithubToken } from "../readEnvironmentSettings.ts"
import { UserError } from "../userError.ts"
import { createGithubClient, type GithubClient, readProperty } from "./githubClient.ts"
import { readWorkflowEvent, statusContext } from "./pullRequestSettings.ts"

export const waitUsage = "Usage: health-code wait"

// how a wait ended: nothing to wait for, a result, no result, no answer in time or a pull request that moved on
export type WaitOutcome = "skipped" | "inspected" | "not-inspected" | "timed-out" | "moved"

type WaitOptions = {
	environment: NodeJS.ProcessEnv
	request?: typeof fetch
	signal?: AbortSignal

	// how the wait passes time, reads the clock and prints
	sleep?: (milliseconds: number) => Promise<void>
	now?: () => number
	log?: (line: string) => void
}

const pollMs = 30_000
const defaultWaitMinutes = 60

/**
 * Waits on a pull request that holds one major upgrade until the inspection's status on its head is no longer pending.
 */
export async function waitForInspection({
	environment,
	request,
	signal,
	sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
	now = Date.now,
	log = console.log,
}: WaitOptions): Promise<WaitOutcome> {
	// return at once for an event that is not a pull request
	const event = await readWorkflowEvent(environment)
	const pullRequest = readProperty(event.payload, "pull_request", "number")
	const isPullRequestEvent = event.name === "pull_request" || event.name === "pull_request_target"
	if (!isPullRequestEvent || typeof pullRequest !== "number") {
		log("Health Code: this job did not start from a pull request. Nothing to wait for.")
		return "skipped"
	}

	// read the pull request's upgrade the way the workflow does
	const token = readGithubToken(environment)
	const client = createGithubClient({ repository: environment.GITHUB_REPOSITORY ?? "", token, request, signal })
	const target = await readPullRequestTarget({
		repositoryUrl: `https://github.com/${client.repository}`,
		pullRequest,
		githubToken: token,
		request,
		signal,
	})
	if ("reason" in target || !target.isMajor || !isExactVersion(target.upgrade.to)) {
		log("Health Code: this pull request holds no single major upgrade. Nothing to wait for.")
		return "skipped"
	}

	// answer for the commit this job tests. a pull request that moved on has a newer job for its new head
	const eventHead = readProperty(event.payload, "pull_request", "head", "sha")
	if (isGitObjectId(eventHead) && eventHead !== target.headCommit) {
		return endWait("moved", { environment, log })
	}

	// poll the status on the head until it leaves pending or the time limit passes
	const { dependency, to } = target.upgrade
	log(`Health Code: waiting for the inspection of ${dependency} ${to}.`)
	const outcome = await pollStatus({ client, commit: target.headCommit, environment, signal, sleep, now })
	return endWait(outcome, { environment, log })
}

async function pollStatus({
	client,
	commit,
	environment,
	signal,
	sleep,
	now,
}: {
	client: GithubClient
	commit: string
	environment: NodeJS.ProcessEnv
	signal?: AbortSignal
	sleep: (milliseconds: number) => Promise<void>
	now: () => number
}): Promise<WaitOutcome> {
	// read the time limit in minutes, or the default for anything that is not a positive number
	const minutes = Number(environment.HEALTH_CODE_WAIT_MINUTES)
	const waitMs = (Number.isFinite(minutes) && minutes > 0 ? minutes : defaultWaitMinutes) * 60_000
	const deadline = now() + waitMs
	for (;;) {
		// take the latest status of each context for this commit. a poll that fails counts as no status yet
		const response = await client.get(`/commits/${commit}/status?per_page=100`).catch((error: unknown) => {
			if (signal?.aborted) {
				throw error
			}
			return undefined
		})

		// find the inspection's own status among them
		const latestStatuses = readProperty(response?.body, "statuses")
		const statuses = Array.isArray(latestStatuses) ? latestStatuses : []
		const status = statuses.find((item) => readProperty(item, "context") === statusContext)
		const state = readProperty(status, "state")

		// end on a result, and on an inspection that did not start
		if (state === "success" || state === "failure") {
			return "inspected"
		}
		if (state === "error") {
			return "not-inspected"
		}

		// stop waiting once the next poll would pass the time limit
		if (now() + pollMs > deadline) {
			return "timed-out"
		}
		await sleep(pollMs)
	}
}

// let the job continue, or fail it when the caller requires an inspection
function endWait(
	outcome: WaitOutcome,
	{ environment, log }: { environment: NodeJS.ProcessEnv; log: (line: string) => void },
): WaitOutcome {
	if (outcome === "inspected") {
		log("Health Code: the inspection ended. Read its result in the pull request's comment.")
		return outcome
	}

	// say whether the sandbox answered at all
	const messages = {
		"timed-out": "No inspection result arrived within the wait step's time limit.",
		"not-inspected":
			"The health inspector did not try this upgrade. The health-code status on the pull request says why.",
		moved: "The pull request has a newer head than the commit this job tests, so this commit has no inspection.",
		skipped: "",
	}
	const message = messages[outcome]

	// fail the step only for a caller that requires an inspection
	if (environment.HEALTH_CODE_REQUIRE_INSPECTION === "true") {
		throw new UserError(`${message} This job requires an inspection before it installs.`)
	}
	log(`::warning::Health Code: ${message} The job continues.`)
	return outcome
}
