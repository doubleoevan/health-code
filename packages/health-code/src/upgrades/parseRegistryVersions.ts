import { z } from "zod"
import { InspectionError, SandboxUnavailableError } from "../contracts.ts"
import { registryResultSchema } from "./fetchRegistryVersions.ts"

export class ProjectEvidenceError extends Error {}
export class RegistryDeadlineError extends ProjectEvidenceError {}

export type RegistryVersions = {
	versions: Record<string, string[]>
	packageTimeoutCount: number
	hasRegistryDeadlineExpired: boolean
}

const registrySchema = z.record(z.string(), registryResultSchema)

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
 * Explains which dependencies a partial registry lookup is missing.
 */
export function toPartialLookupIssue({
	names,
	registryVersions,
	timeoutMs,
}: {
	names: string[]
	registryVersions: RegistryVersions
	timeoutMs: number
}): string | undefined {
	// return nothing for a complete lookup
	const missing = names.length - Object.keys(registryVersions.versions).length
	if (!missing) {
		return undefined
	}

	// Keep available upgrades when only some package requests failed.
	const scope = missing === names.length ? "" : ` for ${missing} of ${names.length} dependencies`
	const reason = registryVersions.hasRegistryDeadlineExpired
		? toTimeoutReason(timeoutMs)
		: registryVersions.packageTimeoutCount === missing
			? "registry requests timed out"
			: "package version information was unavailable"
	return `Couldn’t list available upgrades${scope}: ${reason}.`
}

/**
 * Explains a failed registry lookup and rethrows failures that end the inspection.
 */
export function toRegistryLookupIssue(error: unknown, timeoutMs: number): string {
	if (error instanceof SandboxUnavailableError) {
		throw error
	}

	if (error instanceof InspectionError && error.code === "deadline") {
		// The remote command may still own the sandbox when the host deadline fires.
		throw new RegistryDeadlineError(`Couldn’t list available upgrades: ${toTimeoutReason(timeoutMs)}.`)
	}

	const timedOut = error instanceof InspectionError && error.code === "registry-command-timeout"
	const unavailable = error instanceof InspectionError && error.code === "sandbox-unavailable"
	if (!timedOut && !unavailable && !(error instanceof ProjectEvidenceError)) {
		throw error
	}

	const reason = timedOut ? toTimeoutReason(timeoutMs) : "registry lookup failed"
	return `Couldn’t list available upgrades: ${reason}.`
}

function toTimeoutReason(timeoutMs: number): string {
	return `registry lookup timed out after ${Math.max(0, Math.ceil(timeoutMs / 1000))}s`
}
