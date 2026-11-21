import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { mock, test } from "node:test"
import { createFakeSandboxProvider, type FixtureCommand, type SandboxFixture } from "health-code"
import { fetchPatch } from "./fetchPatch.ts"
import { inspectWithAccount } from "./inspectWithAccount.ts"
import { secretName } from "./modelSettings.ts"
import { cardSchema, toHash } from "./storeInspection.ts"

test("the paid entry point routes each credential and closes the guest binding on a replay", async () => {
	const environment = {
		RUNTA_TOKEN: "synthetic-runta-token",
		ANTHROPIC_API_KEY: "synthetic-model-key",
		GITHUB_TOKEN: "synthetic-github-token",
	}
	const repositoryUrl = "https://github.com/example/project"
	const fixture: SandboxFixture = JSON.parse(
		await readFile(new URL("../../scripts/fixtures/recorded/inspection.json", import.meta.url), "utf8"),
	)
	const [detect, registry, install, , report, bump] = fixture.commands
	assert.ok(detect && registry && install && report && bump)
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
	const provider = createFakeSandboxProvider({
		...fixture,
		commands: commands.map((entry) => ({ ...entry, connections: evidence })),
	})
	const mailbox = "From abc fixture\nSubject: [PATCH] upgrade widget\n"
	provider.patchWorkspace = async (_sandbox, request) => {
		switch (request.kind) {
			case "commit":
				return "b".repeat(40)
			case "export":
				return mailbox
			case "read":
				if (request.file === "package.json") {
					return JSON.stringify({ dependencies: { widget: request.revision === fixture.commit ? "1.2.0" : "1.3.0" } })
				}
				assert.equal(request.file, source)
				return "widget()"
			case "verify":
				return request.tip
			case "restore":
				return null
			default:
				throw new Error("Unexpected workspace operation")
		}
	}
	const phases: string[] = []
	provider.openCredentialSession = async (_sandbox, route) => {
		assert.equal(route.credential.name, secretName("https://api.anthropic.com"))
		assert.equal(route.baseUrl, "https://api.anthropic.com/v1")
		assert.ok(!JSON.stringify(route).includes(environment.ANTHROPIC_API_KEY))
		phases.push("open")
		const reply = { modelId: route.modelId, inputTokens: 1, outputTokens: 1 }
		return {
			async verify(): Promise<typeof reply & { text: string }> {
				phases.push("verify")
				return { ...reply, text: "OK" }
			},
			async generate(prompt): Promise<typeof reply & { text: string }> {
				phases.push("generate")
				assert.ok(!prompt.includes(environment.ANTHROPIC_API_KEY))
				return { ...reply, text: JSON.stringify({ reason: "No suitable edit", edits: [] }) }
			},
			async close(): Promise<void> {
				phases.push("close")
			},
		}
	}
	const requested: string[] = []
	const request = mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
		const url = new URL(input)
		const headers = new Headers(init?.headers)
		if (url.hostname === "registry.npmjs.org") {
			assert.equal(headers.get("authorization"), null)
			requested.push("registry")
			return Response.json({ repository: "https://github.com/example/widget" })
		}
		if (url.hostname === "api.github.com") {
			assert.equal(headers.get("authorization"), `Bearer ${environment.GITHUB_TOKEN}`)
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
		assert.equal(url.href, "https://api.anthropic.com/v1/messages")
		assert.equal(headers.get("x-api-key"), environment.ANTHROPIC_API_KEY)
		assert.equal(headers.get("authorization"), null)
		const first = !requested.includes("summary")
		requested.push(first ? "summary" : "match")
		const value = first
			? { text: "Widget has a new API.", sources: [summarySource] }
			: [{ feature: "Use widget directly", kind: "workaround", source: summarySource, file: source, line: 1 }]
		return Response.json({
			type: "message",
			role: "assistant",
			id: "recorded",
			model: "claude-opus-5-5",
			content: [{ type: "text", text: JSON.stringify(value) }],
			stop_reason: "end_turn",
			stop_sequence: null,
			usage: { input_tokens: 10, output_tokens: 10 },
		})
	})
	try {
		const options = {
			repositoryUrl,
			sandboxProvider: provider,
			signal: new AbortController().signal,
			onEvent(): void {},
		}
		assert.throws(
			() => inspectWithAccount(options, { ...environment, ANTHROPIC_API_KEY: undefined }),
			/ANTHROPIC_API_KEY/,
		)
		assert.deepEqual(requested, [])
		const card = await inspectWithAccount(options, environment)
		assert.equal(card.version, 2)
		assert.deepEqual(requested, ["registry", "releases", "summary", "match"])
		assert.deepEqual(phases, ["open", "verify", "generate", "close"])
		assert.ok(card.timeline.some((event) => event.type === "sandbox.event" && event.action === "agent-started"))
		assert.ok(!Object.values(environment).some((value) => JSON.stringify(card).includes(value)))
		const patch = fetchPatch(cardSchema.parse(card), { sha256: toHash(mailbox), offset: 0 })
		assert.equal(patch.text, mailbox)
		assert.equal(patch.agentPrompt, card.upgrades[0]?.patches[0]?.prompt)
	} finally {
		request.mock.restore()
	}
})
