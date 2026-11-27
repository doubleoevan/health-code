import { createSite } from "../createSite.tsx"
import { Inspections } from "../executeInspection.ts"
import { createReplaySource } from "../replayInspection.ts"
import type { InspectionStore } from "../storeInspections.ts"

export const origin = "https://example.org"
export const replay = createReplaySource(async () => {})

type TestSite = ReturnType<typeof createSite>

// serve recorded inspections from the test's own database
export function createTestSite(store: InspectionStore): TestSite {
	return createSite({
		inspections: new Inspections(store, replay),
		origin,
		replay: true,
		assets: { script: "/assets/client.js", styles: [] },
	})
}

/**
 * Posts a submission body to the site.
 */
export function postSubmission(app: TestSite, body: Record<string, unknown>): Promise<Response> {
	return Promise.resolve(
		app.request("/api/inspections", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
	)
}

/**
 * Waits for an upgrade menu the server is building in the background.
 */
export async function waitForUpgradeMenu(store: InspectionStore, id: string): Promise<void> {
	for (let attempt = 0; attempt < 2000 && store.row(id)?.state === "running"; attempt++) {
		await Bun.sleep(1)
	}

	// fail here when the build never ends, where the cause is visible
	if (store.row(id)?.state === "running") {
		throw new Error(`Upgrade menu ${id} is still running`)
	}
}
