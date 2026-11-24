import { posix } from "node:path"
import type { CommandResult, TestFailure } from "../contracts.ts"

/**
 * Reads the errors of a complete typecheck.
 */
export function readCheckErrors([stage]: string[], result: CommandResult): TestFailure[] {
	return stage === "typecheck" && !result.stdoutTruncated ? readTypeErrors(result.stdout) : []
}

/**
 * Identifies each compiler error by file and message, or none when the output holds anything else.
 */
export function readTypeErrors(output: string): TestFailure[] {
	const errors: TestFailure[] = []
	const occurrences = new Map<string, number>()
	for (const line of output.split(/\r?\n/)) {
		// skip blank lines and indented explanations
		if (!line.trim() || /^\s/.test(line)) {
			continue
		}

		// leave errors without a source file unidentified
		const match = /^([^()]+\.(?:[cm]?[jt]sx?|json))\(\d+,\d+\): error (TS\d+: .*)$/.exec(line)
		const [, file, message] = match ?? []
		if (!file || !message) {
			return []
		}

		// omit line numbers so an edit above the error keeps its identity
		const path = posix.normalize(file)
		const key = JSON.stringify([path, message])
		const occurrence = (occurrences.get(key) ?? 0) + 1
		occurrences.set(key, occurrence)
		errors.push({ workspace: ".", file: path, name: occurrence > 1 ? `${message} (${occurrence})` : message })
	}
	return errors
}
