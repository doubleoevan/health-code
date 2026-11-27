import { gt, major, minor, valid } from "semver"
import { InspectionError } from "../contracts.ts"
import { toRepositoryUrl } from "../toRepositoryUrl.ts"
import { toHighestVersion, toUpgradeKind } from "./checkUpgradeTarget.ts"
import { isPackageName } from "./fetchRegistryVersions.ts"
import { mebibyte, ResponseTooLargeError, readBoundedJson } from "./readBoundedJson.ts"
import { type LockedDependencies, lockfiles, readLockedDependencies } from "./readLockedDependencies.ts"
import {
	defaultRepositoryFileLimits,
	isGitObjectId,
	type RepositoryFileLimits,
	readRepositoryFiles,
} from "./readRepositoryFiles.ts"
import { type GithubSession, requestGithubApi, toAbortError } from "./requestGithubApi.ts"

// the prefix of a tested patch's branch
export const patchBranchPrefix = "health-code/"

// why a pull request holds no single upgrade
export const pullRequestTargetReasons = [
	"other-changes",
	"fork",
	"own-pull-request",
	"no-npm-dependency",
	"no-direct-dependency",
	"grouped",
	"mixed-versions",
	"not-an-upgrade",
	"unreadable",
] as const
export type PullRequestTargetReason = (typeof pullRequestTargetReasons)[number]

// one direct dependency a pull request moves, from its highest locked version at the base commit
export type MovedDependency = { dependency: string; from: string; to: string }

// a single upgrade with the commits it was read at, or the reason there is none
type TargetOrReason =
	| {
			headCommit: string
			baseCommit: string

			// the lead upgrade, whether it counts as a major and the rest of its package family
			upgrade: MovedDependency & { kind: "major" | "minor" | "patch" }
			isMajor: boolean
			movedWith: MovedDependency[]
	  }
	| { reason: PullRequestTargetReason; message: string }

// the upgrade a pull request holds, or the reason it holds no single one
export type PullRequestTarget = { pullRequest: number; author: string } & TargetOrReason

export type PullRequestTargetOptions = {
	// the public repository and the number of its pull request
	repositoryUrl: string
	pullRequest: number

	// how GitHub is reached
	githubToken?: string
	request?: typeof fetch
	signal?: AbortSignal
	limits?: Partial<RepositoryFileLimits>
}

// a pull request's author, branches and commits as GitHub reports them
type PullRequestRecord = {
	author: string
	headRef: string
	headCommit: string
	headRepository: string
	baseRef: string
	baseRepository: string
}

// the changes between two commits that a pull request reader needs
type Comparison = { baseCommit: string; changes: "none" | "package-files" | "other" }

// one moved dependency and what disqualifies it as an upgrade
type DependencyMove = MovedDependency & { problem?: "mixed-versions" | "not-an-upgrade" }

const jsonAccept = "application/vnd.github+json"
const githubTimeoutMs = 30000
const maxComparedFiles = 300
const maxComparisonBytes = 16 * mebibyte
const tooLarge = Symbol("too large")
const packageFileNames = new Set(["package.json", "pnpm-workspace.yaml", ...Object.values(lockfiles).flat()])

// the fixed sentence for each reason. a count is the only value a message adds
export const pullRequestTargetMessages: Readonly<Record<PullRequestTargetReason, string>> = {
	"other-changes":
		"The pull request changes files other than package manifests, lockfiles and the package manager's generated files.",
	fork: "The pull request comes from a fork.",
	"own-pull-request": "The pull request comes from a branch Health Code pushed.",
	"no-npm-dependency": "The pull request changes no package manifest and no lockfile.",
	"no-direct-dependency": "The pull request moves no direct dependency.",
	grouped: "The pull request moves several unrelated packages.",
	"mixed-versions": "The pull request leaves a package on different versions across workspaces.",
	"not-an-upgrade": "The pull request adds, removes or lowers a dependency.",
	unreadable: "The repository's package files cannot be read through GitHub's API.",
}

/**
 * Reads the single upgrade a dependency pull request holds through GitHub's API, or the reason it holds none.
 */
export async function readPullRequestTarget(options: PullRequestTargetOptions): Promise<PullRequestTarget> {
	// validate the caller's input before any request
	const repository = toRepositoryUrl(options.repositoryUrl).slice("https://github.com/".length)
	const { pullRequest } = options
	if (!Number.isSafeInteger(pullRequest) || pullRequest < 1) {
		throw new InspectionError("invalid-pull-request", "Expected a pull request number")
	}

	// bound the reads and keep the caller's cancellation
	const timeout = AbortSignal.timeout(githubTimeoutMs)
	const session: GithubSession = {
		repository,
		githubToken: options.githubToken,
		request: options.request ?? fetch,
		signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
		requestCount: 0,
	}

	// decide from the head repository and the head branch before reading any file
	const pullRequestRecord = await readPullRequestRecord(session, pullRequest)
	const identity = { pullRequest, author: toPrintableLogin(pullRequestRecord.author) }
	const identityReason = toIdentityReason(pullRequestRecord)
	if (identityReason) {
		return { ...identity, ...toReason(identityReason) }
	}

	// skip the file reads when no package file changed
	const comparison = await readComparison(session, pullRequestRecord)
	if (!comparison) {
		return { ...identity, ...toReason("unreadable") }
	}
	if (comparison.changes !== "package-files") {
		return { ...identity, ...toReason(comparison.changes === "none" ? "no-npm-dependency" : "other-changes") }
	}

	// compare the locked dependencies at the merge base and at the head
	const commits = { baseCommit: comparison.baseCommit, headCommit: pullRequestRecord.headCommit }
	const lockedPair = await readLockedPair({ session, ...commits, limits: options.limits })
	if ("reason" in lockedPair) {
		return { ...identity, ...toReason(lockedPair.reason) }
	}
	return { ...identity, ...selectTarget(listMoves(lockedPair), commits) }
}

async function readPullRequestRecord(session: GithubSession, pullRequest: number): Promise<PullRequestRecord> {
	const path = `/repos/${session.repository}/pulls/${pullRequest}`
	const response = await requestGithubApi(session, { path, accept: jsonAccept })
	if (!response.ok) {
		await response.body?.cancel()
		throw new InspectionError(
			"repository-unavailable",
			"GitHub could not find this pull request. Check the address and that the repository is public.",
		)
	}

	// reject a repository that is not public before any file is read
	const body = (await readJson(session, response)) as Record<string, Record<string, unknown> | undefined> | null
	const baseRepository = body?.base?.repo as Record<string, unknown> | undefined
	if (baseRepository?.private !== false || baseRepository.visibility !== "public") {
		throw new InspectionError(
			"repository-unavailable",
			"This repository is private. Health Code inspects public repositories.",
		)
	}

	// keep the fields the reader decides from and require a full head commit
	const headRepository = body?.head?.repo as Record<string, unknown> | undefined
	const pullRequestRecord = {
		author: body?.user?.login,
		headRef: body?.head?.ref,
		headCommit: body?.head?.sha,
		headRepository: headRepository?.full_name ?? "",
		baseRef: body?.base?.ref,
		baseRepository: baseRepository.full_name,
	}
	const isComplete = Object.values(pullRequestRecord).every((value) => typeof value === "string")
	if (!isComplete || !isGitObjectId(pullRequestRecord.headCommit)) {
		throw toUnreadableAnswerError()
	}
	return pullRequestRecord as PullRequestRecord
}

// name the reason for a fork or a branch Health Code pushed
function toIdentityReason(pullRequestRecord: PullRequestRecord): PullRequestTargetReason | undefined {
	const { headRef, headRepository, baseRepository } = pullRequestRecord
	if (headRepository.toLowerCase() !== baseRepository.toLowerCase()) {
		return "fork"
	}
	return headRef.startsWith(patchBranchPrefix) ? "own-pull-request" : undefined
}

// read the merge base and the changed paths, or nothing when the comparison is past its bound
async function readComparison(
	session: GithubSession,
	pullRequestRecord: PullRequestRecord,
): Promise<Comparison | undefined> {
	// compare the head with its base branch. the merge base is the commit the change is measured from
	const baseRef = pullRequestRecord.baseRef.split("/").map(encodeURIComponent).join("/")
	const path = `/repos/${session.repository}/compare/${baseRef}...${pullRequestRecord.headCommit}?per_page=1`
	const response = await requestGithubApi(session, { path, accept: jsonAccept })
	if (!response.ok) {
		await response.body?.cancel()
		throw new InspectionError(
			"github-unavailable",
			"GitHub could not compare this pull request with its base. Try again.",
		)
	}

	// read the comparison inside its bound
	const body = (await readJson(session, response, maxComparisonBytes)) as
		| { merge_base_commit?: { sha?: unknown }; files?: unknown }
		| typeof tooLarge
		| null
	if (body === tooLarge) {
		return undefined
	}

	// accept only a full commit id
	const baseCommit = body?.merge_base_commit?.sha
	if (!isGitObjectId(baseCommit)) {
		throw toUnreadableAnswerError()
	}

	// treat a missing or cut-short list of changed paths as other changes
	const files = Array.isArray(body?.files) ? body.files : undefined
	if (!files || files.length >= maxComparedFiles) {
		return { baseCommit, changes: "other" }
	}

	// classify the changed paths
	const paths = files.flatMap((file) => {
		const { filename, previous_filename: previousFilename } = (file ?? {}) as Record<string, unknown>
		return previousFilename === undefined ? [filename] : [filename, previousFilename]
	})
	const packagePaths = paths.filter(
		(path) => typeof path === "string" && packageFileNames.has(path.split("/").at(-1) ?? ""),
	)
	const isOnlyPackageFiles = paths.every((path) => typeof path === "string" && isPackageManagerPath(path))
	const changes = !packagePaths.length ? "none" : isOnlyPackageFiles ? "package-files" : "other"
	return { baseCommit, changes }
}

// a manifest, a workspace file, a lockfile, or a package archive or a resolution file that Yarn generates
function isPackageManagerPath(path: string): boolean {
	const name = path.split("/").at(-1) ?? ""
	const isYarnGenerated =
		path.startsWith(".yarn/cache/") || path === ".yarn/install-state.gz" || /^\.pnp\.[a-z.]+$/.test(path)
	return packageFileNames.has(name) || isYarnGenerated
}

async function readLockedPair({
	session,
	baseCommit,
	headCommit,
	limits,
}: {
	session: GithubSession
	baseCommit: string
	headCommit: string
	limits?: Partial<RepositoryFileLimits>
}): Promise<{ base: LockedDependencies; head: LockedDependencies } | { reason: PullRequestTargetReason }> {
	const fileLimits = { ...defaultRepositoryFileLimits, ...limits }
	try {
		// read the locked dependencies at the base commit and at the head through one implementation
		const baseFiles = await readRepositoryFiles({
			session,
			commit: baseCommit,
			isRevisionSupplied: true,
			limits: fileLimits,
		})
		const headFiles = await readRepositoryFiles({
			session,
			commit: headCommit,
			isRevisionSupplied: true,
			limits: fileLimits,
		})
		return { base: readLockedDependencies(baseFiles), head: readLockedDependencies(headFiles) }
	} catch (error) {
		// keep typed failures, and turn an unreadable or unsupported project into a reason
		if (error instanceof InspectionError) {
			throw error
		}
		return { reason: "unreadable" }
	}
}

// list every direct dependency whose locked versions differ between the two commits
function listMoves({ base, head }: { base: LockedDependencies; head: LockedDependencies }): DependencyMove[] {
	const names = new Set([...Object.keys(base.sources), ...Object.keys(head.sources)])
	const moves: DependencyMove[] = []
	for (const dependency of [...names].sort()) {
		// skip an unchanged dependency and a name the registry cannot hold
		const baseVersions = base.sources[dependency] ?? {}
		const headVersions = head.sources[dependency] ?? {}
		if (!isPackageName(dependency) || isSameRecord(baseVersions, headVersions)) {
			continue
		}

		// name the version the head installs and what keeps the move from being an upgrade
		const from = toHighestVersion(Object.values(baseVersions))
		const headVersionSet = new Set(Object.values(headVersions))
		const to = toHighestVersion([...headVersionSet])
		const isUpgrade = from !== undefined && to !== undefined && valid(to) !== null && gt(to, from)

		// record the move with the first problem it has
		const problem = headVersionSet.size > 1 ? "mixed-versions" : isUpgrade ? undefined : "not-an-upgrade"
		moves.push({ dependency, from: from ?? "", to: to ?? "", ...(problem && { problem }) })
	}
	return moves
}

function isSameRecord(first: Record<string, string>, second: Record<string, string>): boolean {
	const keys = new Set([...Object.keys(first), ...Object.keys(second)])
	return [...keys].every((key) => first[key] === second[key])
}

// pick the single upgrade or the lead of one package family, or say why there is none
function selectTarget(moves: DependencyMove[], commits: { baseCommit: string; headCommit: string }): TargetOrReason {
	if (!moves.length) {
		return toReason("no-direct-dependency")
	}

	// name the first move that is no upgrade, then a set of unrelated packages
	const problem = moves.find((move) => move.problem)?.problem
	if (problem) {
		return toReason(problem)
	}
	if (moves.length > 1 && !isPackageFamily(moves)) {
		return toReason("grouped", `The pull request moves ${moves.length} unrelated packages.`)
	}

	// take the highest upgrade kind as the target, then the first name
	const upgrades = moves.map(({ dependency, from, to }) => ({ dependency, from, to, kind: toUpgradeKind([from], to) }))
	const lead = upgrades.reduce((best, upgrade) => (kindRank[upgrade.kind] > kindRank[best.kind] ? upgrade : best))
	const movedWith = upgrades
		.filter((upgrade) => upgrade !== lead)
		.map(({ dependency, from, to }) => ({ dependency, from, to }))
	return { ...commits, upgrade: lead, isMajor: upgrades.some(isMajorUpgrade), movedWith }
}

const kindRank = { patch: 0, minor: 1, major: 2 }

// several packages are one family when they share one scope or all reach the same version
function isPackageFamily(moves: DependencyMove[]): boolean {
	const scopes = new Set(moves.map((move) => (move.dependency.startsWith("@") ? move.dependency.split("/")[0] : "")))
	const hasOneScope = scopes.size === 1 && !scopes.has("")
	return hasOneScope || new Set(moves.map((move) => move.to)).size === 1
}

/**
 * Checks whether an upgrade counts as a major: a new major version, or a new minor version below 1.0.
 */
export function isMajorUpgrade({ from, to }: Pick<MovedDependency, "from" | "to">): boolean {
	return major(to) > major(from) || (major(from) === 0 && major(to) === 0 && minor(to) > minor(from))
}

function toReason(
	reason: PullRequestTargetReason,
	message = pullRequestTargetMessages[reason],
): { reason: PullRequestTargetReason; message: string } {
	return { reason, message }
}

/**
 * Checks that a value has the shape GitHub gives the login of an account or an app.
 */
export function isAccountLogin(login: unknown): login is string {
	return typeof login === "string" && /^[a-z\d-]{1,39}(?:\[bot\])?$/i.test(login)
}

function toPrintableLogin(login: string): string {
	return isAccountLogin(login) ? login : ""
}

// read a bounded answer and name what ended the read. an answer past its bound is returned as too large
async function readJson(session: GithubSession, response: Response, maxBytes = mebibyte): Promise<unknown> {
	try {
		return await readBoundedJson(response, maxBytes)
	} catch (error) {
		// name the deadline or the cancellation that ended the read
		if (session.signal.aborted) {
			throw toAbortError(session.signal)
		}

		// tell an answer past its bound from one that could not be read
		if (error instanceof ResponseTooLargeError) {
			return tooLarge
		}
		throw toUnreadableAnswerError()
	}
}

function toUnreadableAnswerError(): InspectionError {
	return new InspectionError("github-unavailable", "GitHub sent an answer that could not be read. Try again.")
}
