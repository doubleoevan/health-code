import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fetchRegistryVersions } from "../guest/fetchRegistryVersions.ts"
import { readReleaseAge } from "../guest/readReleaseAge.ts"

import { type CommandResult, createFakeSandboxProvider, inspectRepository } from "../src/index.ts"
import { buildTestCommand } from "../src/sandbox/executeTests.ts"
import { selectUpgrades } from "../src/selectUpgrades.ts"
import { fixtureCommit, fixtureUrl } from "./providerContract.ts"

test("a 200-package registry lookup keeps sixteen workers busy and retains every result", async () => {
	const names = Array.from({ length: 200 }, (_, index) => `@fixture/package-${index}`)
	const requested: string[] = []
	const first = Promise.withResolvers<void>()
	let active = 0
	let peak = 0

	const result = await fetchRegistryVersions(names, {
		request: async (url, options) => {
			const name = decodeURIComponent(new URL(url).pathname.slice(1))
			assert.ok(options.signal instanceof AbortSignal)
			requested.push(name)
			active++
			peak = Math.max(peak, active)

			// Hold one slow response until the other workers have reached the final package.
			if (name === names[0]) {
				await first.promise
			} else if (name === names.at(-1)) {
				first.resolve()
			}
			await Promise.resolve()
			active--
			return Response.json({ versions: { "1.0.0": {}, "1.1.0": {} } })
		},
	})

	// Check the ceiling, work sharing and completeness independently.
	assert.equal(peak, 16)
	assert.deepEqual(requested.toSorted(), names.toSorted())
	for (const name of names) {
		assert.deepEqual(result[name], ["1.1.0"])
	}
})

test("a minimum release age selects the newest release the repository would install", async () => {
	const time = { "1.0.0": "2026-01-01", "1.1.0": "2026-02-01", "1.2.0": "2026-03-01" }
	const versions = { "1.0.0": {}, "1.1.0": {}, "1.2.0": {}, "1.3.0": {} }
	const accepted: Record<string, string | null> = {}
	const result = await fetchRegistryVersions(["aged", "@scope/exempt"], {
		releaseAge: { publishedBefore: Date.parse("2026-02-15"), excluded: ["@scope/*"] },
		request: async (url, options) => {
			const name = decodeURIComponent(new URL(url).pathname.slice(1))
			accepted[name] = new Headers(options.headers).get("accept")
			return Response.json({ versions, time })
		},
	})

	// Missing publish dates stay ineligible, and exempt packages keep the smaller request.
	assert.deepEqual({ ...result }, { aged: ["1.1.0"], "@scope/exempt": ["1.3.0"] })
	assert.equal(accepted.aged, "application/json")
	assert.equal(accepted["@scope/exempt"], "application/vnd.npm.install-v1+json")
})

test("release age reads each package manager's effective setting", () => {
	const read = (
		manager: "npm" | "pnpm" | "yarn",
		settings: Record<string, string>,
	): ReturnType<typeof readReleaseAge> => readReleaseAge(manager, ([name]) => settings[name ?? ""] ?? "undefined\n")
	assert.equal(read("npm", { before: "null\n" }), undefined)
	assert.equal(read("npm", { before: "2026-11-20T00:00:00.000Z\n" })?.publishedBefore, Date.parse("2026-11-20"))
	assert.equal(read("pnpm", {}), undefined)
	assert.equal(read("yarn", { npmMinimalAgeGate: "0\n" }), undefined)

	// pnpm and yarn measure the age in minutes
	for (const [manager, age, exclusions] of [
		["pnpm", "minimumReleaseAge", "minimumReleaseAgeExclude"],
		["yarn", "npmMinimalAgeGate", "npmPreapprovedPackages"],
	] as const) {
		const policy = read(manager, { [age]: "4320\n", [exclusions]: '["foo"]\n' })
		assert.ok(Math.abs(Date.now() - 3 * 86_400_000 - (policy?.publishedBefore ?? 0)) < 5000)
		assert.deepEqual(policy?.excluded, ["foo"])
	}
	assert.throws(() => read("pnpm", { minimumReleaseAge: "soon" }), /Unsupported minimum release age/)
})

test("release age reads Bun's project configuration in seconds", () => {
	const root = mkdtempSync(join(tmpdir(), "health-code-"))
	const directory = process.cwd()
	try {
		process.chdir(root)
		assert.equal(readReleaseAge("bun"), undefined)

		// Add a three-day policy with one exempt package.
		writeFileSync("bunfig.toml", '[install]\nminimumReleaseAge = 259200\nminimumReleaseAgeExcludes = ["foo"]\n')
		const policy = readReleaseAge("bun")
		assert.ok(Math.abs(Date.now() - 259_200_000 - (policy?.publishedBefore ?? 0)) < 5000)
		assert.deepEqual(policy?.excluded, ["foo"])
	} finally {
		// return to the test runner's directory before removing the fixture
		process.chdir(directory)
		rmSync(root, { recursive: true, force: true })
	}
})

test("an oversized registry response is cancelled while other lookups succeed", async () => {
	let cancelled = false
	const large = new ReadableStream<Uint8Array>({
		pull(controller) {
			controller.enqueue(new Uint8Array(1024 * 1024))
		},
		cancel() {
			cancelled = true
		},
	})

	const result = await fetchRegistryVersions(["large", "small"], {
		request: async (url) =>
			url.endsWith("/large") ? new Response(large) : Response.json({ versions: { "1.1.0": {} } }),
	})
	assert.ok(cancelled)
	assert.equal(result.large, "unavailable")
	assert.deepEqual(result.small, ["1.1.0"])
})

test("registry stage expiry keeps completed results and skips queued requests", async () => {
	const deadline = new AbortController()
	const names = Array.from({ length: 20 }, (_, index) => `package-${index}`)
	const requested: string[] = []
	const result = await fetchRegistryVersions(names, {
		signal: deadline.signal,
		request: async (url, options) => {
			const name = new URL(url).pathname.slice(1)
			requested.push(name)
			if (name === names[0]) {
				return Response.json({ versions: { "1.1.0": {} } })
			}

			// The first worker to finish triggers the deadline when it picks up another package.
			if (name === names[16]) {
				deadline.abort()
			}
			const signal = options.signal
			assert.ok(signal)
			signal.throwIfAborted()
			return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))
		},
	})

	assert.deepEqual(result["package-0"], ["1.1.0"])
	assert.equal(requested.length, 17)
	for (const name of names.slice(1)) {
		assert.equal(result[name], "stage-timed-out")
	}
})

test("the registry command leaves time for Runta to return completed lookups", () => {
	const command = { argv: ["node", "/opt/health-code/project.mjs", "registry", "widget"], timeoutMs: 1000 }
	const { argv } = buildTestCommand({ command, id: "test" })
	assert.ok(argv.includes("--timeout-ms=750"))
})

test("a host deadline returns the partial report and deletes the busy sandbox", async () => {
	const sources = { constructor: { ".": "1.0.0" } }
	const project = {
		manager: "npm" as const,
		version: "10",
		sources,
		skipped: [],
		typecheck: "none" as const,
		environment: [],
	}
	const sandboxProvider = createFakeSandboxProvider({
		commit: fixtureCommit,
		commands: [
			{ argv: ["node", "/opt/health-code/project.mjs", "detect"], result: { stdout: JSON.stringify(project) } },
		],
	})

	// Hold the remote command open until after the host returns its report.
	const pending = Promise.withResolvers<CommandResult>()
	const execute = sandboxProvider.executeCommand.bind(sandboxProvider)
	const actions: string[] = []

	// Record every dispatch to catch attempts to install while the registry command is still running.
	sandboxProvider.executeCommand = async (sandbox, command) => {
		const action = command.argv[2]
		assert.ok(action)
		actions.push(action)
		return action === "registry" ? pending.promise : execute(sandbox, command)
	}

	try {
		const report = await inspectRepository({
			repositoryUrl: fixtureUrl,
			sandboxProvider,
			limits: { timeouts: { registry: 25 } },
		})
		assert.match(report.selection.registryLookupIssue ?? "", /registry lookup timed out/)
		assert.deepEqual(actions, ["detect", "registry"])
		assert.ok(report.timeline.some((event) => event.type === "sandbox.event" && event.action === "deleted"))
	} finally {
		pending.reject(new Error("Released buffered command"))
	}

	// A missing package may have the same name as a property on Object.prototype.
	assert.deepEqual(selectUpgrades(project, {}, 1).selected, [])
})
