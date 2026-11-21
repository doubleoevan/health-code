import { Runta } from "@runta/runta-sdk"
import { createSandboxProvider } from "health-code"
import {
	credentials,
	modelOrigin,
	priceVariables,
	roleVariables,
	secretName,
	toEnvironmentReference,
	UserError,
} from "./modelSettings.ts"

const required = ["RUNTA_TOKEN", "ANTHROPIC_API_KEY"] as const
const optional = ["HEALTH_CODE_MODEL_HOST", ...Object.values(roleVariables), ...priceVariables, "GITHUB_TOKEN"]
type Account = {
	check(token: string): Promise<void>
	store(options: { token: string; name: string; key: string }): Promise<unknown>
}

const account: Account = {
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
	const { token, key } = credentials(environment)
	const origin = modelOrigin(environment)
	// Keep credentials and SDK response bodies out of setup diagnostics.
	try {
		await client.check(token)
	} catch {
		throw new UserError("Runta account check failed. Check RUNTA_TOKEN and account access.")
	}
	const name = secretName(origin)
	try {
		await client.store({ token, key, name })
	} catch {
		throw new UserError("Runta secret write failed. Check secret write access and retry setup.")
	}

	// Forward environment references so the emitted configuration can be shared.
	const names = [...required, ...optional.filter((name) => environment[name])]
	// Resolve npm packages from the user's home when a client opens a new checkout.
	const windows = process.platform === "win32"
	const command = windows ? "cmd.exe" : "/bin/sh"
	const args = windows
		? ["/d", "/c", `cd /d "%USERPROFILE%" && npx -y health-code@${version} mcp`]
		: ["-c", 'cd "$HOME" && exec npx "$@"', "npx", "-y", `health-code@${version}`, "mcp"]
	const env = Object.fromEntries(names.map((name) => [name, toEnvironmentReference(name)]))
	return [
		"Runta account checked and model secret stored.",
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
