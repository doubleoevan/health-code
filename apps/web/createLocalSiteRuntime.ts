import { createHash } from "node:crypto"
import { mkdirSync } from "node:fs"
import { hostname } from "node:os"
import { dirname, resolve } from "node:path"
import { createLiveSource, isReplayEnabled } from "./configureSite.ts"
import { Inspections } from "./executeInspection.ts"
import { createReplaySource } from "./replayInspection.ts"
import type { SiteRuntime } from "./startInspections.ts"
import { InspectionStore } from "./storeInspections.ts"

/**
 * Creates the local site runtime using local credentials or the recorded fixture.
 */
export function createLocalSiteRuntime(environment: NodeJS.ProcessEnv): SiteRuntime {
	if (environment.NODE_ENV === "production") {
		throw new Error("Use the production server to start the hosted demo.")
	}

	// Bind live inspections to localhost and allow a phone preview for fixture replay.
	const replay = isReplayEnabled(environment)
	const port = Number(environment.PORT ?? 3000)
	const localOrigin = `http://localhost:${port}`
	const origin = replay ? (environment.HEALTH_CODE_ORIGIN ?? localOrigin) : localOrigin

	// Keep recordings and live reports in separate local queues.
	const databasePath =
		environment.HEALTH_CODE_DATABASE ??
		resolve(import.meta.dir, `../../logs/site-${replay ? "replay" : "local"}-${port}.sqlite`)
	mkdirSync(dirname(databasePath), { recursive: true })

	// Scope runtime recovery to this machine and working copy across restarts.
	const deploymentSuffix = createHash("sha256")
		.update(JSON.stringify([hostname(), import.meta.dir, port]))
		.digest("hex")
		.slice(0, 11)

	// Use personal credentials only for a live inspection.
	const source = replay
		? createReplaySource()
		: createLiveSource({ ...environment, HEALTH_CODE_DEPLOYMENT: `local${deploymentSuffix}` })
	const inspections = new Inspections(new InspectionStore(databasePath), source)
	return { port, origin, replay, inspections }
}
