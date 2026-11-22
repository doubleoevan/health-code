import { untested } from "./confirmCheck.ts"
import type { CheckResult, CommandResult, Evidence } from "./contracts.ts"
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

	// represent file loading errors as additional test failures
	const failures = summary.data.testFileErrors.map(({ file }) => ({ workspace: ".", file }))
	if (failures.length) {
		check = {
			status: "failed",
			evidence: [evidence],
			failingTests: [...(check.status === "failed" ? check.failingTests : []), ...failures],
		}
	}
	check.inventory = summary.data
	return check
}
