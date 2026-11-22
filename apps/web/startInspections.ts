import { mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { createLiveSource, isReplayEnabled } from "./configureSite.ts"
import { Inspections } from "./executeInspection.ts"
import type { InspectionSource } from "./inspectionSource.ts"
import { LaunchService } from "./launchService.ts"
import { readSiteEnvironment } from "./readConfiguration.ts"
import { InspectionStore } from "./storeInspections.ts"

export type SiteRuntime = { replay: boolean; port: number; origin: string; inspections: Inspections }

export async function startInspections(
	options: {
		environment?: NodeJS.ProcessEnv
		onConfigured?: (runtime: SiteRuntime) => void
		read?: typeof readSiteEnvironment
		retry?: typeof Bun.sleep
	} = {},
): Promise<SiteRuntime> {
	const platform = options.environment ?? process.env
	const replay = isReplayEnabled(platform)
	const port = Number(platform.PORT ?? 3000)

	// Keep the public address and report volume available during a credential-store outage.
	const origin = new URL(
		platform.HEALTH_CODE_ORIGIN ??
			(platform.HEALTH_CODE_RUNTIME_CONFIG_TOKEN ? "https://runhealthcode.dev" : `http://localhost:${port}`),
	).origin
	const databasePath =
		platform.HEALTH_CODE_DATABASE ??
		(replay ? resolve(import.meta.dir, "../../logs/site-replay.sqlite") : "/data/inspections.sqlite")
	mkdirSync(dirname(databasePath), { recursive: true })

	// Share the durable store across the read-only and configured workers.
	const store = new InspectionStore(databasePath)
	const read = options.read ?? readSiteEnvironment
	async function configure(): Promise<SiteRuntime> {
		const environment = await read(platform)

		// Let the configured worker reclaim stale allocations before accepting paid work.
		const source = replay ? (await import("./replayInspection.ts")).createReplaySource() : createLiveSource(environment)
		const inspections = new Inspections(store, source, undefined, new LaunchService(environment, replay))
		return { inspections, port, replay, origin }
	}

	// Local replay and directly configured deployments can start immediately.
	if (!platform.HEALTH_CODE_RUNTIME_CONFIG_TOKEN || !options.onConfigured) {
		const runtime = await configure()
		void runtime.inspections.start()
		return runtime
	}

	// Keep the read-only worker out of recovery and admission until credentials are available.
	const unavailable = async (): Promise<never> => {
		throw new Error("Inspection configuration is unavailable")
	}
	const source: InspectionSource = {
		verify: unavailable,
		license: unavailable,
		inspect: unavailable,
		recover: unavailable,
	}
	const inspections = new Inspections(store, source, undefined, new LaunchService({}, false))

	// Activate admission only after the configuration has been validated.
	const activate = options.onConfigured
	async function activateWorker(): Promise<void> {
		for (;;) {
			try {
				const runtime = await configure()

				// Hand off the routes before starting work on the shared queue.
				activate(runtime)
				void runtime.inspections.start()
				return
			} catch {
				// Keep report reads available while retrying the same read-only configuration.
				console.error("Inspection configuration unavailable. Retrying in 30 seconds.")
				await (options.retry ?? Bun.sleep)(30000)
			}
		}
	}
	setTimeout(() => void activateWorker(), 0)
	return { inspections, port, replay, origin }
}
