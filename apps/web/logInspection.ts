import type { InspectionError } from "health-code"

export function logInspection(input: {
	row: { id: string; repositoryUrl: string }
	state: "failed" | "complete" | "interrupted"
	durationMs: number
	upgrades?: { verdict?: string }[]
	usage?: InspectionError["runtimeUsage"]
}): void {
	// Summarize verdicts in the terminal log without loading command output.
	const counts: Record<string, number> = {}
	for (const upgrade of input.upgrades ?? []) {
		const verdict = upgrade.verdict ?? "Unavailable"
		counts[verdict] = (counts[verdict] ?? 0) + 1
	}
	// Restrict terminal records to public identity and bounded accounting evidence.
	const { usage } = input
	console.info(
		JSON.stringify({
			id: input.row.id,
			repo: input.row.repositoryUrl,
			state: input.state,
			durationMs: input.durationMs,
			verdicts: counts,
			modelCostUsd: usage?.modelCostUsd ?? null,
			modelReservedUsd: usage?.modelReservedUsd ?? null,
			sandboxUpperBoundUsd: usage?.runtimes.reduce((sum, item) => sum + item.upperBoundUsd, 0) ?? null,
			totalUpperBoundUsd: usage?.totalUpperBoundUsd ?? null,
		}),
	)
}
