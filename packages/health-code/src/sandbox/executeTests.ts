import type { Command } from "../contracts.ts"
import { guestArguments, observe } from "./executeGuest.ts"

const projectTool = "/opt/health-code/project.mjs"

/**
 * Prepares sandbox commands for test capture, protected evidence, and registry lookup.
 */
export function buildTestCommand(options: { command: Command; dir?: string; id: string; previous?: string }): {
	argv: string[]
	capture?: string
	maxOutputBytes?: number
	placeholderVariableCount: number
} {
	// identify trusted test and inventory requests before mounting evidence
	const { command, dir, id, previous } = options
	const [node, tool, action, option] = command.argv
	const trustedTool = node === "node" && tool === projectTool
	const capture =
		trustedTool && action === "tests" && option === "--inventory" ? `/var/lib/health-code/tests-${id}` : undefined
	let guest: ReturnType<typeof guestArguments>

	// give a fresh report write access only during its test run
	if (capture) {
		guest = guestArguments(command, dir, { path: `${capture}/raw/report`, kind: "report", writable: true })
	} else if (trustedTool && action === "registry") {
		// Allow the guest to flush completed lookups before the remote command deadline.
		const grace = Math.min(2000, command.timeoutMs / 4)
		const budget = Math.max(0, Math.floor(command.timeoutMs - grace))
		guest = guestArguments(
			{ ...command, argv: [node, tool, action, `--timeout-ms=${budget}`, ...command.argv.slice(3)] },
			dir,
		)
	} else if (trustedTool && action === "integrity" && previous) {
		guest = guestArguments(command, dir, { path: `${previous}/inventory`, kind: "inventory" })
	} else if (trustedTool && action === "report" && previous) {
		guest = guestArguments({ ...command, argv: [...command.argv, "--protected"] }, dir, {
			path: `${previous}/report`,
			kind: "report",
		})
	} else {
		guest = guestArguments(command, dir)
	}

	// wrap the prepared command in observation and capture as requested
	let { argv } = guest
	if (dir) {
		argv = ["bash", "-c", observe, "observe", dir, ...argv]
	}

	// Capture test evidence outside the project filesystem.
	if (capture) {
		argv = ["/opt/health-code/bin/node", projectTool, "capture-tests", capture, ...argv]
	}
	const maxOutputBytes = trustedTool ? toOutputLimit(command.argv, previous) : undefined
	return { argv, capture, maxOutputBytes, placeholderVariableCount: guest.placeholderVariableCount }
}

// allow room for every install script and for repository-wide paths on the first protected page
function toOutputLimit([, , action, option]: string[], previous?: string): number | undefined {
	const isFirstProtectedPage = action === "integrity" && option === "0" && previous
	return action === "lifecycle" || isFirstProtectedPage ? 1024 * 1024 : undefined
}
