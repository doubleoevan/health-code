import { InspectionError, SandboxUnavailableError } from "health-code"
import { isStorageError } from "./storeInspection.ts"
import { UserError } from "./userError.ts"

const unavailableMessages = {
	authentication:
		"Runta rejected RUNTA_TOKEN. Get a new token at https://dashboard.runta.com, set it and restart your client.",
	permission:
		"RUNTA_TOKEN lacks access. Give it access to runtimes, secrets and the model-provider list at https://dashboard.runta.com.",
	unavailable: "Runta is unavailable or at its limit. Wait a few minutes and try again.",
}

const stopped = "The inspection was stopped. Start it again when you are ready."
const retry = "Try again."
const runSetup = "Run npx health-code mcp setup for this model host and restart your client."

// the cause and next step for each error code
const messages = new Map([
	["cancelled", stopped],
	["cleanup-failed", "A sandbox may still be running. Delete it at https://dashboard.runta.com."],
	["credential-binding", `The sandbox could not use your model key. ${runSetup}`],
	["deadline", "The inspection ran out of time. Try again or pick one upgrade."],
	["event-delivery", `Progress could not be recorded. ${retry}`],
	["model-budget", "The inspection reached its model spending limit. Try one upgrade or use a cheaper model."],
	["model-request-sandbox", `The model did not answer. Check the model ID and your provider account. ${retry}`],
	["model-request-sandbox-startup", `The model request sandbox did not start. ${retry}`],
	["registry-command-timeout", `The package registry took too long to answer. ${retry}`],
	[
		"repository-unavailable",
		"The sandbox could not clone the repository at that commit. Check that it is public, then call list_upgrades again.",
	],
	["sandbox-absent", `The sandbox ended early. ${retry}`],
	["sandbox-busy", `The sandbox was busy. ${retry}`],
	["sandbox-command", `A sandbox command failed. ${retry}`],
])

// the errors whose library message names a value to change
const inputCodes = new Set([
	"invalid-environment",
	"invalid-limits",
	"invalid-model-settings",
	"invalid-repository",
	"invalid-revision",
	"invalid-upgrade",
])

/**
 * Describes a failure with its cause and next step.
 */
export function toFailureMessage(error: unknown): string {
	if (error instanceof UserError) {
		return error.message
	}

	// name a local cause outside the inspection
	if (error instanceof Error && error.name === "AbortError") {
		return stopped
	}
	if (isStorageError(error)) {
		return `Local storage failed (${error.code}). Check disk space and permissions for ~/.health-code.`
	}

	// keep unexpected text private
	if (!(error instanceof InspectionError)) {
		return "Health Code hit an unexpected error. Try again. If it repeats, restart your client."
	}

	// keep library messages that name input the caller supplied
	const message =
		error instanceof SandboxUnavailableError
			? unavailableMessages[error.reason]
			: (messages.get(error.code) ??
				(inputCodes.has(error.code) ? `${error.message.replace(/\.$/, "")}. Correct it and try again.` : undefined) ??
				"The inspection failed. Try again. If it repeats, report it at https://github.com/doubleoevan/health-code/issues with the inspection ID.")

	// name any sandbox whose deletion is unconfirmed
	const cleanup = error.cleanupIds?.length ? ` Sandbox deletion unconfirmed: ${error.cleanupIds.join(", ")}.` : ""
	return `${message}${cleanup} (${error.code})`
}
