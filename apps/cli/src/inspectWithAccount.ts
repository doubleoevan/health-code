import {
	type InspectionOptions,
	inspectRepository,
	type ModelRequestSandboxEvent,
	type ModelRequestSandboxInspectionReport,
	type SandboxProvider,
} from "health-code"
import { configureModels } from "./configureModels.ts"
import { type PersonalProvider, personalProvider } from "./personalModelRequestSandboxes.ts"
import { accountToken, readGithubToken, requireSettings } from "./readEnvironmentSettings.ts"

// the choices a caller makes for one inspection
export type InspectOptions = Pick<InspectionOptions, "revision" | "mode" | "upgrade" | "applicationEnvironment"> & {
	limits?: InspectionOptions["limits"] & { maxFeatureMatches?: number }
	repositoryUrl: string
	signal: AbortSignal
	onEvent: (event: ModelRequestSandboxEvent) => void
}

/**
 * Runs an inspection on the account's sandboxes with the models its settings name.
 */
export function inspectWithAccount(
	options: InspectOptions & { sandboxProvider?: PersonalProvider },
	environment: NodeJS.ProcessEnv,
): Promise<ModelRequestSandboxInspectionReport> {
	// resolve the developer's model roles and sandbox account for this inspection
	requireSettings(environment)
	const token = accountToken(environment)
	const models = configureModels(environment)
	function inspect(sandboxProvider: SandboxProvider): Promise<ModelRequestSandboxInspectionReport> {
		return inspectRepository({
			...options,
			callerModelExecution: "modelRequestSandbox",
			models,
			sandboxProvider,
			githubToken: readGithubToken(environment),
		})
	}
	return options.sandboxProvider ? inspect(options.sandboxProvider) : personalProvider(token).then(inspect)
}
