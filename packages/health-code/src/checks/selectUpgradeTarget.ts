import { isDeepStrictEqual } from "node:util"
import {
	InspectionError,
	type InspectionOptions,
	type InspectionReport,
	type Project,
	type Upgrade,
} from "../contracts.ts"
import { readOwnProperty } from "../readOwnProperty.ts"
import {
	isNewerStable,
	type TargetCheck,
	targetCheckSchema,
	toHighestVersion,
	toTargetRejection,
	toUpgradeKind,
} from "../upgrades/checkUpgradeTarget.ts"
import { ProjectEvidenceError } from "../upgrades/parseRegistryVersions.ts"

type SelectedTarget = NonNullable<InspectionOptions["upgrade"]>

// the selection for one named version, with the reason when the package manager would reject it as too new
export type TargetSelection = { selection: InspectionReport["selection"]; tooNewReason?: string }

/**
 * Validates one named version against the checkout's locked versions and the registry.
 */
export async function selectUpgradeTarget({
	project,
	target,
	readTargetCheck,
}: {
	project: Project
	target: SelectedTarget
	readTargetCheck: (lockedVersions: string[]) => Promise<unknown>
}): Promise<TargetSelection> {
	// require the inspected source version in every declaring workspace
	const sources = readOwnProperty(project.sources, target.dependency) ?? {}
	const lockedVersions = Object.values(sources)
	if (!lockedVersions.length || !matchesSource(target.from, sources)) {
		throw new ProjectEvidenceError(
			`The checkout locks ${target.dependency} at a different version than the selected target. Refresh the upgrade menu and select again.`,
		)
	}

	// reject a version that is not a newer stable release before asking the registry
	const highestLockedVersion = toHighestVersion(lockedVersions)
	if (!highestLockedVersion || !isNewerStable(target.to, highestLockedVersion)) {
		throw new InspectionError("invalid-upgrade", "The selected target must be a newer stable version")
	}

	// check the version against the registry and the minimum release age in the sandbox
	const upgrade: Upgrade = {
		dependency: target.dependency,
		from: sources,
		to: target.to,
		kind: toUpgradeKind(lockedVersions, target.to),
	}
	const check = toTargetCheck(await readTargetCheck(lockedVersions))
	const selection = { eligible: [upgrade], selected: [upgrade], omitted: [], skipped: [...project.skipped] }
	if (check.status === "eligible" || check.status === "unavailable") {
		return { selection }
	}

	// keep a version that is only too new selected, with the reason it cannot install yet
	const rejection = toTargetRejection({ dependency: target.dependency, to: target.to, check })
	if (check.status === "too-new") {
		return { selection, tooNewReason: rejection }
	}

	// name the eligible dependency versions
	const error = new InspectionError("invalid-upgrade", rejection)
	error.eligibleDependencyVersions = check.eligibleDependencyVersions
	throw error
}

// accept the checkout's locked versions when the target names no source versions
function matchesSource(from: SelectedTarget["from"], sources: Record<string, string>): boolean {
	if (from === undefined) {
		return true
	}
	return typeof from === "string"
		? Object.values(sources).every((locked) => locked === from)
		: isDeepStrictEqual({ ...sources }, { ...from })
}

// treat a target check that does not parse as unavailable
function toTargetCheck(metadata: unknown): TargetCheck {
	const parsed = targetCheckSchema.safeParse(metadata)
	return parsed.success ? parsed.data : { status: "unavailable", eligibleDependencyVersions: [] }
}
