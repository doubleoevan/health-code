import {
	type InspectionEvent,
	type InspectionOptions,
	type InspectionReport,
	inspectRepository,
	type ModelRequestSandboxEvent,
	type ModelRequestSandboxInspectionReport,
	type SandboxProvider,
} from "health-code"
import { configureModels } from "./configureModels.ts"
import { type PersonalProvider, personalProvider } from "./personalModelRequestSandboxes.ts"
import { accountToken, readGithubToken, requireSettings } from "./readEnvironmentSettings.ts"

// accept either supported event and report format from the inspection engine
type Choice = Pick<InspectionOptions, "revision" | "mode" | "upgrade" | "limits" | "applicationEnvironment">
export type Inspect = (
	options: Choice & {
		repositoryUrl: string
		signal: AbortSignal
		onEvent: (event: InspectionEvent | ModelRequestSandboxEvent) => void
	},
) => Promise<InspectionReport | ModelRequestSandboxInspectionReport>

export function inspectWithAccount(
	options: Parameters<Inspect>[0] & { sandboxProvider?: PersonalProvider },
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
