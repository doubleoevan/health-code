import type { Command } from "../contracts.ts"
import { guestArguments, observe } from "./executeGuest.ts"

const projectTool = "/opt/health-code/project.mjs"

/**
 * Prepares sandbox commands for test capture, protected evidence, and registry lookup.
 */
export function buildTestCommand(options: { command: Command; dir?: string; id: string; previous?: string }): {
	argv: string[]
	capture?: string
} {
	// identify trusted test and inventory requests before mounting evidence
	const { command, dir, id, previous } = options
	const [node, tool, action, option] = command.argv
	const trustedTool = node === "node" && tool === projectTool
	const capture =
		trustedTool && action === "tests" && option === "--inventory" ? `/var/lib/health-code/tests-${id}` : undefined
	let argv: string[]

	// give a fresh report write access only during its test run
	if (capture) {
		argv = guestArguments(command, dir, { path: `${capture}/raw/report`, kind: "report", writable: true })
	} else if (trustedTool && action === "registry") {
		// Allow the guest to flush completed lookups before the remote command deadline.
		const grace = Math.min(2000, command.timeoutMs / 4)
		const budget = Math.max(0, Math.floor(command.timeoutMs - grace))
		argv = guestArguments(
			{ ...command, argv: [node, tool, action, `--timeout-ms=${budget}`, ...command.argv.slice(3)] },
			dir,
		)
	} else if (trustedTool && action === "integrity" && previous) {
		argv = guestArguments(command, dir, { path: `${previous}/inventory`, kind: "inventory" })
	} else if (trustedTool && action === "report" && previous) {
		argv = guestArguments({ ...command, argv: [...command.argv, "--protected"] }, dir, {
			path: `${previous}/report`,
			kind: "report",
		})
	} else {
		argv = guestArguments(command, dir)
	}

	// wrap the prepared command in observation and capture as requested
	if (dir) {
		argv = ["bash", "-c", observe, "observe", dir, ...argv]
	}
	if (capture) {
		argv = ["/opt/health-code/bin/node", projectTool, "capture-tests", capture, ...argv]
	}
	return { argv, capture }
}
