import { createSite } from "../createSite.tsx"
import { Inspections } from "../executeInspection.ts"
import { createReplaySource } from "../replayInspection.ts"
import type { InspectionStore } from "../storeInspections.ts"

export const origin = "https://example.org"
export const replay = createReplaySource(async () => {})
// serve recorded inspections from the test's own database
export function createTestSite(store: InspectionStore): ReturnType<typeof createSite> {
	return createSite({
		inspections: new Inspections(store, replay),
		origin,
		replay: true,
		assets: { script: "/assets/client.js", styles: [] },
	})
}
