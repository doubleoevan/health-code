import assert from "node:assert/strict"
import { test } from "node:test"
import {
	createFakeSandboxProvider,
	createSandboxProvider,
	InspectionError,
	inspectRepository,
	type SandboxFixture,
} from "../src/index.ts"
import { buildGuestArguments } from "../src/sandbox/buildGuestArguments.ts"
import { buildTestCommand } from "../src/sandbox/buildTestCommand.ts"
import { confirmNetworkPolicy, validateRegistryHosts } from "../src/sandbox/networkPolicy.ts"
import { fixtureCommit, fixtureUrl } from "./providerContract.ts"

test("verifies the complete allowlist before any repository-controlled command", async () => {
	// capture whether the provider executes commands or releases the sandbox
	const sandboxProvider = createFakeSandboxProvider({ commit: fixtureCommit, commands: [] })
	let executed = false
	let released = false

	// return a policy that fails readback before any repository command
	sandboxProvider.setNetworkPolicy = async () =>
		confirmNetworkPolicy(["registry.npmjs.org"], { mode: "denylist", allowedHosts: [], deniedHosts: [] })
	sandboxProvider.executeCommand = async () => {
		executed = true
		throw Error("unexpected repository execution")
	}

	// record teardown even when policy verification fails
	sandboxProvider.destroySandbox = async () => {
		released = true
	}

	// verify release, isolation and registry validation
	await assert.rejects(inspectRepository({ repositoryUrl: fixtureUrl, sandboxProvider }), { code: "policy" })
	assert.ok(released)
	assert.equal(executed, false)
	assert.throws(() => validateRegistryHosts(["github.com"]), { code: "policy" })
})

test("invalid or contradictory inspection modes are rejected before contacting the provider", async () => {
	// Detect any attempt to allocate resources for an ambiguous request.
	const sandboxProvider = createFakeSandboxProvider({ commit: fixtureCommit, commands: [] })
	let contacted = false
	sandboxProvider.checkAvailability = async () => {
		contacted = true
	}

	// Exercise JavaScript inputs alongside conflicting options passed by a typed wrapper.
	for (const options of [
		{ mode: "inspectUpgrades", discoveryOnly: true },
		{ mode: "listUpgrades", discoveryOnly: false },
		{ mode: "unknown" },
		{ discoveryOnly: "false" },
	]) {
		// Pass inputs through the same untyped boundary as a JavaScript consumer.
		const input = { repositoryUrl: fixtureUrl, sandboxProvider, ...options } as Parameters<typeof inspectRepository>[0]
		await assert.rejects(inspectRepository(input), { code: "invalid-mode" })
	}
	assert.equal(contacted, false)
})

test("guest environment contains inert application values and trusted controls", () => {
	const { argv, placeholderVariableCount } = buildGuestArguments(
		{
			argv: ["node", "--version"],
			timeoutMs: 5000,
			environment: ["OPTION", "OPTION", "NOT-VALID", "PATH", "NODE_OPTIONS", "RUNTA_TOKEN", "LD_PRELOAD", "HOME"],
		},
		undefined,
	)

	// check which environment values reach the guest
	assert.equal(placeholderVariableCount, 1)
	assert.deepEqual(
		argv.filter((arg) => arg === "OPTION=placeholder"),
		["OPTION=placeholder"],
	)
	assert.ok(argv.includes("-i"))
	for (const key of ["PATH", "NODE_OPTIONS", "RUNTA_TOKEN", "LD_PRELOAD", "HOME"]) {
		assert.ok(!argv.includes(`${key}=placeholder`))
	}
})

test("pins once when a branch moves after acquisition", async () => {
	const fixture: SandboxFixture = {
		commit: fixtureCommit,
		commands: [
			{
				argv: ["node", "/opt/health-code/project.mjs", "detect"],
				result: { exitCode: 1, stderr: "Unsupported project" },
			},
		],
	}

	// inspect a fixture that moves the source branch after checkout
	const sandboxProvider = createFakeSandboxProvider(fixture)
	const report = await inspectRepository({
		repositoryUrl: fixtureUrl,
		sandboxProvider,
		onEvent: (event) => {
			if (event.type === "sandbox.event" && event.action === "network-locked") {
				fixture.commit = "f".repeat(40)
			}
		},
	})

	// verify the report retains the originally acquired commit
	assert.equal(report.repository.commit, fixtureCommit)
	assert.deepEqual(report.packageManager, { reason: "Unsupported project" })
})

test("unavailable repository releases its sandbox before any repository code executes", async () => {
	const sandboxProvider = createFakeSandboxProvider({ commit: fixtureCommit, commands: [] })
	let destroyed = false

	// fail acquisition and observe sandbox cleanup
	sandboxProvider.prepareRepository = async () => {
		throw new InspectionError("repository-unavailable", "Public repository unavailable")
	}
	sandboxProvider.destroySandbox = async () => {
		destroyed = true
	}
	await assert.rejects(inspectRepository({ repositoryUrl: fixtureUrl, sandboxProvider }), {
		code: "repository-unavailable",
	})
	assert.ok(destroyed)
})

test("the provider limits deletion to allocations that it owns", async () => {
	await createSandboxProvider({ token: "" }).destroySandbox({ id: "unrelated" }, { timeoutMs: 1 })
})

test("only inventory readers receive the completed read-only snapshot", () => {
	const base = ["node", "/opt/health-code/project.mjs"]
	const args = (argv: string[], previous?: string): ReturnType<typeof buildTestCommand> =>
		buildTestCommand({ command: { argv, timeoutMs: 1000 }, id: "fixture", previous })

	// capture the inventory while tests run
	const tests = args([...base, "tests", "--inventory"])
	assert.ok(tests.capture)
	assert.ok(tests.argv.includes("capture-tests"))
	assert.equal(tests.argv.includes("/inspection-inventory"), false)

	// verify that only the patch verification reader receives the read-only inventory
	assert.equal(args([...base, "integrity", "0"], tests.capture).maxOutputBytes, 1024 * 1024)
	assert.equal(args([...base, "integrity", "0"]).maxOutputBytes, undefined)
	assert.equal(args([...base, "lifecycle"]).maxOutputBytes, 1024 * 1024)
	assert.equal(tests.maxOutputBytes, undefined)
	const read = args([...base, "integrity", "100"], tests.capture).argv
	assert.deepEqual(read.slice(read.indexOf("/inspection-inventory") - 2, read.indexOf("/inspection-inventory") + 1), [
		"--ro-bind",
		tests.capture + "/inventory",
		"/inspection-inventory",
	])
	assert.equal(args(["bun", "run", "test"], tests.capture).argv.includes("/inspection-inventory"), false)
})

test("test inventory pages retain all cases and mark the end of a full page", async () => {
	const { writeInventoryPages } = await import("../guest/measureTests.ts")
	const { mkdtempSync, readFileSync, rmSync } = await import("node:fs")
	const { join } = await import("node:path")
	const { tmpdir } = await import("node:os")
	const root = mkdtempSync(join(tmpdir(), "test-inventory-"))
	const directory = join(root, "inventory")

	// create exactly two full inventory pages
	const cases = Array.from({ length: 200 }, (_, index) => ({
		file: "sample.test.ts",
		name: String(index),
		status: "passed" as const,
	}))
	try {
		writeInventoryPages(directory, {
			cases,
			discoveredFiles: ["sample.test.ts"],
			counts: { passed: 200, failed: 0, skipped: 0, todo: 0 },
			testFileErrors: [],
		})

		// check the contents of each page and the empty terminal page
		const page = (offset: number): { cases: [string, string, string][]; discoveredFiles?: string[] } =>
			JSON.parse(readFileSync(join(directory, offset + ".json"), "utf8"))

		// verify discovery, case offsets and the end marker
		assert.deepEqual(page(0).discoveredFiles, ["sample.test.ts"])
		assert.equal(page(100).cases[0]?.[1], "100")
		assert.deepEqual(page(200).cases, [])
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test("caller test values replace placeholders without overriding runtime controls", () => {
	const { argv, placeholderVariableCount } = buildGuestArguments(
		{
			argv: ["true"],
			timeoutMs: 1000,
			environment: ["BUDGET", "API_URL"],
			environmentValues: { BUDGET: "5", EXTRA: "a=b", PATH: "/unsafe", NODE_OPTIONS: "--require=x" },
		},
		undefined,
	)

	// keep the trusted path and count only inert placeholders
	assert.ok(argv.includes("BUDGET=5") && argv.includes("EXTRA=a=b") && argv.includes("API_URL=placeholder"))
	assert.ok(!argv.includes("BUDGET=placeholder") && !argv.includes("PATH=/unsafe"))
	assert.ok(!argv.some((item) => item.startsWith("NODE_OPTIONS=")))
	assert.equal(placeholderVariableCount, 1)
})
