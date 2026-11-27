import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { InspectionError } from "health-code"
import { buildUpgradeMenuInProcess, toUpgradeMenuFailureMessage } from "./buildUpgradeMenu.ts"

test("the build process loads the library, reports typed failures and is ended at its time limit", async () => {
	const invalid = buildUpgradeMenuInProcess({
		request: { repositoryUrl: "https://gitlab.com/example/project" },
		onEvent: () => {},
	})
	await expect(invalid).rejects.toMatchObject({ code: "invalid-repository" })

	// check that a build that never answers ends at the limit and the next build runs
	const stalledPath = fileURLToPath(new URL("./fixtures/stalledUpgradeMenuProcess.ts", import.meta.url))
	const stalled = buildUpgradeMenuInProcess({
		request: { repositoryUrl: "https://github.com/example/project" },
		onEvent: () => {},
		entryPath: stalledPath,
		timeoutMs: 400,
	})
	await expect(stalled).rejects.toMatchObject({ code: "deadline" })
	const next = buildUpgradeMenuInProcess({ request: { repositoryUrl: "not a url" }, onEvent: () => {} })
	await expect(next).rejects.toMatchObject({ code: "invalid-repository" })
})

test("a build past its memory limit ends as a repository the upgrade menu cannot read", async () => {
	// check that a known commit offers the sandbox listing with the limit in the message
	const stalledPath = fileURLToPath(new URL("./fixtures/stalledUpgradeMenuProcess.ts", import.meta.url))
	const revision = "a".repeat(40)
	const overLimit = await buildUpgradeMenuInProcess({
		request: { repositoryUrl: "https://github.com/example/project", revision, maxMemoryMiB: 1 },
		onEvent: () => {},
		entryPath: stalledPath,
	})
	expect(overLimit.unreadable?.reason).toBe("limit")
	expect(overLimit.unreadable?.message).toBe(
		"Reading this repository took more than 1 MiB of memory. List upgrades in a sandbox instead.",
	)
	expect(overLimit.repository.commit).toBe(revision)

	// check that a build that names no commit fails
	const unpinned = buildUpgradeMenuInProcess({
		request: { repositoryUrl: "https://github.com/example/project", maxMemoryMiB: 1 },
		onEvent: () => {},
		entryPath: stalledPath,
	})
	await expect(unpinned).rejects.toMatchObject({ code: "menu-failed" })
})

test("a GitHub rate limit says when to try again and leaves out the server's token", () => {
	const libraryMessage = "GitHub's limit for this token is used up until 14:32 UTC. Try again then."
	const rateLimitError = new InspectionError("github-rate-limit", libraryMessage)
	rateLimitError.retryAt = "2099-01-01T14:32:00.000Z"
	expect(toUpgradeMenuFailureMessage(rateLimitError)).toBe(
		"GitHub is limiting requests until 14:32 UTC. Try again then.",
	)
})
