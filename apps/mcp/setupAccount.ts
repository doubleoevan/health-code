import { Runta } from "@runta/runta-sdk"
import { createSandboxProvider, type SandboxModelRoutes } from "health-code"
import { configureModels } from "./configureModels.ts"
import {
	accountToken,
	modelOrigin,
	priceVariables,
	roleVariables,
	secretName,
	setupKey,
	toEnvironmentReference,
	UserError,
} from "./modelSettings.ts"
import { personalProvider } from "./personalModelRequestSandboxes.ts"
import { probeModelRequestSandbox, setupTimeoutMs } from "./probeModelRequestSandbox.ts"

const optional = ["HEALTH_CODE_MODEL_HOST", ...Object.values(roleVariables), ...priceVariables]
type Account = {
	probe(token: string, route: SandboxModelRoutes["releaseSummary"], end: number): Promise<void>
	check(token: string): Promise<void>
	store(options: { token: string; name: string; key: string }): Promise<unknown>
}

const account: Account = {
	async probe(token, route, end): Promise<void> {
		const modelRequestSandbox = (await personalProvider(token, end)).modelRequestSandbox
		await probeModelRequestSandbox({ modelRequestSandbox, route, end })
	},
	check(token): Promise<void> {
		return createSandboxProvider({ token }).checkAvailability()
	},
	store({ token, name, key }): Promise<unknown> {
		// Pin the service that receives both account credentials.
		return new Runta({ token, endpoint: "https://api.runta.com", timeoutMs: 10000 }).secrets.set(name, key)
	},
}

export async function setupAccount(
	environment: NodeJS.ProcessEnv,
	{ version, client = account }: { version: string; client?: Account },
): Promise<string> {
	const token = accountToken(environment)
	const key = setupKey(environment)
	const end = Date.now() + setupTimeoutMs
	const route = configureModels(environment).releaseSummary
	const origin = modelOrigin(environment)
	// Keep credentials and SDK response bodies out of setup diagnostics.
	try {
		await client.check(token)
	} catch {
		throw new UserError("Runta account check failed. Check RUNTA_TOKEN and account access.")
	}
	// register the model key under the selected origin's secret name
	const name = secretName(origin)
	try {
		if (key) {
			await client.store({ token, key, name })
		}
	} catch {
		throw new UserError("Runta secret write failed. Check secret write access and retry setup.")
	}

	try {
		await client.probe(token, route, end)
	} catch (error) {
		if (error instanceof UserError) {
			throw error
		}
		throw new UserError("Model Request Sandbox verification failed. Register the origin-bound key during setup.")
	}
	// Forward environment references so the emitted configuration can be shared.
	const names = ["RUNTA_TOKEN", ...optional.filter((name) => environment[name])]
	// Resolve npm packages from the user's home when a client opens a new checkout.
	const windows = process.platform === "win32"
	const command = windows ? "cmd.exe" : "/bin/sh"
	const args = windows
		? ["/d", "/c", `cd /d "%USERPROFILE%" && npx -y health-code@${version} mcp`]
		: ["-c", 'cd "$HOME" && exec npx "$@"', "npx", "-y", `health-code@${version}`, "mcp"]
	// render shared launcher settings in each client's configuration format
	const env = Object.fromEntries(names.map((name) => [name, toEnvironmentReference(name)]))
	return [
		"Model key verified in Runta. After setup, only RUNTA_TOKEN is required.",
		"Claude Code · add inside mcpServers in .mcp.json",
		`"health-code": ${JSON.stringify({ type: "stdio", command, args, env })}`,
		"Codex · add at the top level of ~/.codex/config.toml",
		`mcp_servers.health-code = { command = ${JSON.stringify(command)}, args = ` +
			JSON.stringify(args) +
			", env_vars = " +
			JSON.stringify(names) +
			" }",
	].join("\n")
}
