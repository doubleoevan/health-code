import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { test } from "node:test"
import type { Runta } from "@runta/runta-sdk"
import type { ModelRoute } from "../src/agentContracts.ts"
import { createModelRequestSandbox } from "../src/sandbox/createModelRequestSandbox.ts"

function route(origin: string): ModelRoute {
	return {
		protocol: "openai-compatible",
		baseUrl: origin,
		modelId: "fixture",
		credential: { name: "registered", header: "authorization", valueTemplate: `Bearer \${credential}` },
	}
}

test("the production capability replaces and verifies the complete route before dispatch", async () => {
	for (const mismatch of [false, true]) {
		let hosts: string[] = []
		let revision = 1,
			paid = 0,
			deleted = 0
		let bindings: {
			environment: unknown[]
			files: unknown[]
			egress_rules: { host_pattern: string; path_pattern: string; name: string; value_template: string }[]
		}[] = []
		const transitions: string[] = []
		const runtime = {
			id: randomUUID(),
			async waitUntilReady(): Promise<void> {},
			egress: {
				async setPolicy(policy: { allowedHosts: string[] }): Promise<void> {
					hosts = policy.allowedHosts
				},
				async get(): Promise<{ mode: string; allowedHosts: string[]; deniedHosts: string[] }> {
					return {
						mode: "allowlist",
						allowedHosts: mismatch && hosts.length ? ["wrong.example"] : hosts,
						deniedHosts: [],
					}
				},
			},
			async delete(): Promise<void> {
				deleted++
			},
			async exec(argv: string[], op: { stdin: string }): Promise<{ exitCode: number; stdoutText: string }> {
				const url = new URL(argv.at(-1) ?? "")
				assert.deepEqual(hosts, [url.hostname])
				if (op.stdin === "{}") {
					return { exitCode: 0, stdoutText: `{}\n${bindings.length ? "400" : "401"}` }
				}
				// Paid calls require the read-back binding for the exact route.
				assert.deepEqual(bindings[0]?.environment, [])
				assert.deepEqual(bindings[0]?.files, [])
				assert.deepEqual(bindings[0]?.egress_rules, [
					{
						action: "header",
						host_pattern: url.hostname,
						path_pattern: url.pathname,
						name: "authorization",
						value_template: `Bearer \${secret}`,
					},
				])
				paid++
				const body = {
					id: "receipt",
					choices: [{ message: { content: "OK" } }],
					usage: { prompt_tokens: 2, completion_tokens: 1 },
				}
				return { exitCode: 0, stdoutText: `${JSON.stringify(body)}\n200` }
			},
		}
		const sdk = {
			runtimes: {
				async create(_name: string, config: Record<string, unknown>): Promise<typeof runtime> {
					hosts = []
					assert.deepEqual(config.egressPolicy, { mode: "allowlist", allowedHosts: [], deniedHosts: [] })
					assert.deepEqual(
						[config.vcpus, config.memoryMib, config.memoryMaxMib, config.ingressSpecs],
						[1, 512, 512, []],
					)
					return runtime
				},
			},
		} as unknown as Runta
		const request = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
			const url = new URL(String(input))
			if (url.pathname === "/v2/secrets") {
				return Response.json({ data: [{ id: "stored", display_name: "registered" }] })
			}
			// Track revision-checked replacements separately from metadata reads.
			if (init?.method === "PATCH") {
				assert.equal(Number(url.searchParams.get("expected_revision")), revision++)
				bindings = JSON.parse(String(init.body)).secret_configuration
				transitions.push(bindings[0]?.egress_rules[0]?.host_pattern ?? "revoke")
			}
			return Response.json({ data: { id: runtime.id, revision, secret_configuration: bindings } })
		}
		const provider = createModelRequestSandbox({
			sdk: () => sdk,
			runtimeName: (name) => name,
			token: "fixture",
			request: request as typeof fetch,
		})
		const name = `health-code-${randomUUID()}-relay`
		const operation = { timeoutMs: 5000 }
		const first = route("https://one.example/v1")
		// Exercise startup with both a matching and an unexpected policy.
		const open = provider.open(name, first, operation)
		if (mismatch) {
			await assert.rejects(open, /policy mismatch/)
			assert.equal(paid, 0)
		} else {
			await open
			// Reject an output ceiling above the configured limit.
			const input = { role: "featureMatch" as const, route: first, prompt: "data", output: 1024 }
			await assert.rejects(provider.send(name, { ...input, output: 1025 }, operation), /Invalid sandbox model request/)
			// Changing the caller's object must not change the binding already cached by the provider.
			first.credential.name = "unknown"
			await assert.rejects(provider.send(name, input, operation), /verification failed/)
			await provider.close(name, operation)
			// Restore the registered credential before testing a change of origin.
			first.credential.name = "registered"
			await provider.open(name, first, operation)
			for (const selected of [first, route("https://two.example/v2")]) {
				await provider.send(name, { role: "featureMatch", route: selected, prompt: "data", output: 1024 }, operation)
			}
			assert.deepEqual(transitions, ["one.example", "revoke", "one.example", "revoke", "two.example"])
			assert.equal(paid, 2)
		}
		// Verify that teardown revokes the final binding.
		const closing = provider.close(name, operation)
		await assert.rejects(
			provider.send(name, { role: "featureMatch", route: first, prompt: "data", output: 1 }, operation),
			/unavailable/,
		)
		await Promise.all([closing, provider.close(name, operation)])
		assert.deepEqual(bindings, [])
		assert.equal(deleted, mismatch ? 1 : 2)
	}
})

test("a lost create response and a restarted owner reconcile only the exact model request sandbox name", async () => {
	const name = `health-code-${randomUUID()}-relay`
	let listings = 0
	let present = true
	let deleted = 0
	const runtime = {
		displayName: name,
		async delete(): Promise<void> {
			present = false
			deleted++
		},
	}
	const other = {
		displayName: `${name}-other`,
		async delete(): Promise<void> {
			assert.fail("Unrelated runtime")
		},
	}
	const sdk = {
		runtimes: {
			async create(): Promise<never> {
				throw new Error("Response lost")
			},
			async list(): Promise<(typeof runtime)[]> {
				return ++listings > 1 && present ? [other, runtime] : [other]
			},
		},
	} as unknown as Runta
	// Each factory call represents a fresh owner with no in-memory allocation record.
	const capability = (): ReturnType<typeof createModelRequestSandbox> =>
		createModelRequestSandbox({ sdk: () => sdk, runtimeName: (id) => id, token: "fixture", request: fetch })

	const provider = capability()
	const operation = { timeoutMs: 1000 }
	await assert.rejects(provider.open(name, route("https://one.example/v1"), operation))
	await capability().close(name, { ...operation, creationPending: true })
	await capability().close(name, operation)
	assert.equal(deleted, 1)
})
