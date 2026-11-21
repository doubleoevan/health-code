import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import {
	createFakeSandboxProvider,
	createSandboxProvider,
	type FixtureCommand,
	InspectionError,
	type InspectionEvent,
	inspectRepository,
	type Observation,
	type SandboxProvider,
	SandboxUnavailableError,
} from "../src/index.ts"
import {
	controlCommand,
	fixtureCommit,
	fixtureUrl,
	outsideCommand,
	providerContract,
	registryCommand,
} from "./providerContract.ts"

const base = ["node", "/opt/health-code/project.mjs"]
const clean: Observation = { complete: true, findings: [] }
function command(args: string[], stdout = "", exitCode = 0): FixtureCommand {
	return { argv: [...base, ...args], result: { stdout, exitCode } }
}
function report(names: string[]): FixtureCommand {
	return command(
		["report"],
		JSON.stringify({
			complete: true,
			granularity: "case",
			failures: names.map((name) => ({ file: "unit.test.js", workspace: ".", name })),
		}),
	)
}
function scripts(baseline: string[], upgraded: string[], repeated: string[]): FixtureCommand[] {
	const transcript = JSON.parse(
		readFileSync(new URL("./fixtures/recorded/pnpm/transcript.json", import.meta.url), "utf8"),
	)

	// replay baseline and upgrade checks in execution order
	const steps = [
		command(["detect"], JSON.stringify(transcript.project)),
		command(["registry", "widget"], JSON.stringify(transcript.registry)),
		command(["install"]),
		command(["typecheck", "build"]),
		command(["tests"], "", Number(!!baseline.length)),
		report(baseline),
		command(["install", "widget", "1.3.0"]),
		command(["typecheck", "build"]),
		command(["tests"], "", Number(!!upgraded.length)),
		report(upgraded),
	]

	// append a confirmation run only for newly failing cases
	if (upgraded.some((name) => !baseline.includes(name))) {
		steps.push(
			command(["install", "widget", "1.3.0"]),
			command(["typecheck", "build"]),
			command(["tests"], "", Number(!!repeated.length)),
			report(repeated),
		)
	}
	return steps
}
function provider(commands: FixtureCommand[]): SandboxProvider {
	return createFakeSandboxProvider({ commit: fixtureCommit, commands })
}
test("shares one provider contract with the credentialed suite", async () => {
	// exercise the shared provider contract with recorded observations
	await providerContract(
		provider([
			{
				argv: controlCommand,
				result: { stdout: "stdout", stderr: "stderr" },
				connections: clean,
				files: { complete: true, findings: [{ kind: "write", path: "/tmp/health-code-evidence" }] },
			},
			{ argv: registryCommand, result: {} },
			{
				argv: outsideCommand,
				result: { exitCode: 6 },
				connections: {
					complete: true,
					findings: [{ kind: "connection", destination: "example.com", source: "dns", outcome: "unknown" }],
				},
			},
			{ argv: ["sleep", "5"], result: { exitCode: 124, timedOut: true } },
		]),
	)
})
test("records existing, flaky and confirmed tests with exact callback replay", async () => {
	// collect callback events as the fixture repeats the failing tests
	const timeline: InspectionEvent[] = []
	const inspectionReport = await inspectRepository({
		repositoryUrl: fixtureUrl,
		sandboxProvider: provider(scripts(["existing"], ["existing", "flaky", "regression"], ["existing", "regression"])),
		limits: { maxUpgrades: 1 },
		onEvent: (e) => {
			timeline.push(e)
		},
	})

	// compare the saved timeline and selection with the delivered evidence
	assert.deepEqual(JSON.parse(JSON.stringify(inspectionReport.timeline)), timeline)
	assert.deepEqual(
		inspectionReport.selection.omitted.map((u) => u.to),
		["2.0.0"],
	)

	// attribute only the reproducible new failure to the upgrade
	const outcome = inspectionReport.upgrades[0]?.result
	assert.equal(outcome?.status, "failed")
	assert.deepEqual(
		outcome.failingTests.map((t) => t.name),
		["regression"],
	)
	assert.equal(inspectionReport.timeline.at(-1)?.type, "inspection.finished")
})
test("a transient outside write stops the trial on a successful install", async () => {
	// inject a transient write into the successful install
	const entries = scripts([], [], []).slice(0, 7)
	const install = entries.at(-1)
	assert.ok(install)
	install.files = { complete: true, findings: [{ kind: "write", path: "/tmp/transient" }] }
	const inspectionReport = await inspectRepository({
		repositoryUrl: fixtureUrl,
		sandboxProvider: provider(entries),
		limits: { maxUpgrades: 1 },
	})

	// verify that the finding survives the skipped check
	assert.equal(inspectionReport.upgrades[0]?.result.status, "untested")
	assert.equal(inspectionReport.upgrades[0]?.observation.findings.length, 1)
})
test("incomplete observation cannot pass; only confirmed denials become sandbox events", async () => {
	// mark the network trace incomplete and vary the connection outcomes
	const entries = scripts([], [], []).slice(0, 7)
	const install = entries.at(-1)
	assert.ok(install)
	install.connections = {
		complete: false,
		findings: [
			{ kind: "connection", destination: "example.invalid", outcome: "blocked" },
			{ kind: "connection", destination: "192.0.2.1", outcome: "unknown" },
		],
	}
	const inspectionReport = await inspectRepository({
		repositoryUrl: fixtureUrl,
		sandboxProvider: provider(entries),
		limits: { maxUpgrades: 1 },
	})

	// check that only the confirmed denial produces a sandbox event
	assert.equal(inspectionReport.upgrades[0]?.result.status, "untested")
	assert.equal(
		inspectionReport.timeline.filter((e) => e.type === "sandbox.event" && e.action === "connection-blocked").length,
		1,
	)
})
test("broken Baseline prevents all trials", async () => {
	// fail the baseline install before either upgrade trial
	const entries = scripts([], [], []).slice(0, 3)
	entries[2] = command(["install"], "broken", 1)
	const inspectionReport = await inspectRepository({ repositoryUrl: fixtureUrl, sandboxProvider: provider(entries) })
	assert.equal(inspectionReport.upgrades.length, 2)
	assert.ok(inspectionReport.upgrades.every((u) => u.result.status === "untested"))
})
test("expired token and invalid sources fail before allocation", async () => {
	// simulate expired credentials in the provider availability check
	const sandboxProvider = createSandboxProvider({
		token: "fixture",
		fetch: async () => new Response(null, { status: 401 }),
	})

	// distinguish credential failure from repository url validation
	await assert.rejects(inspectRepository({ repositoryUrl: fixtureUrl, sandboxProvider }), SandboxUnavailableError)
	await assert.rejects(inspectRepository({ repositoryUrl: "https://github.com:443/ai/nanoid", sandboxProvider }), {
		code: "invalid-repository",
	})
})
test("preserves terminal evidence on callback failure and reconciles an ambiguous allocation", async () => {
	// observe teardown when the event consumer throws
	const sandboxProvider = provider([])
	let deleted = false
	sandboxProvider.destroySandbox = async () => {
		deleted = true
	}

	// check that the thrown inspection error retains terminal evidence
	await assert.rejects(
		inspectRepository({
			repositoryUrl: fixtureUrl,
			sandboxProvider,
			onEvent: (e) => {
				if (e.type === "sandbox.event") {
					throw Error("consumer")
				}
			},
		}),
		(error: unknown) => error instanceof InspectionError && error.timeline.at(-1)?.type === "inspection.failed",
	)
	assert.ok(deleted)

	// simulate a lost allocation and verify teardown again
	deleted = false
	sandboxProvider.createSandbox = async () => {
		throw new SandboxUnavailableError("unavailable")
	}
	await assert.rejects(inspectRepository({ repositoryUrl: fixtureUrl, sandboxProvider }), SandboxUnavailableError)
	assert.ok(deleted)
})

test("a confirmation deadline preserves the first result and the clean install evidence", async () => {
	// replay a new failure that needs a confirmation install
	const sandboxProvider = provider(scripts([], ["new failure"], []))
	const reset = sandboxProvider.resetProject
	let resets = 0

	// interrupt the reset that starts confirmation
	sandboxProvider.resetProject = async (...args) => {
		if (++resets === 3) {
			throw new InspectionError("deadline", "Confirmation interrupted")
		}
		await reset(...args)
	}

	// check that the original install and unconfirmed failure survive the deadline
	const inspectionReport = await inspectRepository({
		repositoryUrl: fixtureUrl,
		sandboxProvider,
		limits: { maxUpgrades: 1 },
	})
	const check = inspectionReport.upgrades[0]
	assert.equal(check?.install.status, "passed")
	assert.equal(check?.tests.status, "untested")
	assert.equal(check.tests.reason, "inspection-deadline")
	assert.equal(check.tests.unconfirmedTests?.[0]?.name, "new failure")
	assert.equal(check.tests.evidence.length, 1)
})

test("a dirty confirmation install stops the check and redacts the finding in the saved report", async () => {
	// add a sensitive path to the confirmation install findings
	const entries = scripts([], [], []).slice(0, 8)
	entries[7] = command(["typecheck", "build"], "error TS999", 1)
	const retry = command(["install", "widget", "1.3.0"], "confirmation install")
	retry.files = { complete: true, findings: [{ kind: "write", path: "/tmp/sk-sensitivefixture" }] }
	entries.push(retry)
	const inspectionReport = await inspectRepository({
		repositoryUrl: fixtureUrl,
		sandboxProvider: provider(entries),
		limits: { maxUpgrades: 1 },
	})

	// verify that the saved evidence includes only the redacted path
	const check = inspectionReport.upgrades[0]
	assert.equal(check?.tests.status, "untested")
	assert.equal(check.tests.reason, "installation-finding")
	assert.deepEqual(check.observation.findings, [{ kind: "write", path: "/tmp/[redacted]" }])
	assert.equal(check.install.evidence.length, 2)
	assert.doesNotMatch(JSON.stringify(inspectionReport), /sensitivefixture/)
})

test("malformed registry data leaves the baseline runnable", async () => {
	const entries = scripts([], [], []).slice(0, 6)
	entries[1] = command(["registry", "widget"], '{"widget":null}')

	// check that malformed registry data permits the baseline and skips selection
	const inspectionReport = await inspectRepository({ repositoryUrl: fixtureUrl, sandboxProvider: provider(entries) })
	assert.equal(inspectionReport.baseline.install.status, "passed")
	assert.equal(inspectionReport.upgrades.length, 0)
	assert.match(inspectionReport.selection.skipped.join(" "), /registry/)
	assert.ok(
		inspectionReport.timeline.some(
			(event) => event.type === "step.finished" && event.summary === "registry" && event.status === "failed",
		),
	)
	assert.equal(
		inspectionReport.selection.registryLookupIssue,
		"Couldn’t list available upgrades: registry lookup failed.",
	)
})
test("exit 124 retains identified test failures when the provider reports no timeout", async () => {
	// replay a failed baseline test with a known case and exit code
	const entries = scripts(["known"], [], []).slice(0, 6)
	entries[4] = command(["tests"], "", 124)
	entries.splice(1, 1)
	const inspectionReport = await inspectRepository({
		repositoryUrl: fixtureUrl,
		sandboxProvider: provider(entries),
		limits: { maxUpgrades: 0 },
	})

	// verify the provider still attributes the failure to the named case
	assert.equal(inspectionReport.baseline.tests.status, "failed")
	assert.equal(inspectionReport.baseline.tests.failingTests[0]?.name, "known")
})
test("a failed confirmation install prevents tests on the incomplete checkout", async () => {
	// fail the confirmation install after the initial typecheck failure
	const entries = scripts([], [], []).slice(0, 8)
	entries[7] = command(["typecheck", "build"], "type error", 1)
	entries.push(command(["install", "widget", "1.3.0"], "install error", 1))
	const inspectionReport = await inspectRepository({
		repositoryUrl: fixtureUrl,
		sandboxProvider: provider(entries),
		limits: { maxUpgrades: 1 },
	})

	// check that the incomplete install prevents a test verdict
	const result = inspectionReport.upgrades[0]?.tests
	assert.equal(result?.status, "untested")
	assert.equal(result.reason, "confirmation-install-unavailable")
})

test("a branch move cannot replace the requested checkout", async () => {
	// Move the advertised branch while keeping the selected revision accessible.
	const sandboxProvider = provider(scripts([], [], []))
	const prepare = sandboxProvider.prepareRepository
	sandboxProvider.prepareRepository = async (sandbox, url, options) => {
		assert.equal(options.revision, fixtureCommit)
		return prepare(sandbox, url, options)
	}
	const inspectionReport = await inspectRepository({
		repositoryUrl: fixtureUrl,
		revision: fixtureCommit,
		sandboxProvider,
		limits: { maxUpgrades: 1 },
	})
	assert.equal(inspectionReport.repository.commit, fixtureCommit)
})

test("rejects malformed revisions before allocation and reclaims failed checkouts", async () => {
	const sandboxProvider = provider([])
	const options = { repositoryUrl: fixtureUrl, revision: fixtureCommit, sandboxProvider }
	const actions: string[] = []

	// Record provisioning boundaries for each failed attempt.
	const onEvent = (event: InspectionEvent): void => {
		if (event.type === "sandbox.event") {
			actions.push(event.action)
		}
	}
	await assert.rejects(inspectRepository({ ...options, revision: "main", onEvent }), /full commit SHA/)
	assert.equal(actions.length, 0)

	// Verify cleanup whether GitHub rejects the pin or a provider returns another commit.
	for (const result of ["mismatch", "inaccessible"]) {
		sandboxProvider.prepareRepository = async () => {
			if (result === "inaccessible") {
				throw new Error("Commit inaccessible")
			}
			return "f".repeat(40)
		}

		// Require teardown before any project command can run.
		await assert.rejects(inspectRepository({ ...options, onEvent }))
		assert.equal(actions.at(-1), "deleted")
		assert.ok(!actions.includes("network-locked"))
	}
})

test("registry lookup has its own timeout and preserves that failure in the report", async () => {
	const entries = scripts([], [], []).slice(0, 6)
	entries[1] = { argv: [...base, "registry", "widget"], result: { exitCode: 124, timedOut: true } }
	const sandboxProvider = provider(entries)
	const execute = sandboxProvider.executeCommand.bind(sandboxProvider)
	let registryBudget = 0

	sandboxProvider.executeCommand = async (sandbox, command) => {
		if (command.argv[2] === "registry") {
			registryBudget = command.timeoutMs
		}
		return execute(sandbox, command)
	}

	// A short detection budget must leave the full registry window available.
	const inspectionReport = await inspectRepository({
		repositoryUrl: fixtureUrl,
		sandboxProvider,
		limits: { timeouts: { detect: 100, registry: 60000 } },
	})
	assert.equal(registryBudget, 60000)
	assert.equal(
		inspectionReport.selection.registryLookupIssue,
		"Couldn’t list available upgrades: registry lookup timed out after 60s.",
	)
	assert.equal(inspectionReport.baseline.install.status, "passed")
})

test("partial registry failures preserve upgrades from successful lookups", async () => {
	const entries = scripts([], [], [])
	const detect = entries[0]
	assert.ok(detect?.result.stdout)
	const project = JSON.parse(detect.result.stdout)
	project.sources.unavailable = { ".": "1.0.0" }
	entries[0] = command(["detect"], JSON.stringify(project))

	// Replay one successful response alongside a package whose request timed out.
	entries[1] = command(
		["registry", "widget", "unavailable"],
		JSON.stringify({
			widget: ["1.3.0"],
			unavailable: "timed-out",
		}),
	)
	const inspectionReport = await inspectRepository({
		repositoryUrl: fixtureUrl,
		sandboxProvider: provider(entries),
		limits: { maxUpgrades: 1 },
	})
	assert.equal(
		inspectionReport.selection.registryLookupIssue,
		"Couldn’t list available upgrades for 1 of 2 dependencies: registry requests timed out.",
	)
	assert.ok(
		inspectionReport.timeline.some(
			(event) => event.type === "step.finished" && event.summary === "registry" && event.status === "untested",
		),
	)
	assert.equal(inspectionReport.upgrades[0]?.dependency, "widget")
})
