#!/usr/bin/env node
import { checkRepository, checkUsage } from "./checkRepository.ts"
import { runPullRequestStep } from "./dependencyPullRequest/runPullRequestStep.ts"
import { waitForInspection, waitUsage } from "./dependencyPullRequest/waitForInspection.ts"
import { describeTarget, targetUsage } from "./describeTarget.ts"
import { describeVersion, versionUsage } from "./describeVersion.ts"
import { setupAccount } from "./setupAccount.ts"
import { toFailureMessage } from "./toFailureMessage.ts"
import { UserError } from "./userError.ts"

async function main(args: string[]): Promise<void> {
	if (args[0] === "check") {
		await runCheck(args.slice(1))
		return
	}

	// read a pull request's upgrade with no account and no model
	if (args[0] === "target") {
		console.log(await describeTarget(args.slice(1), { environment: process.env }))
		return
	}

	// run a step of the dependency pull request workflow, or wait for its status in another job
	if (args[0] === "dependency-pull-request") {
		process.exitCode = await runPullRequestStep(args.slice(1), { environment: process.env, signal: toStopSignal() })
		return
	}
	if (args[0] === "wait") {
		await runWait(args.slice(1))
		return
	}

	// name the release before reading any setting
	if (args[0] === "--version") {
		console.log(describeVersion(args.slice(1)))
		return
	}

	// reject unsupported subcommands before loading account settings
	if (args[0] !== "setup" || args.length > 1) {
		throw new UserError(`Usage: health-code setup\n${checkUsage}\n${targetUsage}\n${waitUsage}\n${versionUsage}`)
	}
	console.log(await setupAccount(process.env))
}

// stop the inspection and delete its sandboxes when CI cancels the job
async function runCheck(args: string[]): Promise<void> {
	const { isComplete } = await checkRepository(args, { environment: process.env, signal: toStopSignal() })
	process.exitCode = isComplete ? 0 : 1
}

// abort when CI sends the process a stop signal
function toStopSignal(): AbortSignal {
	const controller = new AbortController()
	for (const signal of ["SIGTERM", "SIGINT"] as const) {
		process.once(signal, () => controller.abort())
	}
	return controller.signal
}

async function runWait(args: string[]): Promise<void> {
	if (args.length) {
		throw new UserError(waitUsage)
	}
	await waitForInspection({ environment: process.env, signal: toStopSignal() })
}

// name the next step and keep internal errors out of stderr
main(process.argv.slice(2)).catch((error: unknown) => {
	console.error(toFailureMessage(error))
	process.exitCode = 1
})
