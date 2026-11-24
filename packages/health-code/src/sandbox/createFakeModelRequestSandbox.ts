import type { ModelReply, ModelRoute } from "../agentContracts.ts"
import { InspectionError } from "../contracts.ts"
import {
	type ModelRequestSandbox,
	type SandboxModelRequest,
	snapshotSandboxModelRequest,
} from "../models/modelRequestSandbox.ts"

export type ModelRequestSandboxFixture = {
	replies?: readonly ModelReply[]
	fail?: "open" | "send" | "close"
	usdPerMinute?: number
}

/**
 * Returns a provider fixture that records model request sandbox activity and replays model replies.
 */
export function createFakeModelRequestSandbox(fixture?: ModelRequestSandboxFixture): {
	modelRequestSandbox: ModelRequestSandbox
	modelRequestSandboxEvents: { id: string; action: string; request?: SandboxModelRequest }[]
} {
	const modelRequestSandboxEvents: { id: string; action: string; request?: SandboxModelRequest }[] = []
	const allocations = new Map<string, { index: number; route: ModelRoute }>()
	return {
		modelRequestSandboxEvents,
		modelRequestSandbox: {
			estimateMaxCost(ms): number {
				return Math.ceil(ms / 60000) * (fixture?.usdPerMinute ?? 0)
			},
			async open(id, route): Promise<void> {
				modelRequestSandboxEvents.push({ id, action: "open" })
				if (fixture?.fail === "open") {
					throw new InspectionError("credential-binding", "Fixture binding failed")
				}
				allocations.set(id, { index: 0, route: structuredClone(route) })
			},
			async send(id, input): Promise<ModelReply> {
				const request = snapshotSandboxModelRequest(input)
				const state = allocations.get(id)
				if (!state) {
					throw new InspectionError("model-request-sandbox", "Fixture model request sandbox absent")
				}

				// Record when the fixture selects a different credential route.
				if (JSON.stringify(state.route) !== JSON.stringify(request.route)) {
					modelRequestSandboxEvents.push({ id, action: "switch" })
				}
				state.route = request.route

				// Keep the snapshot independent of subsequent caller mutation.
				modelRequestSandboxEvents.push({ id, action: "send", request: structuredClone(request) })
				const reply = fixture?.replies?.[state.index++]
				if (!reply || fixture?.fail === "send") {
					throw new InspectionError("model-request-sandbox", "Fixture reply unavailable")
				}
				return structuredClone(reply)
			},
			async close(id): Promise<void> {
				modelRequestSandboxEvents.push({ id, action: "close" })
				if (fixture?.fail === "close") {
					throw new InspectionError("cleanup-failed", "Fixture deletion failed")
				}
				allocations.delete(id)
			},
		},
	}
}
