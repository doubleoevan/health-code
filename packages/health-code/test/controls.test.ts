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
import { fixtureCommit, fixtureUrl } from "./providerContract.ts"

test("verifies the complete allowlist before any repository-controlled command", async () => {
	const sandboxProvider = createFakeSandboxProvider({ commit: fixtureCommit, commands: [] })
	let executed = false
	let released = false
	sandboxProvider.setNetworkPolicy = async () =>
		confirmNetworkPolicy(["registry.npmjs.org"], { mode: "denylist", allowedHosts: [], deniedHosts: [] })
	sandboxProvider.executeCommand = async () => {
		executed = true
		throw Error("unexpected repository execution")
	}
	sandboxProvider.destroySandbox = async () => {
		released = true
	}
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
	assert.equal(card.repository.commit, fixtureCommit)
	assert.deepEqual(card.packageManager, { reason: "Unsupported project" })
})
test("unavailable repository releases its sandbox before any repository code executes", async () => {
	const sandboxProvider = createFakeSandboxProvider({ commit: fixtureCommit, commands: [] })
	let destroyed = false
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
	const result = inspectTrace(trace, "", "0 packets dropped by kernel", [], ["/project/dir/link"])
	assert.equal(result.files.complete, false)
	assert.deepEqual(result.files.findings, [{ kind: "write", path: "/tmp/outside" }])
})
