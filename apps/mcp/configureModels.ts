import { readModelRoutes, type SandboxModelRoutes } from "health-code"
import { UserError } from "./modelSettings.ts"

/**
 * Resolves the caller's model routes with a stored credential bound to their origin.
 */
export function configureModels(environment: NodeJS.ProcessEnv): SandboxModelRoutes {
	try {
		return readModelRoutes(environment)
	} catch (error) {
		throw error instanceof Error ? new UserError(error.message) : error
	}
}
