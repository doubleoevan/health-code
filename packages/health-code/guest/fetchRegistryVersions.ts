import { readBoundedJson } from "../src/readBoundedJson.ts"
import { selectRegistryVersions } from "./selectRegistryVersions.ts"

type RegistryRequest = (url: string, options: RequestInit) => Promise<Response>
type RegistryResult = string[] | "timed-out" | "unavailable" | "stage-timed-out"

type RegistryOptions = { includePrevious?: boolean; request?: RegistryRequest; signal?: AbortSignal }

async function fetchPackage(name: string, options: RegistryOptions): Promise<RegistryResult> {
	const timeout = AbortSignal.timeout(8000)
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
	const request = options.request ?? fetch
	try {
		const response = await request(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
			headers: { accept: "application/vnd.npm.install-v1+json" },
			redirect: "error",
			signal,
		})

		// Release the connection before this worker takes another package.
		if (!response.ok) {
			await response.body?.cancel()
			return "unavailable"
		}

		const record = (await readBoundedJson(response, 8 * 1024 * 1024)) as { versions?: unknown } | null
		const versions = record?.versions
		if (!versions || typeof versions !== "object" || Array.isArray(versions)) {
			return "unavailable"
		}

		return selectRegistryVersions(Object.keys(versions), options.includePrevious ?? false)
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
 * Fetches registry versions with at most sixteen requests in flight.
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
	await Promise.all(Array.from({ length: Math.min(names.length, 16) }, worker))
	return output
}
