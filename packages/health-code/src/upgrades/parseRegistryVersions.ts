import { z } from "zod"
import { InspectionError, SandboxUnavailableError } from "../contracts.ts"

export class ProjectEvidenceError extends Error {}
export class RegistryDeadlineError extends ProjectEvidenceError {}

export type RegistryVersions = {
	versions: Record<string, string[]>
	packageTimeoutCount: number
	hasRegistryDeadlineExpired: boolean
}

const registrySchema = z.record(
	z.string(),
	z.union([z.array(z.string()), z.enum(["timed-out", "stage-timed-out", "unavailable"])]),
)

/**
 * Separates completed registry lookups from package and stage timeouts.
 */
export function parseRegistryVersions(metadata: unknown, names: string[]): RegistryVersions {
	const result = registrySchema.safeParse(metadata)
	if (!result.success) {
		throw new ProjectEvidenceError("Invalid registry metadata")
	}

	// preserve completed lookups and distinguish the stage deadline from a single slow package
	const versions: Record<string, string[]> = Object.create(null)
	let packageTimeoutCount = 0
	let hasRegistryDeadlineExpired = false
	for (const name of names) {
		const entry = result.data[name]
		if (Array.isArray(entry)) {
			versions[name] = entry
		} else if (entry === "stage-timed-out") {
			// report the shared deadline even for packages still in the queue
			hasRegistryDeadlineExpired = true
		} else if (entry === "timed-out") {
			packageTimeoutCount++
		}
	}
	return { versions, packageTimeoutCount, hasRegistryDeadlineExpired }
}

/**
 * Explains a failed registry lookup and rethrows failures that end the inspection.
 */
export function toRegistryLookupIssue(error: unknown, timeoutReason: string): string {
	if (error instanceof SandboxUnavailableError) {
		throw error
	}

	if (error instanceof InspectionError && error.code === "deadline") {
		// The remote command may still own the sandbox when the host deadline fires.
		throw new RegistryDeadlineError(`Couldn’t list available upgrades: ${timeoutReason}.`)
	}

	const timedOut = error instanceof InspectionError && error.code === "registry-command-timeout"
	const unavailable = error instanceof InspectionError && error.code === "sandbox-unavailable"
	if (!timedOut && !unavailable && !(error instanceof ProjectEvidenceError)) {
		throw error
	}

	const reason = timedOut ? timeoutReason : "registry lookup failed"
	return `Couldn’t list available upgrades: ${reason}.`
}
