import { explainedErrorCodes, InspectionError, SandboxUnavailableError } from "health-code"
import { UserError } from "./userError.ts"

const unavailableMessages = {
	authentication: "Runta rejected RUNTA_TOKEN. Get a new token at https://dashboard.runta.com, and set it again.",
	permission:
		"RUNTA_TOKEN lacks access. Give it access to runtimes, secrets and the model-provider list at https://dashboard.runta.com.",
	unavailable: "Runta is unavailable or at its limit. Wait a few minutes and try again.",
}

const stopped = "The inspection was stopped. Start it again when you are ready."
const retry = "Try again."
const runSetup = "Run npx health-code setup for this model host."

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
		"github-token-rejected",
		"GitHub rejected the token in GITHUB_TOKEN or GH_TOKEN. Check that the token is valid, or unset it to read without a token.",
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
])

const maxListedVersions = 10

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

	// keep unexpected text private
	if (!(error instanceof InspectionError)) {
		return "Health Code hit an unexpected error. Try again."
	}

	// keep library messages that name input the caller supplied or the next step
	const message =
		error instanceof SandboxUnavailableError
			? unavailableMessages[error.reason]
			: (messages.get(error.code) ?? toLibraryMessage(error) ?? fallbackMessage)

	// name any sandbox whose deletion is unconfirmed
	const cleanup = error.cleanupIds?.length ? ` Sandbox deletion unconfirmed: ${error.cleanupIds.join(", ")}.` : ""
	return `${message}${cleanup} (${error.code})`
}

const fallbackMessage =
	"The inspection failed. Try again. If it repeats, report it at https://github.com/doubleoevan/health-code/issues with the inspection ID."

// reword a library message for someone reading a CI log
function toLibraryMessage(error: InspectionError): string | undefined {
	if (error.code === "github-rate-limit") {
		return error.message.replace("Supply a GitHub token or", "Set GITHUB_TOKEN or GH_TOKEN, or")
	}
	if (error.code === "invalid-upgrade") {
		return `${error.message} ${toEligibleDependencyVersionsSentence(error.eligibleDependencyVersions ?? [])}`
	}

	// end a message that names caller input with the next step
	if (inputCodes.has(error.code)) {
		return `${error.message.replace(/\.$/, "")}. Correct it and try again.`
	}
	return explainedErrorCodes.has(error.code) ? error.message : undefined
}

// name the newest eligible dependency versions and count the rest
function toEligibleDependencyVersionsSentence(eligibleDependencyVersions: string[]): string {
	if (!eligibleDependencyVersions.length) {
		return "No version is eligible at this commit."
	}

	// keep the newest versions up to the listing limit
	const listedVersions = eligibleDependencyVersions.slice(0, maxListedVersions)
	const olderCount = eligibleDependencyVersions.length - listedVersions.length
	const versionNames = olderCount ? [...listedVersions, `${olderCount} older`] : listedVersions
	const versionList = new Intl.ListFormat("en-GB").format(versionNames)
	return `Eligible versions: ${versionList}.`
}
