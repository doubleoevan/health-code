import assert from "node:assert/strict"
import { test } from "node:test"
import { InspectionError, type PullRequestTarget, readPullRequestTarget } from "../src/index.ts"
import { createFakeGithub, type FakeGithub, type FakePullRequest } from "../src/upgrades/createFakeGithub.ts"
import { fakeRepositoryUrl, readFixtureProject, textFixtureNames } from "./readFixtureProject.ts"

type Files = Map<string, string>
type Project = { dependencies: Record<string, string>; workspaces?: Record<string, Record<string, string>> }

const baseCommit = "b".repeat(40)
const headCommit = "a".repeat(40)

// build an npm project whose lockfile locks each declared version
function toNpmProject({ dependencies, workspaces = {} }: Project): Files {
	const packages: Record<string, { version: string }> = {}
	for (const [name, version] of Object.entries(dependencies)) {
		packages[`node_modules/${name}`] = { version }
	}

	// lock each workspace's own version beside its manifest
	const files: Files = new Map()
	for (const [directory, workspaceDependencies] of Object.entries(workspaces)) {
		files.set(`${directory}/package.json`, JSON.stringify({ name: directory, dependencies: workspaceDependencies }))
		for (const [name, version] of Object.entries(workspaceDependencies)) {
			packages[`${directory}/node_modules/${name}`] = { version }
		}
	}
	const manifest = {
		name: "example",
		dependencies,
		...(Object.keys(workspaces).length && { workspaces: ["packages/*"] }),
	}
	files.set("package.json", JSON.stringify(manifest))
	files.set("package-lock.json", JSON.stringify({ name: "example", lockfileVersion: 3, packages }))
	return files
}

// serve one pull request whose base and head hold the two sets of files
function github(base: Files, head: Files, pullRequest: Partial<FakePullRequest> = {}): FakeGithub {
	return createFakeGithub({
		repositories: {
			"example/project": {
				files: head,
				commit: headCommit,
				revisions: { [baseCommit]: base },
				pullRequests: {
					7: { author: "renovate[bot]", headRef: "renovate/widget-2.x", headCommit, baseCommit, ...pullRequest },
				},
			},
		},
	})
}

async function readTarget(fake: FakeGithub): Promise<PullRequestTarget> {
	const target = await readPullRequestTarget({
		repositoryUrl: fakeRepositoryUrl,
		pullRequest: 7,
		request: fake.request,
	})
	assert.deepEqual(fake.unexpectedRequests, [])
	assert.deepEqual(fake.registryRequests, [])
	return target
}

function readReason(target: PullRequestTarget): string {
	assert.ok("reason" in target, "expected a reason")
	return target.reason
}

// replace the recorded project's locked widget versions in every file. the pnpm child locks 1.1.0
function moveWidget(files: Files, to: string): Files {
	return new Map([...files].map(([path, text]) => [path, text.replaceAll(/1\.[12]\.0/g, to)]))
}

for (const name of textFixtureNames) {
	test(`a single upgrade is read from the recorded ${name} project`, async () => {
		const base = readFixtureProject(name).files
		const target = await readTarget(github(base, moveWidget(base, "1.3.0")))
		assert.deepEqual(target, {
			pullRequest: 7,
			author: "renovate[bot]",
			baseCommit,
			headCommit,
			upgrade: { dependency: "widget", from: "1.2.0", to: "1.3.0", kind: "minor" },
			isMajor: false,
			movedWith: [],
		})
	})
}

test("a major, a minor below 1.0 and a patch below 1.0 are told apart", async () => {
	const read = async (from: string, to: string): Promise<PullRequestTarget> =>
		readTarget(github(toNpmProject({ dependencies: { widget: from } }), toNpmProject({ dependencies: { widget: to } })))
	const major = await read("18.3.1", "19.0.0")
	assert.ok("upgrade" in major)
	assert.deepEqual([major.upgrade.kind, major.isMajor], ["major", true])

	// a 0.x minor can break as a major does, and a 0.x patch cannot
	const minorBelowOne = await read("0.4.2", "0.5.0")
	assert.ok("upgrade" in minorBelowOne)
	assert.deepEqual([minorBelowOne.upgrade.kind, minorBelowOne.isMajor], ["minor", true])
	const patchBelowOne = await read("0.4.2", "0.4.3")
	assert.ok("upgrade" in patchBelowOne)
	assert.deepEqual([patchBelowOne.upgrade.kind, patchBelowOne.isMajor], ["patch", false])
})

test("one package declared in several workspaces is one target", async () => {
	const project = (version: string): Files =>
		toNpmProject({
			dependencies: { widget: version },
			workspaces: { "packages/a": { widget: version }, "packages/b": { widget: version } },
		})
	const target = await readTarget(github(project("1.2.0"), project("2.0.0")))
	assert.ok("upgrade" in target)
	assert.deepEqual(target.upgrade, { dependency: "widget", from: "1.2.0", to: "2.0.0", kind: "major" })
})

test("workspaces that end on different versions give a reason", async () => {
	const base = toNpmProject({ dependencies: { widget: "1.2.0" }, workspaces: { "packages/a": { widget: "1.2.0" } } })
	const head = toNpmProject({ dependencies: { widget: "2.0.0" }, workspaces: { "packages/a": { widget: "1.2.0" } } })
	assert.equal(readReason(await readTarget(github(base, head))), "mixed-versions")
})

test("a family names its lead and lists the packages that moved with it", async () => {
	const sameVersion = await readTarget(
		github(
			toNpmProject({ dependencies: { "react-dom": "18.3.1", react: "18.3.1" } }),
			toNpmProject({ dependencies: { "react-dom": "19.0.0", react: "19.0.0" } }),
		),
	)
	assert.ok("upgrade" in sameVersion)
	assert.equal(sameVersion.upgrade.dependency, "react")
	assert.deepEqual(sameVersion.movedWith, [{ dependency: "react-dom", from: "18.3.1", to: "19.0.0" }])

	// one scope is a family, and the highest upgrade kind leads
	const sameScope = await readTarget(
		github(
			toNpmProject({ dependencies: { "@babel/core": "7.1.0", "@babel/preset-env": "7.4.0" } }),
			toNpmProject({ dependencies: { "@babel/core": "7.2.0", "@babel/preset-env": "8.0.0" } }),
		),
	)
	assert.ok("upgrade" in sameScope)
	assert.equal(sameScope.upgrade.dependency, "@babel/preset-env")
	assert.equal(sameScope.isMajor, true)
})

test("a family counts as a major when any member does", async () => {
	const target = await readTarget(
		github(
			toNpmProject({ dependencies: { "@example/a": "1.0.0", "@example/z": "0.1.0" } }),
			toNpmProject({ dependencies: { "@example/a": "1.1.0", "@example/z": "0.2.0" } }),
		),
	)
	assert.ok("upgrade" in target)
	assert.deepEqual([target.upgrade.dependency, target.isMajor], ["@example/a", true])
})

test("a grouped pull request gives a reason with the number of packages", async () => {
	const names = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"]
	const project = (bump: number): Files =>
		toNpmProject({ dependencies: Object.fromEntries(names.map((name, index) => [name, `1.${index + bump}.0`])) })
	const target = await readTarget(github(project(0), project(1)))
	assert.deepEqual("reason" in target && [target.reason, target.message], [
		"grouped",
		"The pull request moves 6 unrelated packages.",
	])
})

test("a lockfile-only change of a direct dependency is a target", async () => {
	const manifest = JSON.stringify({ name: "example", dependencies: { widget: "^1.2.0" } })
	const lock = (version: string): string =>
		JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/widget": { version } } })
	const base: Files = new Map([
		["package.json", manifest],
		["package-lock.json", lock("1.2.0")],
	])
	const head: Files = new Map([
		["package.json", manifest],
		["package-lock.json", lock("1.2.5")],
	])
	const target = await readTarget(github(base, head, { changedFiles: ["package-lock.json"] }))
	assert.ok("upgrade" in target)
	assert.deepEqual(target.upgrade, { dependency: "widget", from: "1.2.0", to: "1.2.5", kind: "patch" })
})

test("a change to transitive packages only gives a reason", async () => {
	const base = toNpmProject({ dependencies: { widget: "1.2.0" } })
	const head = new Map(base)

	// lock one more package that no manifest declares
	const lockfile = JSON.parse(head.get("package-lock.json") ?? "")
	lockfile.packages["node_modules/transitive"] = { version: "3.0.0" }
	head.set("package-lock.json", JSON.stringify(lockfile))
	const target = await readTarget(github(base, head, { changedFiles: ["package-lock.json"] }))
	assert.equal(readReason(target), "no-direct-dependency")
})

test("an action or image bump reads no file", async () => {
	const project = toNpmProject({ dependencies: { widget: "1.2.0" } })
	const fake = github(project, project, { changedFiles: [".github/workflows/ci.yml", "Dockerfile"] })
	assert.equal(readReason(await readTarget(fake)), "no-npm-dependency")
	assert.equal(
		fake.githubRequests.some((path) => path.includes("/git/")),
		false,
	)
})

test("a downgrade, a removal and an addition are not upgrades", async () => {
	const widget = (version: string): Files => toNpmProject({ dependencies: { widget: version } })
	assert.equal(readReason(await readTarget(github(widget("2.0.0"), widget("1.2.0")))), "not-an-upgrade")
	const both = toNpmProject({ dependencies: { widget: "1.2.0", gadget: "1.0.0" } })
	assert.equal(readReason(await readTarget(github(both, widget("1.2.0")))), "not-an-upgrade")
	assert.equal(readReason(await readTarget(github(widget("1.2.0"), both))), "not-an-upgrade")
})

test("the head repository and the changed files decide, never the author or the branch name", async () => {
	const base = toNpmProject({ dependencies: { widget: "1.2.0" } })
	const head = toNpmProject({ dependencies: { widget: "2.0.0" } })
	const read = async (pullRequest: Partial<FakePullRequest>): Promise<PullRequestTarget> =>
		readTarget(github(base, head, pullRequest))

	// both bots' shapes and a person's dependency-only pull request are answered alike
	assert.ok("upgrade" in (await read({ author: "renovate[bot]", headRef: "renovate/widget-2.x" })))
	assert.ok("upgrade" in (await read({ author: "dependabot[bot]", headRef: "dependabot/npm_and_yarn/widget-2.0.0" })))
	const person = await read({ author: "octocat", headRef: "upgrade-widget" })
	assert.ok("upgrade" in person)
	assert.equal(person.author, "octocat")

	// a fork gains nothing from a bot's branch name, and a branch Health Code pushed is never answered
	const fork = await read({ headRepository: "stranger/project", headRef: "renovate/widget-2.x" })
	assert.equal(readReason(fork), "fork")
	const own = await read({ author: "renovate[bot]", headRef: "health-code/widget-2.0.0" })
	assert.equal(readReason(own), "own-pull-request")
})

test("a pull request that also changes other files gives a reason", async () => {
	const base = toNpmProject({ dependencies: { widget: "1.2.0" } })
	const head = toNpmProject({ dependencies: { widget: "2.0.0" } })
	const read = async (changedFiles: string[]): Promise<PullRequestTarget> =>
		readTarget(github(base, head, { changedFiles }))
	assert.equal(readReason(await read(["package.json", "package-lock.json", "src/index.ts"])), "other-changes")

	// workspace manifests and Yarn's own files are part of a dependency change
	assert.ok("upgrade" in (await read(["package.json", "packages/a/package.json", "package-lock.json"])))
	assert.ok("upgrade" in (await read(["package.json", "yarn.lock", ".yarn/cache/widget-npm-2.0.0.zip", ".pnp.cjs"])))

	// yarn's own release, a plugin and a file renamed into place are code, not a dependency change
	assert.equal(readReason(await read(["package.json", "yarn.lock", ".yarn/releases/yarn-4.0.0.cjs"])), "other-changes")
	assert.equal(readReason(await read(["package.json", "packages/a/.pnp.cjs"])), "other-changes")

	// a list of changed paths that is cut short cannot prove the rule
	const manyFiles = Array.from({ length: 300 }, (_, index) =>
		index ? `packages/${index}/package.json` : "package.json",
	)
	assert.equal(readReason(await read(manyFiles)), "other-changes")
})

test("a name that fails npm's grammar appears nowhere in the result", async () => {
	const untrusted = "$(curl evil)`x`"
	const base = toNpmProject({ dependencies: { widget: "1.2.0", [untrusted]: "1.0.0" } })
	const head = toNpmProject({ dependencies: { widget: "1.3.0", [untrusted]: "2.0.0" } })
	const target = await readTarget(github(base, head, { author: "renovate[bot]" }))
	assert.ok("upgrade" in target)
	assert.equal(target.upgrade.dependency, "widget")
	assert.equal(JSON.stringify(target).includes("curl"), false)

	// a login outside GitHub's shape is not printed either
	const stranger = await readTarget(github(base, head, { author: "<script>" }))
	assert.equal(stranger.author, "")
})

test("a repository the api cannot serve gives the unreadable reason", async () => {
	const base = toNpmProject({ dependencies: { widget: "1.2.0" } })
	const head = toNpmProject({ dependencies: { widget: "2.0.0" } })
	const fake = createFakeGithub({
		repositories: {
			"example/project": {
				files: head,
				commit: headCommit,
				revisions: { [baseCommit]: base },
				links: ["package-lock.json"],
				pullRequests: { 7: { author: "renovate[bot]", headCommit, baseCommit } },
			},
		},
	})
	assert.equal(readReason(await readTarget(fake)), "unreadable")
})

test("a missing pull request, a private repository and a used-up limit are typed errors", async () => {
	const project = toNpmProject({ dependencies: { widget: "1.2.0" } })
	const read = (fake: FakeGithub, pullRequest = 7): Promise<PullRequestTarget> =>
		readPullRequestTarget({ repositoryUrl: fakeRepositoryUrl, pullRequest, request: fake.request })
	const hasCode = (code: string) => (error: unknown) => error instanceof InspectionError && error.code === code
	await assert.rejects(read(github(project, project), 8), hasCode("repository-unavailable"))
	await assert.rejects(read(github(project, project), 0), hasCode("invalid-pull-request"))

	// a private repository is rejected before any file is read
	const pullRequests = { 7: { author: "renovate[bot]", headCommit, baseCommit } }
	const privateFake = createFakeGithub({
		repositories: { "example/project": { files: project, isPrivate: true, pullRequests } },
	})
	await assert.rejects(read(privateFake), hasCode("repository-unavailable"))
	assert.deepEqual(privateFake.githubRequests, ["/repos/example/project/pulls/7"])
	const limited = createFakeGithub({
		repositories: { "example/project": { files: project, pullRequests } },
		remainingRequests: 0,
	})
	await assert.rejects(read(limited), hasCode("github-rate-limit"))
})
