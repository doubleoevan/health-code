import { isDeepStrictEqual } from "node:util"
import { readConfiguration } from "./readConfiguration.ts"
export type LaunchLimits = {
	dailyVisitorInspections: number
	concurrency: number
	dailyMicros: number
	maxSizeKiB: number
	maxUpgrades: number
	// Per-inspection and per-attempt USD ceilings.
	maxCostUsd: number
	repairUsd: number
	adoptionUsd: number
}

export function toLaunchLimits(environment: Record<string, string | undefined>): LaunchLimits {
	function number(name: string, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number {
		// Interpret only explicit finite nonnegative values.
		const raw = environment[`HEALTH_CODE_${name}`]
		const parsed = raw === undefined ? fallback : Number(raw)
		if (raw?.trim() === "" || !Number.isFinite(parsed) || parsed < 0 || parsed > maximum) {
			throw new Error(`Invalid launch limit: ${name}`)
		}
		return parsed
	}
	// Validate the complete replacement before exposing it to admission.
	const limits = {
		dailyVisitorInspections: number("VISITOR_RUNS", 3),
		concurrency: number("CONCURRENCY", 2),
		dailyMicros: Math.floor(number("DAILY_COST_USD", 10) * 1e6),
		maxSizeKiB: number("MAX_REPO_MIB", 100) * 1024,
		maxUpgrades: number("MAX_UPGRADES", 2, 5),
		maxCostUsd: number("MAX_COST_USD", 5, 5),
		repairUsd: number("REPAIR_COST_USD", 2, 2),
		adoptionUsd: number("ADOPTION_COST_USD", 1, 1),
	}
	for (const count of [
		limits.dailyVisitorInspections,
		limits.concurrency,
		limits.maxSizeKiB,
		limits.maxUpgrades,
		limits.dailyMicros,
	]) {
		if (!Number.isSafeInteger(count)) {
			throw new Error("Invalid integral launch limit")
		}
	}
	return limits
}

export class LaunchSettings {
	current: LaunchLimits
	private refreshed: number
	constructor(
		environment: NodeJS.ProcessEnv,
		private readonly token?: string,
		private readonly request: (...args: Parameters<typeof fetch>) => Promise<Response> = fetch,
	) {
		this.current = toLaunchLimits(environment)
		this.refreshed = token ? 0 : Date.now()
	}
	// Permit a short outage after a successful limits refresh.
	get available(): boolean {
		return !this.token || Date.now() - this.refreshed < 180000
	}
	// Expose the last accepted refresh time to the operator.
	get updated(): string | null {
		return this.refreshed ? new Date(this.refreshed).toISOString() : null
	}
	async refresh(): Promise<void> {
		if (!this.token) {
			return
		}
		// Read only the dedicated limits configuration using its read-only token.
		const values = await readConfiguration(this.token, this.request)
		// Require the entire limits snapshot before replacing the last accepted configuration.
		const required = [
			"VISITOR_RUNS",
			"CONCURRENCY",
			"DAILY_COST_USD",
			"MAX_REPO_MIB",
			"MAX_UPGRADES",
			"MAX_COST_USD",
			"REPAIR_COST_USD",
			"ADOPTION_COST_USD",
		]
		if (!required.every((key) => Object.hasOwn(values, `HEALTH_CODE_${key}`))) {
			throw new Error("Incomplete limits configuration")
		}

		const next = toLaunchLimits(values)
		if (!isDeepStrictEqual(next, this.current)) {
			this.current = next
		}
		this.refreshed = Date.now()
	}
}
