import { readBoundedJson } from "../src/upgrades/readBoundedJson.ts"
import { isExcluded, type ReleaseAge } from "./readReleaseAge.ts"
import { selectRegistryVersions } from "./selectRegistryVersions.ts"

type RegistryRequest = (url: string, options: RequestInit) => Promise<Response>
type RegistryResult = string[] | "timed-out" | "unavailable" | "stage-timed-out"

type RegistryOptions = {
	includePrevious?: boolean
	releaseAge?: ReleaseAge
	request?: RegistryRequest
	signal?: AbortSignal
}

// publish dates need the larger metadata response
const summaryLookup = { accept: "application/vnd.npm.install-v1+json", timeoutMs: 8000, maxBytes: 16 * 1024 * 1024 }
const datedLookup = { accept: "application/json", timeoutMs: 20000, maxBytes: 48 * 1024 * 1024 }

type RegistryRecord = { versions?: unknown; time?: Record<string, unknown> }

async function fetchPackage(name: string, options: RegistryOptions): Promise<RegistryResult> {
	// request publish dates only for packages subject to a release age
	const releaseAge = options.releaseAge && !isExcluded(name, options.releaseAge) ? options.releaseAge : undefined
	const lookup = releaseAge ? datedLookup : summaryLookup
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

		const record = (await readBoundedJson(response, lookup.maxBytes)) as RegistryRecord | null
		const versions = record?.versions
		if (!versions || typeof versions !== "object" || Array.isArray(versions)) {
			return "unavailable"
		}

		// Exclude deprecated releases.
		const undeprecatedVersions = Object.entries(versions)
			.filter(([, release]) => !release?.deprecated)
			.map(([version]) => version)

		// Drop releases that are too new before choosing the latest of each major.
		const published = record?.time
		const eligibleVersions = undeprecatedVersions.filter(
			(version) => !releaseAge || Date.parse(String(published?.[version])) <= releaseAge.publishedBefore,
		)
		return selectRegistryVersions(eligibleVersions, options.includePrevious ?? false)
	} catch {
		return options.signal?.aborted ? "stage-timed-out" : timeout.aborted ? "timed-out" : "unavailable"
	}
}

/**
 * Accepts scoped and unscoped package names with a single package path segment.
 */
export function isPackageName(name: string): boolean {
	return /^(?:@[a-z\d_.-]+\/)?(?!\.{1,2}$)[a-z\d_.-]+$/i.test(name)
}

/**
 * Fetches registry versions with at most sixteen requests in flight, or four when publish dates are needed.
 */
export async function fetchRegistryVersions(
	names: string[],
	options: RegistryOptions = {},
): Promise<Record<string, RegistryResult>> {
	const output: Record<string, RegistryResult> = Object.create(null)
	const pending = names.filter(isPackageName).values()

	// Share the package queue so a slow lookup occupies only one worker.
	async function worker(): Promise<void> {
		for (const name of pending) {
			output[name] = options.signal?.aborted ? "stage-timed-out" : await fetchPackage(name, options)
		}
	}
	await Promise.all(Array.from({ length: Math.min(names.length, options.releaseAge ? 4 : 16) }, worker))
	return output
}
