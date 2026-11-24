export class UserError extends Error {}

export function toEnvironmentReference(name: string): string {
	return `\${${name}}`
}

export function accountToken(environment: NodeJS.ProcessEnv): string {
	const token = environment.RUNTA_TOKEN
	if (!token?.trim() || token === toEnvironmentReference("RUNTA_TOKEN")) {
		throw new UserError("Supply RUNTA_TOKEN through your environment.")
	}
	return token
}

export function setupKey(environment: NodeJS.ProcessEnv): string | undefined {
	const key = environment.MODEL_API_KEY
	if (key !== undefined && (!key.trim() || key === toEnvironmentReference("MODEL_API_KEY"))) {
		throw new UserError("Supply MODEL_API_KEY only when registering a key.")
	}
	return key
}
