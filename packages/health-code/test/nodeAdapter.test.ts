import assert from "node:assert/strict"
import { type SpawnSyncReturns, spawnSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { inspectTrace } from "../guest/observe.ts"
import { confirm } from "../src/checkProject.ts"
import type { CheckResult, Project } from "../src/contracts.ts"
import { selectUpgrades } from "../src/selectUpgrades.ts"

const recorded = fileURLToPath(new URL("./fixtures/recorded/", import.meta.url))
const entry = fileURLToPath(new URL("../guest/project.ts", import.meta.url))

function fixture(
	name: string,
	work: (cwd: string, invoke: (args: string[]) => SpawnSyncReturns<string>) => void,
): void {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "health-code-fixture-")))
	try {
		const cwd = join(dir, "project")
		cpSync(join(recorded, name), cwd, { recursive: true, filter: (path) => !path.endsWith("node_modules") })
		if (name === "bun-binary") {
			const bytes = Buffer.from(readFileSync(join(cwd, "bun.lockb.base64"), "utf8"), "base64")
			writeFileSync(join(cwd, "bun.lockb"), bytes)
		}
		const bin = join(dir, "bin")
		mkdirSync(bin)
		for (const manager of ["yarn", "npm", "pnpm"]) {
			writeFileSync(
				join(bin, manager),
				'#!/bin/sh\nif [ "$1" = --version ]; then echo 10; else echo "$@" > invocation; fi\n',
				{ mode: 0o755 },
			)
		}
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
for (const name of ["npm", "pnpm", "bun", "bun-binary", "yarn", "yarn-modern"]) {
	test(`detects recorded ${name} inputs`, () =>
		fixture(name, (_cwd, invoke) => {
			const result = invoke(["detect"])
			assert.equal(result.status, 0, result.stderr)
			const project = JSON.parse(result.stdout) as Project
			assert.equal(project.manager, name.split("-")[0])
			assert.ok(Object.values(project.sources).length)
			if (name === "bun-binary") {
				assert.deepEqual(project.sources["is-number"], { ".": "7.0.0" })
			}
			if (name === "pnpm") {
				assert.deepEqual(project.sources.widget, { ".": "1.2.0", "packages/child": "1.1.0" })
				assert.equal(project.typecheck, "build")
			}
		}))
}
test("bumps all declaring workspaces and uses the original manager lifecycle policy", () =>
	fixture("pnpm", (cwd, invoke) => {
		assert.equal(invoke(["install"]).status, 0)
		assert.match(readFileSync(join(cwd, "invocation"), "utf8"), /--frozen-lockfile/)
		assert.equal(invoke(["install", "widget", "2.0.0"]).status, 0)
		for (const dir of [".", "packages/child"]) {
			assert.equal(JSON.parse(readFileSync(resolve(cwd, dir, "package.json"), "utf8")).dependencies.widget, "2.0.0")
		}
		assert.equal(readFileSync(join(cwd, "invocation"), "utf8").trim(), "install --no-frozen-lockfile")
	}))
test("ambiguous lockfiles and environment names", () =>
	fixture("npm", (cwd, invoke) => {
		writeFileSync(join(cwd, ".env.example"), "APP_SECRET=sample\n")
		writeFileSync(join(cwd, "index.js"), 'process.env["ANOTHER_NAME"]')
		assert.deepEqual(JSON.parse(invoke(["detect"]).stdout).environment, ["ANOTHER_NAME", "APP_SECRET"])
		writeFileSync(join(cwd, "package.json"), "{}")
		writeFileSync(join(cwd, "yarn.lock"), "")
		assert.notEqual(invoke(["detect"]).status, 0)
	}))
test("parses file-load failures and preserves opaque script evidence", () =>
	fixture("npm", (cwd, invoke) => {
		mkdirSync(join(cwd, ".health-code"))
		writeFileSync(
			join(cwd, ".health-code/test-results"),
			JSON.stringify({ testResults: [{ name: join(cwd, "load.test.ts"), assertionResults: [], status: "failed" }] }),
		)
		assert.deepEqual(JSON.parse(invoke(["report"]).stdout).failures, [{ workspace: ".", file: "load.test.ts" }])
		writeFileSync(
			join(cwd, ".health-code/test-results"),
			'<testsuites><testsuite name="suite.ts"><testcase name="case"><failure>failed</failure></testcase></testsuite></testsuites>',
		)
		assert.deepEqual(JSON.parse(invoke(["report"]).stdout).failures, [
			{ workspace: ".", file: "suite.ts", name: "case" },
		])
	}))
test("bounds selection deterministically and excludes patch and prerelease candidates", () => {
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
	const evidence = inspectTrace(trace, dns, "0 packets dropped by kernel", [])
	assert.deepEqual(evidence.connections.findings, [
		{ kind: "connection", destination: "example.org", outcome: "attempted" },
	])
	assert.deepEqual(evidence.files.findings, [{ kind: "write", path: "/tmp/outside" }])
	assert.equal(inspectTrace(trace, "", "1 packets dropped by kernel", []).connections.complete, false)
})
test("opaque baseline and non-reproducing failures remain untested", async () => {
	const failed: CheckResult = { status: "failed", evidence: [], failingTests: [] }
	const passed: CheckResult = { status: "passed", evidence: [] }
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
		const project = JSON.parse(invoke(["detect"]).stdout)
		assert.equal(project.sources.widget["packages/build"], "1.2.0")
		assert.ok(project.skipped.includes("large.js: environment scan file limit"))
	}))
