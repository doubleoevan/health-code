import { UserError } from "../userError.ts"
import { type GithubClient, readProperty } from "./githubClient.ts"
import type { MarkStatus } from "./inspectionMarks.ts"
import { statusContext } from "./pullRequestSettings.ts"
import { commentMarker } from "./toPullRequestComment.ts"

// the account the workflow's token comments as
const workflowLogin = "github-actions[bot]"

type CommitStatus = { state: "pending" | MarkStatus["state"]; description: string }

/**
 * Names the folder the inspect step writes its report and state to.
 */
export function toOutputFolder(environment: NodeJS.ProcessEnv): string {
	return environment.HEALTH_CODE_OUTPUT?.trim() || "health-code-report"
}

/**
 * Builds the address of the workflow run from the runner's own variables, or nothing outside Actions.
 */
export function toRunUrl(environment: NodeJS.ProcessEnv): string | undefined {
	const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: runId } = environment
	const isComplete = server === "https://github.com" && repository && /^\d+$/.test(runId ?? "")
	return isComplete ? `${server}/${repository}/actions/runs/${runId}` : undefined
}

/**
 * Sets the inspection's commit status on a pull request's head.
 */
export async function setStatus(
	client: GithubClient,
	{ commit, status, targetUrl }: { commit: string; status: CommitStatus; targetUrl?: string },
): Promise<void> {
	const answer = await client.send("POST", `/statuses/${commit}`, {
		state: status.state,
		context: statusContext,
		description: status.description.slice(0, 140),
		...(targetUrl && { target_url: targetUrl }),
	})
	if (answer.status !== 201) {
		throw new UserError(`GitHub answered ${answer.status} to the commit status. Grant the job statuses: write.`)
	}
}

/**
 * Writes the workflow's one comment on a pull request, replacing the comment an earlier run left.
 */
export async function replaceComment(
	client: GithubClient,
	{ pullRequest, body }: { pullRequest: number; body: string },
): Promise<void> {
	// ponytail: read the first 100 comments. page through them if a pull request gathers more
	const listed = await client.get(`/issues/${pullRequest}/comments?per_page=100`)
	if (listed.status !== 200 || !Array.isArray(listed.body)) {
		throw new UserError(`GitHub answered ${listed.status} to the list of comments. Run the job again.`)
	}

	// find the comment an earlier report left
	const earlier = listed.body.find((comment) => {
		const text = readProperty(comment, "body")
		const isOwn = readProperty(comment, "user", "login") === workflowLogin
		return isOwn && typeof text === "string" && text.startsWith(commentMarker)
	})

	// replace the earlier comment, or add the first one
	const commentId = readProperty(earlier, "id")
	const answer =
		typeof commentId === "number"
			? await client.send("PATCH", `/issues/comments/${commentId}`, { body })
			: await client.send("POST", `/issues/${pullRequest}/comments`, { body })

	// name the permission a rejected comment needs
	if (answer.status !== 200 && answer.status !== 201) {
		throw new UserError(`GitHub answered ${answer.status} to the comment. Grant the job pull-requests: write.`)
	}
}

/**
 * Removes the label that asked for an inspection, so adding it again asks again.
 */
export async function removeLabel(
	client: GithubClient,
	{ pullRequest, label }: { pullRequest: number; label: string },
): Promise<void> {
	const response = await client.send("DELETE", `/issues/${pullRequest}/labels/${encodeURIComponent(label)}`)

	// a label that is already gone needs no removal
	if (response.status !== 200 && response.status !== 404) {
		throw new UserError(
			`GitHub answered ${response.status} to the label removal. Remove the label by hand to ask again.`,
		)
	}
}
