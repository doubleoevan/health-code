import { Runta } from "@runta/runta-sdk"
import { createSandboxProvider, readModelOrigin, type SandboxModelRoutes, toModelSecretName } from "health-code"
import { configureModels } from "./configureModels.ts"
import { personalProvider } from "./personalModelRequestSandboxes.ts"
import { probeModelRequestSandbox, setupTimeoutMs } from "./probeModelRequestSandbox.ts"
import { accountToken, readModelSettings, requireSettings, setupKey } from "./readEnvironmentSettings.ts"
import { UserError } from "./userError.ts"

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
	{ client = account }: { client?: Account } = {},
): Promise<string> {
	requireSettings(environment)
	const token = accountToken(environment)
	const key = setupKey(environment)
	const end = Date.now() + setupTimeoutMs
	const route = configureModels(environment).releaseSummary
	const origin = readModelOrigin(environment)

	// Keep credentials and SDK response bodies out of setup diagnostics.
	try {
		await client.check(token)
	} catch {
		throw new UserError("Runta account check failed. Check RUNTA_TOKEN and account access.")
	}

	// register the model key under the selected origin's secret name
	const name = toModelSecretName(origin)
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

	// name the settings a CI job needs
	const settings = Object.keys(readModelSettings(environment))
	return [
		"Model key verified in Runta. You can now remove MODEL_API_KEY from your environment.",
		`Set RUNTA_TOKEN as a CI secret, then set ${settings.join(", ")} and run npx health-code check.`,
	].join("\n")
}
