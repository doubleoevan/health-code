import type { InspectionOptionsV2, InspectionReportV2 } from "./agentContracts.ts"
import { defaultDurationMs } from "./collectEvents.ts"
import type { InspectionOptions, InspectionReport, Upgrade } from "./contracts.ts"
import { inspectRepository } from "./inspectRepository.ts"
import type { ModelRequestSandboxInspectionReport, ModelRequestSandboxOptions } from "./modelRequestSandbox.ts"
import { readUpgradeFeatures, type UpgradeFeatures } from "./readUpgradeFeatures.ts"
import { type DependencyChoice, toUpgradeMenu, type UpgradeMenuOrder, type UpgradeMenuTarget } from "./upgradeMenu.ts"

type FeaturedChoice = Omit<DependencyChoice, "targets"> & {
	targets: (UpgradeMenuTarget & { releaseFeatures: UpgradeFeatures })[]
}
type FeatureOptions = NonNullable<Parameters<typeof readUpgradeFeatures>[1]>

/**
 * Reads documented features for an upgrade menu while bounding upstream release requests.
 */
export async function readUpgradeMenuFeatures(
	choices: DependencyChoice[],
	options: FeatureOptions & { deadline?: number } = {},
): Promise<FeaturedChoice[]> {
	const result: FeaturedChoice[] = []
	for (let index = 0; index < choices.length; index += 4) {
		options.signal?.throwIfAborted()
		const page = choices.slice(index, index + 4)

		// Share the remaining upgrade menu deadline across each group of releases.
		const remaining =
			options.deadline === undefined ? undefined : Math.max(0, Math.floor(options.deadline - Date.now()))
		const timeout = remaining === undefined ? undefined : AbortSignal.timeout(remaining)
		const signal = timeout && options.signal ? AbortSignal.any([timeout, options.signal]) : (timeout ?? options.signal)

		// Read the minor and major releases for each visible dependency.
		const rows = await Promise.all(
			page.map(async (group) => {
				const targets = await Promise.all(
					group.targets.map(async (target) => ({
						...target,
						releaseFeatures:
							remaining === 0
								? { features: [], sources: [], gaps: ["Release lookup time limit reached"] }
								: await readUpgradeFeatures(target, { ...options, signal }),
					})),
				)
				return { ...group, targets }
			}),
		)

		// Preserve the upgrade menu order across independent requests.
		options.signal?.throwIfAborted()
		result.push(...rows)
	}
	return result
}

/**
 * Lists eligible dependency versions and their documented features at one commit.
 */
export async function listUpgrades({
	order,
	search,
	githubToken,
	request,
	...options
}: Omit<InspectionOptions, "upgrade" | "mode" | "discoveryOnly" | "models"> &
	FeatureOptions & { order?: UpgradeMenuOrder; search?: string }): Promise<{
	repository: InspectionReport["repository"]
	dependencies: FeaturedChoice[]
	skipped: string[]
	issue?: string
}> {
	// Release the sandbox before fetching public release notes.
	const deadline = Date.now() + (options.limits?.maxDurationMs ?? defaultDurationMs)
	const report = await inspectRepository({ ...options, mode: "listUpgrades" })
	const choices = toUpgradeMenu(report.selection.eligible, { order, search })
	const dependencies = await readUpgradeMenuFeatures(choices, {
		githubToken,
		request,
		signal: options.signal,
		deadline,
	})
	return {
		repository: report.repository,
		dependencies,
		skipped: report.selection.skipped,
		issue: report.selection.registryLookupIssue ?? report.stoppedReason,
	}
}

type SelectedUpgrade<Options> = Omit<Options, "mode" | "discoveryOnly"> & { revision: string; upgrade: Upgrade }

/**
 * Tests one upgrade menu target at its inspected commit and returns its report and verified patches.
 */
export function getUpgrade(
	options: SelectedUpgrade<ModelRequestSandboxOptions>,
): Promise<ModelRequestSandboxInspectionReport>
export function getUpgrade(options: SelectedUpgrade<InspectionOptionsV2>): Promise<InspectionReportV2>
export async function getUpgrade(
	options: SelectedUpgrade<InspectionOptionsV2> | SelectedUpgrade<ModelRequestSandboxOptions>,
): Promise<ModelRequestSandboxInspectionReport> {
	if (!options.upgrade || !options.revision) {
		throw new TypeError("Select a dependency version and its inspected commit.")
	}

	if (options.limits?.maxUpgrades === 0) {
		throw new RangeError("Testing a selected upgrade requires maxUpgrades of at least one.")
	}

	// Require patch-producing roles before allocating a runtime for JavaScript callers.
	if (!options.models?.repair || !options.models.featureAdoption) {
		throw new TypeError("Supply the repair and feature adoption model routes to test an upgrade.")
	}
	return inspectRepository({ ...options, mode: "inspectUpgrades" })
}
