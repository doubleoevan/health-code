import { posix } from "node:path"
import type { CheckResult, CommandResult, Evidence } from "../contracts.ts"
import { untested } from "./confirmCheck.ts"
import { testInventorySummarySchema } from "./testInventorySummary.ts"

function parseInventory(text: string): unknown {
	try {
		return JSON.parse(text)
	} catch {
		return undefined
	}
}

// merge inventory failures only when a complete summary is available
export function mergeTestInventory({
	check,
	commandResult,
	evidence,
}: {
	check: CheckResult
	commandResult: CommandResult
	evidence: Evidence
}): CheckResult {
	if (check.inventoryUnavailable) {
		return check
	}

	// A truncated inventory cannot establish comparable passing tests.
	const summary = commandResult.stdoutTruncated
		? undefined
		: testInventorySummarySchema.safeParse(parseInventory(commandResult.stdout))
	if (!summary?.success) {
		// Keep named failures recovered separately from the incomplete inventory.
		if (check.status === "failed") {
			return { ...check, inventoryUnavailable: "Test inventory incomplete" }
		}
		return untested("incomplete-test-report", [evidence])
	}

	// add file loading errors missing from the reported failures
	const { testFileErrors } = summary.data
	const reportedFailures = check.status === "failed" ? check.failingTests : []
	const reportedFileErrors = new Set(
		reportedFailures.filter(({ name }) => !name).map(({ workspace, file }) => posix.join(workspace, file)),
	)

	// compare files by repository path
	const addedFileErrors = testFileErrors
		.filter(({ file }) => !reportedFileErrors.has(posix.normalize(file)))
		.map(({ file }) => ({ workspace: ".", file }))
	if (testFileErrors.length) {
		check = {
			status: "failed",
			evidence: [evidence],
			failingTests: [...reportedFailures, ...addedFileErrors],
		}
	}
	check.inventory = summary.data
	return check
}
