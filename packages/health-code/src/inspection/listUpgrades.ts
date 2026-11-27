import type { InspectionOptionsV2, InspectionReportV2 } from "../agentContracts.ts"
import { InspectionError, type InspectionOptions, type InspectionReport, type Upgrade } from "../contracts.ts"
import type { ModelRequestSandboxInspectionReport, ModelRequestSandboxOptions } from "../models/modelRequestSandbox.ts"
import { readOwnProperty } from "../readOwnProperty.ts"
import { toTargetRejection, toUpgradeKind } from "../upgrades/checkUpgradeTarget.ts"
import { mebibyte } from "../upgrades/readBoundedJson.ts"
import type { MinimumReleaseAge } from "../upgrades/readCommittedReleaseAge.ts"
import type { LockedDependencies } from "../upgrades/readLockedDependencies.ts"
import type { UnreadableRepository } from "../upgrades/readRepositoryFiles.ts"
import { readUpgradeFeatures, type UpgradeFeatures } from "../upgrades/readUpgradeFeatures.ts"
import { selectUpgrades } from "../upgrades/selectUpgrades.ts"
import {
	type DependencyChoice,
	toUpgradeMenu,
	type UpgradeMenuOrder,
	type UpgradeMenuTarget,
} from "../upgrades/toUpgradeMenu.ts"
import { inspectRepository } from "./inspectRepository.ts"
import {
	lookUpUpgradeMenuTarget,
	lookUpUpgradeMenuVersions,
	readUpgradeMenuProject,
	type UpgradeMenuLimits,
	type UpgradeMenuOptions,
	type UpgradeMenuPackageManager,
	withUpgradeMenuContext,
} from "./upgradeMenuContext.ts"

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

// the deprecated options an upgrade menu accepts and ignores
type DeprecatedUpgradeMenuOptions = {
	/**
	 * @deprecated Ignored by the upgrade menu.
	 */
	sandboxProvider?: InspectionOptions["sandboxProvider"]

	/**
	 * @deprecated Ignored by the upgrade menu.
	 */
	prompts?: InspectionOptions["prompts"]

	/**
	 * @deprecated Ignored by the upgrade menu.
	 */
	telemetry?: InspectionOptions["telemetry"]

	/**
	 * @deprecated Ignored by the upgrade menu.
	 */
	includeTestInventory?: boolean

	/**
	 * @deprecated Ignored by the upgrade menu.
	 */
	applicationEnvironment?: InspectionOptions["applicationEnvironment"]

	/**
	 * @deprecated Ignored by the upgrade menu.
	 */
	callerModelExecution?: "local"
}

// the deprecated limits an upgrade menu accepts and ignores
type DeprecatedUpgradeMenuLimits = {
	/**
	 * @deprecated Ignored by the upgrade menu.
	 */
	maxUpgrades?: number

	/**
	 * @deprecated Ignored by the upgrade menu.
	 */
	maxCostUsd?: number
}

export type ListUpgradesOptions = UpgradeMenuOptions &
	DeprecatedUpgradeMenuOptions & {
		order?: UpgradeMenuOrder
		search?: string
		limits?: UpgradeMenuLimits & DeprecatedUpgradeMenuLimits
	}

// the eligible versions at one commit, or the reason the committed files could not be read
export type UpgradeMenu = {
	repository: InspectionReport["repository"]
	packageManager: UpgradeMenuPackageManager
	dependencies: DependencyChoice[]
	skipped: string[]

	// what is missing, the age that was applied and why the files could not be read
	issue?: string
	minimumReleaseAge?: MinimumReleaseAge
	unreadable?: UnreadableRepository
}

/**
 * Lists eligible dependency versions at one commit from GitHub and the npm registry, without a sandbox.
 */
export async function listUpgrades({ order, search, ...options }: ListUpgradesOptions): Promise<UpgradeMenu> {
	return withUpgradeMenuContext(options, async (context) => {
		// return no targets for a project that cannot be read or detected
		const project = await readUpgradeMenuProject(context)
		const {
			repository,
			packageManager,
			minimumReleaseAge,
			lockedDependencies,
			unreadableRepository: unreadable,
		} = project
		if (!lockedDependencies) {
			const issue = "reason" in packageManager ? packageManager.reason : undefined
			return { repository, packageManager, dependencies: [], skipped: [], issue, ...(unreadable && { unreadable }) }
		}

		// select stable minor and major targets from the registry's answers
		const { releaseAge } = project
		const { versions, oversizedPackageNames, issue } = await lookUpUpgradeMenuVersions(context, {
			lockedDependencies,
			releaseAge,
		})
		const sources = Object.fromEntries(
			Object.entries(lockedDependencies.sources).filter(([name]) => !oversizedPackageNames.includes(name)),
		)
		const selection = selectUpgrades({ sources, skipped: lockedDependencies.skipped }, versions, 0)

		// name the limit that each oversized registry response passed
		const sizeLimit = toSizeLimit(options.limits?.maxRegistryResponseBytes ?? 0)
		const oversizedSkips = oversizedPackageNames.map(
			(name) => `${name}: registry response is over the ${sizeLimit} limit`,
		)
		return {
			repository,
			packageManager,
			dependencies: toUpgradeMenu(selection.eligible, { order, search }),
			skipped: [...selection.skipped, ...oversizedSkips],
			...(issue && { issue }),
			...(minimumReleaseAge && { minimumReleaseAge }),
		}
	})
}

function toSizeLimit(bytes: number): string {
	return `${Number((bytes / mebibyte).toFixed(1))} MiB`
}

/**
 * Shapes an upgrade menu and its Inspection Events as the Inspection Report of a sandbox listing.
 */
export function toUpgradeMenuReport(
	upgradeMenu: UpgradeMenu,
	timeline: InspectionReport["timeline"],
): InspectionReport {
	const { packageManager, repository, issue, unreadable } = upgradeMenu
	const notRun = { status: "untested" as const, reason: "not-run", evidence: [] }
	const isDetected = "name" in packageManager
	return {
		version: 1,
		inspectionId: timeline[0]?.inspectionId ?? "",
		repository,
		packageManager: isDetected ? { name: packageManager.name, version: packageManager.version ?? "" } : packageManager,
		baseline: { install: notRun, typecheck: notRun, tests: notRun },

		// report the issue of a detected project as a registry lookup issue. detection holds every other reason
		selection: {
			mode: "listUpgrades",
			eligible: upgradeMenu.dependencies.flatMap((choice) => choice.targets),
			selected: [],
			omitted: [],
			skipped: upgradeMenu.skipped,
			...(issue && isDetected && !unreadable && { registryLookupIssue: issue }),
		},
		upgrades: [],
		timeline,
	}
}

export type ResolveUpgradeOptions = UpgradeMenuOptions &
	DeprecatedUpgradeMenuOptions & { dependency: string; to: string }

// the upgrade a named version resolves to, or the reason the committed files could not be read
export type ResolvedUpgrade = Pick<
	UpgradeMenu,
	"repository" | "packageManager" | "minimumReleaseAge" | "unreadable"
> & {
	upgrade?: Upgrade
}

/**
 * Validates one named dependency version at a commit in the caller's process, without a sandbox.
 */
export async function resolveUpgrade({ dependency, to, ...options }: ResolveUpgradeOptions): Promise<ResolvedUpgrade> {
	return withUpgradeMenuContext(options, async (context) => {
		// return the reason for a repository the upgrade menu cannot read
		const project = await readUpgradeMenuProject(context)
		const { repository, packageManager, minimumReleaseAge, lockedDependencies, releaseAge } = project
		if (project.unreadableRepository) {
			return { repository, packageManager, unreadable: project.unreadableRepository }
		}

		// reject an unsupported project
		if (!lockedDependencies) {
			const reason = "reason" in packageManager ? packageManager.reason : "Unsupported project"
			throw new InspectionError("unsupported-project", `${reason}.`)
		}

		// check the version against the locked versions and the registry's record
		const lockedVersions = readVersionLookup({ lockedDependencies, dependency, commit: repository.commit })
		const check = await lookUpUpgradeMenuTarget(context, { dependency, to, lockedVersions, releaseAge })
		if (check.status !== "eligible") {
			const error = new InspectionError("invalid-upgrade", toTargetRejection({ dependency, to, check }))
			error.eligibleDependencyVersions = check.eligibleDependencyVersions
			throw error
		}

		// return the upgrade with the source versions the sandbox will check again
		const from = { ...lockedDependencies.sources[dependency] }
		const upgrade: Upgrade = { dependency, from, to, kind: toUpgradeKind(lockedVersions, to) }
		return { repository, packageManager, upgrade, ...(minimumReleaseAge && { minimumReleaseAge }) }
	})
}

// read a dependency's locked versions, or explain why it has none
function readVersionLookup({
	lockedDependencies,
	dependency,
	commit,
}: {
	lockedDependencies: LockedDependencies
	dependency: string
	commit: string
}): string[] {
	// return the locked versions of a dependency the locked dependencies hold
	const sources = readOwnProperty(lockedDependencies.sources, dependency)
	if (sources) {
		return Object.values(sources)
	}

	// match the dependency in the skipped entries, which name the workspace, the dependency and the reason
	const isSkipped = lockedDependencies.skipped.some((entry) => entry.split(" ")[1] === `${dependency}:`)
	throw new InspectionError(
		"invalid-upgrade",
		isSkipped
			? `${dependency} resolves from a source the npm registry does not serve in at least one workspace.`
			: `${dependency} is not a direct dependency of this repository at ${commit}.`,
	)
}

// a named version. the checkout's locked versions apply when the source versions are omitted
type UpgradeTarget = Pick<Upgrade, "dependency" | "to"> & Partial<Pick<Upgrade, "from" | "kind">>
type SelectedUpgrade<Options> = Omit<Options, "mode" | "discoveryOnly" | "upgrade"> & {
	revision: string
	upgrade: UpgradeTarget
}

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
