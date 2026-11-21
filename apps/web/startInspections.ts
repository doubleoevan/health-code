import { mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { createLiveSource, isReplayEnabled } from "./configureSite.ts"
import { Inspections } from "./executeInspection.ts"
import { InspectionStore } from "./storeInspections.ts"

export async function startInspections(): Promise<{
	replay: boolean
	port: number
	origin: string
	inspections: Inspections
}> {
	// resolve the public origin and development replay setting
	const replay = isReplayEnabled(process.env)
	const port = Number(process.env.PORT ?? 3000)
	const origin = new URL(process.env.HEALTH_CODE_ORIGIN ?? `http://localhost:${port}`).origin
	// choose a separate default database for recorded inspections
	const storage =
		process.env.HEALTH_CODE_DATABASE ??
		(replay ? resolve(import.meta.dir, "../../logs/site-replay.sqlite") : "/data/inspections.sqlite")
	// open the selected source and storage before starting the workers
	const source = replay ? (await import("./replayInspection.ts")).createReplaySource() : createLiveSource(process.env)
	mkdirSync(dirname(storage), { recursive: true })
	const inspections = new Inspections(
		new InspectionStore(storage),
		source,
		Number(process.env.HEALTH_CODE_CONCURRENCY ?? 2),
	)
	void inspections.start()
	return { replay, port, origin, inspections }
}
