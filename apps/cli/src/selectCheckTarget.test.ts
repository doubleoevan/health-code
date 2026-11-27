import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import {
	createFakeGithub,
	createFakeSandboxProvider,
	InspectionError,
	type InspectionEvent,
	listUpgrades,
} from "health-code"
import { checkRepository } from "./checkRepository.ts"
import { recordedProjectsUrl } from "./fixtures/inspectionSettings.ts"
import { modelRequestSandboxFixture } from "./fixtures/modelRequestSandboxInspection.ts"
import { createPublicProject } from "./fixtures/publicProject.ts"
import { environment, repositoryUrl, runCheck } from "./fixtures/runCheck.ts"
import { toEventLine } from "./toEventLine.ts"
import { toFailureMessage } from "./toFailureMessage.ts"

test("a named patch release is tested in one sandbox although the menu would list a newer version", async () => {
	const versions = { "1.2.0": {}, "1.2.1": {}, "1.3.0": {} }
	const result = await runCheck(["--dependency", "widget", "--to", "1.2.1"], {
		versions,
		selectedUpgrade: { to: "1.2.1" },
	})
	try {
		assert.equal(result.isComplete, true)
		assert.equal(result.sandboxCount, 1)
		assert.ok(result.files.includes("inspection-report.json") && !result.files.includes("upgrade-menu.json"))

		// check that the report records the named version as a patch upgrade
		const report = JSON.parse(await readFile(join(result.output, "inspection-report.json"), "utf8"))
		assert.equal(report.upgrades[0].to, "1.2.1")
		assert.equal(report.upgrades[0].kind, "patch")

		// check that the upgrade was tested and returned its patch
		assert.equal(report.upgrades[0].verdict, "Passes as is")
		assert.equal(report.upgrades[0].patches.length, 1)
	} finally {
		await rm(result.output, { recursive: true, force: true })
	}
})

test("a named version that is not eligible fails before any sandbox and names the eligible versions", async () => {
	const versions = { "1.2.0": {}, "1.2.1": {}, "1.2.2": { deprecated: "broken" }, "1.3.0": {}, "2.0.0-beta.1": {} }
	const cases: [string, RegExp][] = [
		[
			"9.9.9",
			/widget 9\.9\.9 is not published on the npm registry\. Eligible versions: 1\.3\.0 and 1\.2\.1\. \(invalid-upgrade\)/,
		],
		["1.2.2", /widget 1\.2\.2 is deprecated\. Eligible versions: 1\.3\.0 and 1\.2\.1\./],
		["2.0.0-beta.1", /is a prerelease and only stable releases can be tested\. Eligible versions:/],
		["1.2.0", /is not newer than the highest version this repository locks\. Eligible versions:/],
	]
	for (const [to, message] of cases) {
		const { provider, restore } = await modelRequestSandboxFixture({ makeProvider: createFakeSandboxProvider })
		provider.createSandbox = () => assert.fail("a sandbox was allocated")
		const output = await mkdtemp(join(tmpdir(), "health-code-check-"))
		try {
			// check that the command stops at the registry answer
			const failure = await checkRepository([repositoryUrl, "--output", output, "--dependency", "widget", "--to", to], {
				environment,
				signal: new AbortController().signal,
				sandboxProvider: provider,
				request: (await createPublicProject(versions)).request,
				log: () => undefined,
			}).then(
				() => assert.fail("expected a rejection"),
				(error: unknown) => error,
			)

			// check that the message names the eligible versions and nothing is written
			assert.match(toFailureMessage(failure), message)
			assert.deepEqual(await readdir(output), [])
		} finally {
			restore()
			await rm(output, { recursive: true, force: true })
		}
	}
})

test("a named version inside the minimum release age fails before any sandbox and says when it is eligible", async () => {
	// commit a one-day minimum release age beside the recorded npm project
	const read = (name: string): Promise<string> => readFile(new URL(`npm/${name}`, recordedProjectsUrl), "utf8")
	const files = new Map([
		["package.json", await read("package.json")],
		["package-lock.json", await read("package-lock.json")],
		[".npmrc", "min-release-age=1\n"],
	])

	// date the named version one hour ago and an older patch release a month ago
	const publishedAt = Date.now() - 3_600_000
	const time = {
		"1.2.1": new Date(publishedAt - 30 * 86_400_000).toISOString(),
		"1.3.0": new Date(publishedAt).toISOString(),
	}
	const versions = { "1.2.0": {}, "1.2.1": {}, "1.3.0": {} }
	const github = createFakeGithub({
		repositories: { "example/project": { files } },
		registry: () => Response.json({ versions, time, modified: new Date().toISOString() }),
	})

	// fail the test if the command asks for a sandbox
	const provider = createFakeSandboxProvider({ commit: "", commands: [] })
	provider.createSandbox = () => assert.fail("a sandbox was allocated")
	const output = await mkdtemp(join(tmpdir(), "health-code-check-"))
	try {
		const failure = await checkRepository(
			[repositoryUrl, "--output", output, "--dependency", "widget", "--to", "1.3.0"],
			{
				environment,
				signal: new AbortController().signal,
				sandboxProvider: provider,
				request: github.request,
				log: () => undefined,
			},
		).then(
			() => assert.fail("expected a rejection"),
			(error: unknown) => error,
		)

		// check that the message names the setting, both times and the version that is old enough
		const toMinute = (timestamp: number): string => new Date(timestamp).toISOString().slice(0, 16).replace("T", " ")
		assert.equal(
			toFailureMessage(failure),
			`widget 1.3.0 is newer than this repository's minimum release age of 1 day allows. It was published at ${toMinute(publishedAt)} UTC. It becomes eligible at ${toMinute(publishedAt + 86_400_000)} UTC. Eligible versions: 1.2.1. (invalid-upgrade)`,
		)
		assert.deepEqual(await readdir(output), [])
	} finally {
		await rm(output, { recursive: true, force: true })
	}
})

test("a check with nothing to upgrade allocates no sandbox and clears the earlier results", async () => {
	const result = await runCheck([], { versions: { "1.2.0": {} } })
	try {
		assert.equal(result.isComplete, true)
		assert.equal(result.sandboxCount, 0)

		// check that only the menu remains in the output folder
		assert.deepEqual(result.files, ["upgrade-menu.json"])
		assert.match(result.lines.at(-1) ?? "", /^No eligible upgrade at [0-9a-f]{40}\.$/)
	} finally {
		await rm(result.output, { recursive: true, force: true })
	}
})

test("a menu with an issue leaves eligibility unknown and the check incomplete", async () => {
	const { provider, restore } = await modelRequestSandboxFixture({ makeProvider: createFakeSandboxProvider })
	provider.createSandbox = () => assert.fail("a sandbox was allocated")
	const output = await mkdtemp(join(tmpdir(), "health-code-check-"))
	const lines: string[] = []
	try {
		const publicProject = await createPublicProject()
		const { isComplete } = await checkRepository([repositoryUrl, "--output", output], {
			environment,
			signal: new AbortController().signal,
			sandboxProvider: provider,
			request: ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
				String(input).startsWith("https://registry.npmjs.org/")
					? Promise.resolve(new Response(null, { status: 503 }))
					: publicProject.request(input, init)) as typeof fetch,
			log: (line) => lines.push(line),
		})

		// check that the command prints the issue and saves the menu
		assert.equal(isComplete, false)
		assert.match(lines.at(-1) ?? "", /^Couldn’t list available upgrades/)
		assert.deepEqual(await readdir(output), ["upgrade-menu.json"])
	} finally {
		restore()
		await rm(output, { recursive: true, force: true })
	}
})

test("a repository the menu cannot read is listed or checked in a sandbox", async () => {
	const listed = await runCheck([], { project: "bun-binary" })
	const named = await runCheck(["--dependency", "widget", "--to", "1.3.0"], {
		project: "bun-binary",
		selectedUpgrade: { to: "1.3.0" },
	})
	try {
		// check that both fall back with the reason in the log
		for (const result of [listed, named]) {
			assert.equal(result.isComplete, true)
			assert.equal(result.sandboxCount, 1)
			assert.ok(result.lines.some((line) => line.includes("binary bun.lockb")))
		}

		// check that each says which fallback it took
		assert.ok(listed.lines.includes("Listing upgrades in a sandbox instead."))
		assert.ok(named.lines.includes("Checking the version in a sandbox instead."))
	} finally {
		await rm(listed.output, { recursive: true, force: true })
		await rm(named.output, { recursive: true, force: true })
	}
})

test("menu events print as log lines with no sandbox line", async () => {
	const events: InspectionEvent[] = []
	const publicProject = await createPublicProject()
	await listUpgrades({ repositoryUrl, request: publicProject.request, onEvent: (event) => void events.push(event) })
	const lines = events.map(toEventLine)
	assert.ok(lines.includes("Starting · detect") && lines.includes("Starting · registry"))
	assert.ok(lines.every((line) => !line.startsWith("◆")))
})

test("failures from GitHub name the reset time, the token setting and what to check", () => {
	const limited = new InspectionError(
		"github-rate-limit",
		"GitHub's limit for requests without a token is used up until 14:32 UTC. Supply a GitHub token or try again then.",
	)
	assert.equal(
		toFailureMessage(limited),
		"GitHub's limit for requests without a token is used up until 14:32 UTC. Set GITHUB_TOKEN or GH_TOKEN, or try again then. (github-rate-limit)",
	)
	assert.match(
		toFailureMessage(new InspectionError("github-token-rejected", "x")),
		/GITHUB_TOKEN or GH_TOKEN\. .* read without a token\./,
	)
	assert.match(
		toFailureMessage(
			new InspectionError(
				"revision-unavailable",
				"GitHub could not find this commit in the repository. Check the full commit SHA and try again.",
			),
		),
		/Check the full commit SHA/,
	)
	assert.match(
		toFailureMessage(
			new InspectionError(
				"repository-unavailable",
				"GitHub could not find a public repository at this URL. Check the address and that the repository is public.",
			),
		),
		/Check the address/,
	)

	// check that eligible versions past the listing limit are counted instead of listed
	const rejected = new InspectionError("invalid-upgrade", "widget 9.9.9 is not published on the npm registry.")
	rejected.eligibleDependencyVersions = Array.from({ length: 14 }, (_, index) => `1.${14 - index}.0`)
	assert.match(toFailureMessage(rejected), /Eligible versions: 1\.14\.0, .*1\.5\.0 and 4 older\. \(invalid-upgrade\)$/)
})
