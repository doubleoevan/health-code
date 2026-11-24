#!/usr/bin/env node
import { readFileSync } from "node:fs"
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio"
import { InspectionError } from "health-code"
import { checkRepository, checkUsage } from "./checkRepository.ts"
import { createServer } from "./createServer.ts"
import { inspectWithAccount } from "./inspectWithAccount.ts"
import { accountToken, readGithubToken, requireSettings, UserError } from "./modelSettings.ts"
import { recoverAccount } from "./personalModelRequestSandboxes.ts"
import { requirePublicRepository } from "./readRepository.ts"
import { setupAccount } from "./setupAccount.ts"
import { InspectionStore } from "./storeInspection.ts"
import { toFailureMessage } from "./toFailureMessage.ts"
import { Inspections } from "./trackInspections.ts"

async function main(args: string[]): Promise<void> {
	if (args[0] === "check") {
		await runCheck(args.slice(1))
		return
	}

	// reject unsupported subcommands before loading account settings
	if (args[0] !== "mcp" || args.length > 2 || (args.length === 2 && args[1] !== "setup")) {
		throw new UserError(`Usage: health-code mcp [setup]\n${checkUsage}`)
	}

	// Pin client configurations to the installed release that provided this executable.
	const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"))
	if (args[1] === "setup") {
		console.log(await setupAccount(process.env, { version }))
		return
	}

	// Saved reports remain readable while the provider reclaims previous allocations.
	const recovery = process.env.RUNTA_TOKEN
		? Promise.resolve()
				.then(() => recoverAccount(accountToken(process.env)))
				.catch((error: unknown) =>
					error instanceof UserError || error instanceof InspectionError
						? error
						: new UserError("Model Request Sandbox recovery failed. Check your account and restart."),
				)
		: undefined

	// bind inspection jobs to the stdio session
	const inspections = new Inspections(new InspectionStore(), async (options) => {
		requireSettings(process.env)
		await requirePublicRepository(options.repositoryUrl, {
			githubToken: readGithubToken(process.env),
			signal: options.signal,
		})

		// wait for the account before running the inspection
		const provider = await recovery
		if (provider instanceof Error) {
			throw provider
		}
		return inspectWithAccount({ ...options, sandboxProvider: provider }, process.env)
	})

	// Connect stdio independently of remote recovery.
	const server = createServer({ inspections, version })
	const transport = new StdioServerTransport()
	server.server.onclose = () => {
		void inspections.close()
	}

	// finish active jobs before closing the server on a signal
	for (const signal of ["SIGTERM", "SIGINT"] as const) {
		process.once(signal, async () => {
			await inspections.close()
			await server.close()
		})
	}
	await server.connect(transport)
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
