import assert from "node:assert/strict"
import { type SpawnSyncReturns, spawnSync } from "node:child_process"
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	truncateSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { inspectSandboxActivity } from "../guest/inspectSandboxActivity.ts"
import { pageFileAndHookEntries } from "../guest/readPatchVerificationInputs.ts"
import { readSystemCallLogLines } from "../guest/readSystemCallLogLines.ts"
import { confirm } from "../src/checks/confirmCheck.ts"
import type { CheckResult, Project } from "../src/contracts.ts"
import { formatManifest } from "../src/patches/formatManifest.ts"
import { maxSystemCallLogBytes } from "../src/sandbox/maxSystemCallLogBytes.ts"
import { selectUpgrades } from "../src/upgrades/selectUpgrades.ts"

const recorded = fileURLToPath(new URL("./fixtures/recorded/", import.meta.url))
const entry = fileURLToPath(new URL("../guest/project.ts", import.meta.url))

function fixture(
	name: string,
	work: (cwd: string, invoke: (args: string[]) => SpawnSyncReturns<string>) => void,
): void {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "health-code-fixture-")))
	try {
		// copy the recorded project into a disposable checkout
		const cwd = join(dir, "project")
		cpSync(join(recorded, name), cwd, { recursive: true, filter: (path) => !path.endsWith("node_modules") })

		// restore the binary lockfile from its recorded bytes
		if (name === "bun-binary") {
			const bytes = Buffer.from(readFileSync(join(cwd, "bun.lockb.base64"), "utf8"), "base64")
			writeFileSync(join(cwd, "bun.lockb"), bytes)
		}

		// capture package-manager arguments with temporary executables
		const bin = join(dir, "bin")
		mkdirSync(bin)
		for (const manager of ["yarn", "npm", "pnpm"]) {
			writeFileSync(
				join(bin, manager),
				'#!/bin/sh\nif [ "$1" = --version ]; then echo 10; else echo "$@" > invocation; fi\n',
				{ mode: 0o755 },
			)
		}

		// run the guest with the recording executables first on its path
		work(cwd, (args) =>
			spawnSync(process.execPath, [entry, ...args], {
				cwd,
				encoding: "utf8",
				env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
			}),
		)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

// run package discovery for every recorded lockfile format
for (const name of ["npm", "pnpm", "bun", "bun-binary", "yarn", "yarn-modern"]) {
	test(`detects recorded ${name} inputs`, () =>
		fixture(name, (_cwd, invoke) => {
			const result = invoke(["detect"])
			assert.equal(result.status, 0, result.stderr)

			// compare the detected manager with the fixture family
			const project = JSON.parse(result.stdout) as Project
			assert.equal(project.manager, name.split("-")[0])
			assert.ok(Object.values(project.sources).length)
			if (name === "bun-binary") {
				assert.deepEqual(project.sources["is-number"], { ".": "7.0.0" })
			}

			// verify that pnpm preserves per-workspace versions and the build script
			if (name === "pnpm") {
				assert.deepEqual(project.sources.widget, { ".": "1.2.0", "packages/child": "1.1.0" })
				assert.equal(project.typecheck, "build")
			}
		}))
}
test("bumps all declaring workspaces and uses the original manager lifecycle policy", () =>
	fixture("pnpm", (cwd, invoke) => {
		// check the frozen install policy on the unchanged project
		assert.equal(invoke(["install"]).status, 0)
		assert.match(readFileSync(join(cwd, "invocation"), "utf8"), /--frozen-lockfile/)

		// update every declaring workspace and check the upgrade install arguments
		assert.equal(invoke(["install", "widget", "2.0.0"]).status, 0)
		for (const dir of [".", "packages/child"]) {
			assert.equal(JSON.parse(readFileSync(resolve(cwd, dir, "package.json"), "utf8")).dependencies.widget, "2.0.0")
		}
		assert.equal(readFileSync(join(cwd, "invocation"), "utf8").trim(), "install --no-frozen-lockfile")
	}))
test("removes npm lockfile entries that differ from an exact version", () =>
	fixture("npm", (cwd, invoke) => {
		// lock an outdated package with a nested copy beside a matching package
		const lockfile = join(cwd, "package-lock.json")
		const packages = {
			"node_modules/widget": { version: "1.2.0" },
			"node_modules/widget/node_modules/gadget": { version: "1.0.0" },
			"node_modules/widget-extra": { version: "1.0.0" },
			"node_modules/ranged": { version: "1.0.0" },
		}

		// require a newer exact version of the outdated package
		writeFileSync(lockfile, JSON.stringify({ lockfileVersion: 3, packages }, null, "\t"))
		const manifest = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"))
		manifest.dependencies = { widget: "2.0.0", "widget-extra": "1.0.0", ranged: "^2.0.0" }
		writeFileSync(join(cwd, "package.json"), JSON.stringify(manifest))

		// leave the frozen Baseline install untouched
		const original = readFileSync(lockfile, "utf8")
		assert.equal(invoke(["install"]).status, 0)
		assert.equal(readFileSync(lockfile, "utf8"), original)

		// remove only the outdated package before npm resolves the changed set
		for (const command of ["--update-lock", "--resolve-lock"]) {
			writeFileSync(lockfile, original)
			const result = invoke(["install", command])
			assert.equal(result.status, 0, result.stderr)

			// keep the original indentation and the remaining entries
			const text = readFileSync(lockfile, "utf8")
			assert.match(text, /\n\t"packages"/)
			assert.deepEqual(Object.keys(JSON.parse(text).packages), ["node_modules/widget-extra", "node_modules/ranged"])
		}
	}))
test("a version change keeps the manifest's formatting", () => {
	// start from tabs and an inline array
	const text = '{\n\t"name": "app",\n\t"files": ["a", "b"],\n\t"dependencies": {\n\t\t"widget": "^1.0.0"\n\t}\n}\n'
	const manifest = { name: "app", files: ["a", "b"], dependencies: { widget: "2.0.0" } }

	// change only the version text
	assert.equal(formatManifest(text, manifest), text.replace("^1.0.0", "2.0.0"))

	// insert and remove dependencies with the file's own indentation
	const added = { ...manifest, dependencies: { ...manifest.dependencies, gadget: "1.0.0" } }
	const result = formatManifest(text, added)
	assert.match(result, /\n\t\t"gadget": "1\.0\.0"\n/)
	assert.equal(formatManifest(result, manifest), text.replace("^1.0.0", "2.0.0"))
})
test("ambiguous lockfiles and environment names", () =>
	fixture("npm", (cwd, invoke) => {
		// collect environment names from example settings and source
		writeFileSync(join(cwd, ".env.example"), "APP_SECRET=sample\n")
		writeFileSync(join(cwd, "index.js"), 'process.env["ANOTHER_NAME"]')
		assert.deepEqual(JSON.parse(invoke(["detect"]).stdout).environment, ["ANOTHER_NAME", "APP_SECRET"])

		// add a conflicting lockfile without an explicit manager
		writeFileSync(join(cwd, "package.json"), "{}")
		writeFileSync(join(cwd, "yarn.lock"), "")
		assert.notEqual(invoke(["detect"]).status, 0)
	}))
test("lists install scripts that package managers run", () =>
	fixture("npm", (cwd, invoke) => {
		// give the root and one installed package both kinds of script
		writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "root", scripts: { prepare: "root" } }))
		mkdirSync(join(cwd, "node_modules/widget"), { recursive: true })
		writeFileSync(
			join(cwd, "node_modules/widget/package.json"),
			JSON.stringify({ name: "widget", scripts: { prepare: "build", postinstall: "node setup.js" } }),
		)

		// skip the preparation script of a registry package
		const signatures: string[] = JSON.parse(invoke(["lifecycle"]).stdout)
		assert.deepEqual(
			signatures.map((signature) => JSON.stringify(signature)).filter((text) => text.includes("prepare")).length,
			1,
		)
		assert.equal(signatures.filter((signature) => JSON.stringify(signature).includes("postinstall")).length, 1)
	}))
test("parses file-load failures and preserves opaque script evidence", () =>
	fixture("npm", (cwd, invoke) => {
		// write a runner result for a suite that failed during loading
		mkdirSync(join(cwd, ".health-code"))
		writeFileSync(
			join(cwd, ".health-code/test-results"),
			JSON.stringify({ testResults: [{ name: join(cwd, "load.test.ts"), assertionResults: [], status: "failed" }] }),
		)
		assert.deepEqual(JSON.parse(invoke(["report"]).stdout).failures, [{ workspace: ".", file: "load.test.ts" }])

		// replace the suite-level failure with a named case failure
		writeFileSync(
			join(cwd, ".health-code/test-results"),
			'<testsuites><testsuite name="suite.ts"><testcase name="case"><failure>failed</failure></testcase></testsuite></testsuites>',
		)
		assert.deepEqual(JSON.parse(invoke(["report"]).stdout).failures, [
			{ workspace: ".", file: "suite.ts", name: "case" },
		])
	}))
test("bounds selection deterministically and excludes patch and prerelease targets", () => {
	const dependencies = Object.fromEntries("ihgfedcba".split("").map((n) => [n, { ".": "1.0.0" }]))
	const project: Project = {
		manager: "npm",
		version: "11",
		sources: dependencies,
		skipped: [],
		typecheck: "none",
		environment: [],
	}
	const registry = Object.fromEntries(
		Object.keys(dependencies).map((n) => [n, ["3.0.0-beta.1", "1.0.1", "2.0.0", "1.2.0"]]),
	)

	// check deterministic selection under the upgrade limit
	const selected = selectUpgrades(project, registry, 6)
	assert.equal(selected.eligible.length, 18)
	assert.deepEqual(
		selected.selected.map((u) => u.dependency),
		"abcdef".split(""),
	)
})
test("tracks observed destinations and transient writes with explicit uncertainty", () => {
	const trace = [
		'1 execve("/usr/bin/env", [], []) = 0',
		'1 3.000000 connect(3, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr("192.0.2.5")}, 16) = -1 EINPROGRESS',
		'1 write(4</tmp/outside>, "x", 1) = 1',
	].join("\n")
	const dns =
		"1 IP 10.0.0.2.123 > 10.0.0.1.53: 10+ A? example.org. (29)\n2 IP 10.0.0.1.53 > 10.0.0.2.123: 10 1/0/0 A 192.0.2.5"

	// verify the attempted destination against earlier dns evidence
	const evidence = inspectSandboxActivity(trace, dns, "0 packets dropped by kernel", [])
	assert.deepEqual(evidence.connections.findings, [
		{ kind: "connection", destination: "example.org", outcome: "attempted" },
	])

	// check filesystem attribution and explicitly dropped packets
	assert.deepEqual(evidence.files.findings, [{ kind: "write", path: "/tmp/outside" }])
	assert.equal(inspectSandboxActivity(trace, "", "1 packets dropped by kernel", []).connections.complete, false)
})
test("wildcard and mapped loopback sockets stay local while raw addresses are named", () => {
	const connect = (address: string): string =>
		`1 execve("/usr/bin/env", [], []) = 0\n1 3.000000 connect(3, {sa_family=AF_INET6, sin6_port=htons(80), inet_pton(AF_INET6, "${address}", &sin6_addr)}, 28) = 0`
	for (const address of ["::1", "::", "::ffff:127.0.0.1"]) {
		assert.equal(
			inspectSandboxActivity(connect(address), "", "0 packets dropped by kernel", []).connections.complete,
			true,
		)
	}

	// name the address behind incomplete coverage
	const { connections } = inspectSandboxActivity(connect("2001:db8::1"), "", "0 packets dropped by kernel", [])
	assert.match(connections.reason ?? "", /2001:db8::1/)
})
test("repeated npm failures match across log timestamps", async () => {
	// record the same npm failure under a different log name
	const failure = (time: string): CheckResult => ({
		status: "failed",
		failingTests: [],

		// include the complete command output
		evidence: [
			{
				stdout: "",
				stderr: `npm error ERESOLVE\nnpm error A complete log of this run: /logs/${time}-debug-0.log`,
				exitCode: 1,
				durationMs: 1,
				stdoutTruncated: false,
				stderrTruncated: false,
			},
		],
	})
	const passed: CheckResult = { status: "passed", evidence: [] }

	// compare the same error from two log files
	const result = await confirm(failure("2026-11-23T21_31_25_884Z"), passed, async () =>
		failure("2026-11-23T21_31_40_112Z"),
	)
	assert.equal(result.status, "failed")
})
test("calls killed before execution leave network coverage complete", () => {
	// read coverage for one recorded process
	const start = '1 execve("/usr/bin/env", [], []) = 0\n'
	const read = (line: string): boolean =>
		inspectSandboxActivity(start + line, "", "0 packets dropped by kernel", []).connections.complete

	// allow only a call that never ran
	assert.equal(read("2 1.000000 ????( <unfinished ...>"), true)
	assert.equal(read("2 1.000000 connect(3, <unfinished ...>"), false)

	// keep a call interrupted twice incomplete until it returns
	const twice = "2 1.0 connect(3, <unfinished ...>\n2 1.1 <... connect resumed> <unfinished ...>"
	assert.equal(read(twice), false)
	assert.equal(read(`${twice}\n2 1.2 <... connect resumed>{sa_family=AF_UNIX, sun_path="/x"}, 8) = 0`), true)
})
test("opaque baseline and non-reproducing failures remain untested", async () => {
	const failed: CheckResult = { status: "failed", evidence: [], failingTests: [] }
	const passed: CheckResult = { status: "passed", evidence: [] }

	// keep opaque or transient failures untested
	assert.equal((await confirm(failed, failed, async () => failed)).status, "untested")
	assert.equal((await confirm(failed, passed, async () => passed)).status, "untested")
})

test("Git shorthand is never treated as a registry dependency", () =>
	fixture("npm", (cwd, invoke) => {
		writeFileSync(join(cwd, "package.json"), JSON.stringify({ dependencies: { widget: "example/widget#main" } }))
		const data = JSON.parse(invoke(["detect"]).stdout)
		assert.deepEqual(data.sources, {})
		assert.match(data.skipped.join(" "), /widget/)
	}))

test("Bun workspace resolutions use the workspace name from the lockfile", () =>
	fixture("bun", (cwd, invoke) => {
		mkdirSync(join(cwd, "packages/app"), { recursive: true })
		writeFileSync(
			join(cwd, "package.json"),
			JSON.stringify({ workspaces: ["packages/*"], dependencies: { widget: "1" } }),
		)
		writeFileSync(
			join(cwd, "packages/app/package.json"),
			JSON.stringify({ name: "app", dependencies: { widget: "2" } }),
		)

		// record distinct resolutions for the root and named workspace
		writeFileSync(
			join(cwd, "bun.lock"),
			JSON.stringify({
				workspaces: { "packages/app": { name: "app" } },
				packages: { widget: ["widget@1.0.0"], "app/widget": ["widget@2.0.0"] },
			}),
		)
		assert.deepEqual(JSON.parse(invoke(["detect"]).stdout).sources.widget, { ".": "1.0.0", "packages/app": "2.0.0" })
	}))

test("an opaque first failure does not confirm a named failure on retry", async () => {
	const failed: CheckResult = { status: "failed", failingTests: [], evidence: [] }
	const retry: CheckResult = { ...failed, failingTests: [{ workspace: ".", file: "index.test.ts", name: "named" }] }
	const result = await confirm(failed, { status: "passed", evidence: [] }, async () => retry)
	assert.equal(result.status, "untested")
})

test("npm inventory honors shrinkwrap precedence and preserves matching direct overrides", () =>
	fixture("npm", (cwd, invoke) => {
		const manifest = { dependencies: { widget: "1.2.0" }, overrides: { widget: { ".": "1.2.0", child: "3.0.0" } } }
		writeFileSync(join(cwd, "package.json"), JSON.stringify(manifest))
		writeFileSync(
			join(cwd, "npm-shrinkwrap.json"),
			JSON.stringify({ packages: { "node_modules/widget": { version: "1.2.1" } } }),
		)

		// verify that the upgrade keeps the nested override intact
		assert.equal(JSON.parse(invoke(["detect"]).stdout).sources.widget["."], "1.2.1")
		assert.equal(invoke(["install", "widget", "2.0.0"]).status, 0)
		assert.deepEqual(JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")).overrides.widget, {
			".": "2.0.0",
			child: "3.0.0",
		})
	}))

test("an oversized source file does not hide dependency evidence or a workspace named build", () =>
	fixture("npm", (cwd, invoke) => {
		mkdirSync(join(cwd, "packages/build"), { recursive: true })
		writeFileSync(join(cwd, "packages/build/package.json"), JSON.stringify({ dependencies: { widget: "1.2.0" } }))
		writeFileSync(join(cwd, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }))
		writeFileSync(join(cwd, "large.js"), " ".repeat(1024 * 1024 + 1))

		// check that the environment scan limit preserves workspace dependency evidence
		const project = JSON.parse(invoke(["detect"]).stdout)
		assert.equal(project.sources.widget["packages/build"], "1.2.0")
		assert.ok(project.skipped.includes("large.js: environment scan file limit"))
	}))

test("streamed install evidence preserves split records and rejects truncated captures", () => {
	const directory = mkdtempSync(join(tmpdir(), "install-trace-"))
	const path = join(directory, "syscalls")
	try {
		const row = "x".repeat(256 * 1024 - 1) + "é"
		writeFileSync(path, row + "\nnext\n")
		assert.deepEqual([...readSystemCallLogLines(path)], [row, "next"])

		// Require both the final record boundary and the collector's overflow marker.
		writeFileSync(path, "partial")
		assert.throws(() => [...readSystemCallLogLines(path)], /ended during/)
		truncateSync(path, maxSystemCallLogBytes + 1)
		assert.throws(() => [...readSystemCallLogLines(path)], /exceeded/)
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
})

test("patch verification pages preserve paths, lifecycle hooks and test file errors beyond the transport limit", () => {
	const projectFilePaths = Array.from({ length: 2400 }, (_, index) => `${"a".repeat(500)}/${index}.ts`)
	const fileAndHookEntries = {
		projectFilePaths,
		lifecycleHookSignatures: ["postinstall"],
		discoveredTestFiles: ["unit.test.ts"],
		testFileErrors: ["load failed"],
	}
	const first = pageFileAndHookEntries(fileAndHookEntries, {
		cases: [["unit.test.ts", "passes", "passed"]],
		fileAndHookEntryOffset: 0,
	})
	assert.ok(first.nextFileAndHookEntryOffset)

	// Read the continuation at the entry offset the sandbox returned.
	const second = pageFileAndHookEntries(fileAndHookEntries, {
		cases: [],
		fileAndHookEntryOffset: first.nextFileAndHookEntryOffset,
	})
	assert.equal(second.nextFileAndHookEntryOffset, undefined)
	assert.deepEqual([...first.projectFilePaths, ...second.projectFilePaths], projectFilePaths)
	assert.deepEqual(second.testFileErrors, fileAndHookEntries.testFileErrors)
	assert.deepEqual(second.discoveredTestFiles, fileAndHookEntries.discoveredTestFiles)
	assert.deepEqual(second.lifecycleHookSignatures, fileAndHookEntries.lifecycleHookSignatures)
	assert.ok(Buffer.byteLength(JSON.stringify(first)) < 1024 * 1024)
})
