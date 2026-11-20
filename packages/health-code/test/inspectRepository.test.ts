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
	const timeline: InspectionEvent[] = []
	const card = await inspectRepository({
		repositoryUrl: fixtureUrl,
		sandboxProvider: provider(scripts(["existing"], ["existing", "flaky", "regression"], ["existing", "regression"])),
		limits: { maxUpgrades: 1 },
		onEvent: (e) => {
			timeline.push(e)
		},
	})
	assert.deepEqual(JSON.parse(JSON.stringify(card.timeline)), timeline)
	assert.deepEqual(
		card.selection.omitted.map((u) => u.to),
		["2.0.0"],
	)
	const outcome = card.upgrades[0]?.result
	assert.equal(outcome?.status, "failed")
	assert.deepEqual(
		outcome.failingTests.map((t) => t.name),
		["regression"],
	)
	assert.equal(card.timeline.at(-1)?.type, "inspection.finished")
})
test("a transient outside write stops the trial on a successful install", async () => {
	const entries = scripts([], [], []).slice(0, 7)
	const install = entries.at(-1)
	assert.ok(install)
	install.files = { complete: true, findings: [{ kind: "write", path: "/tmp/transient" }] }
	const card = await inspectRepository({
		repositoryUrl: fixtureUrl,
		sandboxProvider: provider(entries),
		limits: { maxUpgrades: 1 },
	})
	assert.equal(card.upgrades[0]?.result.status, "untested")
	assert.equal(card.upgrades[0]?.observation.findings.length, 1)
})
test("incomplete observation cannot pass; only confirmed denials become sandbox events", async () => {
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
	const card = await inspectRepository({
		repositoryUrl: fixtureUrl,
		sandboxProvider: provider(entries),
		limits: { maxUpgrades: 1 },
	})
	assert.equal(card.upgrades[0]?.result.status, "untested")
	assert.equal(card.timeline.filter((e) => e.type === "sandbox.event" && e.action === "connection-blocked").length, 1)
})
test("broken Baseline prevents all trials", async () => {
	const entries = scripts([], [], []).slice(0, 3)
	entries[2] = command(["install"], "broken", 1)
	const card = await inspectRepository({ repositoryUrl: fixtureUrl, sandboxProvider: provider(entries) })
	assert.equal(card.upgrades.length, 2)
	assert.ok(card.upgrades.every((u) => u.result.status === "untested"))
})
test("expired token and invalid sources fail before allocation", async () => {
	const sandboxProvider = createSandboxProvider({
		token: "fixture",
		fetch: async () => new Response(null, { status: 401 }),
	})
	await assert.rejects(inspectRepository({ repositoryUrl: fixtureUrl, sandboxProvider }), SandboxUnavailableError)
	await assert.rejects(inspectRepository({ repositoryUrl: "https://github.com:443/ai/nanoid", sandboxProvider }), {
		code: "invalid-repository",
	})
})
test("preserves terminal evidence on callback failure and reconciles an ambiguous allocation", async () => {
	const sandboxProvider = provider([])
	let deleted = false
	sandboxProvider.destroySandbox = async () => {
		deleted = true
	}
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
	deleted = false
	sandboxProvider.createSandbox = async () => {
		throw new SandboxUnavailableError("unavailable")
	}
	await assert.rejects(inspectRepository({ repositoryUrl: fixtureUrl, sandboxProvider }), SandboxUnavailableError)
	assert.ok(deleted)
})

test("a confirmation deadline preserves the first result and the clean install evidence", async () => {
	const sandboxProvider = provider(scripts([], ["new failure"], []))
	const reset = sandboxProvider.resetProject
	let resets = 0
	sandboxProvider.resetProject = async (...args) => {
		if (++resets === 3) {
			throw new InspectionError("deadline", "Confirmation interrupted")
		}
		await reset(...args)
	}
	const card = await inspectRepository({ repositoryUrl: fixtureUrl, sandboxProvider, limits: { maxUpgrades: 1 } })
	const check = card.upgrades[0]
	assert.equal(check?.install.status, "passed")
	assert.equal(check?.tests.status, "untested")
	assert.equal(check.tests.reason, "inspection-deadline")
	assert.equal(check.tests.unconfirmedTests?.[0]?.name, "new failure")
	assert.equal(check.tests.evidence.length, 1)
})

test("a dirty confirmation install stops the check and redacts the finding in the saved card", async () => {
	const entries = scripts([], [], []).slice(0, 8)
	entries[7] = command(["typecheck", "build"], "error TS999", 1)
	const retry = command(["install", "widget", "1.3.0"], "confirmation install")
	retry.files = { complete: true, findings: [{ kind: "write", path: "/tmp/sk-sensitivefixture" }] }
	entries.push(retry)
	const card = await inspectRepository({
		repositoryUrl: fixtureUrl,
		sandboxProvider: provider(entries),
		limits: { maxUpgrades: 1 },
	})
	const check = card.upgrades[0]
	assert.equal(check?.tests.status, "untested")
	assert.equal(check.tests.reason, "installation-finding")
	assert.deepEqual(check.observation.findings, [{ kind: "write", path: "/tmp/[redacted]" }])
	assert.equal(check.install.evidence.length, 2)
	assert.doesNotMatch(JSON.stringify(card), /sensitivefixture/)
})

test("malformed registry data leaves the baseline runnable", async () => {
	const entries = scripts([], [], []).slice(0, 6)
	entries[1] = command(["registry", "widget"], '{"widget":null}')
	const card = await inspectRepository({ repositoryUrl: fixtureUrl, sandboxProvider: provider(entries) })
	assert.equal(card.baseline.install.status, "passed")
	assert.equal(card.upgrades.length, 0)
	assert.match(card.selection.skipped.join(" "), /registry/)
})
test("exit 124 retains identified test failures when the provider reports no timeout", async () => {
	const entries = scripts(["known"], [], []).slice(0, 6)
	entries[4] = command(["tests"], "", 124)
	entries.splice(1, 1)
	const card = await inspectRepository({
		repositoryUrl: fixtureUrl,
		sandboxProvider: provider(entries),
		limits: { maxUpgrades: 0 },
	})
	assert.equal(card.baseline.tests.status, "failed")
	assert.equal(card.baseline.tests.failingTests[0]?.name, "known")
})
test("a failed confirmation install prevents tests on the incomplete checkout", async () => {
	const entries = scripts([], [], []).slice(0, 8)
	entries[7] = command(["typecheck", "build"], "type error", 1)
	entries.push(command(["install", "widget", "1.3.0"], "install error", 1))
	const card = await inspectRepository({
		repositoryUrl: fixtureUrl,
		sandboxProvider: provider(entries),
		limits: { maxUpgrades: 1 },
	})
	const result = card.upgrades[0]?.tests
	assert.equal(result?.status, "untested")
	assert.equal(result.reason, "confirmation-install-unavailable")
})
