import assert from "node:assert/strict"
import { test } from "node:test"
import { inspectTrace } from "../guest/observe.ts"
import {
	createFakeSandboxProvider,
	createSandboxProvider,
	InspectionError,
	inspectRepository,
	type Observation,
	type SandboxFixture,
} from "../src/index.ts"
import { confirmNetworkPolicy, validateRegistryHosts } from "../src/networkPolicy.ts"
import { guestArguments } from "../src/sandbox/executeGuest.ts"
import { buildTestCommand } from "../src/sandbox/executeTests.ts"
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
test("guest environment contains inert application values and trusted controls", () => {
	const argv = guestArguments(
		{
			argv: ["node", "--version"],
			timeoutMs: 5000,
			environment: ["OPTION", "PATH", "NODE_OPTIONS", "RUNTA_TOKEN", "LD_PRELOAD", "HOME"],
		},
		undefined,
	)

	// check which environment values reach the guest
	assert.ok(argv.includes("OPTION=placeholder"))
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
	const card = await inspectRepository({
		repositoryUrl: fixtureUrl,
		sandboxProvider,
		onEvent: (event) => {
			if (event.type === "sandbox.event" && event.action === "network-locked") {
				fixture.commit = "f".repeat(40)
			}
		},
	})

	// verify the report retains the originally acquired commit
	assert.equal(card.repository.commit, fixtureCommit)
	assert.deepEqual(card.packageManager, { reason: "Unsupported project" })
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
test("uses resolved descriptor targets for writes through symlinks", () => {
	const result = inspectTrace(
		'1 execve("/usr/bin/env", [], []) = 0\n1 openat(AT_FDCWD</project>, "link", O_WRONLY|O_TRUNC) = 3</tmp/actual>\n1 write(3</tmp/actual>, "x", 1) = 1',
		"",
		"0 packets dropped by kernel",
		[],
	)
	assert.deepEqual(result.files, { complete: true, findings: [{ kind: "write", path: "/tmp/actual" }] })
})

test("the provider limits deletion to allocations that it owns", async () => {
	await createSandboxProvider({ token: "" }).destroySandbox({ id: "unrelated" }, { timeoutMs: 1 })
})
test("unexpected DNS questions and ambiguous metadata writes cannot produce a clean install", () => {
	const trace = ['1 execve("/usr/bin/env", [], []) = 0', '1 mkdirat(AT_FDCWD</project>, "linked/dir", 0755) = 0'].join(
		"\n",
	)
	const result = inspectTrace(
		trace,
		"1 IP 10.0.2.1.111 > 10.0.2.3.53: 11+ TXT? example.org. (30)",
		"0 packets dropped by kernel",
		[],
		["/project/linked"],
	)

	// check both uncertainty and the unexpected dns destination
	assert.equal(result.files.complete, false)
	assert.deepEqual(result.connections.findings, [
		{ kind: "connection", destination: "example.org", source: "dns", outcome: "unknown" },
	])
})

test("path metadata operations that follow the last symlink report incomplete coverage", () => {
	const trace = '1 execve("/usr/bin/env", [], []) = 0\n1 chmod("/project/linked", 0600) = 0'
	assert.equal(inspectTrace(trace, "", "0 packets dropped by kernel", [], ["/project/linked"]).files.complete, false)
})

test("only DNS answers preceding a connection can establish its destination", () => {
	const trace = [
		'1 1.000000 execve("/usr/bin/env", [], []) = 0',
		'1 2.000000 connect(3, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr("192.0.2.5")}, 16) = -1 EINPROGRESS',
	].join("\n")
	const dns =
		"3 IP 10.0.0.2.123 > 10.0.0.1.53: 10+ A? registry.npmjs.org. (29)\n4 IP 10.0.0.1.53 > 10.0.0.2.123: 10 1/0/0 A 192.0.2.5"

	// keep an address unresolved when its dns response follows the connection
	const result = inspectTrace(trace, dns, "0 packets dropped by kernel", ["registry.npmjs.org"])
	assert.equal(result.connections.complete, false)
	assert.deepEqual(result.connections.findings, [{ kind: "connection", destination: "192.0.2.5", outcome: "unknown" }])
})
test("records descriptor metadata and keeps ambiguous mapping changes incomplete", () => {
	const trace = [
		'1 execve("/usr/bin/env", [], []) = 0',
		"1 fchmod(3</tmp/metadata>, 0600) = 0",
		"1 mmap(NULL, 4096, PROT_READ, MAP_SHARED, 4</tmp/shared>, 0) = 0x1234",
	]
	const read = (lines: string[]): Observation =>
		inspectTrace(lines.join("\n"), "", "0 packets dropped by kernel", []).files

	// distinguish a known metadata write from an ambiguous mapped write
	assert.deepEqual(read(trace), { complete: true, findings: [{ kind: "write", path: "/tmp/metadata" }] })
	assert.equal(read([...trace, "1 mprotect(0x1234, 4096, PROT_READ|PROT_WRITE) = 0"]).complete, false)
})

test("normalizes renamed link ancestors and reads descriptor-only timestamp changes", () => {
	const trace = [
		'1 execve("/usr/bin/env", [], []) = 0',
		'1 rename("/project/./dir", "/project/moved") = 0',
		'1 utime("/project/moved/link", NULL) = 0',
		"1 utimensat(3</tmp/outside>, NULL, NULL, 0) = 0",
	].join("\n")

	// retain descriptor writes when a renamed link obscures path coverage
	const result = inspectTrace(trace, "", "0 packets dropped by kernel", [], ["/project/dir/link"])
	assert.equal(result.files.complete, false)
	assert.deepEqual(result.files.findings, [{ kind: "write", path: "/tmp/outside" }])
})

test("observes pnpm permission changes through project links alongside read-only system mappings", () => {
	const trace = [
		'1 execve("/usr/bin/env", [], []) = 0',
		"1 mmap(NULL, 4096, PROT_READ, MAP_SHARED, 3</usr/lib/gconv/gconv-modules.cache>, 0) = 0x1000",
		"2 mprotect(0x4000, 4096, PROT_READ|PROT_WRITE) = 0",
		'2 symlink("../acorn@8/node_modules/acorn", "/project/.pnpm/node_modules/acorn") = 0',
		'2 symlinkat(".pnpm/node_modules/acorn", AT_FDCWD</project>, "acorn") = 0',
		'2 chmod("/project/acorn/bin/acorn", 0755) = 0',
		'2 openat(AT_FDCWD</project>, "/tmp/log", O_CREAT|O_WRONLY, 0600) = 4</tmp/log>',
	].join("\n")

	// check the read-only mount and the write that escapes the project
	const args = guestArguments({ argv: ["true"], timeoutMs: 1000 }, undefined)
	const mount = args.indexOf("/usr")
	assert.deepEqual(args.slice(mount - 1, mount + 2), ["--ro-bind", "/usr", "/usr"])
	assert.deepEqual(inspectTrace(trace, "", "0 packets dropped by kernel", []).files, {
		complete: true,
		findings: [{ kind: "write", path: "/tmp/log" }],
	})
})

test("keeps coverage incomplete for escaping, cyclic, or replaced link targets", () => {
	const start = '1 execve("/usr/bin/env", [], []) = 0'
	for (const links of [
		['1 symlink("../outside", "/project/link") = 0'],
		['1 symlink("link", "/project/link") = 0'],
		['1 symlink("/tmp", "/project/alias") = 0', '1 symlink("alias/../project", "/project/link") = 0'],
		[
			'1 symlink("/tmp", "/project/link") = 0',
			'1 unlink("/project/link") = 0',
			'1 symlink("pkg", "/project/link") = 0',
		],
		['1 symlink("pkg", "/project/link") = 0', '1 rename("/project/replacement", "/project/link") = 0'],
	]) {
		// apply the metadata change through each ambiguous link
		const trace = [start, ...links, '1 chmod("/project/link/bin", 0755) = 0'].join("\n")
		const files = inspectTrace(trace, "", "0 packets dropped by kernel", []).files
		assert.equal(files.complete, false)
		assert.match(files.reason ?? "", /symbolic link/)
	}
})

test("Bun hardlinks anonymous temporary inodes into the project", () => {
	const trace = [
		'2 execve("/usr/bin/env", [], []) = 0',
		'2 linkat(5</project/.cache/#123>(deleted), "", 6</project/node_modules>, "pkg", AT_EMPTY_PATH) = 0',
	].join("\n")
	assert.deepEqual(inspectTrace(trace, "", "0 packets dropped by kernel", []).files, { complete: true, findings: [] })
})

test("network observation traces all outbound address-bearing calls and keeps unfinished sends inconclusive", () => {
	// inspect an unfinished system call under network observation
	const args = guestArguments({ argv: ["true"], timeoutMs: 1000, observe: "network" }, "/evidence")
	assert.ok(args.includes("trace=execve,connect,sendto,sendmsg,sendmmsg"))
	const inspect = (name: string): ReturnType<typeof inspectTrace> =>
		inspectTrace(
			`1 execve("/usr/bin/env", [], []) = 0\n2 ${name}(3, <unfinished ...>`,
			"",
			"0 packets dropped by kernel",
			[],
		)

	// distinguish inbound calls from outbound sends and writes
	assert.equal(inspect("recvfrom").connections.complete, true)
	assert.equal(inspect("recvfrom").files.complete, true)
	assert.equal(inspect("write").files.complete, false)
	assert.equal(inspect("sendto").connections.complete, false)
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

	// verify that only the integrity reader receives the read-only inventory
	const read = args([...base, "integrity", "100"], tests.capture).argv
	assert.deepEqual(read.slice(read.indexOf("/inspection-inventory") - 2, read.indexOf("/inspection-inventory") + 1), [
		"--ro-bind",
		tests.capture + "/inventory",
		"/inspection-inventory",
	])
	assert.equal(args(["bun", "run", "test"], tests.capture).argv.includes("/inspection-inventory"), false)
})

test("pinned runner setup and test-only helpers stay protected outside test folders", async () => {
	const { protectedTestFiles } = await import("../guest/protectTestSupport.ts")
	const files: Record<string, string> = {
		"package.json": JSON.stringify({ scripts: { test: "jest --config ./configuration.json" } }),
		"configuration.json": JSON.stringify({ rootDir: "./src", setupFiles: ["<rootDir>/jestSetup.ts"] }),
		"src/jestSetup.ts": "",
		"src/alternative.ts": "",
		"pkg/tsconfig.json": '{"extends":["../tsconfig.json","../other.json"],"compilerOptions":{"baseUrl":"."}}',
		"other.json": '{"compilerOptions":{"paths":{"choice":["one","two"]}}}',
		"pkg/one.ts": "",
		"pkg/two.ts": "",
		"pkg/main.ts": 'import "choice"; import "@support/alternative"',
		"pkg/main.test.ts": 'import "./two"; import "../src/alternative"',

		"tsconfig.json": '{"extends":"./config/base"}',
		"config/base.json": '{"compilerOptions":{"baseUrl":"..","paths":{"@support/*":["src/*"]}}}',
		"bunfig.toml": '[test]\npreload=["./src/bootstrap.ts"]',
		"src/bootstrap.ts": 'import "./environment"',
		"src/environment.ts": "",
		"src/widget.ts": "export const widget = 1",
		"src/fixtureHelper.ts": "",
		"src/app.ts": 'import "./widget"',
		"src/widget.test.ts": 'import "./widget"; import "@support/fixtureHelper"',
	}

	// find test support through runner configuration and import aliases
	const blocked = protectedTestFiles(
		Object.keys(files),
		["src/widget.test.ts", "pkg/main.test.ts"],
		(file) => files[file] ?? "",
	)

	// require the runner's setup dependencies to remain protected
	assert.ok(blocked.has("src/bootstrap.ts"))
	assert.ok(blocked.has("src/environment.ts"))
	assert.ok(blocked.has("src/jestSetup.ts"))
	assert.ok(blocked.has("configuration.json"))

	// distinguish test-only imports from shared production dependencies
	assert.ok(blocked.has("pkg/two.ts"))
	assert.ok(blocked.has("src/alternative.ts"))
	assert.equal(blocked.has("pkg/one.ts"), false)
	assert.ok(blocked.has("src/fixtureHelper.ts"))
	assert.equal(blocked.has("src/widget.ts"), false)
	assert.throws(() => protectedTestFiles(["vitest.config.ts"], [], () => "export default loadConfig()"), /Dynamic/)
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
