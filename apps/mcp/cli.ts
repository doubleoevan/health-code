#!/usr/bin/env node
import { readFileSync } from "node:fs"
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio"
import { createServer } from "./createServer.ts"
import { inspectWithAccount } from "./inspectWithAccount.ts"
import { accountToken, UserError } from "./modelSettings.ts"
import { recoverAccount } from "./personalModelRequestSandboxes.ts"
import { setupAccount } from "./setupAccount.ts"
import { InspectionStore } from "./storeInspection.ts"
import { Inspections } from "./trackInspections.ts"

async function main(args: string[]): Promise<void> {
	// reject unsupported subcommands before loading account settings
	if (args[0] !== "mcp" || args.length > 2 || (args.length === 2 && args[1] !== "setup")) {
		throw new UserError("Usage: health-code mcp [setup]")
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
					error instanceof UserError
						? error
						: new UserError("Model Request Sandbox recovery failed. Check your account and restart."),
				)
		: undefined

	// bind inspection jobs to the stdio session
	const inspections = new Inspections(new InspectionStore(), async (options) => {
		const provider = await recovery
		if (provider instanceof UserError) {
			throw provider
		}
		return inspectWithAccount({ ...options, sandboxProvider: provider }, process.env)
	})

	// Connect stdio independently of remote recovery.
	const server = createServer(inspections, version)
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

// expose setup guidance and keep internal errors out of stderr
main(process.argv.slice(2)).catch((error: unknown) => {
	console.error(error instanceof UserError ? error.message : "Health Code MCP could not start.")
	process.exitCode = 1
})
