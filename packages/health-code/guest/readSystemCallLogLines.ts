import { closeSync, fstatSync, openSync, readSync } from "node:fs"
import { StringDecoder } from "node:string_decoder"
import { maxSystemCallLogBytes } from "../src/sandbox/maxSystemCallLogBytes.ts"

/**
 * Marks installation evidence that exceeded a capture limit.
 */
export class CaptureLimitError extends Error {}

/**
 * Reads the protected system call log one chunk at a time.
 */
export function* readSystemCallLogLines(path: string): Generator<string> {
	const descriptor = openSync(path, "r")
	try {
		if (fstatSync(descriptor).size > maxSystemCallLogBytes) {
			throw new CaptureLimitError("System call log exceeded the capture limit")
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
				throw new CaptureLimitError("System call log line exceeded the capture limit")
			}
			yield* lines
		}

		// Require a complete last record from the tracer.
		if (tail || decoder.end()) {
			throw new CaptureLimitError("System call log ended during a syscall record")
		}
	} finally {
		closeSync(descriptor)
	}
}
