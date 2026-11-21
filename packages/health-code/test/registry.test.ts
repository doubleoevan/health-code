import assert from "node:assert/strict"
import { test } from "node:test"
import { fetchRegistryVersions } from "../guest/fetchRegistryVersions.ts"

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
		const card = await inspectRepository({
			repositoryUrl: fixtureUrl,
			sandboxProvider,
			limits: { timeouts: { registry: 25 } },
		})
		assert.match(card.selection.registryLookupIssue ?? "", /registry lookup timed out/)
		assert.deepEqual(actions, ["detect", "registry"])
		assert.ok(card.timeline.some((event) => event.type === "sandbox.event" && event.action === "deleted"))
	} finally {
		pending.reject(new Error("Released buffered command"))
	}

	// A missing package may have the same name as a property on Object.prototype.
	assert.deepEqual(selectUpgrades(project, {}, 1).selected, [])
})
