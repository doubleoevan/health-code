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
import { confirmNetworkPolicy, validateRegistryHosts } from "../networkPolicy.ts"
import { toRepositoryUrl } from "../toRepositoryUrl.ts"
import { executeCommand, type Instance } from "./executeCommand.ts"
import { guestArguments } from "./executeGuest.ts"
import { openCredentialSession } from "./openCredentialSession.ts"
import { checkout, provision, restore } from "./provision.ts"
import { toSandboxPrefix } from "./reconcileSandboxes.ts"
import {
	availabilityReason,
	checked,
	providerRequest,
	type Runtime,
	remainingOperation,
	translate,
} from "./requestRuntime.ts"
import { credentialTarget } from "./setCredentialBinding.ts"

function validatedPath(path: string): string {
	if (
		!path ||
		path.startsWith("/") ||
		path.split("/").some((part) => !part || part === "." || part === "..") ||
		path.includes("\0")
	) {
		throw new InspectionError("invalid-path", "Expected a relative project file")
	}
	return `/project/${path}`
}
export type ProviderOptions = {
	token?: string
	fetch?: typeof fetch
	deployment?: string
	memoryMib?: 4096 | 8192
	revision?: string
}
/** Creates an isolated provider client. Only its token default reads application settings. */
export function createSandboxProvider(options: ProviderOptions = {}): SandboxProvider {
	if (options.revision && !/^[a-f0-9]{40}$/.test(options.revision)) {
		throw new InspectionError("invalid-revision", "Expected a full commit SHA")
	}
	return connectProvider(options, options.revision)
}
/** Connects the sandbox client and optionally pins acquisition to a specific revision. */
export function connectProvider(
	options: ProviderOptions,
	revision?: string,
	proveDeniedRequest = false,
): SandboxProvider {
	const memoryMib = options.memoryMib ?? 4096
	if (![4096, 8192].includes(memoryMib)) {
		throw new InspectionError("invalid-limits", "Unsupported sandbox memory size")
	}
	const token = options.token ?? process.env.RUNTA_TOKEN
	const prefix = options.deployment === undefined ? "health-code-" : toSandboxPrefix(options.deployment)
	function runtimeName(name: string): string {
		return prefix + name.slice("health-code-".length)
	}
	const endpoint = "https://api.runta.com"
	let client: Runta | undefined
	const instances = new Map<string, Instance>()
	const creating = new Map<string, Promise<Runtime>>()
	const owned = new Set<string>()
	const deletions = new Map<string, Promise<void>>()
	function sdk(): Runta {
		if (!token) {
			throw new SandboxUnavailableError("authentication")
		}
		client ??= new Runta({ token, endpoint, timeoutMs: 30000 })
		return client
	}
	function state(sandbox: Sandbox): Instance {
		const instance = instances.get(sandbox.id)
		if (!instance) {
			throw new InspectionError("sandbox-absent", "Sandbox is unavailable")
		}
		return instance
	}
	function locked(sandbox: Sandbox): Instance {
		const instance = state(sandbox)
		if (!instance.locked) {
			throw new InspectionError("policy", "Registry policy required")
		}
		return instance
	}
	async function withCommand<T>(instance: Instance, work: (runtime: Runtime) => Promise<T>): Promise<T> {
		if (instance.updating) {
			throw new InspectionError("sandbox-busy", "Sandbox policy transition is active")
		}
		instance.commands++
		try {
			return await work(instance.runtime)
		} finally {
			instance.commands--
		}
	}
	function destroy(sandbox: Sandbox, operation: Operation): Promise<void> {
		const pending = deletions.get(sandbox.id)
		if (pending) {
			return pending
		}
		const deletion = deleteAllocation(sandbox, operation).finally(() => deletions.delete(sandbox.id))
		deletions.set(sandbox.id, deletion)
		return deletion
	}
	async function deleteAllocation(sandbox: Sandbox, operation: Operation): Promise<void> {
		if (!owned.has(sandbox.id)) {
			return
		}
		try {
			await bounded((signal) => deleteWithRetries(sandbox, signal), operation)
		} catch (error) {
			const pending = creating.get(sandbox.id)
			if (pending) {
				void pending
					.then(() => bounded((signal) => deleteWithRetries(sandbox, signal), { timeoutMs: 60000 }))
					.catch(() => undefined)
			}
			throw error
		}
	}
	async function resolveAllocation(sandbox: Sandbox): Promise<Runtime> {
		const pending = creating.get(sandbox.id)
		if (pending) {
			await pending.catch(() => undefined)
		}
		return instances.get(sandbox.id)?.runtime ?? (await sdk().runtimes.get(runtimeName(sandbox.id)))
	}
	function deletedInstance(sandbox: Sandbox, error: unknown): boolean {
		return error instanceof ApiError && error.statusCode === 404 && instances.has(sandbox.id)
	}
	async function deleteWithRetries(sandbox: Sandbox, signal: AbortSignal): Promise<void> {
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				checkOperation(signal)
				const runtime = await resolveAllocation(sandbox)
				checkOperation(signal)
				await runtime.delete()
				owned.delete(sandbox.id)
				instances.delete(sandbox.id)
				return
			} catch (error) {
				if (!owned.has(sandbox.id) || deletedInstance(sandbox, error)) {
					owned.delete(sandbox.id)
					instances.delete(sandbox.id)
					return
				}
				if (attempt === 2) {
					throw translate(error)
				}
				await delay(1000 * (attempt + 1), undefined, { signal })
			}
		}
	}
	return {
		async patchWorkspace(sandbox, request, operation): Promise<string | null> {
			const instance = locked(sandbox)
			if (instance.commands || instance.updating) {
				throw new InspectionError("sandbox-busy", "Repository command is active")
			}
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
				if (outcome.exitCode || outcome.stdoutTruncated) {
					throw new InspectionError("patch-workspace", `Protected patch operation failed (${request.kind})`)
				}
				return JSON.parse(outcome.stdoutText) as string | null
			} finally {
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
			return (Math.ceil(durationMs / 60000) / 60) * (2 * 0.0504 + (memoryMib / 1024) * 0.0162 + 256 * 0.000108)
		},
		async createSandbox(name, operation): Promise<Sandbox> {
			if (!/^health-code-[\da-f-]{36}$/.test(name)) {
				throw new InspectionError("invalid-name", "Expected a unique inspection sandbox name")
			}
			try {
				if (owned.has(name)) {
					throw new InspectionError("duplicate-allocation", "Sandbox name already allocated")
				}
				checkOperation(operation.signal)
				const manager = sdk().runtimes
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
						if (error instanceof ApiError && [400, 401, 403, 409, 422].includes(error.statusCode ?? 0)) {
							owned.delete(name)
						}
						throw error
					})
					.finally(() => creating.delete(name))
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
				const info = (await response.json()) as { data?: { secret_configuration?: unknown[] } }
				const bindings = info.data?.secret_configuration
				if (!Array.isArray(bindings) || bindings.length) {
					throw new InspectionError("credentials-present", "Sandbox inherited a credential binding")
				}
				return { id: name }
			} catch (error) {
				throw translate(error)
			}
		},
		async prepareRepository(sandbox, url, operation): Promise<string> {
			return withCommand(state(sandbox), async (runtime) => {
				const repositoryUrl = toRepositoryUrl(url)
				const remaining = remainingOperation(operation)
				await checked(runtime, ["sh", "-c", provision()], remaining())
				for (const [local, remote] of [
					["guest.mjs", "project.mjs"],
					["observe.mjs", "observe.mjs"],
					["agent.mjs", "agent.mjs"],
					["patch.mjs", "patch.mjs"],
				] as const) {
					const contents = await readFile(new URL(`../../dist/${local}`, import.meta.url))
					remaining()
					const archive = `/opt/health-code/${remote}.gz`
					await providerRequest(runtime.files.write(archive, gzipSync(contents)))
					await checked(runtime, ["gzip", "-df", archive], remaining())
				}
				await checked(runtime, ["chmod", "-R", "a+rX", "/opt/health-code"], remaining())
				try {
					return (
						await checked(runtime, ["sh", "-c", checkout, "checkout", repositoryUrl, revision ?? ""], remaining())
					).trim()
				} catch (error) {
					if (error instanceof InspectionError && error.code === "sandbox-command") {
						throw new InspectionError("repository-unavailable", "Public repository or pinned commit is unavailable")
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
			instance.locked = false
			try {
				validateRegistryHosts(hosts)
				checkOperation(operation.signal)
				await providerRequest(
					instance.runtime.egress.setPolicy({ mode: "allowlist", allowedHosts: [...hosts], deniedHosts: [] }),
				)
				checkOperation(operation.signal)
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
			return withCommand(locked(sandbox), (runtime) =>
				checked(
					runtime,
					guestArguments({ argv: ["cat", "--", validatedPath(path)], timeoutMs: operation.timeoutMs }, undefined),
					operation,
					true,
				),
			)
		},
		async writeFile(sandbox, path, contents, operation): Promise<void> {
			const instance = locked(sandbox)
			return withCommand(instance, async (runtime) => {
				const target = validatedPath(path)
				if (Buffer.byteLength(contents) > 65536) {
					throw new InspectionError("input-limit", "File exceeds input limit")
				}
				checkOperation(operation.signal)
				const result = await runtime.exec(
					guestArguments(
						{ argv: ["sh", "-c", 'cat > "$1"', "write", target], timeoutMs: operation.timeoutMs },
						undefined,
					),
					{ stdin: contents, timeoutSecs: Math.max(1, Math.ceil(operation.timeoutMs / 1000)) },
				)
				if (result.exitCode !== 0) {
					throw new InspectionError("write-failed", "Could not write project file")
				}
			})
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
