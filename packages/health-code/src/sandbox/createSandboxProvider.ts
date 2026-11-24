import { readFile } from "node:fs/promises"
import { setTimeout as delay } from "node:timers/promises"
import { gzipSync } from "node:zlib"
import { ApiError, Runta } from "@runta/runta-sdk"
import type { CredentialSession } from "../agentContracts.ts"
import { bounded, checkOperation } from "../collectEvents.ts"
import {
	type CommandResult,
	InspectionError,
	type Observation,
	type Operation,
	type Sandbox,
	type SandboxProvider,
	SandboxUnavailableError,
} from "../contracts.ts"
import { toRepositoryUrl } from "../toRepositoryUrl.ts"
import { createModelRequestSandbox } from "./createModelRequestSandbox.ts"
import { executeCommand, type Instance } from "./executeCommand.ts"
import { confirmNetworkPolicy, validateRegistryHosts } from "./networkPolicy.ts"
import { openCredentialSession } from "./openCredentialSession.ts"
import { readProjectFile, writeProjectFile } from "./projectFiles.ts"
import { checkout, provision, restore } from "./provision.ts"
import { toSandboxPrefix } from "./reconcileSandboxes.ts"
import {
	availabilityReason,
	checked,
	providerRequest,
	type Runtime,
	refusedAllocation,
	remainingOperation,
	runtimeCost,
	translate,
} from "./requestRuntime.ts"
import { credentialTarget } from "./setCredentialBinding.ts"

// accept deployment, resource and revision overrides at allocation time
export type ProviderOptions = {
	token?: string
	fetch?: typeof fetch
	deployment?: string
	memoryMib?: 4096 | 8192
	revision?: string
}

/**
 * Creates an isolated provider client. Only its token default reads application settings.
 */
export function createSandboxProvider(options: ProviderOptions = {}): SandboxProvider {
	if (options.revision && !/^[a-f0-9]{40}$/.test(options.revision)) {
		throw new InspectionError("invalid-revision", "Expected a full commit SHA")
	}
	return connectProvider(options, options.revision)
}

/**
 * Connects the sandbox client and optionally pins acquisition to a specific revision.
 */
export function connectProvider(
	options: ProviderOptions,
	revision?: string,
	proveDeniedRequest = false,
): SandboxProvider {
	// validate memory before pricing or creating the runtime
	const memoryMib = options.memoryMib ?? 4096
	if (![4096, 8192].includes(memoryMib)) {
		throw new InspectionError("invalid-limits", "Unsupported sandbox memory size")
	}
	const token = options.token ?? process.env.RUNTA_TOKEN
	const prefix = options.deployment === undefined ? "health-code-" : toSandboxPrefix(options.deployment)

	// give the runtime a deployment-scoped name
	function runtimeName(name: string): string {
		return prefix + name.slice("health-code-".length)
	}
	const endpoint = "https://api.runta.com"
	let client: Runta | undefined

	// track pending allocations and deletions by inspection identity
	const instances = new Map<string, Instance>()
	const creating = new Map<string, Promise<Runtime>>()
	const owned = new Set<string>()
	const deletions = new Map<string, Promise<void>>()
	function sdk(): Runta {
		// create the sdk client only when an operation requires authentication
		if (!token) {
			throw new SandboxUnavailableError("authentication")
		}
		client ??= new Runta({ token, endpoint, timeoutMs: 30000 })
		return client
	}
	function state(sandbox: Sandbox): Instance {
		// retrieve the active runtime for this sandbox
		const instance = instances.get(sandbox.id)
		if (!instance) {
			throw new InspectionError("sandbox-absent", "Sandbox is unavailable")
		}
		return instance
	}
	function locked(sandbox: Sandbox): Instance {
		// require confirmed registry policy before repository work
		const instance = state(sandbox)
		if (!instance.locked) {
			throw new InspectionError("policy", "Registry policy required")
		}
		return instance
	}
	async function withCommand<T>(instance: Instance, work: (runtime: Runtime) => Promise<T>): Promise<T> {
		// exclude repository commands during policy transitions
		if (instance.updating) {
			throw new InspectionError("sandbox-busy", "Sandbox policy transition is active")
		}
		instance.commands++
		try {
			return await work(instance.runtime)
		} finally {
			// release the command count even when guest execution fails
			instance.commands--
		}
	}
	function destroy(sandbox: Sandbox, operation: Operation): Promise<void> {
		// share in-flight deletion requests for the same sandbox
		const pending = deletions.get(sandbox.id)
		if (pending) {
			return pending
		}
		const deletion = deleteAllocation(sandbox, operation).finally(() => deletions.delete(sandbox.id))
		deletions.set(sandbox.id, deletion)
		return deletion
	}

	// delete only allocations owned by this provider
	async function deleteAllocation(sandbox: Sandbox, operation: Operation): Promise<void> {
		if (!owned.has(sandbox.id)) {
			return
		}
		try {
			await bounded((signal) => deleteWithRetries(sandbox, signal), operation)
		} catch (error) {
			// retry cleanup after an allocation that outlives its caller
			const pending = creating.get(sandbox.id)
			if (pending) {
				void pending
					.then(() => bounded((signal) => deleteWithRetries(sandbox, signal), { timeoutMs: 60000 }))
					.catch(() => undefined)
			}

			// propagate the failed deletion while its deferred retry waits
			throw error
		}
	}

	// wait for pending creation before resolving the runtime by name
	async function resolveAllocation(sandbox: Sandbox): Promise<Runtime> {
		const pending = creating.get(sandbox.id)
		if (pending) {
			await pending.catch(() => undefined)
		}
		return instances.get(sandbox.id)?.runtime ?? (await sdk().runtimes.get(runtimeName(sandbox.id)))
	}

	// accept a missing runtime as evidence of a completed deletion
	function deletedInstance(sandbox: Sandbox, error: unknown): boolean {
		return error instanceof ApiError && error.statusCode === 404 && instances.has(sandbox.id)
	}
	async function deleteWithRetries(sandbox: Sandbox, signal: AbortSignal): Promise<void> {
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				// check cancellation before and after resolving the allocation
				checkOperation(signal)
				const runtime = await resolveAllocation(sandbox)
				checkOperation(signal)
				await runtime.delete()
				owned.delete(sandbox.id)
				instances.delete(sandbox.id)
				return
			} catch (error) {
				// clear ownership when the provider confirms deletion
				if (!owned.has(sandbox.id) || deletedInstance(sandbox, error)) {
					owned.delete(sandbox.id)
					instances.delete(sandbox.id)
					return
				}
				if (attempt === 2) {
					// propagate the terminal deletion error after bounded retries
					throw translate(error)
				}
				await delay(1000 * (attempt + 1), undefined, { signal })
			}
		}
	}
	return {
		modelRequestSandbox: createModelRequestSandbox({ sdk, runtimeName, token, request: options.fetch ?? fetch }),

		// serialize protected patch operations with guest commands
		async patchWorkspace(sandbox, request, operation): Promise<string | null> {
			const instance = locked(sandbox)
			if (instance.commands || instance.updating) {
				throw new InspectionError("sandbox-busy", "Repository command is active")
			}

			// reserve the runtime for the trusted patch helper
			instance.updating = true
			instance.locked = false
			try {
				checkOperation(operation.signal)
				const outcome = await instance.runtime.exec(
					["env", "-i", "PATH=/usr/bin:/bin", "/opt/health-code/bin/node", "/opt/health-code/patch.mjs"],
					{
						stdin: JSON.stringify(request),
						timeoutSecs: Math.ceil(operation.timeoutMs / 1000),
						maxOutputBytes: 1024 * 1024,
					},
				)

				// require complete output before parsing the helper response
				if (outcome.exitCode || outcome.stdoutTruncated) {
					throw new InspectionError("patch-workspace", `Protected patch operation failed (${request.kind})`)
				}
				return JSON.parse(outcome.stdoutText) as string | null
			} finally {
				// release the runtime back to registry-only work
				instance.updating = false
				instance.locked = true
			}
		},
		async openCredentialSession(sandbox, route, operation): Promise<CredentialSession> {
			const instance = locked(sandbox)
			if (!token || instance.updating || instance.commands) {
				throw new InspectionError("credential-binding", "Runtime is busy or unavailable")
			}
			credentialTarget(route)

			// hold the runtime exclusively while a credential is attached
			instance.updating = true
			instance.locked = false
			return openCredentialSession({
				proveDeniedRequest,
				runtime: instance.runtime,
				token,
				request: options.fetch ?? fetch,
				route,
				operation,
				release() {
					instance.updating = false
					instance.locked = true
				},
				destroy: (cleanup) => destroy(sandbox, cleanup),
			})
		},
		async checkAvailability(operation = { timeoutMs: 10000 }): Promise<void> {
			if (!token) {
				throw new SandboxUnavailableError("authentication")
			}
			await bounded(async (signal) => {
				try {
					const response = await (options.fetch ?? fetch)(`${endpoint}/v2/runtimes?limit=1`, {
						headers: { Authorization: `Bearer ${token}` },
						signal,
						redirect: "error",
					})

					// classify unsuccessful account checks by their http status
					await response.body?.cancel()
					if (!response.ok) {
						throw new SandboxUnavailableError(availabilityReason(response.status))
					}
				} catch (error) {
					throw translate(error)
				}
			}, operation)
		},
		estimateMaxCost(durationMs): number {
			return runtimeCost({ durationMs, vcpus: 2, memoryMib })
		},
		async createSandbox(name, operation): Promise<Sandbox> {
			if (!/^health-code-[\da-f-]{36}$/.test(name)) {
				throw new InspectionError("invalid-name", "Expected a unique inspection sandbox name")
			}

			// reject duplicate allocations before reserving the sandbox name
			try {
				if (owned.has(name)) {
					throw new InspectionError("duplicate-allocation", "Sandbox name already allocated")
				}
				checkOperation(operation.signal)
				const manager = sdk().runtimes

				// track ownership before dispatching creation to the provider
				owned.add(name)
				const request = manager.create(runtimeName(name), {
					vcpus: 2,
					memoryMib,
					memoryMaxMib: memoryMib,
					timeoutMs: operation.timeoutMs,
				})
				creating.set(name, request)
				const runtime = await request
					.catch((error: unknown) => {
						// release ownership on definitive creation rejections
						if (refusedAllocation(error)) {
							owned.delete(name)
						}
						throw error
					})
					.finally(() => creating.delete(name))

				// initialize sandbox state before inspecting inherited configuration
				instances.set(name, {
					runtime,
					locked: false,
					updating: false,
					commands: 0,
					hosts: [],
					observations: new Map(),
				})
				const response = await (options.fetch ?? fetch)(`${endpoint}/v2/runtimes/${encodeURIComponent(runtime.id)}`, {
					headers: { Authorization: `Bearer ${token}` },
					signal: operation.signal,
					redirect: "error",
				})
				if (!response.ok) {
					throw new SandboxUnavailableError(availabilityReason(response.status))
				}

				// verify the new runtime starts without a credential binding
				const info = (await response.json()) as { data?: { secret_configuration?: unknown[] } }
				const bindings = info.data?.secret_configuration
				if (!Array.isArray(bindings) || bindings.length) {
					throw new InspectionError("credentials-present", "Sandbox inherited a credential binding")
				}
				return { id: name }
			} catch (error) {
				// translate setup failures into provider errors
				throw translate(error)
			}
		},
		async prepareRepository(sandbox, url, operation): Promise<string> {
			return withCommand(state(sandbox), async (runtime) => {
				const repositoryUrl = toRepositoryUrl(url)
				const remaining = remainingOperation(operation)
				await checked(runtime, ["sh", "-c", provision()], remaining())
				for (const [local, remote] of [
					["project.mjs", "project.mjs"],
					["observe.mjs", "observe.mjs"],
					["agent.mjs", "agent.mjs"],
					["patch.mjs", "patch.mjs"],
					["nodeTestReporter.mjs", "nodeTestReporter.mjs"],
				] as const) {
					// upload the pinned guest bundle from the release package
					const contents = await readFile(new URL(`../../dist/${local}`, import.meta.url))
					remaining()
					const archive = `/opt/health-code/${remote}.gz`
					await providerRequest(runtime.files.write(archive, gzipSync(contents)))
					await checked(runtime, ["gzip", "-df", archive], remaining())
				}

				// enable trusted guest tools and check out the inspected repository
				await checked(runtime, ["chmod", "-R", "a+rX", "/opt/health-code"], remaining())
				try {
					return (
						await checked(
							runtime,
							["sh", "-c", checkout, "checkout", repositoryUrl, operation.revision ?? revision ?? ""],
							remaining(),
						)
					).trim()
				} catch (error) {
					// report unavailable repositories separately from provider failures
					if (error instanceof InspectionError && error.code === "sandbox-command") {
						throw new InspectionError("repository-unavailable", "Public repository or inspected commit is unavailable")
					}
					throw error
				}
			})
		},
		async setNetworkPolicy(sandbox, hosts, operation): Promise<void> {
			const instance = state(sandbox)
			if (instance.updating || instance.commands) {
				throw new InspectionError("policy", "Sandbox command or policy update in progress")
			}
			instance.updating = true

			// reserve the runtime while replacing its registry policy
			instance.locked = false
			try {
				validateRegistryHosts(hosts)
				checkOperation(operation.signal)
				await providerRequest(
					instance.runtime.egress.setPolicy({ mode: "allowlist", allowedHosts: [...hosts], deniedHosts: [] }),
				)
				checkOperation(operation.signal)

				// confirm the full egress policy before unlocking repository commands
				const policy = await providerRequest(instance.runtime.egress.get())
				checkOperation(operation.signal)
				confirmNetworkPolicy(hosts, policy)
				instance.hosts = [...hosts]
				instance.locked = true
			} finally {
				instance.updating = false
			}
		},
		async resetProject(sandbox, operation): Promise<void> {
			await withCommand(locked(sandbox), (runtime) => checked(runtime, ["sh", "-c", restore], operation))
		},
		async executeCommand(sandbox, command): Promise<CommandResult> {
			return executeCommand(locked(sandbox), command)
		},
		async readFile(sandbox, path, operation): Promise<string> {
			return withCommand(locked(sandbox), (runtime) => readProjectFile({ runtime, path, operation }))
		},
		async writeFile(sandbox, path, contents, operation): Promise<void> {
			return withCommand(locked(sandbox), (runtime) => writeProjectFile({ runtime, path, contents, operation }))
		},
		async readAttemptedConnections(sandbox, id): Promise<Observation> {
			const item = state(sandbox).observations.get(id)
			if (!item) {
				throw new InspectionError("missing-evidence", "Connection evidence unavailable")
			}
			return item.connections
		},
		async readFileChanges(sandbox, id): Promise<Observation> {
			const item = state(sandbox).observations.get(id)
			if (!item) {
				throw new InspectionError("missing-evidence", "Filesystem evidence unavailable")
			}
			return item.files
		},
		destroySandbox: destroy,
	}
}
