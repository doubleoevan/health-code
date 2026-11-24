import assert from "node:assert/strict"
import { test } from "node:test"
import { InspectionError, SandboxUnavailableError } from "health-code"
import { readRepository, requirePublicRepository } from "./readRepository.ts"
import { toFailureMessage } from "./toFailureMessage.ts"

const url = "https://github.com/example/project"

test("repository input accepts shorthand, URLs and Git remotes", () => {
	const addresses = [
		"example/project",
		"github.com/example/project",
		`${url}/`,
		`${url}.git`,
		`https://user:synthetic@github.com/example/project.git`,

		// include the SSH remote forms
		"ssh://git@github.com:22/example/project.git",
		"ssh://git@ssh.github.com:443/example/project.git",
		"git@github.com:example/project.git",
		"ssh://git@github.com/example/project.git",
		" example/project\n",
	]
	for (const address of addresses) {
		assert.equal(readRepository(address), url)
	}

	// direct the agent to the checkout or the right form
	assert.throws(() => readRepository(undefined), /git remote get-url origin/)
	for (const address of ["project", "https://gitlab.com/example/project", "a/b/c", "git@gitlab.com:example/project"]) {
		assert.throws(() => readRepository(address), /not a GitHub repository/)
	}
})

test("a missing or private repository stops before the sandbox", async () => {
	const lookup = (status: number, body: object): Promise<void> =>
		requirePublicRepository(url, { request: async () => Response.json(body, { status }) })
	await assert.rejects(lookup(404, {}), /no public repository at example\/project/)
	await assert.rejects(lookup(200, { private: true }), /example\/project is private/)

	// look again without a rejected token
	const rejected = async (_url: unknown, init?: RequestInit): Promise<Response> =>
		new Headers(init?.headers).has("authorization")
			? Response.json({}, { status: 401 })
			: Response.json({}, { status: 404 })
	await assert.rejects(
		requirePublicRepository(url, { githubToken: "expired", request: rejected }),
		/no public repository/,
	)

	// stop for a cancelled caller
	await assert.rejects(
		requirePublicRepository(url, { signal: AbortSignal.abort(), request: () => Promise.reject(new Error("aborted")) }),
		{ name: "AbortError" },
	)

	// leave public, limited and unreachable lookups to the clone
	await lookup(200, { private: false })
	await lookup(403, {})
	await requirePublicRepository(url, { request: () => Promise.reject(new Error("offline")) })
})

test("each failure names its cause and next step", () => {
	assert.match(toFailureMessage(new SandboxUnavailableError("authentication")), /rejected RUNTA_TOKEN.+dashboard/)
	assert.match(toFailureMessage(new SandboxUnavailableError("permission")), /Give it access/)
	assert.match(
		toFailureMessage(new InspectionError("repository-unavailable", "")),
		/public.+\(repository-unavailable\)/,
	)
	assert.match(toFailureMessage(new InspectionError("new-code", "private text")), /report it.+\(new-code\)/)

	// keep library guidance for invalid input and hide unexpected text
	const invalid = new InspectionError("invalid-model-settings", "Set HEALTH_CODE_MODEL.")
	assert.match(toFailureMessage(invalid), /^Set HEALTH_CODE_MODEL\. Correct it/)
	assert.doesNotMatch(toFailureMessage(new InspectionError("invalid-path", "private text")), /private text/)
	assert.match(toFailureMessage(Object.assign(new Error(), { code: "ENOSPC" })), /disk space/)
	assert.doesNotMatch(toFailureMessage(new Error("private text")), /private text/)
})
