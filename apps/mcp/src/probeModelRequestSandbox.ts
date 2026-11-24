import { randomUUID } from "node:crypto"
import { type ModelRequestSandbox, type SandboxModelRoutes, toModelRequestSandboxName } from "health-code"
import { UserError } from "./userError.ts"

export const setupTimeoutMs = 120000

/**
 * Verifies the stored model credential with one output token and reclaims its model request sandbox.
 */
export async function probeModelRequestSandbox({
	modelRequestSandbox,
	route,
	end,
}: {
	modelRequestSandbox: ModelRequestSandbox
	route: SandboxModelRoutes["releaseSummary"]
	end: number
}): Promise<void> {
	const name = toModelRequestSandboxName(randomUUID())
	const price = route.pricing

	// Price the probe and its maximum runtime before creating anything.
	const cost =
		modelRequestSandbox.estimateMaxCost(setupTimeoutMs) +
		(price.fixedUsd ?? 0) +
		(price.inputUsdPerMillion * price.maxInputTokens + price.outputUsdPerMillion) / 1e6

	// Enforce a setup budget independent of any Inspection.
	if (!Number.isFinite(cost) || cost > 15) {
		throw new UserError("Setup probe exceeds the default $15 Inspection ceiling. Check model pricing.")
	}

	// Check the remaining work window before claiming a cleanup identity.
	const startup = sandboxOperation({ end, cap: 60000, reserve: 15000 })
	let failure: UserError | undefined

	// Setup gets exactly one paid inference and keeps time for independent cleanup.
	try {
		await modelRequestSandbox.open(name, route, startup)
		const reply = await modelRequestSandbox.send(
			name,
			{ role: "releaseSummary", route, prompt: "Reply OK.", output: 1 },
			sandboxOperation({ end, cap: setupTimeoutMs, reserve: 15000 }),
		)

		// Accept only usage covered by the setup reservation.
		const input = reply.inputTokens ?? -1
		if (!Number.isSafeInteger(input) || input < 0 || input > price.maxInputTokens || reply.outputTokens !== 1) {
			throw new Error("Missing probe receipt")
		}
	} catch {
		// Keep credential errors and upstream response bodies private.
		failure = new UserError(
			"Model Request Sandbox verification failed. Check the model and its pricing. Register the key for this origin with MODEL_API_KEY during setup.",
		)
	} finally {
		try {
			await modelRequestSandbox.close(name, sandboxOperation({ end, cap: 30000 }))
		} catch {
			failure = modelRequestSandboxCleanupError(name)
		}
	}

	// Surface any outstanding cleanup before returning success.
	if (failure) {
		throw failure
	}
}

/**
 * Keeps recovery, verification and cleanup within the same wall-clock deadline.
 */
export function sandboxOperation({ end, cap, reserve = 0 }: { end: number; cap: number; reserve?: number }): {
	timeoutMs: number
	signal: AbortSignal
} {
	// Reserve the final work window for teardown.
	const timeoutMs = Math.floor(Math.min(cap, end - Date.now() - reserve))
	if (timeoutMs <= 0) {
		throw new UserError("Model Request Sandbox deadline reached.")
	}
	return { timeoutMs, signal: AbortSignal.timeout(timeoutMs) }
}

/**
 * Identifies the outstanding allocation without exposing provider diagnostics.
 */
export function modelRequestSandboxCleanupError(name: string): UserError {
	return new UserError(`Model Request Sandbox cleanup failed. Check ${name} in Runta and retry.`)
}
