import type { ModelRequestSandboxEvent } from "health-code"

/**
 * Describes an inspection event in one line.
 */
export function toEventLine(event: ModelRequestSandboxEvent): string {
	switch (event.type) {
		// highlight sandbox activity
		case "sandbox.event":
			return `◆ ${toSandboxEventLabel(event)}`
		case "step.started":
			return `Starting · ${event.label}`
		case "step.finished":
			return String(event.summary)

		// show detail output with its source stream
		case "detail":
			return `${event.stream} · ${event.text}`

		// label inspection lifecycle events separately from individual steps
		case "inspection.started":
			return "Inspection started"
		case "inspection.failed":
			return `Inspection failed · ${event.message}`
		case "inspection.finished":
			return "Inspection finished"
	}
}

const sandboxEventLabels = new Map<unknown, string>([
	["created", "Sandbox created"],
	["credentials-withheld", "Keys kept outside the sandbox"],
	["network-locked", "Network locked to approved destinations"],
	["connection-blocked", "Connection blocked"],
	["agent-started", "Agent started with its model key kept outside the sandbox"],
	["deleted", "Sandbox deleted"],
])

/**
 * Describes sandbox activity in words.
 */
function toSandboxEventLabel({ action, detail }: Record<string, unknown>): string {
	// keep the credential detail supplied by the provider
	if (action === "model-request-sandbox-started" || action === "model-relay-started") {
		const startupDetail = typeof detail === "string" ? detail : "Model request sandbox started"
		return startupDetail.replace(/^Model relay started/, "Model request sandbox started")
	}

	// add a blocked destination or other recorded detail
	const label = sandboxEventLabels.get(action) ?? String(action)
	return typeof detail === "string" && detail && detail !== label ? `${label} ${detail}` : label
}
