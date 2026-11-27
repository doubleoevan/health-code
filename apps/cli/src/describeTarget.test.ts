import assert from "node:assert/strict"
import { test } from "node:test"
import { createFakeGithub } from "health-code"
import { describeTarget, targetUsage, toPullRequestAddress } from "./describeTarget.ts"
import { baseCommit, fakeRepository, toWidgetProject } from "./fixtures/fakeRepositoryApi.ts"
import { toFailureMessage } from "./toFailureMessage.ts"
import { UserError } from "./userError.ts"

const headCommit = "a".repeat(40)
const pullRequestUrl = "https://github.com/example/project/pull/7"

// serve a pull request by the given author that moves widget to a new major
function github(author: string, remainingRequests?: number): typeof fetch {
	const pullRequests = { 7: { author, headCommit, baseCommit } }
	const revisions = { [baseCommit]: toWidgetProject("1.2.0") }
	const repository = { files: toWidgetProject("2.0.0"), commit: headCommit, revisions, pullRequests }
	return createFakeGithub({ repositories: { [fakeRepository]: repository }, remainingRequests }).request
}

test("target prints the upgrade a bot's pull request holds", async () => {
	const output = await describeTarget([pullRequestUrl], { environment: {}, request: github("dependabot[bot]") })
	assert.deepEqual(JSON.parse(output), {
		pullRequest: 7,
		author: "dependabot[bot]",
		baseCommit,
		headCommit,
		upgrade: { dependency: "widget", from: "1.2.0", to: "2.0.0", kind: "major" },
		isMajor: true,
		movedWith: [],
	})
})

test("target prints a reason for a pull request with no single upgrade", async () => {
	const request = github("octocat")
	const sameVersion = createFakeGithub({
		repositories: {
			"example/project": {
				files: toWidgetProject("1.2.0"),
				commit: headCommit,
				revisions: { [baseCommit]: toWidgetProject("1.2.0") },
				pullRequests: { 7: { author: "octocat", headCommit, baseCommit } },
			},
		},
	}).request
	const read = async (fake: typeof fetch): Promise<Record<string, unknown>> =>
		JSON.parse(await describeTarget([pullRequestUrl], { environment: {}, request: fake }))
	assert.equal("upgrade" in (await read(request)), true)
	assert.equal((await read(sameVersion)).reason, "no-direct-dependency")
})

test("target rejects anything but one pull request address", async () => {
	const invalid = [[], ["https://github.com/example/project"], [pullRequestUrl, "extra"], [pullRequestUrl, "--bots"]]
	for (const args of invalid) {
		await assert.rejects(
			describeTarget(args, { environment: {} }),
			(error) => error instanceof UserError && error.message === targetUsage,
		)
	}

	// an address on another host or with a untrusted number is no pull request
	assert.equal(toPullRequestAddress("https://github.com.evil.example/a/b/pull/1"), undefined)
	assert.equal(toPullRequestAddress("https://github.com/a/b/pull/1;rm"), undefined)
	assert.deepEqual(toPullRequestAddress("https://github.com/a/b/pull/12/"), {
		repositoryUrl: "https://github.com/a/b",
		pullRequest: 12,
	})
})

test("target names the reset time when GitHub's limit is used up", async () => {
	const failure = await describeTarget([pullRequestUrl], {
		environment: {},
		request: github("renovate[bot]", 0),
	}).catch((error: unknown) => toFailureMessage(error))
	assert.match(failure, /GitHub's limit for requests without a token is used up until .* Set GITHUB_TOKEN or GH_TOKEN/)
})
