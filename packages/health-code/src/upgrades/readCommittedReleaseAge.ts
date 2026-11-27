import { matchesGlob } from "node:path"
import { major, minor, valid } from "semver"
import { parse as toml } from "smol-toml"
import type { PackageManager } from "../contracts.ts"
import { parseYaml } from "../parseYaml.ts"
import { readOwnProperty } from "../readOwnProperty.ts"
import { isBoundedGlob, maxGlobPatterns } from "./isBoundedGlob.ts"

export type ReleaseAge = { publishedBefore: number; excluded: string[] }

// the minimum release age an upgrade menu applied, with the file or default it came from or the reason it was assumed
export type MinimumReleaseAge = { minutes: number; excluded: string[]; source: string; isAssumed?: true }

type ReleaseAgeSetting = { minutes: number; excluded?: unknown; source: string; publishedBefore?: number }
type UnknownReleaseAge = { unknownReason: string; minutes?: number }
type ReleaseAgeReading = ReleaseAgeSetting | UnknownReleaseAge | undefined

type CommittedReleaseAgeOptions = {
	manager: PackageManager
	packageManagerVersion: string | undefined
	files: ReadonlyMap<string, string>
	now?: number
}

export const minutesPerDay = 1440
const maxDurationLength = 32
const durationUnits: Record<string, number> = {
	ms: 1 / 60000,
	s: 1 / 60,
	m: 1,
	h: 60,
	d: minutesPerDay,
	w: 7 * minutesPerDay,
}

/**
 * Checks whether a package is exempt from the repository's release age.
 */
export function isExcluded(name: string, age: ReleaseAge): boolean {
	return age.excluded.some((pattern) => matchesGlob(name, pattern))
}

/**
 * Builds a release age from a publish cutoff and the exempt package patterns.
 */
export function toReleaseAge(publishedBefore: number, excluded: unknown): ReleaseAge {
	if (!Number.isFinite(publishedBefore)) {
		throw new Error("Unsupported minimum release age")
	}
	const names = Array.isArray(excluded) ? excluded.slice(0, maxGlobPatterns) : []
	return { publishedBefore, excluded: names.filter(isBoundedGlob) }
}

/**
 * Reads Bun's minimum release age from the text of its project configuration.
 */
export function readBunReleaseAge(bunfig: string | undefined): ReleaseAge | undefined {
	const setting = readBunSetting(bunfig)
	return setting && toReleaseAge(Date.now() - setting.minutes * 60000, setting.excluded)
}

/**
 * Derives the minimum release age from committed configuration and the package manager version the sandbox would run.
 */
export function readCommittedReleaseAge({
	manager,
	packageManagerVersion,
	files,
	now = Date.now(),
}: CommittedReleaseAgeOptions): { releaseAge?: ReleaseAge; minimumReleaseAge?: MinimumReleaseAge } {
	// treat a configuration file that does not parse as an unknown setting
	let reading: ReleaseAgeReading
	try {
		reading = releaseAgeReaders[manager]({ packageManagerVersion, files })
	} catch {
		reading = { unknownReason: "a package manager configuration file could not be parsed" }
	}

	// return no age when nothing sets one
	if (!reading) {
		return {}
	}

	// assume one day, or a larger value that was read, when the setting is unknown
	const minutes = "unknownReason" in reading ? Math.max(minutesPerDay, reading.minutes ?? 0) : reading.minutes
	if (!(minutes > 0)) {
		return {}
	}

	// return the applied minutes with the publish cutoff
	const publishedBefore = ("publishedBefore" in reading && reading.publishedBefore) || now - minutes * 60000
	const releaseAge = toReleaseAge(publishedBefore, "excluded" in reading ? reading.excluded : [])
	const { excluded } = releaseAge
	if ("unknownReason" in reading) {
		return { releaseAge, minimumReleaseAge: { minutes, excluded, source: reading.unknownReason, isAssumed: true } }
	}
	return { releaseAge, minimumReleaseAge: { minutes, excluded, source: reading.source } }
}

/**
 * Says that the minimum release age could not be read and names the age that was assumed.
 */
export function toReleaseAgeNotice({ minutes }: Pick<MinimumReleaseAge, "minutes">): string {
	return `The health inspector could not read this repository’s minimum release age and assumed ${toAssumedAge(minutes)}.`
}

// name whole days as days and any other age in minutes
function toAssumedAge(minutes: number): string {
	const days = minutes / minutesPerDay
	if (days === 1) {
		return "one day"
	}
	return Number.isInteger(days) ? `${days} days` : `${Math.round(minutes)} minutes`
}

type ReleaseAgeReaderInput = Pick<CommittedReleaseAgeOptions, "packageManagerVersion" | "files">

const releaseAgeReaders: Record<PackageManager, (input: ReleaseAgeReaderInput) => ReleaseAgeReading> = {
	bun: ({ files }) => readBunSetting(files.get("bunfig.toml")),
	npm: readNpmSetting,
	pnpm: readPnpmSetting,
	yarn: readYarnSetting,
}

function readBunSetting(bunfig: string | undefined): ReleaseAgeSetting | undefined {
	if (bunfig === undefined) {
		return undefined
	}

	// bun measures the release age in seconds
	const { install } = toml(bunfig) as {
		install?: { minimumReleaseAge?: unknown; minimumReleaseAgeExcludes?: unknown }
	}

	// skip the age check when the setting is off
	const seconds = install?.minimumReleaseAge
	if (seconds === undefined || seconds === 0) {
		return undefined
	}

	// reject a value that is not a number of seconds
	const minutes = Number(seconds) / 60
	if (!Number.isFinite(minutes)) {
		throw new Error("Unsupported minimum release age")
	}
	return { minutes, excluded: install?.minimumReleaseAgeExcludes, source: "bunfig.toml" }
}

function readNpmSetting({ files }: ReleaseAgeReaderInput): ReleaseAgeReading {
	// prefer an explicit date over a number of days
	const settings = readNpmrcSettings(files.get(".npmrc"), ["before", "min-release-age"])
	const before = settings.get("before")
	if (before !== undefined) {
		const publishedBefore = Date.parse(before)
		return Number.isFinite(publishedBefore)
			? { minutes: Math.max(1, (Date.now() - publishedBefore) / 60000), publishedBefore, source: ".npmrc" }
			: { unknownReason: "before in .npmrc is not a date" }
	}

	// npm measures the release age in days
	const days = settings.get("min-release-age")
	if (days === undefined) {
		return undefined
	}

	// treat a value that is not a number as an unknown setting
	const minutes = Number(days) * minutesPerDay
	return Number.isFinite(minutes) && days !== ""
		? { minutes, source: ".npmrc" }
		: { unknownReason: "min-release-age in .npmrc is not a number" }
}

function readPnpmSetting({ packageManagerVersion: version, files }: ReleaseAgeReaderInput): ReleaseAgeReading {
	if (!version || !valid(version)) {
		return { unknownReason: "the pnpm version is not declared" }
	}

	// skip pnpm before 10.16, which has no minimum release age
	if (major(version) < 10 || (major(version) === 10 && minor(version) < 16)) {
		return undefined
	}

	// read .npmrc only before pnpm 11
	const workspaceText = files.get("pnpm-workspace.yaml")
	const workspace: unknown = workspaceText === undefined ? undefined : parseYaml(workspaceText)
	const fromWorkspace = readOwnProperty(workspace, "minimumReleaseAge")
	const npmrc = readNpmrcSettings(files.get(".npmrc"), ["minimum-release-age", "minimumReleaseAge"])
	const fromNpmrc =
		major(version) < 11 ? (npmrc.get("minimum-release-age") ?? npmrc.get("minimumReleaseAge")) : undefined

	// reject a value that is not a number of minutes
	const excluded = readOwnProperty(workspace, "minimumReleaseAgeExclude")
	const rawCandidates = [fromWorkspace, fromNpmrc].filter((candidate) => candidate !== undefined)
	const isNumeric = (candidate: unknown): boolean =>
		typeof candidate === "number" || (typeof candidate === "string" && candidate.trim() !== "")
	const minuteCandidates = rawCandidates.map((candidate) => (isNumeric(candidate) ? Number(candidate) : Number.NaN))
	if (minuteCandidates.some((candidate) => !Number.isFinite(candidate))) {
		return { unknownReason: "minimumReleaseAge is not a number of minutes" }
	}

	// assume the larger value when the two committed files disagree
	if (new Set(minuteCandidates).size > 1) {
		const minutes = Math.max(...minuteCandidates)
		return { unknownReason: "pnpm-workspace.yaml and .npmrc set different ages", minutes }
	}

	// use the one value the committed files agree on
	if (minuteCandidates[0] !== undefined) {
		const source = fromWorkspace === undefined ? ".npmrc" : "pnpm-workspace.yaml"
		return { minutes: minuteCandidates[0], excluded, source }
	}

	// apply the default of this pnpm version
	if (major(version) > 11) {
		return { unknownReason: `the default for pnpm ${version} is not known` }
	}
	return major(version) === 11 ? { minutes: minutesPerDay, excluded, source: "pnpm 11 default" } : undefined
}

function readYarnSetting({ packageManagerVersion: version, files }: ReleaseAgeReaderInput): ReleaseAgeReading {
	if (!version || !valid(version)) {
		return { unknownReason: "the Yarn version is not declared" }
	}

	// skip yarn before 4.10, which has no age gate
	const hasAgeGate = major(version) > 4 || (major(version) === 4 && minor(version) >= 10)
	if (!hasAgeGate) {
		return undefined
	}
	const configurationText = files.get(".yarnrc.yml")
	const configuration: unknown = configurationText === undefined ? undefined : parseYaml(configurationText)
	const gate = readOwnProperty(configuration, "npmMinimalAgeGate")
	const excluded = readOwnProperty(configuration, "npmPreapprovedPackages")

	// read an explicit gate as minutes or a duration with a unit
	if (gate !== undefined) {
		const minutes = toDurationMinutes(gate)
		return minutes === undefined
			? { unknownReason: "npmMinimalAgeGate in .yarnrc.yml is not a duration" }
			: { minutes, excluded, source: ".yarnrc.yml" }
	}

	// apply the one-day default from yarn 4.15
	if (major(version) > 4) {
		return { unknownReason: `the default for Yarn ${version} is not known` }
	}
	return minor(version) >= 15 ? { minutes: minutesPerDay, excluded, source: "Yarn 4.15 default" } : undefined
}

function toDurationMinutes(gate: unknown): number | undefined {
	// bound the text before matching it, so a long value costs nothing
	const text = typeof gate === "string" || typeof gate === "number" ? String(gate).trim() : ""
	const match = text.length <= maxDurationLength ? /^(\d*\.?\d+)(ms|s|m|h|d|w)?$/.exec(text) : null
	const unit = durationUnits[match?.[2] ?? "m"]
	return match?.[1] && unit !== undefined ? Number(match[1]) * unit : undefined
}

// read only the named keys. .npmrc can hold a registry credential
function readNpmrcSettings(text: string | undefined, keys: readonly string[]): Map<string, string> {
	const settings = new Map<string, string>()
	for (const line of (text ?? "").split(/\r?\n/)) {
		// split at the first equals sign, in time linear in the line
		const separator = line.indexOf("=")
		const key = separator === -1 ? "" : line.slice(0, separator).trim()
		if (!keys.includes(key)) {
			continue
		}

		// keep a quoted value whole, and end an unquoted one at an inline comment as npm does
		const value = line.slice(separator + 1).trim()
		const quote = value[0] ?? ""
		const isQuoted = value.length > 1 && "\"'".includes(quote) && value.endsWith(quote)
		settings.set(key, isQuoted ? value.slice(1, -1) : dropInlineComment(value))
	}
	return settings
}

// cut an unquoted value at the first semicolon or hash sign that a backslash does not escape
function dropInlineComment(value: string): string {
	for (let index = 0; index < value.length; index++) {
		// skip the character a backslash escapes
		const character = value[index]
		if (character === "\\") {
			index++
			continue
		}

		// end the value where a comment starts
		if (character === ";" || character === "#") {
			return value.slice(0, index).trim()
		}
	}
	return value
}
