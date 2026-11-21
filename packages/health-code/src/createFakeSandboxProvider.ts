import { randomUUID } from "node:crypto"
import type { CredentialSession, ModelReply, PatchOperation } from "./agentContracts.ts"
import {
	type Command,
	type CommandResult,
	InspectionError,
	type Observation,
	type Sandbox,
	type SandboxProvider,
} from "./contracts.ts"
import { createFakeModelRequestSandbox, type ModelRequestSandboxFixture } from "./createFakeModelRequestSandbox.ts"
import { validateRegistryHosts } from "./networkPolicy.ts"

export type FixtureCommand = {
	argv: string[]
	result: Partial<CommandResult>
	connections?: Observation
	files?: Observation
}
// pin replay commands and model replies to a repository revision
export type SandboxFixture = {
	commit: string
	commands: readonly FixtureCommand[]
	modelRequestSandbox?: ModelRequestSandboxFixture
	agentReplies?: readonly ModelReply[]
	verifiedStub?: boolean
	patches?: readonly { request: PatchOperation; response: string | null }[]
	// seed files readable through the fake provider
	files?: Readonly<Record<string, string>>
}

const empty: Observation = { complete: true, findings: [] }

/** Replays each inspection independently, using the caller's fixture records. */
export function createFakeSandboxProvider(fixture: SandboxFixture): SandboxProvider &
	ReturnType<typeof createFakeModelRequestSandbox> & {
		credentialEvents: { sandboxId: string; action: string; host: string }[]
	} {
	const credentialEvents: { sandboxId: string; action: string; host: string }[] = []
	const sessions = new Map<
		string,
		{
			index: number
			turn: number
			patch: number
			// track isolated policy and evidence state for each fixture session
			bound: boolean
			locked: boolean
			files: Map<string, string>
			observations: Map<string, FixtureCommand>
		}
	>()
	// require a live fixture sandbox before reading its state
	function session(sandbox: Sandbox): NonNullable<ReturnType<typeof sessions.get>> {
		const state = sessions.get(sandbox.id)
		if (!state) {
			throw new InspectionError("sandbox-absent", "Sandbox has been deleted")
		}
		return state
	}
	// resolve installation observations by their capture id
	function observed(sandbox: Sandbox, id: string): FixtureCommand {
		const entry = session(sandbox).observations.get(id)
		if (!entry) {
			throw new InspectionError("unknown-observation", "Unknown installation evidence")
		}
		return entry
	}
	return {
		...createFakeModelRequestSandbox(fixture.modelRequestSandbox),
		credentialEvents,
		// bind a fake credential only during the locked registry phase
		async openCredentialSession(sandbox, route): Promise<CredentialSession> {
			const state = session(sandbox)
			if (!state.locked || state.bound) {
				throw new InspectionError("credential-binding", "Registry phase required")
			}
			const record = (action: string): void => {
				// record credential lifecycle events for test assertions
				credentialEvents.push({ sandboxId: sandbox.id, host: new URL(route.baseUrl).hostname, action })
			}
			state.bound = true
			let verified = false
			let closed = false
			record("attach")
			record("readback")
			return {
				// require a successful probe before generating replies
				async verify(): Promise<ModelReply> {
					if (closed || !fixture.verifiedStub) {
						throw new InspectionError("credential-binding", "Credential probe failed")
					}
					verified = true
					record("verified")
					return { text: "OK", modelId: route.modelId, inputTokens: 1, outputTokens: 1 }
				},
				async generate(): Promise<ModelReply> {
					if (closed || !verified) {
						throw new InspectionError("credential-binding", "Verified stub required")
					}
					// consume the next recorded model reply
					const reply = fixture.agentReplies?.[state.turn++]
					if (!reply) {
						throw new InspectionError("fixture-command", "Missing model reply")
					}
					return structuredClone(reply)
				},
				async close(): Promise<void> {
					if (!closed) {
						closed = true
						verified = false
						state.bound = false
						record("revoke")
						record("registry-only")
					}
				},
			}
		},
		async patchWorkspace(sandbox, request): Promise<string | null> {
			const state = session(sandbox)
			if (!state.locked || state.bound) {
				throw new InspectionError("policy", "Registry phase required")
			}
			// match protected patch requests in fixture order
			const patch = fixture.patches?.[state.patch++]
			if (!patch || JSON.stringify(patch.request) !== JSON.stringify(request)) {
				throw new InspectionError("fixture-command", "Unexpected patch operation")
			}
			return patch.response
		},
		async checkAvailability(): Promise<void> {},
		estimateMaxCost(): number {
			return 0
		},
		async createSandbox(name): Promise<Sandbox> {
			sessions.set(name, {
				index: 0,
				turn: 0,
				patch: 0,
				bound: false,
				locked: false,
				files: new Map(),
				observations: new Map(),
			})
			return { id: name }
		},
		async prepareRepository(sandbox): Promise<string> {
			session(sandbox)
			return fixture.commit
		},
		async setNetworkPolicy(sandbox, hosts): Promise<void> {
			validateRegistryHosts(hosts)
			if (session(sandbox).bound) {
				throw new InspectionError("policy", "Agent session active")
			}
			session(sandbox).locked = true
		},
		async resetProject(sandbox): Promise<void> {
			const state = session(sandbox)
			state.files = new Map(Object.entries(fixture.files ?? {}))
		},
		async executeCommand(sandbox, command: Command): Promise<CommandResult> {
			const state = session(sandbox)
			if (!state.locked || state.bound) {
				throw new InspectionError("policy", "Registry policy required")
			}
			// match the next command against the recorded arguments
			const entry = fixture.commands[state.index++]
			if (!entry || JSON.stringify(command.argv) !== JSON.stringify(entry.argv)) {
				throw new InspectionError("fixture-command", `Unexpected fixture command ${JSON.stringify(command.argv)}`)
			}
			const result: CommandResult = {
				stdout: "",
				stderr: "",
				exitCode: 0,
				durationMs: 1,
				stdoutTruncated: false,
				stderrTruncated: false,
				...entry.result,
			}
			if (command.observe) {
				result.observationId = randomUUID()
				state.observations.set(result.observationId, entry)
			}
			return result
		},
		async readFile(sandbox, path): Promise<string> {
			const contents = session(sandbox).files.get(path)
			if (contents === undefined) {
				throw new InspectionError("missing-file", "Missing fixture file")
			}
			return contents
		},
		async writeFile(sandbox, path, contents): Promise<void> {
			session(sandbox).files.set(path, contents)
		},
		async readAttemptedConnections(sandbox, id): Promise<Observation> {
			return structuredClone(observed(sandbox, id).connections ?? empty)
		},
		async readFileChanges(sandbox, id): Promise<Observation> {
			return structuredClone(observed(sandbox, id).files ?? empty)
		},
		async destroySandbox(sandbox): Promise<void> {
			sessions.delete(sandbox.id)
		},
	}
}
