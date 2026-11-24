import { readFileSync, rmSync, statSync } from "node:fs"
import { posix } from "node:path"
import { inspectSandboxActivity } from "./inspectSandboxActivity.ts"
import { CaptureLimitError, readSystemCallLogLines } from "./readSystemCallLogLines.ts"

// accept only the supervisor's per-inspection evidence directory
const directory = process.argv[2]
if (directory && /^\/var\/lib\/health-code\/evidence-[a-f0-9-]{36}$/.test(directory)) {
	const read = (name: string): string => {
		const path = `${directory}/${name}`

		// bound each capture before loading it into memory
		if (statSync(path).size >= 32 * 1024 * 1024) {
			throw new CaptureLimitError("Installation evidence exceeded the capture limit")
		}
		return readFileSync(path, "utf8")
	}
	try {
		// seed link tracking with the inspected project entries
		const links = read("links")
			.split("\0")
			.filter(Boolean)
			.map((path) => posix.resolve("/project", path))
		console.log(
			JSON.stringify(
				inspectSandboxActivity(
					readSystemCallLogLines(`${directory}/syscalls`),
					read("dns"),
					read("status"),
					process.argv.slice(3),
					links,
				),
			),
		)
	} catch (error) {
		// Publish only supervisor-defined diagnostics for an incomplete capture.
		const reason = error instanceof CaptureLimitError ? error.message : "Could not read installation activity records"
		const missing = { complete: false, reason, findings: [] }
		console.log(JSON.stringify({ connections: missing, files: missing }))
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
}
