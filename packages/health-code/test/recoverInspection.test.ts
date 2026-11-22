import assert from "node:assert/strict"
import { test } from "node:test"
import {
	type FixtureCommand,
	InspectionError,
	type InspectionEvent,
	inspectRepository,
	listUpgrades,
	type SandboxProvider,
	SandboxUnavailableError,
} from "../src/index.ts"
import { preservePartialReport, retainCompletedChecks } from "../src/preservePartialReport.ts"
import { fixtureCommit, fixtureUrl } from "./providerContract.ts"
import { base, command, provider, report, scripts } from "./replayProjectChecks.ts"

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

test("the interrupted upgrade uses its own install duration", async () => {
	const inspection = await inspectRepository({
		repositoryUrl: fixtureUrl,
		sandboxProvider: provider(scripts([], [], [])),
		limits: { maxUpgrades: 1 },
	})
	const upgrade = inspection.upgrades[0]!
	upgrade.install = upgrade.result = { status: "untested", reason: "not-run", evidence: [] }

	// Replay the timed-out step after successful baseline checks at the same commit.
	const activeUpgrade = `${upgrade.dependency}@${upgrade.to}`
	inspection.timeline.push({
		version: 1,
		inspectionId: "fixture",
		timestamp: new Date(0).toISOString(),
		sequence: inspection.timeline.length + 1,
		type: "step.finished",
		stepId: "candidate-install",
		status: "failed",
		upgradeId: activeUpgrade,
		summary: "install",
		durationMs: 180015,
	})
	preservePartialReport({
		report: inspection,
		activeUpgrade,
		error: new InspectionError("deadline", "Inspection interrupted"),
	})

	// Keep the original installation's result separate from the upgrade's timeout.
	assert.equal(inspection.baseline.install.status, "passed")
	assert.equal(upgrade.result.detail, "The upgrade install timed out after 180 seconds.")
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

function retryFixture(first: FixtureCommand[], replacement: FixtureCommand[]): SandboxProvider {
	const sandbox = provider(first)
	const create = sandbox.createSandbox.bind(sandbox)
	let allocations = 0

	// Replay a fresh checkout with the original selection already known.
	sandbox.createSandbox = async (name, operation) => {
		if (allocations++ === 1) {
			first.splice(0, first.length, ...replacement)
		}
		return create(name, operation)
	}
	return sandbox
}

test("losing a pinned sandbox preserves the baseline and names the skipped upgrades", async () => {
	const sandbox = retryFixture(
		scripts([], [], []),
		scripts([], [], []).filter((item) => item.argv[2] !== "registry"),
	)
	const run = sandbox.executeCommand.bind(sandbox)

	// Interrupt the selected command after setup succeeds.
	sandbox.executeCommand = (allocation, input) => {
		if (input.argv[2] === "tests") {
			throw new SandboxUnavailableError("unavailable")
		}
		return run(allocation, input)
	}

	// Preserve the two completed checks and identify the interrupted test command.
	const report = await inspectRepository({ repositoryUrl: fixtureUrl, sandboxProvider: sandbox })
	assert.equal(report.baseline.install.status, "passed")
	assert.equal(report.baseline.typecheck.status, "passed")
	assert.ok(report.baseline.tests.status === "untested" && report.baseline.tests.reason === "interrupted")
	assert.match(report.stoppedReason ?? "", /sandbox became unavailable.*tests/)
	assert.deepEqual(
		report.upgrades.map((upgrade) => upgrade.coverage),
		["skipped", "skipped"],
	)
	assert.ok(report.timeline.some((event) => event.type === "sandbox.event" && event.action === "deleted"))
})

test("losing a sandbox on the second upgrade retains the first verdict", async () => {
	const sandbox = retryFixture(
		scripts([], [], []),
		scripts([], [], []).filter((item) => item.argv[2] !== "registry"),
	)
	const run = sandbox.executeCommand.bind(sandbox)

	// Interrupt the selected command after setup succeeds.
	sandbox.executeCommand = (allocation, input) => {
		if (input.argv.includes("2.0.0")) {
			throw new SandboxUnavailableError("unavailable")
		}
		return run(allocation, input)
	}

	// Keep the first upgrade's successful checks and distinguish the interrupted installation.
	const report = await inspectRepository({ repositoryUrl: fixtureUrl, sandboxProvider: sandbox })
	assert.equal(report.upgrades[0]?.result.status, "passed")
	assert.equal(report.upgrades[1]?.coverage, "partial")
	assert.equal(report.upgrades[1]?.install.status, "untested")
	assert.equal(report.upgrades[1]?.tests.status, "untested")
})

test("a replacement that stops during baseline checks preserves the original completed baseline", async () => {
	const sandbox = retryFixture(
		scripts([], [], []),
		scripts([], [], []).filter((entry) => entry.argv[2] !== "registry"),
	)
	const execute = sandbox.executeCommand.bind(sandbox)
	let retrying = false

	// Lose the first sandbox during an upgrade, then the second before its baseline tests.
	sandbox.executeCommand = (runtime, input) => {
		if ((!retrying && input.argv.includes("1.3.0")) || (retrying && input.argv[2] === "typecheck")) {
			retrying = true
			throw new SandboxUnavailableError("unavailable")
		}
		return execute(runtime, input)
	}

	const report = await inspectRepository({ repositoryUrl: fixtureUrl, sandboxProvider: sandbox })
	assert.match(report.stoppedReason ?? "", /replacement sandbox also became unavailable/)
	assert.equal(report.baseline.typecheck.status, "passed")
	assert.equal(report.baseline.tests.status, "passed")
})

test("a confirmed replacement install failure survives a partial first attempt with more measured checks", async () => {
	const original = await inspectRepository({
		repositoryUrl: fixtureUrl,
		sandboxProvider: provider(scripts([], [], [])),
		limits: { maxUpgrades: 1 },
	})
	const retry = structuredClone(original)
	const earlier = original.upgrades[0]!
	const latest = retry.upgrades[0]!
	earlier.coverage = "partial"

	// A blocked test after a failed install cannot inherit an earlier passing test.
	latest.coverage = "partial"
	latest.install = { status: "failed", failingTests: [], evidence: latest.install.evidence }
	latest.result = latest.install
	latest.tests = latest.typecheck = { status: "untested", reason: "install-failed", evidence: [] }
	retainCompletedChecks(retry, original)
	assert.equal(retry.upgrades[0]?.result.status, "failed")
	assert.deepEqual(retry.upgrades[0]?.tests, { status: "untested", reason: "install-failed", evidence: [] })
})

test("a retry restores an earlier measured comparison when its own checks are interrupted", async () => {
	const original = await inspectRepository({
		repositoryUrl: fixtureUrl,
		sandboxProvider: provider(scripts([], [], [])),
		limits: { maxUpgrades: 1 },
	})
	const retry = structuredClone(original)
	const upgrade = retry.upgrades[0]!

	// Interrupt the replacement before it can repeat the baseline-comparable test stage.
	upgrade.coverage = "partial"
	upgrade.tests = upgrade.result = { status: "untested", reason: "interrupted", evidence: [] }
	retainCompletedChecks(retry, original)
	assert.equal(upgrade.tests.status, "passed")
	assert.equal(upgrade.result.status, "passed")
	assert.equal(upgrade.coverage, "partial")
})

test("a broken original typecheck still permits the upgrade install and independent tests", async () => {
	const commands = scripts([], [], [])
	commands[3] = command(["typecheck", "build"], "original build failed", 1)
	commands.splice(7, 1)
	const report = await inspectRepository({
		repositoryUrl: fixtureUrl,
		sandboxProvider: provider(commands),
		limits: { maxUpgrades: 1 },
	})

	// Withhold a passing verdict when the typecheck could not be compared.
	const upgrade = report.upgrades[0]
	assert.equal(upgrade?.coverage, "partial")
	assert.equal(upgrade?.install.status, "passed")
	assert.equal(upgrade?.tests.status, "passed")
	assert.equal(upgrade?.result.status, "untested")
})

test("one replacement rebuilds the baseline, inspects untouched targets first and finishes the interrupted upgrade", async () => {
	const initial = scripts([], [], [])
	const replacement = scripts([], [], []).filter((entry) => entry.argv[2] !== "registry")
	const major = replacement
		.slice(-4)
		.map((entry) => ({ ...entry, argv: entry.argv.map((arg) => (arg === "1.3.0" ? "2.0.0" : arg)) }))

	// Reproduce both candidate installations in replacement order.
	replacement.splice(replacement.length - 4, 0, ...major)
	const sandbox = retryFixture(initial, replacement)
	const execute = sandbox.executeCommand.bind(sandbox)
	const installs: string[] = []

	// Lose only the first candidate installation.
	sandbox.executeCommand = (runtime, input) => {
		if (input.argv[2] === "install") {
			installs.push(input.argv[4] ?? "baseline")

			// Allow the same target to succeed after the replacement.
			if (installs.length === 2) {
				throw new SandboxUnavailableError("unavailable")
			}
		}
		return execute(runtime, input)
	}

	// Preserve discovery order in the published report.
	const report = await inspectRepository({ repositoryUrl: fixtureUrl, sandboxProvider: sandbox })
	assert.deepEqual(installs, ["baseline", "1.3.0", "baseline", "2.0.0", "1.3.0"])
	assert.deepEqual(
		report.upgrades.map(({ to, result }) => [to, result.status]),
		[
			["1.3.0", "passed"],
			["2.0.0", "passed"],
		],
	)
	assert.equal(report.stoppedReason, undefined)

	// Verify both lifetimes and one continuous inspection timeline.
	const actions = report.timeline.flatMap((event) => (event.type === "sandbox.event" ? [event.action] : []))
	assert.deepEqual(
		actions.filter((action) => action === "created" || action === "deleted"),
		["created", "deleted", "created", "deleted"],
	)
	assert.equal(actions.filter((action) => action === "network-locked").length, 2)
	assert.deepEqual(
		report.timeline.map((event) => event.sequence),
		report.timeline.map((_, index) => index + 1),
	)
})

test("a second runtime must fit the original spend ceiling", async () => {
	const sandbox = provider(scripts([], [], []))

	// Quote each allocation independently.
	sandbox.estimateMaxCost = () => 0.2
	const execute = sandbox.executeCommand.bind(sandbox)
	sandbox.executeCommand = (runtime, input) => {
		if (input.argv[2] === "tests") {
			throw new SandboxUnavailableError("unavailable")
		}
		return execute(runtime, input)
	}

	// Reserve enough for the first runtime only.
	const report = await inspectRepository({
		repositoryUrl: fixtureUrl,
		sandboxProvider: sandbox,
		limits: { maxCostUsd: 0.25 },
	})
	assert.equal(report.sandboxUnavailable, true)
	assert.equal(
		report.timeline.filter((event) => event.type === "sandbox.event" && event.action === "created").length,
		1,
	)
})

test("discovery lists every eligible target without installing, then checks one chosen workspace upgrade", async () => {
	const commands = scripts([], [], [])
	const upgradeMenu = await inspectRepository({
		repositoryUrl: fixtureUrl,
		sandboxProvider: provider(commands.slice(0, 2)),
		mode: "listUpgrades",
		limits: { maxUpgrades: 1 },
	})

	// Earlier callers can still request the same listing through the boolean option.
	const earlier = await inspectRepository({
		repositoryUrl: fixtureUrl,
		sandboxProvider: provider(scripts([], [], []).slice(0, 2)),
		discoveryOnly: true,
	})
	assert.equal(earlier.selection.mode, "listUpgrades")
	assert.deepEqual(earlier.selection.eligible, upgradeMenu.selection.eligible)

	// Preserve both versions and the workspace-specific pins under a one-upgrade ceiling.
	assert.deepEqual(
		upgradeMenu.selection.eligible.map((target) => target.to),
		["1.3.0", "2.0.0"],
	)
	assert.deepEqual(upgradeMenu.upgrades, [])
	assert.equal(
		upgradeMenu.timeline.some((event) => event.type === "step.started" && event.label === "install"),
		false,
	)
	assert.ok(upgradeMenu.timeline.some((event) => event.type === "sandbox.event" && event.action === "deleted"))

	// Inspect exactly the chosen target from the same commit without querying the registry again.
	const upgrade = upgradeMenu.selection.eligible[0]!
	const checked = await inspectRepository({
		repositoryUrl: fixtureUrl,
		revision: upgradeMenu.repository.commit,
		upgrade,
		sandboxProvider: provider(commands.filter((command) => command.argv[2] !== "registry")),
	})
	assert.deepEqual(
		checked.upgrades.map((target) => target.to),
		[upgrade.to],
	)
	assert.equal(checked.upgrades[0]?.install.status, "passed")
	assert.equal(checked.selection.mode, "inspectUpgrades")
})

test("the public list includes documented features even under a single-upgrade test limit", async () => {
	const events: InspectionEvent[] = []
	const upgradeMenu = await listUpgrades({
		repositoryUrl: fixtureUrl,
		sandboxProvider: provider(scripts([], [], []).slice(0, 2)),
		limits: { maxUpgrades: 1 },
		onEvent: (event) => {
			events.push(event)
		},
		request: async (url) =>
			Response.json(
				String(url).startsWith("https://registry.npmjs.org/")
					? { repository: "https://github.com/example/widget" }
					: [{ tag_name: "v1.3.0", body: "## Features\n- Faster imports", draft: false, prerelease: false }],
			),
	})

	// Both version choices cross the documented release at the same commit.
	assert.equal(upgradeMenu.repository.commit, fixtureCommit)
	assert.deepEqual(
		upgradeMenu.dependencies[0]?.targets.map((target) => [target.to, target.releaseFeatures.features[0]?.text]),
		[
			["1.3.0", "Faster imports"],
			["2.0.0", "Faster imports"],
		],
	)
	assert.equal(events.at(-1)?.type, "inspection.finished")
})
