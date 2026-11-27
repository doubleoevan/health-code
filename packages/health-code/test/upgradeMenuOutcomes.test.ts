import assert from "node:assert/strict"
import { test } from "node:test"
import { InspectionError, type InspectionEvent, listUpgrades } from "../src/index.ts"
import { createFakeGithub, type FakeRepository, fakeCommit } from "../src/upgrades/createFakeGithub.ts"
import { fakeRepositoryUrl, toFakeRepository } from "./readFixtureProject.ts"

const token = "ghp_exampleexampleexampleexample0000"
const versions = { "1.99.0": {} }

async function readFailure(work: Promise<unknown>): Promise<InspectionError> {
	const error = await work.then(
		() => assert.fail("expected a typed error"),
		(reason: unknown) => reason,
	)
	assert.ok(error instanceof InspectionError, String(error))
	return error
}

test("a renamed repository is followed within the api origin", async () => {
	const github = createFakeGithub({
		repositories: {
			"example/project": { files: new Map(), redirectsTo: "https://api.github.com/repositories/42" },
			"42": toFakeRepository("npm"),
		},
		versions,
	})
	const upgradeMenu = await listUpgrades({
		repositoryUrl: fakeRepositoryUrl,
		githubToken: token,
		request: github.request,
	})
	assert.equal(upgradeMenu.dependencies[0]?.dependency, "widget")
	assert.ok(github.authorizations.every((authorization) => authorization === `Bearer ${token}`))
})

test("a redirect off the api origin is not followed and receives no token", async () => {
	const github = createFakeGithub({
		repositories: { "example/project": { files: new Map(), redirectsTo: "https://evil.example/repos/x" } },
	})
	const error = await readFailure(
		listUpgrades({ repositoryUrl: fakeRepositoryUrl, githubToken: token, request: github.request }),
	)
	assert.equal(error.code, "github-unavailable")
	assert.deepEqual(github.unexpectedRequests, [])
	assert.doesNotMatch(error.message, new RegExp(token))
})

test("a registry redirect is not followed and the dependency ends as a lookup issue", async () => {
	const redirectModes: (string | undefined)[] = []
	const github = createFakeGithub({
		repositories: { "example/project": toFakeRepository("npm") },
		intercept: (url, init) => {
			if (url.origin !== "https://registry.npmjs.org") {
				return undefined
			}

			// reject the redirect the way fetch does when it is told not to follow one
			redirectModes.push(init.redirect)
			return init.redirect === "error"
				? Promise.reject(new TypeError("unexpected redirect"))
				: new Response(null, { status: 301, headers: { location: "https://evil.example/widget" } })
		},
	})
	const upgradeMenu = await listUpgrades({
		repositoryUrl: fakeRepositoryUrl,
		githubToken: token,
		request: github.request,
	})

	// the lookup asked for no redirect, reached no other origin and sent no token
	assert.deepEqual(redirectModes, ["error"])
	assert.deepEqual(github.unexpectedRequests, [])
	assert.deepEqual(upgradeMenu.dependencies, [])
	assert.equal(upgradeMenu.issue, "Couldn’t list available upgrades: package version information was unavailable.")
})

test("a repository the upgrade menu cannot read returns a typed reason and no targets", async () => {
	const largeLockfile = "x".repeat(2 * 1024 * 1024)
	const cases: [string, FakeRepository, Parameters<typeof listUpgrades>[0]["limits"]][] = [
		["binary-lockfile", toFakeRepository("bun-binary"), undefined],
		["tree-truncated", toFakeRepository("npm", { isTruncated: true }), undefined],
		["symbolic-link", toFakeRepository("npm", { links: ["package-lock.json"] }), undefined],
		["symbolic-link", toFakeRepository("npm", { links: ["package.json"] }), undefined],
		["limit", toFakeRepository("pnpm"), { maxWorkspaces: 0 }],
		[
			"limit",
			{ files: new Map([...toFakeRepository("npm").files, ["package-lock.json", largeLockfile]]) },
			{ maxLockfileBytes: 1024 * 1024 },
		],
		["limit", toFakeRepository("npm"), { maxTotalBytes: 16 }],
	]
	for (const [reason, fakeRepository, limits] of cases) {
		const github = createFakeGithub({ repositories: { "example/project": fakeRepository }, versions })
		const upgradeMenu = await listUpgrades({ repositoryUrl: fakeRepositoryUrl, limits, request: github.request })

		// the reason arrives with a message and the registry is never asked
		assert.equal(upgradeMenu.unreadable?.reason, reason)
		assert.equal(upgradeMenu.issue, upgradeMenu.unreadable?.message)
		assert.deepEqual(upgradeMenu.dependencies, [])
		assert.equal(upgradeMenu.repository.commit, fakeCommit)
		assert.deepEqual(github.registryRequests, [])
	}
})

test("a registry response over the caller's limit is skipped with the limit named", async () => {
	const description = "x".repeat(2 * 1024 * 1024)
	const github = createFakeGithub({
		repositories: { "example/project": toFakeRepository("npm") },
		versions: { "1.99.0": { description } },
	})
	const upgradeMenu = await listUpgrades({
		repositoryUrl: fakeRepositoryUrl,
		limits: { maxRegistryResponseBytes: 1024 * 1024 },
		request: github.request,
	})
	assert.deepEqual(upgradeMenu.dependencies, [])
	assert.deepEqual(upgradeMenu.skipped, ["widget: registry response is over the 1 MiB limit"])
})

test("an oversized file is rejected from its listed size before it is requested", async () => {
	const files = new Map([...toFakeRepository("npm").files, ["package-lock.json", "x".repeat(2 * 1024 * 1024)]])
	const github = createFakeGithub({ repositories: { "example/project": { files } }, versions })
	const upgradeMenu = await listUpgrades({
		repositoryUrl: fakeRepositoryUrl,
		limits: { maxLockfileBytes: 1024 * 1024 },
		request: github.request,
	})
	assert.match(
		upgradeMenu.unreadable?.message ?? "",
		/package-lock\.json is 2\.0 MiB\. The upgrade menu reads at most 1\.0 MiB/,
	)
	assert.equal(github.githubRequests.filter((path) => path.includes("/git/blobs/")).length, 1)
})

test("an unsupported project reports the detection reason and no unreadable reason", async () => {
	const files = new Map([
		["package.json", "{}"],
		["package-lock.json", "{}"],
		["yarn.lock", ""],
	])
	const github = createFakeGithub({ repositories: { "example/project": { files } }, versions })
	const upgradeMenu = await listUpgrades({ repositoryUrl: fakeRepositoryUrl, request: github.request })
	assert.deepEqual(upgradeMenu.packageManager, { reason: "Unsupported or ambiguous root lockfile" })
	assert.equal(upgradeMenu.issue, "Unsupported or ambiguous root lockfile")
	assert.equal(upgradeMenu.unreadable, undefined)
})

test("workspaces behind a symbolic link or a submodule are not read", async () => {
	const files = new Map([
		...toFakeRepository("pnpm").files,
		["packages/linked/package.json", '{"dependencies":{"hidden":"1.0.0"}}'],
	])
	const fakeRepository = { files, links: ["packages/linked/package.json"], submodules: ["packages/vendored"] }
	const github = createFakeGithub({ repositories: { "example/project": fakeRepository }, versions })
	const upgradeMenu = await listUpgrades({ repositoryUrl: fakeRepositoryUrl, request: github.request })
	assert.deepEqual(
		upgradeMenu.dependencies.map((choice) => choice.dependency),
		["widget"],
	)
	assert.ok(upgradeMenu.skipped.every((entry) => !entry.includes("hidden")))
})

test("github outcomes are typed errors that name a next step", async () => {
	const unknownRevision = "e".repeat(40)
	const cases: [string, Parameters<typeof createFakeGithub>[0], Partial<Parameters<typeof listUpgrades>[0]>][] = [
		["repository-unavailable", { repositories: {} }, {}],
		["repository-unavailable", { repositories: {} }, { revision: unknownRevision }],
		[
			"repository-unavailable",
			{ repositories: { "example/project": toFakeRepository("npm", { isPrivate: true }) } },
			{ githubToken: token },
		],
		[
			"revision-unavailable",
			{ repositories: { "example/project": toFakeRepository("npm") } },
			{ revision: unknownRevision },
		],
		[
			"revision-unavailable",
			{ repositories: { "example/project": toFakeRepository("npm") } },
			{ revision: unknownRevision, githubToken: token },
		],
		[
			"github-token-rejected",
			{ repositories: { "example/project": toFakeRepository("npm") }, validToken: "another" },
			{ githubToken: token },
		],
		["github-rate-limit", { repositories: { "example/project": toFakeRepository("npm") }, remainingRequests: 0 }, {}],
		["github-unavailable", { repositories: {}, intercept: () => new Response(null, { status: 502 }) }, {}],
		["invalid-revision", { repositories: {} }, { revision: "main" }],
		["invalid-repository", { repositories: {} }, { repositoryUrl: "https://gitlab.com/example/project" }],
	]

	// each outcome keeps its code, hides the token and stays on the two allowed origins
	for (const [code, fake, options] of cases) {
		const github = createFakeGithub({ versions, ...fake })
		const error = await readFailure(
			listUpgrades({ repositoryUrl: fakeRepositoryUrl, request: github.request, ...options }),
		)
		assert.equal(error.code, code, error.message)
		assert.doesNotMatch(`${error.message} ${error.stack}`, new RegExp(token))
		assert.deepEqual(github.unexpectedRequests, [])
	}
})

test("a private repository is rejected before any of its files is read", async () => {
	const github = createFakeGithub({ repositories: { "example/project": toFakeRepository("npm", { isPrivate: true }) } })
	await readFailure(listUpgrades({ repositoryUrl: fakeRepositoryUrl, githubToken: token, request: github.request }))
	assert.deepEqual(github.githubRequests, ["/repos/example/project"])
})

test("a rate limit includes its reset time and says whether a token would help", async () => {
	const fake = { repositories: { "example/project": toFakeRepository("npm") }, remainingRequests: 0 }
	const anonymous = await readFailure(
		listUpgrades({ repositoryUrl: fakeRepositoryUrl, request: createFakeGithub(fake).request }),
	)
	assert.equal(anonymous.retryAt, new Date(1795731326000).toISOString())
	assert.match(
		anonymous.message,
		/without a token is used up until \d\d:\d\d UTC\. Supply a GitHub token or try again then\./,
	)

	// a caller with a token is told only when to return
	const github = createFakeGithub({ ...fake, validToken: token })
	const authenticated = await readFailure(
		listUpgrades({ repositoryUrl: fakeRepositoryUrl, githubToken: token, request: github.request }),
	)
	assert.match(authenticated.message, /limit for this token is used up until \d\d:\d\d UTC\. Try again then\./)
})

test("a secondary limit waits for the seconds github names and is not retried", async () => {
	const github = createFakeGithub({
		repositories: { "example/project": toFakeRepository("npm") },
		intercept: () => new Response(null, { status: 429, headers: { "retry-after": "90" } }),
	})
	const before = Date.now()
	const error = await readFailure(listUpgrades({ repositoryUrl: fakeRepositoryUrl, request: github.request }))
	assert.equal(error.code, "github-rate-limit")
	assert.ok(Math.abs(Date.parse(error.retryAt ?? "") - before - 90000) < 5000)
	assert.equal(github.githubRequests.length, 1)
})

test("a rate limit too low for the remaining files fails before they are requested", async () => {
	const github = createFakeGithub({
		repositories: { "example/project": toFakeRepository("pnpm") },
		remainingRequests: 5,
	})
	const error = await readFailure(listUpgrades({ repositoryUrl: fakeRepositoryUrl, request: github.request }))
	assert.equal(error.code, "github-rate-limit")

	// the commit, the tree, the root manifest and the workspace file are the only requests
	assert.equal(github.githubRequests.length, 4)
	assert.deepEqual(github.registryRequests, [])
})

test("the time bound ends the github reads with a deadline and the registry lookup with an issue", async () => {
	const stall = (_url: URL, init: RequestInit): Promise<Response> =>
		new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)))
	const slowGithub = createFakeGithub({
		repositories: { "example/project": toFakeRepository("npm") },
		intercept: stall,
	})
	const error = await readFailure(
		listUpgrades({ repositoryUrl: fakeRepositoryUrl, limits: { maxDurationMs: 50 }, request: slowGithub.request }),
	)
	assert.equal(error.code, "deadline")

	// a registry that never answers leaves the upgrade menu without that dependency's targets
	const slowRegistry = createFakeGithub({
		repositories: { "example/project": toFakeRepository("npm") },
		intercept: (url, init) => (url.origin === "https://registry.npmjs.org" ? stall(url, init) : undefined),
	})
	const upgradeMenu = await listUpgrades({
		repositoryUrl: fakeRepositoryUrl,
		limits: { maxDurationMs: 300 },
		request: slowRegistry.request,
	})
	assert.deepEqual(upgradeMenu.dependencies, [])
	assert.match(upgradeMenu.issue ?? "", /registry lookup timed out/)
})

test("a caller's cancellation is reported as cancelled", async () => {
	const controller = new AbortController()
	const github = createFakeGithub({
		repositories: { "example/project": toFakeRepository("npm") },
		intercept: (_url, init) => {
			controller.abort()
			return new Promise((_resolve, reject) => queueMicrotask(() => reject(init.signal?.reason)))
		},
	})
	const error = await readFailure(
		listUpgrades({ repositoryUrl: fakeRepositoryUrl, signal: controller.signal, request: github.request }),
	)
	assert.equal(error.code, "cancelled")
})

test("a typed failure ends the events with the failure event and its code", async () => {
	const cases: [string, Parameters<typeof createFakeGithub>[0]][] = [
		["repository-unavailable", { repositories: {} }],
		["github-rate-limit", { repositories: { "example/project": toFakeRepository("npm") }, remainingRequests: 0 }],
		["github-unavailable", { repositories: {}, intercept: () => new Response(null, { status: 502 }) }],
	]
	for (const [code, fake] of cases) {
		const events: InspectionEvent[] = []
		const github = createFakeGithub({ versions, ...fake })
		const error = await readFailure(
			listUpgrades({
				repositoryUrl: fakeRepositoryUrl,
				request: github.request,
				onEvent: (event) => void events.push(event),
			}),
		)

		// the failure is the last event and the only terminal one
		const last = events.at(-1)
		assert.equal(error.code, code)
		assert.equal(last?.type === "inspection.failed" && last.code, code)
		assert.equal(last?.type === "inspection.failed" && last.message, error.message)
		assert.equal(events.filter((event) => /^inspection\.(failed|finished)$/.test(event.type)).length, 1)
	}
})
