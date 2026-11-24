import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import {
	createFakeSandboxProvider,
	createSandboxProvider,
	InspectionError,
	type InspectionEvent,
	inspectRepository,
} from "../src/index.ts"
import { fixtureCommit, fixtureUrl } from "./providerContract.ts"

function offline(
	output = "TOKEN=private-sample",
	commit = fixtureCommit,
): ReturnType<typeof createFakeSandboxProvider> {
	return createFakeSandboxProvider({
		commit,
		commands: [
			{
				argv: ["node", "/opt/health-code/project.mjs", "detect"],
				result: {
					stdout: JSON.stringify({
						manager: "npm",
						version: "11",
						sources: {},
						skipped: [],
						typecheck: "none",
						environment: [],
					}),
				},
			},
			{ argv: ["node", "/opt/health-code/project.mjs", "install"], result: { stdout: output } },
		],
	})
}
test("independent inspections share a provider without sharing event delivery", async () => {
	const sandboxProvider = offline()

	// capture a separate callback history for each inspection
	const inspect = async (): Promise<string> => {
		const events: InspectionEvent[] = []
		const report = await inspectRepository({
			repositoryUrl: fixtureUrl,
			sandboxProvider,
			onEvent: (e) => {
				events.push(e)
			},
			models: { future: "unused" },
		})

		// compare the saved timeline with the ordered callback events
		assert.deepEqual(report.timeline, events)
		assert.deepEqual(
			events.map((e) => e.sequence),
			events.map((_, i) => i + 1),
		)
		assert.doesNotMatch(JSON.stringify(report), /private-sample/)
		assert.equal(report.baseline.tests.status, "untested")
		return report.inspectionId
	}

	// start both inspections concurrently and check their identities
	const [a, b] = await Promise.all([inspect(), inspect()])
	assert.notEqual(a, b)
})
test("budget admission, abort and cleanup failures retain ownership", async () => {
	const sandboxProvider = offline()
	sandboxProvider.estimateMaxCost = () => 2
	let allocated = false

	// observe whether the over-budget request allocates a sandbox
	sandboxProvider.createSandbox = async () => {
		allocated = true
		return { id: "unexpected" }
	}
	await assert.rejects(inspectRepository({ repositoryUrl: fixtureUrl, sandboxProvider, limits: { maxCostUsd: 1 } }), {
		code: "deadline",
	})
	assert.equal(allocated, false)

	// reject a cancellation supplied before the inspection starts
	await assert.rejects(
		inspectRepository({ repositoryUrl: fixtureUrl, sandboxProvider: offline(), signal: AbortSignal.abort() }),
		{ code: "cancelled" },
	)

	// simulate a lost response during sandbox deletion
	const failing = offline()
	failing.destroySandbox = async () => {
		throw Error("lost reply")
	}

	// verify that the failed inspection retains its cleanup identifier
	await assert.rejects(inspectRepository({ repositoryUrl: fixtureUrl, sandboxProvider: failing }), (error: unknown) => {
		assert.ok(error instanceof InspectionError)
		assert.ok(error.cleanupId)
		assert.equal(error.timeline.at(-1)?.type, "inspection.failed")
		return true
	})
})
for (const [status, reason] of [
	[401, "authentication"],
	[403, "permission"],
	[503, "unavailable"],
] as const) {
	test(`maps availability status ${status}`, async () => {
		let calls = 0
		const provider = createSandboxProvider({
			token: "example",
			fetch: async (input) => {
				calls++
				assert.match(String(input), /runtimes\?limit=1$/)
				return new Response(null, { status })
			},
		})

		// check the mapped reason and the number of availability calls
		await assert.rejects(provider.checkAvailability(), { code: "sandbox-unavailable", reason })
		assert.equal(calls, 1)
	})
}
test("unused credentials are never required by module import or fake callers", async () => {
	const missing = createSandboxProvider({
		token: "",
		fetch: async () => {
			throw Error("unexpected request")
		},
	})
	await assert.rejects(missing.checkAvailability(), { reason: "authentication" })
})

test("version one report can be replayed by a reader that ignores new fields", async () => {
	const golden = JSON.parse(
		readFileSync(new URL("./fixtures/recorded/npm/inspection-report.json", import.meta.url), "utf8"),
	)
	const sandboxProvider = offline("", "a".repeat(40))
	const report = await inspectRepository({ repositoryUrl: "https://github.com/example/project", sandboxProvider })

	// normalize volatile fields before comparing the recorded report
	const stable: Record<string, string | number> = {
		durationMs: 0,
		timestamp: "2026-01-01T00:00:00.000Z",
		inspectionId: "inspection",
		sandboxId: "sandbox",
	}
	const { promptVersions, selection, ...rest } = report
	const { mode, ...originalSelection } = selection
	const legacy = { ...rest, selection: originalSelection }

	// Compare the original report shape alongside the new operation and prompt metadata.
	assert.equal(mode, "inspectUpgrades")
	assert.deepEqual(promptVersions, { model: [], handoff: [] })
	assert.deepEqual(JSON.parse(JSON.stringify(legacy, (key, value) => stable[key] ?? value)), golden)

	// read the same versioned fields when the report contains extra data
	const reader = ({ version, timeline }: typeof report): unknown => ({ version, timeline })
	assert.deepEqual(reader(Object.assign({}, golden, { additional: "new" })), reader(golden))
})

test("caller cancellation during a callback reaches the caller as cancellation", async () => {
	const controller = new AbortController()
	await assert.rejects(
		inspectRepository({
			repositoryUrl: fixtureUrl,
			sandboxProvider: offline(),
			signal: controller.signal,

			// abort during a step callback that never settles
			onEvent: async (event) => {
				if (event.type === "step.started") {
					controller.abort()
					await new Promise<void>(() => {})
				}
			},
		}),
		{ code: "cancelled" },
	)
})

test("cleanup still starts when the host resumes past the admitted deadline", async () => {
	const sandboxProvider = offline()
	const destroy = sandboxProvider.destroySandbox
	let deleted = false

	// record teardown after the inspection exceeds its deadline
	sandboxProvider.destroySandbox = async (...args) => {
		await destroy(...args)
		deleted = true
	}
	await assert.rejects(
		inspectRepository({
			repositoryUrl: fixtureUrl,
			sandboxProvider,
			limits: { maxDurationMs: 120 },

			// suspend the host past the deadline immediately after allocation
			onEvent(event) {
				if (event.type === "sandbox.event" && event.action === "created") {
					Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150)
				}
			},
		}),
	)
	assert.ok(deleted)
})

test("structured credential values are scrubbed from detail events and the report", async () => {
	const events: InspectionEvent[] = []
	const report = await inspectRepository({
		repositoryUrl: fixtureUrl,
		sandboxProvider: offline(JSON.stringify({ password: "sample value with spaces" })),
		onEvent(event) {
			events.push(event)
		},
	})

	// verify redaction in both the callback stream and stored evidence
	assert.doesNotMatch(JSON.stringify(events), /sample value/)
	assert.doesNotMatch(JSON.stringify(report), /sample value/)
	assert.ok(report.baseline.install.evidence[0]?.stdout.includes("[redacted]"))
})
test("throwing callbacks leave exactly one finish for each recorded step start", async () => {
	for (const type of ["step.started", "step.finished"]) {
		await assert.rejects(
			inspectRepository({
				repositoryUrl: fixtureUrl,
				sandboxProvider: offline(),

				// interrupt delivery at each boundary of the recorded step
				onEvent(event) {
					if (event.type === type) {
						throw Error("callback")
					}
				},
			}),

			// check that a failed callback still leaves a balanced timeline
			(error: unknown) => {
				assert.ok(error instanceof InspectionError)
				assert.equal(error.timeline.filter((e) => e.type === "step.started").length, 1)
				assert.equal(error.timeline.filter((e) => e.type === "step.finished").length, 1)
				return true
			},
		)
	}
})

test("a timed-out final check settles before its caller can publish", async () => {
	const { InspectionContext } = await import("../src/collectEvents.ts")
	const context = new InspectionContext({
		repositoryUrl: fixtureUrl,
		sandboxProvider: offline(),
		limits: { timeouts: { setup: 20, tests: 60000 } },
	})
	context.setupComplete = true
	let published = false
	let settled = false

	// attempt publication only after the bounded final check settles
	await assert.rejects(
		async () => {
			await context.group("setup", "Final patch check", async () => {
				assert.ok(context.operation("tests").timeoutMs <= 20)
				try {
					await context.step(
						"tests",
						"tests",
						(op) =>
							new Promise<void>((resolve) => op.signal?.addEventListener("abort", () => resolve(), { once: true })),
					)
				} finally {
					settled = true
				}
			})
			published = true
		},
		{ code: "deadline" },
	)

	// confirm teardown settled before publication could proceed
	assert.ok(settled)
	assert.equal(published, false)
})

test("later project reads outlive the initial detection deadline", async () => {
	const { InspectionContext } = await import("../src/collectEvents.ts")
	const { NodeAdapter } = await import("../src/checks/checkProject.ts")
	const sandboxProvider = offline()
	sandboxProvider.executeCommand = async () => ({
		exitCode: 0,
		stdout: "{}",
		stderr: "",
		durationMs: 0,
		timedOut: false,
		stdoutTruncated: false,
		stderrTruncated: false,
	})
	const context = new InspectionContext({
		repositoryUrl: fixtureUrl,
		sandboxProvider,
		limits: { timeouts: { detect: 20 } },
	})
	context.setupComplete = true
	const adapter = new NodeAdapter(context, { id: "fixture" })

	// expire the detection deadline before rereading the project
	await assert.rejects(adapter.detectProject())
	await new Promise((resolve) => setTimeout(resolve, 30))
	assert.deepEqual(await adapter.data(["detect"]), {})
	await assert.rejects(adapter.detectProject(), { code: "deadline" })
})

test("a failed event listener leaves internal cleanup and terminal events sequenced", async () => {
	const { InspectionContext } = await import("../src/collectEvents.ts")
	const internal: InspectionEvent[] = []
	let deliveries = 0

	// record internal events while failing external delivery
	const context = new InspectionContext({ repositoryUrl: fixtureUrl, sandboxProvider: offline() }, (event) => {
		internal.push(event)
		return async () => {
			deliveries++
			throw Error("Listener unavailable")
		}
	})

	// reject subsequent work after the first delivery error
	await assert.rejects(context.emit({ type: "inspection.started", repositoryUrl: fixtureUrl }), {
		code: "event-delivery",
	})
	await assert.rejects(
		context.step("setup", "Next model", async () => assert.fail("Model should not start")),
		{ code: "event-delivery" },
	)

	// finish the internal timeline during cleanup
	context.cleaningUp = true
	await context.emit({ type: "sandbox.event", sandboxId: "fixture", action: "deleted" })
	await context.emit({ type: "inspection.failed", code: "event-delivery", message: "Delivery failed" })
	assert.deepEqual(
		internal.map((event) => event.type),
		["inspection.started", "sandbox.event", "inspection.failed"],
	)
	assert.deepEqual(
		internal.map((event) => event.sequence),
		[1, 2, 3],
	)
	assert.equal(deliveries, 1)
})
