#!/usr/bin/env node
import { readFileSync } from "node:fs"
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio"
import { createServer } from "./createServer.ts"
import { inspectWithAccount } from "./inspectWithAccount.ts"
import { UserError } from "./modelSettings.ts"
import { setupAccount } from "./setupAccount.ts"
import { InspectionStore } from "./storeInspection.ts"
import { Inspections } from "./trackInspections.ts"

async function main(args: string[]): Promise<void> {
	if (args[0] !== "mcp" || args.length > 2 || (args.length === 2 && args[1] !== "setup")) {
		throw new UserError("Usage: health-code mcp [setup]")
	}
	// Pin client configurations to the installed release that provided this executable.
	const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"))
	if (args[1] === "setup") {
		console.log(await setupAccount(process.env, { version }))
		return
	}

	const inspections = new Inspections(new InspectionStore(), (options) => inspectWithAccount(options, process.env))
	const server = createServer(inspections, version)
	const transport = new StdioServerTransport()
	server.server.onclose = () => {
		void inspections.close()
	}
	for (const signal of ["SIGTERM", "SIGINT"] as const) {
		process.once(signal, async () => {
			await inspections.close()
			await server.close()
		})
	}
	await server.connect(transport)
}
main(process.argv.slice(2)).catch((error: unknown) => {
	console.error(error instanceof UserError ? error.message : "Health Code MCP could not start.")
	process.exitCode = 1
})
