import { closeSync, fstatSync, openSync, readFileSync, readSync, rmSync, statSync } from "node:fs"
import { posix } from "node:path"
import { StringDecoder } from "node:string_decoder"
import { traceByteLimit } from "../src/sandbox/traceByteLimit.ts"
import { inspectTrace } from "./observe.ts"

class CaptureLimitError extends Error {}

/**
 * Reads the protected syscall capture without retaining the install's entire trace in memory.
 */
export function* readTraceLines(path: string): Generator<string> {
	const descriptor = openSync(path, "r")
	try {
		if (fstatSync(descriptor).size > traceByteLimit) {
			throw new CaptureLimitError("Installation trace exceeded the capture limit")
		}

		// Bound each read independently of the total capture size.
		const buffer = Buffer.alloc(256 * 1024)
		const decoder = new StringDecoder("utf8")
		let tail = ""

		// Carry partial lines and multibyte path characters across reads.
		for (let size = readSync(descriptor, buffer); size; size = readSync(descriptor, buffer)) {
			const lines = (tail + decoder.write(buffer.subarray(0, size))).split("\n")
			tail = lines.pop() ?? ""
			if (tail.length > 1024 * 1024) {
				throw new CaptureLimitError("Installation trace line exceeded the capture limit")
			}
			yield* lines
		}

		// Require a complete last record from the tracer.
		if (tail || decoder.end()) {
			throw new CaptureLimitError("Installation trace ended during a syscall record")
		}
	} finally {
		closeSync(descriptor)
	}
}

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
		// seed link tracking with the pinned project entries
		const links = read("links")
			.split("\0")
			.filter(Boolean)
			.map((path) => posix.resolve("/project", path))
		console.log(
			JSON.stringify(
				inspectTrace(
					readTraceLines(`${directory}/syscalls`),
					read("dns"),
					read("status"),
					process.argv.slice(3),
					links,
				),
			),
		)
	} catch (error) {
		// Publish only supervisor-defined diagnostics for an incomplete capture.
		const reason = error instanceof CaptureLimitError ? error.message : "Could not read installation evidence"
		const missing = { complete: false, reason, findings: [] }
		console.log(JSON.stringify({ connections: missing, files: missing }))
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
}
