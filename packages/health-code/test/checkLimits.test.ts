import assert from "node:assert/strict"
import { test } from "node:test"
import { InspectionError, inspectRepository, SandboxUnavailableError } from "../src/index.ts"
import { fixtureUrl } from "./providerContract.ts"
import { provider, scripts } from "./replayProjectChecks.ts"

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

test("a Baseline install past its check limit is untested and names the step instead of ending the inspection", async () => {
	// finish the Baseline install after its one-second limit
	const sandboxProvider = toSlowProvider((action, runCount) => action === "install" && runCount === 1)
	const inspection = await inspectRepository({
		repositoryUrl: fixtureUrl,
		sandboxProvider,
		limits: { maxUpgrades: 1, timeouts: { install: 1000 } },
	})

	// record the timeout on the install and keep the inspection's own deadline out of the report
	const install = inspection.baseline.install
	assert.ok(install.status === "untested")
	assert.equal(install.reason, "command-timeout")
	assert.equal(install.detail, "The install step reached its 1-second limit.")
	assert.equal(inspection.stoppedReason, undefined)
	assert.ok(!inspection.selection.skipped.includes("inspection-deadline"))
})

test("an upgrade's tests past their check limit are untested and the inspection finishes", async () => {
	// finish the upgrade's test run after its one-second limit
	const sandboxProvider = toSlowProvider((action, runCount) => action === "tests" && runCount === 2)
	const inspection = await inspectRepository({
		repositoryUrl: fixtureUrl,
		sandboxProvider,
		limits: { maxUpgrades: 1, timeouts: { tests: 1000 } },
	})

	// keep the Baseline and the upgrade's install, and record the timed-out tests on the upgrade alone
	const tests = inspection.upgrades[0]?.tests
	assert.equal(inspection.baseline.tests.status, "passed")
	assert.equal(inspection.upgrades[0]?.install.status, "passed")
	assert.ok(tests?.status === "untested")
	assert.equal(tests.detail, "The tests step reached its 1-second limit.")
	assert.equal(inspection.stoppedReason, undefined)
})

test("a Baseline typecheck past its check limit frees the sandbox before the tests run", async () => {
	// finish the Baseline typecheck after its one-second limit. the upgrade then skips its own typecheck
	const entries = scripts([], [], [])
	entries.splice(7, 1)
	const sandboxProvider = toSlowProvider((action, runCount) => action === "typecheck" && runCount === 1, entries)
	const inspection = await inspectRepository({
		repositoryUrl: fixtureUrl,
		sandboxProvider,
		limits: { maxUpgrades: 1, timeouts: { typecheck: 1000 } },
	})

	// record the timed-out typecheck and run the tests once the sandbox is free
	const typecheck = inspection.baseline.typecheck
	assert.ok(typecheck.status === "untested")
	assert.equal(typecheck.detail, "The typecheck step reached its 1-second limit.")
	assert.equal(inspection.baseline.tests.status, "passed")
	assert.equal(inspection.upgrades[0]?.tests.status, "passed")
	assert.equal(inspection.stoppedReason, undefined)
})

test("a sandbox lost during a timed-out step starts recovery instead of recording a command timeout", async () => {
	// lose the sandbox after the Baseline typecheck passes its one-second limit, and stop at the next command
	const replayProvider = provider(scripts([], [], []))
	const actions: string[] = []
	const sandboxProvider = {
		...replayProvider,
		executeCommand: async (...args: Parameters<typeof replayProvider.executeCommand>) => {
			// record each action and stop at the first command after the lost sandbox
			const action = String(args[1].argv[2])
			actions.push(action)
			if (actions.includes("typecheck") && action !== "typecheck") {
				throw new InspectionError("fixture-command", "Recovery started")
			}

			// replay the command, then lose the sandbox late on the typecheck
			const commandResult = await replayProvider.executeCommand(...args)
			if (action !== "typecheck") {
				return commandResult
			}
			await new Promise((resolve) => setTimeout(resolve, 1500))
			throw new SandboxUnavailableError("unavailable")
		},
	}
	await assert.rejects(
		inspectRepository({
			repositoryUrl: fixtureUrl,
			sandboxProvider,
			limits: { maxUpgrades: 1, timeouts: { typecheck: 1000 } },
		}),
	)

	// expect a new Baseline setup instead of the tests that follow a recorded timeout
	assert.equal(actions[actions.indexOf("typecheck") + 1], "declared-package-manager")
})

// replay the recorded commands, finish one command late and refuse a command while another runs, as a sandbox does
function toSlowProvider(
	isSlow: (action: string, runCount: number) => boolean,
	entries = scripts([], [], []),
): ReturnType<typeof provider> {
	const replayProvider = provider(entries)
	const runCounts = new Map<string, number>()
	let activeCommandCount = 0
	return {
		...replayProvider,
		executeCommand: async (...args: Parameters<typeof replayProvider.executeCommand>) => {
			if (activeCommandCount) {
				throw new InspectionError("sandbox-busy", "Repository command is active")
			}

			// count runs of each action
			const action = String(args[1].argv[2])
			const runCount = (runCounts.get(action) ?? 0) + 1
			runCounts.set(action, runCount)

			// hold the command slot while the command runs, and the slow one past its limit
			activeCommandCount++
			try {
				// replay the recorded result
				const commandResult = await replayProvider.executeCommand(...args)
				if (isSlow(action, runCount)) {
					await new Promise((resolve) => setTimeout(resolve, 1500))
				}
				return commandResult
			} finally {
				activeCommandCount--
			}
		},
	}
}
