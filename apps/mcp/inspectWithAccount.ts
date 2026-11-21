import { inspectRepository, type ModelRequestSandboxReportCard, type SandboxProvider } from "health-code"
import { configureModels } from "./configureModels.ts"
import { accountToken } from "./modelSettings.ts"
import { type PersonalProvider, personalProvider } from "./personalModelRequestSandboxes.ts"
import type { Inspect } from "./trackInspections.ts"

export function inspectWithAccount(
	options: Parameters<Inspect>[0] & { sandboxProvider?: PersonalProvider },
	environment: NodeJS.ProcessEnv,
): Promise<ModelRequestSandboxReportCard> {
	// resolve the developer's model roles and sandbox account for this inspection
	const token = accountToken(environment)
	const models = configureModels(environment)
	function inspect(sandboxProvider: SandboxProvider): Promise<ModelRequestSandboxReportCard> {
		return inspectRepository({
			...options,
			callerModelExecution: "modelRequestSandbox",
			models,
			sandboxProvider,
			githubToken: environment.GITHUB_TOKEN,
		})
	}
	return options.sandboxProvider ? inspect(options.sandboxProvider) : personalProvider(token).then(inspect)
}
