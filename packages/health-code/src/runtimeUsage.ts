import type { ModelUsage } from "./agentContracts.ts"
import type { RuntimeCharge, RuntimeUsage } from "./modelRequestSandbox.ts"

type Lifetime = {
	resource: RuntimeCharge["resource"]
	id: string
	start: number
	end?: number
	reservedUpperBoundUsd?: number
	quote: (ms: number) => number
}

export class RuntimeMeter {
	private allocations: Lifetime[] = []
	start(
		resource: Lifetime["resource"],
		id: string,
		quote: Lifetime["quote"],
		reservedUpperBoundUsd?: number,
	): { id: string } {
		const lifetime = { resource, id, quote, reservedUpperBoundUsd, start: performance.now() }
		this.allocations.push(lifetime)
		return lifetime
	}
	// End metering only when deletion has been acknowledged.
	deleted(id: string): void {
		const allocation = this.allocations.find((item) => item.id === id)
		if (allocation) {
			allocation.end = performance.now()
		}
	}
	// Use one wall-clock cutoff for all outstanding allocations.
	snapshot(receipts: ModelUsage[]): RuntimeUsage {
		const cutoff = performance.now()
		const usageAsOf = new Date().toISOString()
		const runtimes = this.allocations.map(({ resource, id, start, end, quote, reservedUpperBoundUsd }) => {
			const durationMs = Math.ceil(Math.max(0, (end ?? cutoff) - start))
			return {
				resource,
				id,
				durationMs,
				upperBoundUsd: quote(durationMs),
				deleted: end !== undefined,
				...(end === undefined ? { reservedUpperBoundUsd } : {}),
			}
		})
		// Add independent rounded runtime quotes and each model receipt exactly once.
		const modelCostUsd = receipts.reduce((sum, item) => sum + (item.costUsd ?? 0), 0)
		const modelReservedUsd = receipts.reduce((sum, item) => sum + (item.reservedUsd ?? 0), 0)
		const total = modelCostUsd + modelReservedUsd + runtimes.reduce((sum, item) => sum + item.upperBoundUsd, 0)
		return {
			runtimes,
			modelCostUsd,
			modelReservedUsd,
			usageAsOf,
			...(runtimes.every((item) => item.deleted) ? { totalUpperBoundUsd: total } : {}),
		}
	}
}
