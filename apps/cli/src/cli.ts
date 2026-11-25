#!/usr/bin/env node
import { checkRepository, checkUsage } from "./checkRepository.ts"
import { setupAccount } from "./setupAccount.ts"
import { toFailureMessage } from "./toFailureMessage.ts"
import { UserError } from "./userError.ts"

async function main(args: string[]): Promise<void> {
	if (args[0] === "check") {
		await runCheck(args.slice(1))
		return
	}

	// reject unsupported subcommands before loading account settings
	if (args[0] !== "setup" || args.length > 1) {
		throw new UserError(`Usage: health-code setup\n${checkUsage}`)
	}
	console.log(await setupAccount(process.env))
}

// stop the inspection and delete its sandboxes when CI cancels the job
async function runCheck(args: string[]): Promise<void> {
	const controller = new AbortController()
	for (const signal of ["SIGTERM", "SIGINT"] as const) {
		process.once(signal, () => controller.abort())
	}
	const { isComplete } = await checkRepository(args, { environment: process.env, signal: controller.signal })
	process.exitCode = isComplete ? 0 : 1
}

// name the next step and keep internal errors out of stderr
main(process.argv.slice(2)).catch((error: unknown) => {
	console.error(toFailureMessage(error))
	process.exitCode = 1
})
