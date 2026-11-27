import assert from "node:assert/strict"
import { test } from "node:test"
import {
	type InspectionEvent,
	listUpgrades,
	readUpgradeMenuFeatures,
	type SandboxProvider,
	toUpgradeMenuReport,
} from "../src/index.ts"
import { createFakeGithub, type FakeRepository, fakeCommit } from "../src/upgrades/createFakeGithub.ts"
import { readLockedDependencies } from "../src/upgrades/readLockedDependencies.ts"
import { fakeRepositoryUrl, readFixtureProject, textFixtureNames, toFakeRepository } from "./readFixtureProject.ts"

// one newer minor and one newer major release for every package
const versions = { "0.0.1": {}, "1.99.0": {}, "99.0.0": {} }

for (const name of textFixtureNames) {
	test(`the upgrade menu and the locked dependencies agree on the recorded ${name} project`, async () => {
		const github = createFakeGithub({ repositories: { "example/project": toFakeRepository(name) }, versions })
		const upgradeMenu = await listUpgrades({ repositoryUrl: fakeRepositoryUrl, request: github.request })
		const lockedDependencies = readLockedDependencies(readFixtureProject(name))

		// every locked dependency is either offered from its locked versions or skipped
		assert.deepEqual(upgradeMenu.repository, { url: fakeRepositoryUrl, commit: fakeCommit })
		assert.equal("name" in upgradeMenu.packageManager && upgradeMenu.packageManager.name, lockedDependencies.manager)
		for (const choice of upgradeMenu.dependencies) {
			assert.deepEqual({ ...choice.targets[0]?.from }, { ...lockedDependencies.sources[choice.dependency] })
		}
		assert.deepEqual(
			upgradeMenu.dependencies.map((choice) => choice.dependency).sort(),
			Object.keys(lockedDependencies.sources).sort(),
		)
		assert.deepEqual(upgradeMenu.skipped, lockedDependencies.skipped)
	})
}

test("the upgrade menu needs no sandbox credential and never touches a provider", async () => {
	const token = process.env.RUNTA_TOKEN
	delete process.env.RUNTA_TOKEN
	try {
		// fail the test if any provider operation runs
		const sandboxProvider = new Proxy({} as SandboxProvider, {
			get: (_target, operation) => (): never => assert.fail(`provider.${String(operation)} was called`),
		})

		// build the upgrade menu with that provider supplied
		const github = createFakeGithub({ repositories: { "example/project": toFakeRepository("npm") }, versions })
		const upgradeMenu = await listUpgrades({
			repositoryUrl: fakeRepositoryUrl,
			sandboxProvider,
			request: github.request,
		})
		assert.ok(upgradeMenu.dependencies.length)
		assert.ok(!("releaseFeatures" in (upgradeMenu.dependencies[0]?.targets[0] ?? {})))
	} finally {
		// restore the credential for the tests that follow
		if (token !== undefined) {
			process.env.RUNTA_TOKEN = token
		}
	}
})

test("an upgrade menu delivers its Inspection Events and no Sandbox Event", async () => {
	const events: InspectionEvent[] = []
	const github = createFakeGithub({ repositories: { "example/project": toFakeRepository("pnpm") }, versions })
	await listUpgrades({
		repositoryUrl: fakeRepositoryUrl,
		request: github.request,
		onEvent: (event) => void events.push(event),
	})

	// the steps are the commit lookup, detect and registry
	const labels = events.flatMap((event) => (event.type === "step.started" ? [event.label] : []))
	assert.deepEqual(labels, ["Resolve commit", "detect", "registry"])
	assert.deepEqual(
		events.map((event) => event.sequence),
		events.map((_, index) => index + 1),
	)
	assert.equal(events[0]?.type, "inspection.started")
	assert.equal(events.at(-1)?.type, "inspection.finished")
	assert.ok(events.every((event) => event.type !== "sandbox.event" && event.version === 1))
})

test("an upgrade menu is shaped as the Inspection Report of a sandbox listing", async () => {
	const events: InspectionEvent[] = []
	const github = createFakeGithub({ repositories: { "example/project": toFakeRepository("npm") }, versions })
	const onEvent = (event: InspectionEvent): void => void events.push(event)
	const upgradeMenu = await listUpgrades({ repositoryUrl: fakeRepositoryUrl, request: github.request, onEvent })
	const report = toUpgradeMenuReport(upgradeMenu, events)

	// the report holds the listed targets, a baseline that did not run and the events
	const notRun = { status: "untested", reason: "not-run", evidence: [] }
	const eligible = upgradeMenu.dependencies.flatMap((choice) => choice.targets)
	const selection = { mode: "listUpgrades", eligible, selected: [], omitted: [], skipped: upgradeMenu.skipped }
	assert.deepEqual(report, {
		version: 1,
		inspectionId: events[0]?.inspectionId,
		repository: upgradeMenu.repository,
		packageManager: upgradeMenu.packageManager,
		baseline: { install: notRun, typecheck: notRun, tests: notRun },
		selection,
		upgrades: [],
		timeline: events,
	})
})

test("a supplied revision is read without a commit lookup", async () => {
	const events: InspectionEvent[] = []
	const github = createFakeGithub({ repositories: { "example/project": toFakeRepository("npm") }, versions })
	const upgradeMenu = await listUpgrades({
		repositoryUrl: fakeRepositoryUrl,
		revision: fakeCommit,
		request: github.request,
		onEvent: (event) => void events.push(event),
	})
	assert.equal(upgradeMenu.repository.commit, fakeCommit)
	assert.ok(!github.githubRequests.includes("/repos/example/project/commits/HEAD"))
	assert.ok(events.every((event) => event.type !== "step.started" || event.label !== "Resolve commit"))
})

// build an npm project that spreads its direct dependencies over the root and its workspaces
function generatedRepository({
	dependencyCount,
	workspaceCount,
}: {
	dependencyCount: number
	workspaceCount: number
}): FakeRepository {
	const files = new Map<string, string>()
	const locked: Record<string, { version: string }> = {}
	const declared = Array.from({ length: workspaceCount + 1 }, (): Record<string, string> => ({}))

	// lock every dependency and declare it in the root or one workspace
	for (let index = 0; index < dependencyCount; index++) {
		const name = `dependency-${index}`
		locked[`node_modules/${name}`] = { version: "1.0.0" }
		Object.assign(declared[index % declared.length] ?? {}, { [name]: "^1.0.0" })
	}

	// write the root manifest, one manifest per workspace and the lockfile
	files.set("package.json", JSON.stringify({ workspaces: ["packages/*"], dependencies: declared[0] }))
	for (let index = 1; index <= workspaceCount; index++) {
		files.set(`packages/workspace-${index}/package.json`, JSON.stringify({ dependencies: declared[index] }))
	}
	files.set("package-lock.json", JSON.stringify({ lockfileVersion: 3, packages: locked }))
	return { files }
}

test("a 200-dependency upgrade menu across 15 workspaces stays inside its request and time bounds", async () => {
	const github = createFakeGithub({
		repositories: { "example/project": generatedRepository({ dependencyCount: 200, workspaceCount: 15 }) },
		versions,
	})
	const started = performance.now()
	const upgradeMenu = await listUpgrades({ repositoryUrl: fakeRepositoryUrl, request: github.request })

	// one commit, one tree, sixteen manifests and one lockfile, then one lookup per dependency
	assert.equal(upgradeMenu.dependencies.length, 200)
	assert.equal(upgradeMenu.issue, undefined)
	assert.ok(github.githubRequests.length <= 22, `${github.githubRequests.length} GitHub requests`)
	assert.equal(github.githubRequests.length, 19)
	assert.equal(github.registryRequests.length, 200)
	assert.ok(performance.now() - started < 5000)
	assert.ok(github.authorizations.every((authorization) => authorization === null))
})

test("a partial registry lookup returns the targets found with its issue", async () => {
	const github = createFakeGithub({
		repositories: { "example/project": generatedRepository({ dependencyCount: 200, workspaceCount: 15 }) },
		versions,
		registry: (name) => (Number(name.split("-")[1]) < 180 ? undefined : new Response(null, { status: 503 })),
	})
	const upgradeMenu = await listUpgrades({ repositoryUrl: fakeRepositoryUrl, request: github.request })
	assert.equal(upgradeMenu.dependencies.length, 180)
	assert.equal(
		upgradeMenu.issue,
		"Couldn’t list available upgrades for 20 of 200 dependencies: package version information was unavailable.",
	)
})

test("an upgrade menu never lists a patch release as a target", async () => {
	const list = async (releases: Record<string, object>): Promise<string[]> => {
		const repositories = { "example/project": toFakeRepository("npm") }
		const github = createFakeGithub({ repositories, versions: releases })
		const upgradeMenu = await listUpgrades({ repositoryUrl: fakeRepositoryUrl, request: github.request })
		return upgradeMenu.dependencies.flatMap((choice) => choice.targets.map((target) => `${target.kind} ${target.to}`))
	}

	// a dependency locked at 1.2.0 with only patch releases has nothing to offer
	assert.deepEqual(await list({ "1.2.0": {}, "1.2.1": {}, "1.2.9": {} }), [])
	assert.deepEqual(await list({ "1.2.9": {}, "1.3.0": {}, "1.3.4": {}, "2.0.0": {}, "2.0.7": {} }), [
		"minor 1.3.4",
		"major 2.0.7",
	])
})

test("release features are read for the choices a caller shows, apart from the upgrade menu", async () => {
	const github = createFakeGithub({ repositories: { "example/project": toFakeRepository("npm") }, versions })
	const upgradeMenu = await listUpgrades({ repositoryUrl: fakeRepositoryUrl, request: github.request })
	const menuRequestCount = github.githubRequests.length + github.registryRequests.length

	// read the notes of the visible choices through the separate call
	const featured = await readUpgradeMenuFeatures(upgradeMenu.dependencies.slice(0, 4), {
		request: (async (url: Parameters<typeof fetch>[0]) =>
			Response.json(
				String(url).startsWith("https://registry.npmjs.org/")
					? { repository: "https://github.com/example/widget" }
					: [{ tag_name: "v1.99.0", body: "## Features\n- Faster imports", draft: false, prerelease: false }],
			)) as typeof fetch,
	})
	assert.equal(featured[0]?.targets[0]?.releaseFeatures.features[0]?.text, "Faster imports")
	assert.equal(github.githubRequests.length + github.registryRequests.length, menuRequestCount)
})
