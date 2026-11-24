import assert from "node:assert/strict"
import { test } from "node:test"
import {
	createSandboxProvider,
	InspectionError,
	type InspectionEvent,
	inspectRepository,
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
import { clean, command, provider, report, scripts } from "./replayProjectChecks.ts"

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
test("the first measured project command records its placeholder count once", async () => {
	const entries = scripts([], [], [])
	for (const entry of entries) {
		entry.result.placeholderVariableCount = entry.argv[2] === "detect" ? 0 : 3
	}
	const report = await inspectRepository({
		repositoryUrl: fixtureUrl,
		sandboxProvider: provider(entries),
		limits: { maxUpgrades: 1 },
	})

	// Exclude the detection command, which runs before the project environment is known.
	const counts = report.timeline.flatMap((event) =>
		event.type === "sandbox.event" &&
		event.action === "credentials-withheld" &&
		event.placeholderVariableCount !== undefined
			? [event.placeholderVariableCount]
			: [],
	)
	assert.deepEqual(counts, [3])
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
test("incomplete installation coverage keeps measured upgraded checks and an untested verdict", async () => {
	const entries = scripts([], [], [])
	entries[6]!.files = { complete: false, reason: "A file path could not be resolved.", findings: [] }
	const inspection = await inspectRepository({
		repositoryUrl: fixtureUrl,
		sandboxProvider: provider(entries),
		limits: { maxUpgrades: 1 },
	})
	const upgrade = inspection.upgrades[0]!

	// Preserve the independent checks without certifying the install.
	assert.equal(upgrade.coverage, "partial")
	assert.equal(
		upgrade.observation.reason,
		"Could not verify all filesystem changes. A file path could not be resolved.",
	)
	assert.equal(upgrade.typecheck.status, "passed")
	assert.equal(upgrade.tests.status, "passed")
	assert.equal(upgrade.result.status, "untested")
})

test("an upgrade install timeout names the check and reports its recorded duration", async () => {
	const entries = scripts([], [], [])
	entries[6]!.result = { exitCode: 124, timedOut: true, durationMs: 180000 }
	const inspection = await inspectRepository({
		repositoryUrl: fixtureUrl,
		sandboxProvider: provider(entries),
		limits: { maxUpgrades: 1 },
	})

	// The upgrade deadline is independent of the successful baseline installation.
	const install = inspection.upgrades[0]?.install
	assert.equal(inspection.baseline.install.status, "passed")
	assert.ok(install?.status === "untested")
	assert.equal(install.detail, "The upgrade install timed out after 180 seconds.")
})

test("a blocked install script download retries without scripts for every install", async () => {
	const entries = scripts([], [], [])
	entries[2] = command(["install"], "blocked", 1)
	entries[2]!.connections = {
		complete: true,
		findings: [{ kind: "connection", destination: "github.com", outcome: "attempted" }],
	}
	entries.splice(3, 0, command(["install", "--ignore-scripts"]))

	// require the same policy on upgrade installs
	for (const entry of entries.slice(4)) {
		if (entry.argv.includes("install")) {
			entry.argv = [...entry.argv, "--ignore-scripts"]
		}
	}
	const inspection = await inspectRepository({
		repositoryUrl: fixtureUrl,
		sandboxProvider: provider(entries),
		limits: { maxUpgrades: 1 },
	})

	// retain the failed attempt beside the usable install
	assert.equal(inspection.baseline.install.status, "passed")
	assert.equal(inspection.baseline.install.installScriptsSkipped, true)
	assert.equal(inspection.baseline.install.evidence.length, 2)
	assert.equal(inspection.upgrades[0]?.install.installScriptsSkipped, true)
	assert.equal(inspection.upgrades[0]?.result.status, "passed")
})

test("broken Baseline prevents all trials", async () => {
	// fail the baseline install before either upgrade trial
	const entries = scripts([], [], []).slice(0, 3)
	entries[2] = command(["install"], "broken", 1)
	const inspectionReport = await inspectRepository({ repositoryUrl: fixtureUrl, sandboxProvider: provider(entries) })
	assert.equal(inspectionReport.upgrades.length, 2)
	assert.ok(
		inspectionReport.upgrades.every(
			({ result }) => result.status === "untested" && result.detail?.includes("install the original dependencies"),
		),
	)
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
