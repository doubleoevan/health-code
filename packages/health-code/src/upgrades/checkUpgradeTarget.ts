import { gt, major, minor, prerelease, rcompare, valid } from "semver"
import { z } from "zod"
import type { Upgrade } from "../contracts.ts"
import { readOwnProperty } from "../readOwnProperty.ts"
import {
	fetchRegistryRecord,
	isDeprecated,
	isPackageName,
	type RegistryFailure,
	type RegistryOptions,
	type RegistryRecord,
	readPublishTime,
	toInstallableDependencyVersions,
} from "./fetchRegistryVersions.ts"
import { minutesPerDay, type ReleaseAge } from "./readCommittedReleaseAge.ts"
import { toUtcTime } from "./toUtcTime.ts"

const maxEligibleDependencyVersions = 50

// one version's status as a target, with the eligible dependency versions that could take its place
export const targetCheckSchema = z.object({
	status: z.enum(["eligible", "unpublished", "deprecated", "prerelease", "not-newer", "too-new", "unavailable"]),
	eligibleDependencyVersions: z.array(z.string()).max(maxEligibleDependencyVersions).default([]),
	publishedAt: z.string().optional(),
	eligibleAt: z.string().optional(),
	minimumAgeMinutes: z.number().optional(),
})
export type TargetCheck = z.infer<typeof targetCheckSchema>

type TargetCheckOptions = {
	record: RegistryRecord
	lockedVersions: readonly string[]
	to: string
	releaseAge?: ReleaseAge
	now?: number
}

// one named version of a dependency and the options of its registry lookup
type RegistryTargetOptions = Pick<TargetCheckOptions, "lockedVersions" | "to"> & {
	dependency: string
	registry: RegistryOptions
}

// why a target's registry record could not be read
export type TargetLookupFailure = RegistryFailure | "invalid-name"

/**
 * Checks one version against the rule for a target: published, stable, not deprecated, newer and old enough.
 */
export function checkUpgradeTarget({
	record,
	lockedVersions,
	to,
	releaseAge,
	now = Date.now(),
}: TargetCheckOptions): TargetCheck {
	// list every version the rule accepts, newest first
	const highestLockedVersion = toHighestVersion(lockedVersions)
	const allEligibleDependencyVersions = toInstallableDependencyVersions(record, releaseAge)
		.filter((version) => isNewerStable(version, highestLockedVersion))
		.sort(rcompare)
	const eligibleDependencyVersions = allEligibleDependencyVersions.slice(0, maxEligibleDependencyVersions)
	if (allEligibleDependencyVersions.includes(to)) {
		return { status: "eligible", eligibleDependencyVersions }
	}

	// name the first condition the version fails
	const release = readOwnProperty(record.versions, to)
	if (!valid(to) || release === undefined) {
		return { status: "unpublished", eligibleDependencyVersions }
	}
	if (isDeprecated(release)) {
		return { status: "deprecated", eligibleDependencyVersions }
	}

	// name a prerelease, a version that is not newer and a release that is too new
	if (prerelease(to)) {
		return { status: "prerelease", eligibleDependencyVersions }
	}
	if (highestLockedVersion && !gt(to, highestLockedVersion)) {
		return { status: "not-newer", eligibleDependencyVersions }
	}
	return { status: "too-new", eligibleDependencyVersions, ...toReleaseAgeDetail({ record, to, releaseAge, now }) }
}

/**
 * Looks up one package and checks a version against the rule for a target, or returns why the lookup failed.
 */
export async function checkRegistryTarget({
	dependency,
	to,
	lockedVersions,
	registry,
}: RegistryTargetOptions): Promise<TargetCheck | TargetLookupFailure> {
	// skip the request for a name the registry cannot hold
	if (!isPackageName(dependency)) {
		return "invalid-name"
	}

	// check the record, or return why the registry sent none
	const lookup = await fetchRegistryRecord(dependency, registry)
	if (typeof lookup === "string") {
		return lookup
	}
	return checkUpgradeTarget({ record: lookup.record, releaseAge: lookup.releaseAge, lockedVersions, to })
}

/**
 * Names an upgrade's kind from the highest locked version and the target.
 */
export function toUpgradeKind(lockedVersions: readonly string[], to: string): Upgrade["kind"] {
	const highestLockedVersion = toHighestVersion(lockedVersions) ?? to
	if (major(to) > major(highestLockedVersion)) {
		return "major"
	}
	return minor(to) > minor(highestLockedVersion) ? "minor" : "patch"
}

/**
 * Explains why a version was rejected.
 */
export function toTargetRejection({
	dependency,
	to,
	check,
}: {
	dependency: string
	to: string
	check: TargetCheck
}): string {
	const target = `${dependency} ${to}`
	switch (check.status) {
		// explain a version the registry does not offer
		case "unpublished":
			return `${target} is not published on the npm registry.`
		case "deprecated":
			return `${target} is deprecated.`

		// explain a prerelease and a version that is not newer
		case "prerelease":
			return `${target} is a prerelease and only stable releases can be tested.`
		case "not-newer":
			return `${target} is not newer than the highest version this repository locks.`

		// explain a release that is too new
		case "too-new":
			return toReleaseAgeRejection(target, check)
		default:
			return `${target} could not be checked against the npm registry.`
	}
}

/**
 * Picks the highest valid version from a list.
 */
export function toHighestVersion(versions: readonly string[]): string | undefined {
	return versions.filter((version) => valid(version)).sort(rcompare)[0]
}

/**
 * Checks that a version is a stable release above the highest locked version, when one is known.
 */
export function isNewerStable(version: string, highestLockedVersion: string | undefined): boolean {
	const isStable = valid(version) !== null && !prerelease(version)
	return isStable && (!highestLockedVersion || gt(version, highestLockedVersion))
}

function toReleaseAgeRejection(target: string, check: TargetCheck): string {
	const ageClause = check.minimumAgeMinutes === undefined ? "" : ` of ${toDurationText(check.minimumAgeMinutes)}`
	const publishedSentence = check.publishedAt ? ` It was published at ${toDateAndTime(check.publishedAt)}.` : ""
	const eligibleSentence = check.eligibleAt ? ` It becomes eligible at ${toDateAndTime(check.eligibleAt)}.` : ""
	return `${target} is newer than this repository's minimum release age${ageClause} allows.${publishedSentence}${eligibleSentence}`
}

function toReleaseAgeDetail({
	record,
	to,
	releaseAge,
	now,
}: Required<Pick<TargetCheckOptions, "record" | "to" | "now">> &
	Pick<TargetCheckOptions, "releaseAge">): Partial<TargetCheck> {
	// add no detail when no release age applies
	if (!releaseAge) {
		return {}
	}

	// add the age alone for a release the registry does not date
	const minimumAgeMinutes = Math.round((now - releaseAge.publishedBefore) / 60000)
	const publishedAtMs = readPublishTime(record, to)
	if (!Number.isFinite(publishedAtMs)) {
		return { minimumAgeMinutes }
	}

	// add the publish time and the time the age is met
	return {
		minimumAgeMinutes,
		publishedAt: new Date(publishedAtMs).toISOString(),
		eligibleAt: new Date(publishedAtMs + minimumAgeMinutes * 60000).toISOString(),
	}
}

function toDateAndTime(isoTimestamp: string): string {
	return `${isoTimestamp.slice(0, 10)} ${toUtcTime(isoTimestamp)}`
}

// the units an age is formatted in, largest first
const durationUnits = [
	{ name: "day", minutes: minutesPerDay },
	{ name: "hour", minutes: 60 },
]

// format an age in the largest whole unit that fits
function toDurationText(minutes: number): string {
	const unit = durationUnits.find((candidate) => minutes >= candidate.minutes) ?? { name: "minute", minutes: 1 }
	const rounded = Math.round(minutes / unit.minutes)
	return `${rounded} ${unit.name}${rounded === 1 ? "" : "s"}`
}
