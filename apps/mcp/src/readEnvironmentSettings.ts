import { modelSettingNames } from "health-code"
import { UserError } from "./userError.ts"

// the settings without a default, sandbox token first
const requiredSettings = ["RUNTA_TOKEN", "HEALTH_CODE_MODEL_HOST", "HEALTH_CODE_MODEL"] as const

export function toEnvironmentReference(name: string): string {
	return `\${${name}}`
}

// treat a blank value and an unresolved reference as missing
function readSetting(environment: NodeJS.ProcessEnv, name: string): string | undefined {
	const value = environment[name]?.trim()
	return value && value !== toEnvironmentReference(name) ? value : undefined
}

export function accountToken(environment: NodeJS.ProcessEnv): string {
	const token = readSetting(environment, "RUNTA_TOKEN")
	if (!token) {
		throw new UserError("Supply RUNTA_TOKEN through your environment.")
	}
	return token
}

/**
 * Returns the optional GitHub token without an unresolved reference.
 */
export function readGithubToken(environment: NodeJS.ProcessEnv): string | undefined {
	return readSetting(environment, "GITHUB_TOKEN")
}

export function setupKey(environment: NodeJS.ProcessEnv): string | undefined {
	const key = readSetting(environment, "MODEL_API_KEY")
	if (environment.MODEL_API_KEY !== undefined && !key) {
		throw new UserError("Supply MODEL_API_KEY only when registering a key.")
	}
	return key
}

/**
 * Returns the configured model settings without unresolved references.
 */
export function readModelSettings(environment: NodeJS.ProcessEnv): Record<string, string> {
	return Object.fromEntries(
		modelSettingNames.flatMap((name) => {
			const value = readSetting(environment, name)
			return value ? [[name, value]] : []
		}),
	)
}

/**
 * Throws one error that names every missing setting an inspection needs.
 */
export function requireSettings(environment: NodeJS.ProcessEnv): void {
	const missing = requiredSettings.filter((name) => !readSetting(environment, name))
	if (missing.length) {
		const names = new Intl.ListFormat("en-GB").format(missing)
		throw new UserError(
			`Set ${names} in your environment, run npx health-code mcp setup once and restart your client. Get a token at https://dashboard.runta.com.`,
		)
	}
}
