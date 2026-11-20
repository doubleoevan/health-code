import { randomUUID } from "node:crypto"
import {
	type Command,
	type CommandResult,
	InspectionError,
	type Observation,
	type Sandbox,
	type SandboxProvider,
} from "./contracts.ts"
import { validateRegistryHosts } from "./networkPolicy.ts"

export type FixtureCommand = {
	argv: string[]
	result: Partial<CommandResult>
	connections?: Observation
	files?: Observation
}
export type SandboxFixture = {
	commit: string
	commands: readonly FixtureCommand[]
	files?: Readonly<Record<string, string>>
}

const empty: Observation = { complete: true, findings: [] }

/** Replays each inspection independently, using the caller's fixture records. */
export function createFakeSandboxProvider(fixture: SandboxFixture): SandboxProvider {
	const sessions = new Map<
		string,
		{ index: number; locked: boolean; files: Map<string, string>; observations: Map<string, FixtureCommand> }
	>()
	function session(sandbox: Sandbox): NonNullable<ReturnType<typeof sessions.get>> {
		const state = sessions.get(sandbox.id)
		if (!state) {
			throw new InspectionError("sandbox-absent", "Sandbox has been deleted")
		}
		return state
	}
	function observed(sandbox: Sandbox, id: string): FixtureCommand {
		const entry = session(sandbox).observations.get(id)
		if (!entry) {
			throw new InspectionError("unknown-observation", "Unknown installation evidence")
		}
		return entry
	}
	return {
		async checkAvailability(): Promise<void> {},
		estimateMaxCost(): number {
			return 0
		},
		async createSandbox(name): Promise<Sandbox> {
			sessions.set(name, { index: 0, locked: false, files: new Map(), observations: new Map() })
			return { id: name }
		},
		async prepareRepository(sandbox): Promise<string> {
			session(sandbox)
			return fixture.commit
		},
		async setNetworkPolicy(sandbox, hosts): Promise<void> {
			validateRegistryHosts(hosts)
			session(sandbox).locked = true
		},
		async resetProject(sandbox): Promise<void> {
			const state = session(sandbox)
			state.files = new Map(Object.entries(fixture.files ?? {}))
		},
		async executeCommand(sandbox, command: Command): Promise<CommandResult> {
			const state = session(sandbox)
			if (!state.locked) {
				throw new InspectionError("policy", "Registry policy required")
			}
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
