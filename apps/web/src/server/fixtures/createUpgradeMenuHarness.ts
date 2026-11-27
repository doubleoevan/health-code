import type { UpgradeMenu } from "health-code"
import { LaunchService } from "../admitInspections.ts"
import { createSite } from "../createSite.tsx"
import { Inspections } from "../executeInspection.ts"
import type { InspectionSource } from "../inspectionSource.ts"
import { createReplaySource } from "../replayInspection.ts"
import { InspectionStore } from "../storeInspections.ts"
import { origin, postSubmission, waitForUpgradeMenu } from "./createTestSite.ts"

export const commit = "a".repeat(40)
const target = { dependency: "widget", from: { ".": "1.2.0" }, to: "1.3.0", kind: "minor" as const }

type Harness = {
	store: InspectionStore
	inspections: Inspections
	upgradeMenuRequests: string[]
	discover: (repository: string, body?: object) => Promise<Response>
	page: (id: string) => Promise<string>
	settle: (id: string) => Promise<void>
}

/**
 * Serves a hosted site whose source answers every repository with a canned menu.
 */
export async function createUpgradeMenuHarness(
	environment: Record<string, string> = {},
	source: Partial<InspectionSource> = {},
): Promise<Harness> {
	const store = new InspectionStore(":memory:")
	const upgradeMenuRequests: string[] = []
	const replay = createReplaySource(async () => {})
	const stub: InspectionSource = {
		...replay,
		verify: async () => {},
		resolve: async (url) => ({ repositoryId: url, revision: commit, sizeKiB: 1 }),
		upgradeMenu: async (url) => {
			upgradeMenuRequests.push(url)
			return createUpgradeMenu(url)
		},
		...source,
	}
	const inspections = new Inspections(store, stub, 2, new LaunchService(environment, true))
	await inspections.start(async () => {})
	const app = createSite({ inspections, origin, replay: true, assets: { script: "/client.js", styles: [] } })
	return {
		store,
		inspections,
		upgradeMenuRequests,
		discover: (repository, body = {}) =>
			postSubmission(app, {
				repositoryUrl: `https://github.com/example/${repository}`,
				action: "discover",
				...body,
			}),
		page: async (id) => (await app.request(`/r/${id}`)).text(),
		settle: (id) => waitForUpgradeMenu(store, id),
	}
}

/**
 * Builds a one-dependency upgrade menu for a repository.
 */
export function createUpgradeMenu(repositoryUrl: string, overrides: Partial<UpgradeMenu> = {}): UpgradeMenu {
	return {
		repository: { url: repositoryUrl, commit },
		packageManager: { name: "npm", version: "11.11.0" },
		dependencies: [{ dependency: "widget", workspaces: 1, targets: [target] }],
		skipped: [],
		...overrides,
	}
}

/**
 * Counts the rows of one table in the store.
 */
export function countRows(store: InspectionStore, table: string): number {
	return store.database.query<{ total: number }, []>(`SELECT count(*) total FROM ${table}`).get()?.total ?? 0
}
