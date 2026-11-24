import assert from "node:assert/strict"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { InspectionError } from "health-code"
import { key, repo } from "./fixtures/inspectionSettings.ts"
import { InspectionStore, protect } from "./storeInspection.ts"
import { Inspections } from "./trackInspections.ts"

test("an unfinished inspection directs the caller to poll and keeps a credential cause", async () => {
	const store = new InspectionStore(join(tmpdir(), "mcp-track"), protect({ RUNTA_TOKEN: key }))
	const release = Promise.withResolvers<void>()
	const inspections = new Inspections(store, async ({ onEvent }) => {
		// announce the inspection and wait for the first read
		const event = { version: 1 as const, inspectionId: crypto.randomUUID(), timestamp: new Date().toISOString() }
		onEvent({ ...event, type: "inspection.started", sequence: 1, repositoryUrl: repo })
		await release.promise

		// replace the callback error as the library does
		try {
			onEvent({ ...event, type: "inspection.started", sequence: 2, repositoryUrl: key })
		} catch {
			throw new InspectionError("event-delivery", "Inspection event callback failed")
		}
		throw new Error("Expected the credential to be rejected")
	})

	// explain the running state before the failure
	const id = await inspections.start(repo)
	await assert.rejects(inspections.loadReport(id), /still running. Poll read_inspection/)
	release.resolve()
	await assert.rejects(async () => {
		await inspections.close()
		await inspections.loadReport(id)
	}, /configured credential. Remove the credential/)
})
