import { z } from "zod"
import { readOwnProperty } from "../readOwnProperty.ts"
import { forEachConcurrently } from "./forEachConcurrently.ts"
import { mebibyte, ResponseTooLargeError, readBoundedJson } from "./readBoundedJson.ts"
import { isExcluded, type ReleaseAge } from "./readCommittedReleaseAge.ts"
import { selectRegistryVersions } from "./selectRegistryVersions.ts"

// one package's selected versions, or the reason its lookup produced none
export const registryResultSchema = z.union([
	z.array(z.string()),
	z.enum(["timed-out", "stage-timed-out", "unavailable", "too-large"]),
])
type RegistryResult = z.infer<typeof registryResultSchema>
export type RegistryFailure = Exclude<RegistryResult, string[]>
type RegistryRequest = (url: string, options: RequestInit) => Promise<Response>

export type RegistryOptions = {
	includePrevious?: boolean
	releaseAge?: ReleaseAge
	request?: RegistryRequest
	signal?: AbortSignal

	// the requests in flight and the largest response the caller's memory allows
	registryConcurrency?: number
	maxRegistryResponseBytes?: number
}

// publish dates need the larger metadata response
const summaryLookup = { accept: "application/vnd.npm.install-v1+json", timeoutMs: 8000, maxBytes: 32 * mebibyte }
const datedLookup = { accept: "application/json", timeoutMs: 20000, maxBytes: 48 * mebibyte }
type LookupSettings = typeof summaryLookup

export type RegistryRecord = { versions: Record<string, unknown>; time?: unknown; modified?: unknown }

type RecordRequestOptions = { name: string; lookup: LookupSettings; options: RegistryOptions }
type SummaryRequestOptions = { name: string; releaseAge: ReleaseAge | undefined; options: RegistryOptions }

/**
 * Fetches registry versions with a bounded number of requests in flight.
 */
export async function fetchRegistryVersions(
	names: string[],
	options: RegistryOptions = {},
): Promise<Record<string, RegistryResult>> {
	const output: Record<string, RegistryResult> = Object.create(null)

	// start as many workers as the caller's limit allows, or four when publish dates are needed
	await forEachConcurrently({
		items: names.filter(isPackageName),
		concurrency: options.registryConcurrency ?? (options.releaseAge ? 4 : 16),
		work: async (name) => {
			output[name] = options.signal?.aborted ? "stage-timed-out" : await fetchPackage(name, options)
		},
	})
	return output
}

/**
 * Accepts scoped and unscoped package names with a single package path segment.
 */
export function isPackageName(name: string): boolean {
	return /^(?:@[a-z\d_.-]+\/)?(?!\.{1,2}$)[a-z\d_.-]+$/i.test(name)
}

/**
 * Reads one package's registry record, with publish dates only when an age applies to a recently modified package.
 */
export async function fetchRegistryRecord(
	name: string,
	options: RegistryOptions,
): Promise<{ record: RegistryRecord; releaseAge?: ReleaseAge } | RegistryFailure> {
	// skip the release age for an exempt package and answer from the summary when it holds every answer
	const releaseAge = options.releaseAge && !isExcluded(name, options.releaseAge) ? options.releaseAge : undefined
	const summary = await requestSummary({ name, releaseAge, options })
	if (summary !== undefined) {
		return summary
	}
	const dated = await requestRecord({ name, lookup: datedLookup, options })
	return typeof dated === "string" ? dated : { record: dated, releaseAge }
}

// return nothing when publish dates are needed, which frees the summary before the larger record arrives
async function requestSummary({
	name,
	releaseAge,
	options,
}: SummaryRequestOptions): Promise<{ record: RegistryRecord } | RegistryFailure | undefined> {
	const summary = await requestRecord({ name, lookup: summaryLookup, options })
	if (!releaseAge) {
		return typeof summary === "string" ? summary : { record: summary }
	}

	// skip the dated request for a package not modified inside the age window
	const modified = typeof summary === "string" ? Number.NaN : Date.parse(String(summary.modified))
	return typeof summary !== "string" && modified <= releaseAge.publishedBefore ? { record: summary } : undefined
}

/**
 * Lists a record's releases that are not deprecated and are old enough to install.
 */
export function toInstallableDependencyVersions(record: RegistryRecord, releaseAge?: ReleaseAge): string[] {
	// exclude deprecated releases
	const undeprecatedVersions = Object.entries(record.versions)
		.filter(([, release]) => !isDeprecated(release))
		.map(([version]) => version)

	// drop releases that are too new
	return undeprecatedVersions.filter(
		(version) => !releaseAge || readPublishTime(record, version) <= releaseAge.publishedBefore,
	)
}

/**
 * Checks whether the registry marks a release as deprecated.
 */
export function isDeprecated(release: unknown): boolean {
	return Boolean(readOwnProperty(release, "deprecated"))
}

/**
 * Reads the time a version was published, which is not a number when the record has no date for it.
 */
export function readPublishTime(record: RegistryRecord, version: string): number {
	return Date.parse(String(readOwnProperty(record.time, version)))
}

async function fetchPackage(name: string, options: RegistryOptions): Promise<RegistryResult> {
	const lookup = await fetchRegistryRecord(name, options)
	if (typeof lookup === "string") {
		return lookup
	}

	// choose the latest of each major among the installable releases
	const installableDependencyVersions = toInstallableDependencyVersions(lookup.record, lookup.releaseAge)
	return selectRegistryVersions(installableDependencyVersions, options.includePrevious ?? false)
}

async function requestRecord({
	name,
	lookup,
	options,
}: RecordRequestOptions): Promise<RegistryRecord | RegistryFailure> {
	// bound the request by the lookup's timeout and the caller's stage deadline
	const timeout = AbortSignal.timeout(lookup.timeoutMs)
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
	const request = options.request ?? fetch
	try {
		const response = await request(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
			headers: { accept: lookup.accept },
			redirect: "error",
			signal,
		})

		// Release the connection before this worker takes another package.
		if (!response.ok) {
			await response.body?.cancel()
			return "unavailable"
		}

		// read the response within the smaller of the lookup's bound and the caller's
		const maxBytes = Math.min(lookup.maxBytes, options.maxRegistryResponseBytes ?? lookup.maxBytes)
		const record = (await readBoundedJson(response, maxBytes)) as { versions?: unknown } | null

		// reject a response without a versions map
		const versions = record?.versions
		if (!versions || typeof versions !== "object" || Array.isArray(versions)) {
			return "unavailable"
		}

		// return the whole record
		return record as RegistryRecord
	} catch (error) {
		return toLookupFailure(error, { lookup, options, timeout })
	}
}

// classify why a registry request produced no record
function toLookupFailure(
	error: unknown,
	{ lookup, options, timeout }: { lookup: LookupSettings; options: RegistryOptions; timeout: AbortSignal },
): RegistryFailure {
	// report a response over a limit the caller set as too large, which is a stable answer for that caller
	if (error instanceof ResponseTooLargeError && options.maxRegistryResponseBytes !== undefined) {
		return "too-large"
	}

	// name the deadline that ended the request
	if (options.signal?.aborted) {
		return "stage-timed-out"
	}
	return timeout.aborted ? "timed-out" : "unavailable"
}
