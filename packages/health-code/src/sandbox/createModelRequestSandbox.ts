import { setTimeout as delay } from "node:timers/promises"
import { isDeepStrictEqual } from "node:util"
import { ApiError, type Runta } from "@runta/runta-sdk"
import type { ModelReply, ModelRoute } from "../agentContracts.ts"
import { bounded, checkOperation } from "../collectEvents.ts"
import { InspectionError, type Operation } from "../contracts.ts"
import {
	isModelRequestSandboxName,
	type ModelRequestSandbox,
	sandboxModelCallTimeoutMs,
	snapshotSandboxModelRequest,
} from "../modelRequestSandbox.ts"
import { confirmNetworkPolicy } from "../networkPolicy.ts"
import { type Runtime, refusedAllocation, remainingOperation, runtimeCost } from "./requestRuntime.ts"
import { confirmGateway, sendSandboxModelRequest } from "./sandboxModelRequest.ts"
import { credentialTarget, setCredentialBinding } from "./setCredentialBinding.ts"

type Binding = Awaited<ReturnType<typeof setCredentialBinding>>

type Allocation = {
	opening: Promise<Runtime>
	stop: AbortController
	bound?: { route: ModelRoute; binding: Binding }
	refused?: boolean
	poisoned?: boolean
	busy?: Promise<unknown>
}

type CreateModelRequestSandboxOptions = {
	sdk: () => Runta
	runtimeName: (name: string) => string
	request: typeof fetch
	token: string | undefined
}

type SelectRouteOptions = { state: Allocation; runtime: Runtime; route: ModelRoute; operation: Operation }
type FindAllocationOptions = {
	name: string
	creationPending: boolean
	signal: AbortSignal
	state: Allocation | undefined
}

/**
 * Creates the provider capability that binds credentials and manages model request sandbox runtimes.
 */
export function createModelRequestSandbox({
	sdk,
	runtimeName,
	token,
	request,
}: CreateModelRequestSandboxOptions): ModelRequestSandbox {
	const allocations = new Map<string, Allocation>()
	const deletions = new Map<string, Promise<void>>()
	async function selectRoute({ state, runtime, route, operation }: SelectRouteOptions): Promise<void> {
		const remaining = remainingOperation(operation)
		const target = credentialTarget(route)
		// Scope all control-plane writes to the selected runtime.
		const bindingOptions = { request, token: token ?? "", runtimeId: runtime.id, signal: operation.signal }
		if (state.poisoned) {
			throw new InspectionError("credential-binding", "Model request sandbox binding unavailable")
		}
		// Reuse a verified binding across requests for the same route.
		if (state.bound && isDeepStrictEqual(state.bound.route, route)) {
			return
		}
		// A failed transition renders this runtime unusable until deletion.
		state.poisoned = true
		if (state.bound) {
			await setCredentialBinding({ ...bindingOptions, route: state.bound.route, remove: state.bound.binding })
			await confirmGateway({ runtime, route: state.bound.route, isCredentialAttached: false, operation: remaining() })
			delete state.bound
		}
		// Replace the entire network policy before introducing any credential.
		checkOperation(operation.signal)
		await runtime.egress.setPolicy({ mode: "allowlist", allowedHosts: [target.hostname], deniedHosts: [] })
		confirmNetworkPolicy([target.hostname], await runtime.egress.get())
		await confirmGateway({ runtime, route, isCredentialAttached: false, operation: remaining() })
		const binding = await setCredentialBinding({ ...bindingOptions, route })
		// Keep the verified binding rule so teardown can revoke it.
		state.bound = { route, binding }
		await confirmGateway({ runtime, route, isCredentialAttached: true, operation: remaining() })
		state.poisoned = false
	}
	// Resolve the recorded name only when the original create reply is unavailable.
	async function findAllocation({
		name,
		state,
		creationPending,
		signal,
	}: FindAllocationOptions): Promise<Runtime | undefined> {
		const runtime = await state?.opening.catch(() => undefined)
		if (runtime || state?.refused) {
			return runtime
		}
		for (let wait = 250; ; wait = Math.min(wait * 2, 2000)) {
			checkOperation(signal)
			const matches = (await sdk().runtimes.list()).filter((item) => item.displayName === runtimeName(name))
			// A timed-out create can still land after the current inventory snapshot.
			if (matches.length > 1) {
				throw new InspectionError("cleanup-failed", "Model Request Sandbox ownership could not be confirmed")
			}
			if (matches.length || (!creationPending && !state)) {
				return matches[0]
			}
			// Wait for an ambiguous create to appear in inventory.
			await delay(wait, undefined, { signal })
		}
	}

	return {
		estimateMaxCost(ms): number {
			return runtimeCost({ durationMs: ms, vcpus: 1, memoryMib: 512 })
		},
		async open(name, route, operation): Promise<void> {
			if (!isModelRequestSandboxName(name) || allocations.has(name) || deletions.has(name)) {
				throw new InspectionError("invalid-name", "Expected a unique Model Request Sandbox name")
			}
			// Capture the route before asynchronous startup begins.
			const selected = structuredClone(route)
			credentialTarget(selected)
			if (operation.timeoutMs <= 0) {
				throw new InspectionError("deadline", "Model Request Sandbox deadline reached")
			}
			checkOperation(operation.signal)
			const opening = sdk().runtimes.create(runtimeName(name), {
				vcpus: 1,
				memoryMib: 512,
				memoryMaxMib: 512,
				ingressSpecs: [],
				egressPolicy: { mode: "allowlist", allowedHosts: [], deniedHosts: [] },
				wait: false,
				timeoutMs: Math.min(60000, operation.timeoutMs),
			})
			// Track partial creation before awaiting the provider reply.
			const state: Allocation = { opening, stop: new AbortController() }
			allocations.set(name, state)
			const signal = operation.signal ? AbortSignal.any([operation.signal, state.stop.signal]) : state.stop.signal
			const timeoutMs = Math.min(60000, operation.timeoutMs)
			state.busy = bounded(
				async (signal) => {
					const remaining = remainingOperation({ timeoutMs, signal })
					// A definitive refusal releases this name without deleting another owner’s runtime.
					const runtime = await opening.catch((error: unknown) => {
						state.refused = refusedAllocation(error)
						throw error
					})
					// Verify the inherited policy before enabling the first model destination.
					await runtime.waitUntilReady({ timeoutMs: remaining().timeoutMs })
					checkOperation(signal)
					confirmNetworkPolicy([], await runtime.egress.get())
					await selectRoute({ state, runtime, route: selected, operation: remaining() })
				},
				{ timeoutMs, signal },
			)
			await state.busy
		},
		async send(name, input, operation): Promise<ModelReply> {
			const state = allocations.get(name)
			if (!state || state.stop.signal.aborted) {
				throw new InspectionError("model-request-sandbox", "Model Request Sandbox unavailable")
			}
			// Bound input before committing any network or model spend.
			const modelRequest = snapshotSandboxModelRequest(input)
			credentialTarget(modelRequest.route)
			const signal = operation.signal ? AbortSignal.any([operation.signal, state.stop.signal]) : state.stop.signal
			const timeoutMs = Math.min(sandboxModelCallTimeoutMs, operation.timeoutMs)
			const previous = state.busy
			// Queue the actual dispatch so an expired caller cannot send a late request.
			return bounded(
				async (signal) => {
					const remaining = remainingOperation({ timeoutMs, signal })
					const work = Promise.resolve(previous).then(async () => {
						// Check the queued request’s remaining time before changing its binding.
						const runtime = await state.opening
						try {
							await selectRoute({ state, runtime, route: modelRequest.route, operation: remaining() })
						} catch {
							throw new InspectionError(
								"credential-binding",
								"Model Request Sandbox route verification failed before dispatch",
							)
						}
						// Dispatch only after the active route has passed verification.
						return sendSandboxModelRequest({
							runtime,
							request: modelRequest,
							operation: { ...remaining(), modelCallId: operation.modelCallId },
						})
					})
					state.busy = work.catch(() => undefined)
					return work
				},
				{ timeoutMs, signal },
			)
		},
		async close(name, operation): Promise<void> {
			if (!isModelRequestSandboxName(name)) {
				throw new InspectionError("invalid-name", "Invalid Model Request Sandbox identity")
			}
			// Concurrent callers share one remote deletion.
			const active = deletions.get(name)
			if (active) {
				return bounded(async () => active, operation)
			}
			const state = allocations.get(name)
			state?.stop.abort()
			// Leave an existing runtime alone after a definitive create rejection.
			if (state?.refused) {
				allocations.delete(name)
				return
			}
			// Resolve by the exact owner-recorded name after a lost create response or restart.
			const deletion = bounded(async (signal) => {
				const runtime = await findAllocation({
					name,
					state,
					creationPending: operation.creationPending === true,
					signal,
				})
				// Skip deletion when the recorded runtime has already been reclaimed.
				if (!runtime) {
					return
				}
				try {
					// Reserve time for deletion if graceful revocation stalls.
					const bound = state?.bound
					if (bound) {
						await bounded(
							async (revokeSignal) => {
								await setCredentialBinding({
									request,
									token: token ?? "",
									runtimeId: runtime.id,
									route: bound.route,
									remove: bound.binding,
									signal: revokeSignal,
								})
							},
							{ signal, timeoutMs: Math.max(1, operation.timeoutMs / 3) },
						)
					}
				} catch {
					// Deleting the entire runtime also revokes all bindings.
				}
				await runtime.delete().catch((error) => {
					if (!(error instanceof ApiError && error.statusCode === 404)) {
						throw error
					}
				})
			}, operation)
				// Retain ownership after a failed deletion so recovery can retry.
				.then(() => {
					allocations.delete(name)
				})
				.finally(() => deletions.delete(name))
			deletions.set(name, deletion)
			await deletion
		},
	}
}
