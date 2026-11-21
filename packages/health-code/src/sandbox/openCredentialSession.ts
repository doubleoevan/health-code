import { setTimeout as delay } from "node:timers/promises"
import { z } from "zod"
import type { CredentialSession, ModelReply, ModelRoute } from "../agentContracts.ts"
import { bounded, checkOperation } from "../collectEvents.ts"
import { InspectionError, type Operation } from "../contracts.ts"
import { agentOutputTokens } from "../modelBudget.ts"
import { confirmNetworkPolicy, registryHosts } from "../networkPolicy.ts"
import { checked, providerRequest, type Runtime, remainingOperation } from "./requestRuntime.ts"
import { credentialTarget, setCredentialBinding } from "./setCredentialBinding.ts"

type Options = {
	runtime: Runtime
	proveDeniedRequest?: boolean
	token: string
	request: typeof fetch
	route: ModelRoute
	operation: Operation & { cleanupDeadline?: number }
	release: () => void
	destroy: (operation: Operation) => Promise<void>
}
const receipt = z.object({
	status: z.number().int(),
	errorCode: z.string().max(60).optional(),
	text: z.string().optional(),
	modelId: z.string().optional(),
	inputTokens: z.number().int().nonnegative().optional(),
	outputTokens: z.number().int().nonnegative().optional(),
	requestId: z.string().optional(),
})
const probePrompt = "Reply OK."

/** Isolates trusted inference until removal and registry-only egress are verified. */
export async function openCredentialSession(options: Options): Promise<CredentialSession> {
	const { runtime, route } = options
	const target = credentialTarget(route)
	const guestRoute: ModelRoute = {
		protocol: route.protocol,
		modelId: route.modelId,
		baseUrl: route.baseUrl,
		effort: route.effort,
		credential: { name: "", header: route.credential.header, valueTemplate: route.credential.valueTemplate },
	}
	const remaining = remainingOperation(options.operation)
	const cleanupEnd = options.operation.cleanupDeadline ?? Date.now() + options.operation.timeoutMs
	const destroy = (deadline: number, reserveMs: number): Promise<void> => {
		const available = deadline - Date.now()
		return options.destroy({ timeoutMs: available > 0 ? available : Math.max(1, reserveMs) })
	}
	const bindingOptions = { token: options.token, request: options.request, runtimeId: runtime.id, route }
	let bound: Awaited<ReturnType<typeof setCredentialBinding>> | undefined
	let verified = false
	let closing: Promise<void> | undefined
	let closed = false
	let active = false
	async function policy(hosts: readonly string[], operation: Operation): Promise<void> {
		await bounded(async (signal) => {
			checkOperation(signal)
			await providerRequest(runtime.egress.setPolicy({ mode: "allowlist", allowedHosts: [...hosts], deniedHosts: [] }))
			checkOperation(signal)
			confirmNetworkPolicy(hosts, await providerRequest(runtime.egress.get()))
		}, operation)
	}
	async function invoke(
		prompt: string,
		output: number,
		operation: Operation,
		denyOnly = false,
	): Promise<z.infer<typeof receipt>> {
		if (active) {
			throw new InspectionError("credential-binding", "Concurrent inference is unavailable")
		}
		active = true
		try {
			const result = await runtime.exec(
				[
					"env",
					"-i",
					"PATH=/opt/health-code/bin:/usr/bin:/bin",
					"NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt",
					"/opt/health-code/bin/node",
					"/opt/health-code/agent.mjs",
				],
				{
					stdin: JSON.stringify({
						route: guestRoute,
						stub: "runta-secret-stub",
						editTool: !denyOnly && output > 1,
						url: target.href,
						prompt,
						maxOutputTokens: output,
						denyOnly,
					}),
					timeoutSecs: Math.max(1, Math.ceil(operation.timeoutMs / 1000)),
					maxOutputBytes: 65536,
				},
			)
			if (result.exitCode !== 0 || result.stdoutTruncated) {
				throw new Error()
			}
			return receipt.parse(JSON.parse(result.stdoutText))
		} catch {
			throw new InspectionError("credential-binding", "Isolated model transport unavailable")
		} finally {
			active = false
		}
	}
	// A model-less request cannot generate tokens while the gateway applies a rule.
	async function awaitGateway(operation: Operation, attached: boolean): Promise<void> {
		const budget = remainingOperation(operation)
		let status = 0
		for (let wait = 0; wait < budget().timeoutMs; wait = Math.min(8000, Math.max(500, wait * 2))) {
			await bounded((signal) => delay(wait, undefined, { signal }), budget())
			status = (await invoke("", 0, budget(), true)).status
			if (gatewayReady(status, attached)) {
				await confirmProbe(attached, budget())
				return
			}
			if (![0, 400, 401, 403, 422, 429, 502, 503, 504].includes(status)) {
				break
			}
		}
		throw new InspectionError(
			"credential-binding",
			`Gateway ${attached ? "attachment" : "denial"} unverified (${status ? "HTTP " + status : "no HTTP response"})`,
		)
	}
	async function confirmProbe(attached: boolean, operation: Operation): Promise<void> {
		if (!attached && options.proveDeniedRequest) {
			const receipt = await invoke(probePrompt, 1, operation)
			if (receipt.status !== 401) {
				throw new InspectionError("credential-binding", "Unbound one-token request was not denied")
			}
		}
	}
	function close(operation: Operation): Promise<void> {
		closing ??= revoke(operation)
		return closing
	}
	async function revoke(operation: Operation): Promise<void> {
		const closeEnd = Date.now() + operation.timeoutMs
		const graceful = Math.floor(operation.timeoutMs * 0.75)
		const cleanup = remainingOperation({ ...operation, timeoutMs: graceful })
		closed = true
		verified = false
		try {
			if (active) {
				throw new InspectionError("credential-binding", "Guest inference still active")
			}
			if (bound) {
				await bounded((signal) => setCredentialBinding({ ...bindingOptions, remove: bound, signal }), cleanup())
				await awaitGateway(cleanup(), false)
			}
			await policy(registryHosts, cleanup())
			options.release()
		} catch (error) {
			await destroy(closeEnd, operation.timeoutMs - graceful)
			throw error
		}
	}
	try {
		// All repository processes belong to completed PID namespaces before enabling inference egress.
		await checked(runtime, ["sh", "-c", "pgrep -u 65534 >/dev/null; test $? -eq 1"], remaining())
		await policy([...registryHosts, target.hostname], remaining())
		await awaitGateway(remaining(), false)
		bound = await setCredentialBinding({ ...bindingOptions, signal: remaining().signal })
		await awaitGateway(remaining(), true)
	} catch (error) {
		await destroy(cleanupEnd, Math.min(30000, options.operation.timeoutMs))
		throw error
	}
	async function readReply(prompt: string, output: number, operation: Operation): Promise<ModelReply> {
		const reply = await invoke(prompt, output, operation)
		if (reply.status !== 200 || typeof reply.text !== "string" || !reply.modelId) {
			throw new InspectionError(
				"credential-binding",
				`Gateway authentication could not be verified (${reply.status}, ${reply.errorCode})`,
			)
		}
		return { ...reply, text: reply.text, modelId: reply.modelId }
	}
	return {
		async verify(operation): Promise<ModelReply> {
			if (closed || verified) {
				throw new InspectionError("credential-binding", "Invalid verification phase")
			}
			const reply = await readReply(probePrompt, 1, operation)
			verified = true
			return reply
		},
		async generate(prompt, operation): Promise<ModelReply> {
			if (!verified || closed) {
				throw new InspectionError("credential-binding", "Verified model binding required")
			}
			return readReply(prompt, agentOutputTokens, operation)
		},
		close,
	}
}

function gatewayReady(status: number, attached: boolean): boolean {
	return attached ? [400, 422].includes(status) : status === 401
}
