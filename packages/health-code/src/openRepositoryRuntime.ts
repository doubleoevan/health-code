import { defaultMaxCostUsd, type InspectionContext } from "./collectEvents.ts"
import { InspectionError, type InspectionReport, type Sandbox } from "./contracts.ts"
import type { ModelInspection } from "./inspectModels.ts"
import { registryHosts } from "./networkPolicy.ts"

export class RepositoryRuntime {
	allocation?: Sandbox
	constructor(
		private readonly context: InspectionContext,
		private readonly repositoryUrl: string,
		private readonly engine?: ModelInspection,
	) {}

	async open(
		revision?: string,
		label = "Create sandbox",
	): Promise<{ sandbox: Sandbox; repository: InspectionReport["repository"] }> {
		const { context, engine, repositoryUrl } = this
		const { sandboxProvider: provider } = context.options
		const sandbox = await context.step("setup", label, async (config) => {
			// reserve the sandbox identity before awaiting allocation
			this.allocation = { id: `health-code-${context.id}` }
			const lifetime = engine?.meter.start(
				"repository",
				this.allocation.id,
				(ms) => provider.estimateMaxCost(ms),
				provider.estimateMaxCost(
					Math.max(0, context.end - Date.now()) + (engine?.modelRequestSandbox ? context.cleanupMs : 0),
				),
			)
			const created = await provider.createSandbox(this.allocation.id, config)

			// Some providers return an opaque ID after confirming the named allocation.
			if (lifetime) {
				lifetime.id = created.id
			}
			this.allocation = created
			return created
		})

		// publish the sandbox lifecycle events before checkout
		await context.emit({ type: "sandbox.event", sandboxId: sandbox.id, action: "created" })
		await context.emit({
			type: "sandbox.event",
			sandboxId: sandbox.id,
			action: "credentials-withheld",
			...(engine && { storedModelKeyCount: engine.storedModelKeyCount }),
		})
		const commit = await context.step("setup", "Prepare inspected checkout", (config) =>
			provider.prepareRepository(sandbox, repositoryUrl, { ...config, revision }),
		)
		if (!/^[0-9a-f]{40}$/.test(commit) || (revision && revision !== commit)) {
			throw new InspectionError("repository-unavailable", "Unable to verify inspected repository")
		}
		await context.step("setup", "Lock network to registries", (config) =>
			provider.setNetworkPolicy(sandbox, registryHosts, { ...config, timeoutMs: Math.min(10000, config.timeoutMs) }),
		)
		await context.emit({ type: "sandbox.event", sandboxId: sandbox.id, action: "network-locked" })

		// inspect the project under the registry policy
		context.setupComplete = true
		return { sandbox, repository: { url: repositoryUrl, commit } }
	}

	async replace(): Promise<boolean> {
		const { context, engine, allocation } = this
		const provider = context.options.sandboxProvider
		if (!allocation || context.operation("setup").timeoutMs <= 0) {
			return false
		}

		// Confirm deletion before reusing the inspection's runtime name.
		await context.step("setup", "Delete unavailable sandbox", (op) => provider.destroySandbox(allocation, op))
		this.allocation = undefined
		engine?.meter.deleted(allocation.id)
		await context.emit({ type: "sandbox.event", sandboxId: allocation.id, action: "deleted" })

		// Reserve the independently rounded replacement charge inside the remaining budget.
		const remaining = context.end - Date.now()
		const quote = provider.estimateMaxCost(
			Math.max(0, remaining) + (engine?.modelRequestSandbox ? context.cleanupMs : 0),
		)

		// Include the first allocation even for inspections without model roles.
		const spent = provider.estimateMaxCost(Date.now() - context.started)
		const budget = context.options.limits?.maxCostUsd ?? defaultMaxCostUsd
		if (remaining <= context.cleanupMs || !Number.isFinite(quote) || quote < 0 || !(spent + quote <= budget)) {
			return false
		}

		// Preserve all earlier model reservations when admitting a second runtime.
		if (engine) {
			const micros = Math.ceil(quote * 1e6)
			const available = engine.ledger.remainingMicros + engine.repositoryReservationMicros - Math.ceil(spent * 1e6)
			if (micros > available) {
				return false
			}
			engine.ledger.remainingMicros = available - micros
		}

		// Restart only the stage clocks after reserving the replacement.
		context.restartSetup()
		return true
	}
}
