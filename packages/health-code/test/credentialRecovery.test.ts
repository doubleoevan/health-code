import assert from "node:assert/strict"
import { test } from "node:test"
import { registryHosts } from "../src/networkPolicy.ts"
import { openCredentialSession } from "../src/sandbox/openCredentialSession.ts"
import type { Runtime } from "../src/sandbox/requestRuntime.ts"

for (const failure of ["interrupted attachment", "failed restoration", "unavailable process evidence"] as const) {
	test(`a runtime is destroyed after ${failure}`, async () => {
		// track runtime state and cleanup for each failure
		const controller = new AbortController()
		let revision = 1
		let configuration: unknown[] = []
		let deletions = 0
		let releases = 0
		let hosts: string[] = []
		let generations = 0
		// simulate policy updates and host readback
		const runtime = {
			id: "runtime",
			egress: {
				async setPolicy(policy: { allowedHosts: string[] }): Promise<void> {
					hosts = policy.allowedHosts
				},
				async get(): Promise<{ mode: string; allowedHosts: string[]; deniedHosts: string[] }> {
					return {
						mode: "allowlist",
						allowedHosts: failure === "failed restoration" && hosts.length === registryHosts.length ? [] : hosts,
						deniedHosts: [],
					}
				},
			},
			async exec(argv: string[], options: { stdin?: string }): Promise<Record<string, unknown>> {
				// distinguish generation requests from credential probes
				const input = options.stdin ? JSON.parse(options.stdin) : undefined
				if (input && !input.denyOnly) {
					generations++
				}
				return {
					exitCode: argv[0] === "sh" && failure === "unavailable process evidence" ? 2 : 0,
					stdoutText: JSON.stringify({ status: configuration.length ? 400 : 401 }),
					stderrText: "",
					stdoutTruncated: false,
					durationMs: 1,
				}
			},
		} as unknown as Runtime
		// serve the named secret and the runtime's current binding
		const request = async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
			if (String(input).endsWith("secrets")) {
				return Response.json({ data: [{ id: "fixture", display_name: "stored" }] })
			}
			// interrupt attachment after the binding update when requested
			if (init?.method === "PATCH") {
				configuration = JSON.parse(String(init.body)).secret_configuration
				revision++
				if (failure === "interrupted attachment") {
					controller.abort()
				}
			}
			// return the configuration revision for readback
			return Response.json({ data: { id: "runtime", revision, secret_configuration: configuration } })
		}
		// open the credential session with observable release and destruction
		const operation = { timeoutMs: 2000, signal: controller.signal }
		const connect = (): ReturnType<typeof openCredentialSession> =>
			openCredentialSession({
				runtime,
				request,
				token: "fixture",
				operation,
				route: {
					protocol: "anthropic",
					modelId: "fixture",
					baseUrl: "https://fixture.example/v1",
					credential: { name: "stored", header: "x-api-key", valueTemplate: `\${credential}` },
				},
				release: () => {
					releases++
				},
				destroy: async ({ timeoutMs }) => {
					assert.ok(timeoutMs > 0)
					deletions++
				},
			})
		// verify cleanup when attachment or process verification fails
		if (failure !== "failed restoration") {
			await assert.rejects(connect())
			if (failure === "unavailable process evidence") {
				assert.deepEqual(hosts, [])
			}
		} else {
			// verify that restoration failure persists across repeated close calls
			const session = await connect()
			await assert.rejects(session.generate("unverified", operation), /Verified model binding required/)
			const closing = session.close(operation)
			assert.equal(session.close(operation), closing)
			await assert.rejects(closing, /policy mismatch/)
			await assert.rejects(session.close(operation), /policy mismatch/)
		}
		// require one destruction and no subsequent use of the runtime
		assert.equal(generations, 0)
		assert.equal(releases, 0)
		assert.equal(deletions, 1)
	})
}
