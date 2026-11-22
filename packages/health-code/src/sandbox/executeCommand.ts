import { randomUUID } from "node:crypto"
import { type Command, type CommandResult, InspectionError, type Observation, type Operation } from "../contracts.ts"
import { buildTestCommand } from "./executeTests.ts"
import { checked, exec, type Runtime, remainingOperation } from "./requestRuntime.ts"

export type Instance = {
	runtime: Runtime
	locked: boolean
	updating: boolean
	commands: number

	// retain capture handles and policy state for repository commands
	testCapture?: string
	hosts: string[]
	observations: Map<string, { connections: Observation; files: Observation }>
}

async function replaceTestCapture(
	instance: Instance,
	command: { argv: string[] },
	capture: string | undefined,
	remaining: () => Operation,
): Promise<void> {
	if (capture || (command.argv[1] === "/opt/health-code/project.mjs" && command.argv[2] === "tests")) {
		// replace the previous reporter capture when a test run starts
		const previous = instance.testCapture
		instance.testCapture = capture
		if (previous) {
			await checked(instance.runtime, ["rm", "-rf", "--", previous], remaining())
		}
	}
}

// serialize commands on each sandbox
export async function executeCommand(instance: Instance, command: Command): Promise<CommandResult> {
	if (instance.commands) {
		throw new InspectionError("sandbox-busy", "Repository command is active")
	}
	instance.commands++
	try {
		// share the command deadline with capture preparation
		const remaining = remainingOperation(command)
		const id = randomUUID()
		const dir = command.observe ? `/var/lib/health-code/evidence-${id}` : undefined
		const { argv, capture, maxOutputBytes, placeholderVariableCount } = buildTestCommand({
			command,
			dir,
			id,
			previous: instance.testCapture,
		})
		await replaceTestCapture(instance, command, capture, remaining)
		const result = await exec(instance.runtime, argv, command, maxOutputBytes)

		// associate observation evidence with this command id
		if (dir) {
			const missing: Observation = { complete: false, reason: "Installation observer unavailable", findings: [] }
			let evidence = { connections: missing, files: missing }
			try {
				const budget = remaining()
				const raw = await checked(
					instance.runtime,
					["/opt/health-code/bin/node", "/opt/health-code/observe.mjs", dir, ...instance.hosts],
					{ ...budget, timeoutMs: Math.min(5000, budget.timeoutMs) },
				)
				evidence = JSON.parse(raw)
			} catch {
				// Keep the check untested when the supervisor cannot provide complete evidence.
			}
			instance.observations.set(id, evidence)
			result.observationId = id
		}

		// release the command slot after recording its result
		return { ...result, placeholderVariableCount }
	} finally {
		instance.commands--
	}
}
