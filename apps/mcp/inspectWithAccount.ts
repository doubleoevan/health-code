import { createSandboxProvider, inspectRepository, type ReportCardV2, type SandboxProvider } from "health-code"
import { configureModels } from "./configureModels.ts"
import { credentials } from "./modelSettings.ts"
import type { Inspect } from "./trackInspections.ts"

export function inspectWithAccount(
	options: Parameters<Inspect>[0] & { sandboxProvider?: SandboxProvider },
	environment: NodeJS.ProcessEnv,
): Promise<ReportCardV2> {
	// resolve the developer's model roles and sandbox account for this inspection
	const models = configureModels(environment)
	return inspectRepository({
		...options,
		models,
		sandboxProvider: options.sandboxProvider ?? createSandboxProvider({ token: credentials(environment).token }),
		githubToken: environment.GITHUB_TOKEN,
	})
}
