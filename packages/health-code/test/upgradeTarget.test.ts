import assert from "node:assert/strict"
import { test } from "node:test"
import { InspectionError, inspectRepository, resolveUpgrade } from "../src/index.ts"
import { checkUpgradeTarget, toTargetRejection, toUpgradeKind } from "../src/upgrades/checkUpgradeTarget.ts"
import { createFakeGithub, type FakeGithub } from "../src/upgrades/createFakeGithub.ts"
import { fixtureCommit, fixtureUrl } from "./providerContract.ts"
import { fakeRepositoryUrl, fixtureNow, readFixtureProject, toFakeRepository } from "./readFixtureProject.ts"
import { command, provider, scripts } from "./replayProjectChecks.ts"

const record = {
	versions: {
		"1.2.0": {},
		"1.2.1": {},
		"1.2.2": { deprecated: "broken" },
		"1.3.0": {},
		"2.0.0": {},
		"2.1.0-beta.1": {},
		"2.1.0": {},
	},
	time: {
		"1.2.1": "2026-11-01T00:00:00Z",
		"1.3.0": "2026-11-20T00:00:00Z",
		"2.0.0": "2026-11-24T00:00:00Z",
		"2.1.0": "2026-11-26T07:00:00Z",
	},
}
const oneDay = { publishedBefore: fixtureNow - 86_400_000, excluded: [] }

test("a target is eligible when it is published, stable, newer and old enough", () => {
	const check = (to: string, lockedVersions = ["1.2.0"]): string =>
		checkUpgradeTarget({ record, lockedVersions, to, releaseAge: oneDay, now: fixtureNow }).status
	assert.equal(check("1.2.1"), "eligible")
	assert.equal(check("1.3.0"), "eligible")
	assert.equal(check("2.0.0"), "eligible")

	// each rejected version names the first condition it fails
	assert.equal(check("9.9.9"), "unpublished")
	assert.equal(check("not-a-version"), "unpublished")
	assert.equal(check("1.2.2"), "deprecated")
	assert.equal(check("2.1.0-beta.1"), "prerelease")
	assert.equal(check("1.2.0"), "not-newer")
	assert.equal(check("1.2.1", ["1.2.0", "1.3.0"]), "not-newer")
	assert.equal(check("2.1.0"), "too-new")
})

test("a rejected target includes the eligible dependency versions and a too-new one says when it is eligible", () => {
	const check = checkUpgradeTarget({
		record,
		lockedVersions: ["1.2.0"],
		to: "2.1.0",
		releaseAge: oneDay,
		now: fixtureNow,
	})
	assert.deepEqual(check.eligibleDependencyVersions, ["2.0.0", "1.3.0", "1.2.1"])
	assert.equal(check.publishedAt, "2026-11-26T07:00:00.000Z")
	assert.equal(check.eligibleAt, "2026-11-27T07:00:00.000Z")
	assert.equal(
		toTargetRejection({ dependency: "widget", to: "2.1.0", check }),
		"widget 2.1.0 is newer than this repository's minimum release age of 1 day allows. It was published at 2026-11-26 07:00 UTC. It becomes eligible at 2026-11-27 07:00 UTC.",
	)

	// with no age every dated release is eligible
	assert.equal(
		checkUpgradeTarget({ record, lockedVersions: ["1.2.0"], to: "2.1.0", now: fixtureNow }).status,
		"eligible",
	)
})

test("a patch release keeps the major and minor of the highest locked version", () => {
	assert.equal(toUpgradeKind(["1.2.0"], "1.2.1"), "patch")
	assert.equal(toUpgradeKind(["1.2.0", "1.1.0"], "1.3.0"), "minor")
	assert.equal(toUpgradeKind(["1.2.0"], "2.0.0"), "major")
})

function github(): FakeGithub {
	return createFakeGithub({
		repositories: { "example/project": toFakeRepository("pnpm") },
		registry: () => Response.json({ ...record, modified: "2026-11-26T07:00:00Z" }),
	})
}

test("a named patch release resolves without a sandbox and one or two registry requests", async () => {
	const fake = github()
	const resolved = await resolveUpgrade({
		repositoryUrl: fakeRepositoryUrl,
		dependency: "widget",
		to: "1.2.1",
		request: fake.request,
	})
	assert.deepEqual(resolved.upgrade, {
		dependency: "widget",
		from: { ".": "1.2.0", "packages/child": "1.1.0" },
		to: "1.2.1",
		kind: "patch",
	})
	assert.ok(fake.registryRequests.length <= 2)
	assert.deepEqual(fake.unexpectedRequests, [])
})

test("a rejected named version is a typed error with its reason and the eligible dependency versions", async () => {
	const cases: [string, string, RegExp][] = [
		["widget", "9.9.9", /widget 9\.9\.9 is not published on the npm registry\./],
		["widget", "1.2.2", /widget 1\.2\.2 is deprecated\./],
		["widget", "2.1.0-beta.1", /is a prerelease and only stable releases can be tested\./],
		["widget", "1.2.0", /is not newer than the highest version this repository locks\./],
		["left-pad", "2.0.0", /left-pad is not a direct dependency of this repository at c{40}\./],
	]
	for (const [dependency, to, message] of cases) {
		const fake = github()
		const error = await resolveUpgrade({
			repositoryUrl: fakeRepositoryUrl,
			dependency,
			to,
			request: fake.request,
		}).then(
			() => assert.fail("expected a rejection"),
			(reason: unknown) => reason,
		)

		// the rejection names the eligible dependency versions
		assert.ok(error instanceof InspectionError)
		assert.equal(error.code, "invalid-upgrade")
		assert.match(error.message, message)
		if (dependency === "widget") {
			assert.deepEqual(error.eligibleDependencyVersions, ["2.1.0", "2.0.0", "1.3.0", "1.2.1"])
		}
	}
})

test("a named version in a repository the upgrade menu cannot read returns the reason instead of an upgrade", async () => {
	const files = new Map([...readFixtureProject("npm").files, ["package-lock.json", "x"]])
	const fake = createFakeGithub({ repositories: { "example/project": { files, links: ["package-lock.json"] } } })
	const resolved = await resolveUpgrade({
		repositoryUrl: fakeRepositoryUrl,
		dependency: "widget",
		to: "1.3.0",
		request: fake.request,
	})
	assert.equal(resolved.unreadable?.reason, "symbolic-link")
	assert.equal(resolved.upgrade, undefined)
})

test("a named version inside the minimum release age says when it was published and becomes eligible", async () => {
	// date the newest release one hour ago and the others a month ago
	const publishedAt = Date.now() - 3_600_000
	const monthAgo = new Date(publishedAt - 30 * 86_400_000).toISOString()
	const time = { "1.2.1": monthAgo, "1.3.0": monthAgo, "2.0.0": monthAgo, "2.1.0": new Date(publishedAt).toISOString() }
	const registry = (): Response => Response.json({ ...record, time, modified: new Date().toISOString() })

	// commit a one-day minimum release age to the recorded project
	const { files } = readFixtureProject("pnpm")
	files.set("pnpm-workspace.yaml", `${files.get("pnpm-workspace.yaml")}\nminimumReleaseAge: 1440\n`)
	const fake = createFakeGithub({ repositories: { "example/project": { files } }, registry })
	const error = await resolveUpgrade({
		repositoryUrl: fakeRepositoryUrl,
		dependency: "widget",
		to: "2.1.0",
		request: fake.request,
	}).then(
		() => assert.fail("expected a rejection"),
		(reason: unknown) => reason,
	)

	// the rejection names the setting, both times and the versions that are old enough
	const toMinute = (timestamp: number): string => new Date(timestamp).toISOString().slice(0, 16).replace("T", " ")
	assert.ok(error instanceof InspectionError, String(error))
	assert.equal(error.code, "invalid-upgrade")
	assert.equal(
		error.message,
		`widget 2.1.0 is newer than this repository's minimum release age of 1 day allows. It was published at ${toMinute(publishedAt)} UTC. It becomes eligible at ${toMinute(publishedAt + 86_400_000)} UTC.`,
	)
	assert.deepEqual(error.eligibleDependencyVersions, ["2.0.0", "1.3.0", "1.2.1"])
	assert.ok(fake.registryRequests.length <= 2)
})

test("a named dependency the registry does not serve is rejected without a registry request", async () => {
	const { files } = readFixtureProject("pnpm")
	const manifest = JSON.parse(files.get("package.json") ?? "{}")
	manifest.dependencies["local-tool"] = "file:./tool"
	files.set("package.json", JSON.stringify(manifest))
	const fake = createFakeGithub({ repositories: { "example/project": { files } } })
	const error = await resolveUpgrade({
		repositoryUrl: fakeRepositoryUrl,
		dependency: "local-tool",
		to: "2.0.0",
		request: fake.request,
	}).then(
		() => assert.fail("expected a rejection"),
		(reason: unknown) => reason,
	)

	// the message says why the version cannot be checked
	assert.ok(error instanceof InspectionError && error.code === "invalid-upgrade", String(error))
	assert.equal(
		error.message,
		"local-tool resolves from a source the npm registry does not serve in at least one workspace.",
	)
	assert.deepEqual(fake.registryRequests, [])
})

// replay a selection of one version through the sandbox with a recorded registry answer
function inspectTarget({
	to,
	targetAnswer,
	from,
}: {
	to: string
	targetAnswer?: object
	from?: string | Record<string, string>
}): ReturnType<typeof inspectRepository> {
	const [detect, , ...checks] = scripts([], [], [])
	const lockedVersions = ["1.2.0", "1.1.0"]
	const commands = [
		...(detect ? [detect] : []),
		...(targetAnswer ? [command(["target", "widget", to, ...lockedVersions], JSON.stringify(targetAnswer))] : []),
		...checks,
	]
	return inspectRepository({
		repositoryUrl: fixtureUrl,
		revision: fixtureCommit,
		upgrade: { dependency: "widget", to, ...(from !== undefined && { from }) },
		sandboxProvider: provider(commands),
	})
}

test("the sandbox tests a named version without source versions and records its kind", async () => {
	const report = await inspectTarget({ to: "1.3.0", targetAnswer: { status: "eligible" } })
	assert.deepEqual(report.selection.selected, [
		{ dependency: "widget", from: { ".": "1.2.0", "packages/child": "1.1.0" }, to: "1.3.0", kind: "minor" },
	])
	assert.equal(report.upgrades[0]?.install.status, "passed")
})

test("a selection whose locked versions moved says to refresh the upgrade menu", async () => {
	const report = await inspectTarget({ to: "1.3.0", from: "1.0.0" })
	assert.match(
		report.stoppedReason ?? "",
		/^The checkout locks widget at a different version than the selected target\. Refresh the upgrade menu and select again\./,
	)
	assert.ok(report.timeline.every((event) => event.type !== "step.started" || event.label !== "install"))
})

test("a version the package manager rejects as too new ends as untested before anything installs", async () => {
	const targetAnswer = {
		status: "too-new",
		eligibleDependencyVersions: ["1.3.0"],
		minimumAgeMinutes: 4320,
		publishedAt: "2026-11-24T12:00:00.000Z",
		eligibleAt: "2026-11-27T12:00:00.000Z",
	}
	const report = await inspectTarget({ to: "2.0.0", targetAnswer })
	const [upgrade] = report.upgrades

	// the detail names the setting, the publish time and when the version becomes eligible
	assert.equal(upgrade?.result.status, "untested")
	assert.equal(upgrade?.result.status === "untested" && upgrade.result.reason, "minimum-release-age")
	assert.equal(
		upgrade?.result.status === "untested" && upgrade.result.detail,
		"widget 2.0.0 is newer than this repository's minimum release age of 3 days allows. It was published at 2026-11-24 12:00 UTC. It becomes eligible at 2026-11-27 12:00 UTC.",
	)
	assert.equal(report.baseline.install.status, "untested")
	assert.ok(report.timeline.every((event) => event.type !== "step.started" || event.label !== "install"))
})

test("the sandbox rejects a version the registry does not accept before the baseline", async () => {
	for (const status of ["unpublished", "deprecated"]) {
		const error = await inspectTarget({
			to: "1.3.0",
			targetAnswer: { status, eligibleDependencyVersions: ["1.2.1"] },
		}).then(
			() => assert.fail("expected a rejection"),
			(reason: unknown) => reason,
		)
		assert.ok(error instanceof InspectionError, String(error))
		assert.equal(error.code, "invalid-upgrade")
		assert.deepEqual(error.eligibleDependencyVersions, ["1.2.1"])
	}

	// a prerelease and an older version never reach the registry
	for (const to of ["2.0.0-beta.1", "1.0.0"]) {
		const error = await inspectTarget({ to }).then(
			() => assert.fail("expected a rejection"),
			(reason: unknown) => reason,
		)
		assert.ok(error instanceof InspectionError && error.code === "invalid-upgrade", String(error))
	}
})

test("a target check the sandbox cannot answer leaves the decision to the install", async () => {
	const [detect, , ...checks] = scripts([], [], [])
	const target = ["target", "widget", "1.3.0", "1.2.0", "1.1.0"]

	// fail the guest command, then answer with text and with a status the rule does not know
	const answers = [command(target, "", 1), command(target, "not json"), command(target, '{"status":"moved"}')]
	for (const answer of answers) {
		const report = await inspectRepository({
			repositoryUrl: fixtureUrl,
			revision: fixtureCommit,
			upgrade: { dependency: "widget", to: "1.3.0" },
			sandboxProvider: provider([...(detect ? [detect] : []), answer, ...checks]),
		})

		// the version stays selected and the baseline and its install both run
		assert.equal(report.selection.selected[0]?.to, "1.3.0")
		assert.equal(report.baseline.install.status, "passed")
		assert.equal(report.upgrades[0]?.install.status, "passed")
		assert.equal(report.stoppedReason, undefined)
	}
})
