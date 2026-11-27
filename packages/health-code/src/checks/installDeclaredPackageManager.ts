import { z } from "zod"
import type { InspectionContext } from "../collectEvents.ts"
import {
	InspectionError,
	type InspectionReport,
	type Sandbox,
	type ToolName,
	type WithSandboxProvider,
} from "../contracts.ts"
import {
	isSupportedVersion,
	packageManagerDisplayNames,
	packageManagerTools,
	unsupportedVersionReason,
} from "../sandbox/packageManagerVersions.ts"
import { declaredPackageManagerSchema } from "../upgrades/toDeclaredPackageManager.ts"

// the tool a checkout runs and the package manager version its committed files declare
const checkoutPackageManagerSchema = z.object({
	tool: z.enum(Object.keys(packageManagerTools) as [ToolName, ...ToolName[]]),
	declaredPackageManager: declaredPackageManagerSchema.optional(),
})

// where the package manager version that ran came from
export type PackageManagerSource = Pick<
	Extract<InspectionReport["packageManager"], { name: string }>,
	"source" | "declared" | "fallbackReason"
>

/**
 * Installs the package manager version the repository declares, or records why the bundled one runs.
 */
export async function installDeclaredPackageManager({
	context,
	sandbox,
	readDeclaredPackageManager,
}: {
	context: InspectionContext & { options: WithSandboxProvider }
	sandbox: Sandbox
	readDeclaredPackageManager: () => Promise<unknown>
}): Promise<PackageManagerSource> {
	// run the bundled package manager version when the repository declares none
	const checkoutParseResult = checkoutPackageManagerSchema.safeParse(
		await readDeclaredPackageManager().catch(() => undefined),
	)
	if (!checkoutParseResult.success || !checkoutParseResult.data.declaredPackageManager) {
		return { source: "bundled" }
	}

	// name the declared version and the file that declares it
	const { tool, declaredPackageManager } = checkoutParseResult.data
	const { version, source, hash } = declaredPackageManager
	const file = source === ".bun-version" ? source : "package.json"
	const declared = { version, file }
	const toFallbackSource = (reason: string): PackageManagerSource => ({
		source: "bundled",
		declared,
		fallbackReason: `the declared ${version} ${reason}`,
	})

	// download nothing for a version outside the supported range
	const provider = context.options.sandboxProvider
	if (!isSupportedVersion(tool, version)) {
		return toFallbackSource(unsupportedVersionReason)
	}
	if (!provider.installPackageManager) {
		return toFallbackSource("cannot be installed by this sandbox provider")
	}

	// install it as a setup step before any repository command
	const install = provider.installPackageManager.bind(provider)
	try {
		await context.step("setup", `Install ${packageManagerDisplayNames[tool]} ${version}`, (operation) =>
			install(sandbox, { tool, version, ...(hash && { hash }) }, operation),
		)
		return { source: "declared", declared }
	} catch (error) {
		// keep the bundled version when the declared one cannot be verified or installed
		if (error instanceof InspectionError && error.code === "package-manager-install") {
			return toFallbackSource(error.message)
		}
		throw error
	}
}
