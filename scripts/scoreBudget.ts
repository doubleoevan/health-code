import type { InspectionReportV2, ModelUsage, UpgradeReportV2 } from "health-code"

type Limits = NonNullable<InspectionReportV2["limits"]>

// Keep the grading contract independent of the engine defaults under evaluation.
const expected: Limits = {
	maxDurationMs: 3600000,
	maxCostUsd: 15,
	agent: {
		repair: { maxTurns: 40, maxDurationMs: 1200000, maxCostUsd: 4 },
		featureAdoption: { maxTurns: 25, maxDurationMs: 600000, maxCostUsd: 2 },
	},
}

export function scoreBudget(options: {
	limits?: Limits
	modelUsage: ModelUsage[]
	attemptDurationMs?: UpgradeReportV2["attemptDurationMs"]
	durationMs: number
	sandboxCostUpperBoundUsd: number
}): boolean {
	// compare the observed inspection with the evaluation limits
	const { limits, modelUsage, attemptDurationMs, durationMs, sandboxCostUpperBoundUsd } = options
	if (
		!limits ||
		limits.maxCostUsd !== expected.maxCostUsd ||
		limits.maxDurationMs !== expected.maxDurationMs ||
		!within(durationMs, expected.maxDurationMs) ||
		!within(sandboxCostUpperBoundUsd, expected.maxCostUsd) ||
		// require valid usage evidence from at least one repair turn
		!modelUsage.every(validReceipt) ||
		!modelUsage.some((item) => item.step === "repair")
	) {
		return false
	}

	// check each agent role against its own budget
	for (const role of ["repair", "featureAdoption"] as const) {
		const bound = expected.agent[role]
		const actual = limits.agent[role]
		const receipts = modelUsage.filter((item) => item.role === role)
		if (
			// require the expected time, cost and turn limits
			actual.maxDurationMs !== bound.maxDurationMs ||
			actual.maxCostUsd !== bound.maxCostUsd ||
			actual.maxTurns !== bound.maxTurns ||
			// measure turns, charges and elapsed time against the role limits
			receipts.filter((item) => item.step === role).length > bound.maxTurns ||
			!within(totalCost(receipts), bound.maxCostUsd) ||
			((receipts.length || attemptDurationMs?.[role] !== undefined) &&
				!within(attemptDurationMs?.[role], bound.maxDurationMs))
		) {
			return false
		}
	}

	// include sandbox time in the total cost check
	return within(totalCost(modelUsage) + sandboxCostUpperBoundUsd, limits.maxCostUsd)
}

function within(value: number | undefined, limit: number): boolean {
	return value !== undefined && Number.isFinite(value) && value >= 0 && value <= limit
}

function validReceipt(receipt: ModelUsage): boolean {
	// choose the output allowance for the recorded step
	const isCallerModelRole = receipt.role === "releaseSummary" || receipt.role === "featureMatch"
	const cap = receipt.step === "verify credential" ? 1 : isCallerModelRole ? 4096 : 8192
	return (
		// validate the charge, token count and duration
		within(receipt.costUsd ?? receipt.reservedUsd, expected.maxCostUsd) &&
		Number.isSafeInteger(receipt.outputTokens) &&
		within(receipt.outputTokens, cap) &&
		within(receipt.durationMs, isCallerModelRole ? 120000 : expected.agent.repair.maxDurationMs)
	)
}

// include reserved charges when the final price is unavailable
function totalCost(receipts: ModelUsage[]): number {
	return receipts.reduce((sum, item) => sum + (item.costUsd ?? item.reservedUsd ?? Infinity), 0)
}
