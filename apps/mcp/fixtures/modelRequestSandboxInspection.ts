import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { mock } from "node:test"
import type { createFakeSandboxProvider, FixtureCommand, SandboxFixture } from "health-code"
import { secretName } from "../modelSettings.ts"

/**
 * Creates a recorded Inspection with model replies and a restorable release transport.
 */
export async function modelRequestSandboxFixture(
	makeProvider: typeof createFakeSandboxProvider,
	githubToken?: string,
): Promise<{
	provider: ReturnType<typeof createFakeSandboxProvider>
	phases: string[]
	mailbox: string
	requested: string[]
	restore: () => void
}> {
	// load recorded commands for the inspected project
	const fixture: SandboxFixture = JSON.parse(
		await readFile(new URL("../../../scripts/fixtures/recorded/inspection.json", import.meta.url), "utf8"),
	)
	const [detect, registry, install, , report, bump] = fixture.commands
	assert.ok(detect && registry && install && report && bump)

	// prepare matching source and release evidence for the fixture
	const source = "index.ts"
	const summarySource = "https://github.com/example/widget/releases/tag/v1.3.0"
	const evidence = { complete: true, findings: [], destinations: [] }
	const guest = detect.argv.slice(0, 2)
	function command(args: string[], value: unknown): FixtureCommand {
		return {
			argv: [...guest, ...args],
			result: { stdout: JSON.stringify(value) },
			connections: evidence,
		}
	}

	const size = command(["installed-size"], 100)

	// replay a passing test inventory before and after the bump
	const tests = command(["tests", "--inventory"], {
		counts: { passed: 1, failed: 0, skipped: 0, todo: 0 },
		testFileErrors: [],
	})
	const inventory = command(["integrity", "0"], {
		files: ["package.json", "package-lock.json", source],
		hooks: [],
		cases: [["a.test.ts", "example", "passed"]],
		testFileErrors: [],
	})
	const usage = command(["usage", "widget"], {
		usage: [{ file: source, line: 1, symbol: "widget", workspace: ".", text: "widget()" }],
		changelog: "",
		unresolved: [],
	})

	// order guest responses to match the inspection phases
	const commands = [
		detect,
		registry,
		usage,
		install,
		size,
		tests,
		report,
		inventory,
		bump,
		command(["changelog", "widget"], ""),
		size,
		tests,
		report,
		bump,
		install,
		tests,
		report,
		inventory,
	]
	const provider = makeProvider({
		...fixture,
		modelRequestSandbox: {
			replies: [
				{
					text: JSON.stringify({ text: "Widget has a new API.", sources: [summarySource] }),
					modelId: "recorded",
					inputTokens: 10,
					outputTokens: 10,
				},
				{
					text: JSON.stringify([
						{ feature: "Use widget directly", kind: "workaround", source: summarySource, file: source, line: 1 },
					]),
					modelId: "recorded",
					inputTokens: 10,
					outputTokens: 10,
				},
			],
		},
		commands: commands.map((entry) => ({ ...entry, connections: evidence })),
	})

	// emulate the patch workspace at its inspected and upgraded revisions
	const mailbox = "From abc fixture\nSubject: [PATCH] upgrade widget\n"
	provider.patchWorkspace = async (_sandbox, request) => {
		switch (request.kind) {
			case "commit":
				return "b".repeat(40)
			case "export":
				return mailbox

			// return revision-specific manifest and source contents
			case "read":
				if (request.file === "package.json") {
					return JSON.stringify({ dependencies: { widget: request.revision === fixture.commit ? "1.2.0" : "1.3.0" } })
				}
				assert.equal(request.file, source)
				return "widget()"

			// acknowledge verification and restoration of the fixture
			case "verify":
				return request.tip
			case "restore":
				return null
			default:
				throw new Error("Unexpected workspace operation")
		}
	}

	// record the lifetime of the host-bound credential session
	const phases: string[] = []
	provider.openCredentialSession = async (_sandbox, route) => {
		assert.equal(route.credential.name, secretName("https://api.anthropic.com"))
		assert.equal(route.baseUrl, "https://api.anthropic.com/v1")
		assert.ok(!JSON.stringify(route).includes("obsolete-key-never-forward"))
		phases.push("open")

		// supply model replies with measured token usage
		const reply = { modelId: route.modelId, inputTokens: 1, outputTokens: 1 }
		return {
			async verify(): Promise<typeof reply & { text: string }> {
				phases.push("verify")
				return { ...reply, text: "OK" }
			},
			async generate(prompt): Promise<typeof reply & { text: string }> {
				phases.push("generate")
				assert.ok(!prompt.includes("obsolete-key-never-forward"))
				return { ...reply, text: JSON.stringify({ reason: "No suitable edit", edits: [] }) }
			},
			async close(): Promise<void> {
				phases.push("close")
			},
		}
	}

	// intercept requests and check credentials at each destination
	const requested: string[] = []
	const request = mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
		const url = new URL(input)
		const headers = new Headers(init?.headers)

		// keep registry lookups anonymous
		if (url.hostname === "registry.npmjs.org") {
			assert.equal(headers.get("authorization"), null)
			requested.push("registry")
			return Response.json({ repository: "https://github.com/example/widget" })
		}

		// check anonymous REST requests and authenticated GraphQL requests
		if (url.hostname === "api.github.com") {
			if (!githubToken) {
				assert.equal(headers.get("authorization"), null)
				requested.push("releases")
				return Response.json([
					{ tag_name: "v1.3.0", body: "Widget can replace the wrapper.", draft: false, prerelease: false },
				])
			}
			assert.equal(headers.get("authorization"), `Bearer ${githubToken}`)
			assert.equal(url.pathname, "/graphql")
			requested.push("releases")
			return Response.json({
				data: {
					repository: {
						visibility: "PUBLIC",
						releases: {
							nodes: [{ tag_name: "v1.3.0", body: "Widget can replace the wrapper.", draft: false, prerelease: false }],
							pageInfo: { hasNextPage: false, endCursor: null },
						},
					},
				},
			})
		}
		throw new Error("Unexpected model request in the MCP process")
	})
	return { provider, phases, requested, mailbox, restore: () => request.mock.restore() }
}
