import { InspectionError, type PackageManager } from "../contracts.ts"
import { forEachConcurrently } from "./forEachConcurrently.ts"
import { mebibyte, ResponseTooLargeError, readBoundedJson, readBoundedText } from "./readBoundedJson.ts"
import {
	detectionReasons,
	isIgnoredProjectName,
	type LockedDependenciesOptions,
	listLockfileNames,
	maxProjectFiles,
	ProjectDetectionError,
	parseManifest,
	selectPackageManager,
	selectWorkspaceDirectories,
	toLockfileName,
} from "./readLockedDependencies.ts"
import { type GithubSession, requestGithubApi, toAbortError, toRateLimitError } from "./requestGithubApi.ts"

// why a project needs a checkout to be read
export type UnreadableRepository = {
	reason: "binary-lockfile" | "tree-truncated" | "symbolic-link" | "limit"
	message: string
}

export class UnreadableRepositoryError extends Error {
	constructor(readonly unreadableRepository: UnreadableRepository) {
		super(unreadableRepository.message)
	}
}

export type RepositoryFileLimits = { maxWorkspaces: number; maxLockfileBytes: number; maxTotalBytes: number }

export const defaultRepositoryFileLimits: RepositoryFileLimits = {
	maxWorkspaces: 200,
	maxLockfileBytes: 16 * mebibyte,
	maxTotalBytes: 32 * mebibyte,
}

// the committed files read at one commit and the package manager they select
export type RepositoryFiles = LockedDependenciesOptions & { manager: PackageManager }

// the fixed bounds on the tree, a manifest and a configuration file
const maxTreeBytes = 8 * mebibyte
const maxManifestBytes = mebibyte
const maxConfigurationBytes = 256 * 1024
const fileConcurrency = 6

const workspaceFile = "pnpm-workspace.yaml"
const configurationFiles: Record<PackageManager, string[]> = {
	npm: [".npmrc"],
	pnpm: [".npmrc"],
	yarn: [".yarnrc.yml"],
	bun: ["bunfig.toml", ".bun-version"],
}
const sandboxListingAdvice = "List upgrades in a sandbox instead."
const jsonAccept = "application/vnd.github+json"

type TreeEntry = { blobId: string; size: number; isSymbolicLink: boolean }
type RepositoryTree = { entries: Map<string, TreeEntry>; regularFilePaths: string[] }
type PlannedFile = { path: string; entry: TreeEntry; maxBytes: number }
type TreeRequest = { session: GithubSession; commit: string; isRevisionSupplied: boolean }

/**
 * Checks whether a value is the full ID of a git object, such as a commit or a blob.
 */
export function isGitObjectId(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{40}$/.test(value)
}

/**
 * Resolves the commit to read, and confirms that a token is reading a public repository.
 */
export async function resolveRepositoryCommit(session: GithubSession, revision?: string): Promise<string> {
	// confirm the repository is public before a token reads it
	if (session.githubToken) {
		await requirePublicRepository(session)
	}
	if (revision) {
		return revision
	}

	// ask for the default branch head as a bare commit id
	const path = `/repos/${session.repository}/commits/HEAD`
	const response = await requestGithubApi(session, { path, accept: "application/vnd.github.sha" })
	if (!response.ok) {
		await response.body?.cancel()
		throw toMissingRepositoryError()
	}

	// accept only a full commit id
	const commit = (await readBody({ session, body: readBoundedText(response, 64) })).trim()
	if (!isGitObjectId(commit)) {
		throw new InspectionError("github-unavailable", "GitHub returned an invalid commit. Try again.")
	}
	return commit
}

/**
 * Reads the manifests, the lockfile and the package manager configuration at one commit through GitHub's API.
 */
export async function readRepositoryFiles({
	session,
	commit,
	isRevisionSupplied,
	limits,
}: TreeRequest & { limits: RepositoryFileLimits }): Promise<RepositoryFiles> {
	// list the commit's files and read the two that declare workspaces
	const tree = await readTree({ session, commit, isRevisionSupplied })
	const files = new Map<string, string>()
	for (const path of ["package.json", workspaceFile]) {
		const entry = readRootEntry(tree, path)
		if (entry) {
			files.set(path, await readBlob(session, { path, entry, maxBytes: maxManifestBytes }))
		}
	}

	// select the workspaces, the package manager and its lockfile
	const rootManifest = files.get("package.json")
	if (rootManifest === undefined) {
		throw new ProjectDetectionError(detectionReasons.manifest)
	}
	const lockfileNames = listLockfileNames((name) => readRootEntry(tree, name) !== undefined)
	const manager = selectPackageManager(parseManifest(rootManifest), lockfileNames)
	const workspaceDirectories = selectWorkspaceDirectories({
		rootManifest,
		pnpmWorkspace: files.get(workspaceFile),
		filePaths: tree.regularFilePaths,
		manager,
	})

	// read the remaining files inside the byte and request budgets
	const plannedFiles = planFiles({ tree, manager, lockfileNames, workspaceDirectories, limits })
	requireBudget({ session, plannedFiles, readBytes: sumFileBytes(files), limits })
	await forEachConcurrently({
		items: plannedFiles,
		concurrency: fileConcurrency,
		work: async (plannedFile) => void files.set(plannedFile.path, await readBlob(session, plannedFile)),
	})
	return { files, lockfileNames, workspaceDirectories, manager }
}

async function requirePublicRepository(session: GithubSession): Promise<void> {
	// read the repository's record
	const response = await requestGithubApi(session, { path: `/repos/${session.repository}`, accept: jsonAccept })
	if (!response.ok) {
		await response.body?.cancel()
		throw toMissingRepositoryError()
	}

	// reject a repository that is not public
	const repository = (await readBody({ session, body: readBoundedJson(response, mebibyte) })) as {
		private?: unknown
		visibility?: unknown
	} | null
	if (repository?.private !== false || repository.visibility !== "public") {
		throw new InspectionError(
			"repository-unavailable",
			"This repository is private. Health Code inspects public repositories.",
		)
	}
}

function toMissingRepositoryError(): InspectionError {
	return new InspectionError(
		"repository-unavailable",
		"GitHub could not find a public repository at this URL. Check the address and that the repository is public.",
	)
}

async function readTree({ session, commit, isRevisionSupplied }: TreeRequest): Promise<RepositoryTree> {
	// list every file at the commit in one request
	const path = `/repos/${session.repository}/git/trees/${commit}?recursive=1`
	const response = await requestGithubApi(session, { path, accept: jsonAccept })
	if (!response.ok) {
		await response.body?.cancel()
		throw await explainMissingTree(session, isRevisionSupplied)
	}

	// treat a tree past the bound as truncated
	const treeBody = (await readBody({
		session,
		body: readBoundedJson(response, maxTreeBytes),
		toSizeError: toTruncatedTreeError,
	})) as { truncated?: unknown; tree?: unknown } | null
	if (treeBody?.truncated === true) {
		throw toTruncatedTreeError()
	}

	// keep the entries the upgrade menu can read
	if (!Array.isArray(treeBody?.tree)) {
		throw new InspectionError("github-unavailable", "GitHub returned an unreadable file listing. Try again.")
	}
	return toRepositoryTree(treeBody.tree)
}

function toTruncatedTreeError(): UnreadableRepositoryError {
	return new UnreadableRepositoryError({
		reason: "tree-truncated",
		message: `GitHub could not list every file in this repository at once. ${sandboxListingAdvice}`,
	})
}

// tell a missing repository from an unknown commit when no earlier request proved the repository exists
async function explainMissingTree(session: GithubSession, isRevisionSupplied: boolean): Promise<InspectionError> {
	if (!isRevisionSupplied) {
		return new InspectionError("github-unavailable", "GitHub could not list the files at this commit. Try again.")
	}

	// check that the repository exists for a caller without a token
	if (!session.githubToken) {
		const response = await requestGithubApi(session, { path: `/repos/${session.repository}`, accept: jsonAccept })
		await response.body?.cancel()
		if (!response.ok) {
			return toMissingRepositoryError()
		}
	}
	return new InspectionError(
		"revision-unavailable",
		"GitHub could not find this commit in the repository. Check the full commit SHA and try again.",
	)
}

function toRepositoryTree(treeItems: unknown[]): RepositoryTree {
	const entries = new Map<string, TreeEntry>()
	const regularFilePaths: string[] = []
	let entryCount = 0
	for (const item of treeItems) {
		// skip dependency trees and private environment files
		const { path, mode, type, sha, size } = (item ?? {}) as Record<string, unknown>
		if (typeof path !== "string" || path.split("/").some(isIgnoredProjectName)) {
			continue
		}
		if (++entryCount > maxProjectFiles) {
			throw toLimitError({
				observed: `This repository has more than ${maxProjectFiles} files`,
				bound: `${maxProjectFiles} files`,
			})
		}

		// keep files and links. a submodule is a commit entry and holds no file
		if (type !== "blob" || !isGitObjectId(sha)) {
			continue
		}

		// list a regular file as a workspace manifest candidate
		const isSymbolicLink = mode === "120000"
		entries.set(path, { blobId: sha, size: typeof size === "number" ? size : 0, isSymbolicLink })
		if (!isSymbolicLink) {
			regularFilePaths.push(path)
		}
	}
	return { entries, regularFilePaths }
}

// read a root file's entry and reject a symbolic link
function readRootEntry(tree: RepositoryTree, path: string): TreeEntry | undefined {
	const entry = tree.entries.get(path)
	if (entry?.isSymbolicLink) {
		throw new UnreadableRepositoryError({
			reason: "symbolic-link",
			message: `${path} is a symbolic link at this commit and the upgrade menu reads regular files only. ${sandboxListingAdvice}`,
		})
	}
	return entry
}

function planFiles({
	tree,
	manager,
	lockfileNames,
	workspaceDirectories,
	limits,
}: {
	tree: RepositoryTree
	manager: PackageManager
	lockfileNames: string[]
	workspaceDirectories: string[]
	limits: RepositoryFileLimits
}): PlannedFile[] {
	// bound the manifests before planning a request for each
	if (workspaceDirectories.length > limits.maxWorkspaces) {
		throw toLimitError({
			observed: `This repository has ${workspaceDirectories.length} workspace manifests`,
			bound: `${limits.maxWorkspaces}`,
		})
	}

	// report a binary lockfile as unreadable
	const lockfileName = toLockfileName(manager, lockfileNames)
	if (lockfileName === "bun.lockb") {
		throw new UnreadableRepositoryError({
			reason: "binary-lockfile",
			message:
				"This repository commits a binary bun.lockb, which only Bun can decode. Commit a text bun.lock or list upgrades in a sandbox.",
		})
	}

	// give each kind of file its size bound
	const wantedFiles: [string, number][] = [
		...workspaceDirectories.map((directory): [string, number] => [`${directory}/package.json`, maxManifestBytes]),
		[lockfileName, limits.maxLockfileBytes],
		...configurationFiles[manager].map((name): [string, number] => [name, maxConfigurationBytes]),
	]
	return wantedFiles.flatMap(([path, maxBytes]) => {
		const entry = path.includes("/") ? tree.entries.get(path) : readRootEntry(tree, path)
		return entry ? [{ path, entry, maxBytes }] : []
	})
}

// reject the planned files before reading them when the files or the requests would not fit
function requireBudget({
	session,
	plannedFiles,
	readBytes,
	limits,
}: {
	session: GithubSession
	plannedFiles: PlannedFile[]
	readBytes: number
	limits: RepositoryFileLimits
}): void {
	// check the size github lists for each file against its bound
	for (const { path, entry, maxBytes } of plannedFiles) {
		if (entry.size > maxBytes) {
			throw toLimitError({
				observed: `The file ${toPrintablePath(path)} is ${toMebibytes(entry.size)} MiB`,
				bound: `${toMebibytes(maxBytes)} MiB of it`,
			})
		}
	}

	// bound the bytes of every file together
	const plannedBytes = plannedFiles.reduce((sum, { entry }) => sum + entry.size, readBytes)
	if (plannedBytes > limits.maxTotalBytes) {
		throw toLimitError({
			observed: `The manifests and the lockfile are ${toMebibytes(plannedBytes)} MiB together`,
			bound: `${toMebibytes(limits.maxTotalBytes)} MiB`,
		})
	}

	// stop while the rate limit is short instead of spending the last requests
	if (session.remainingRequestCount !== undefined && session.remainingRequestCount < plannedFiles.length) {
		throw toRateLimitError(session, session.resetAt)
	}
}

async function readBlob(session: GithubSession, { path, entry, maxBytes }: PlannedFile): Promise<string> {
	// request the file by the blob id from the tree
	const blobPath = `/repos/${session.repository}/git/blobs/${entry.blobId}`
	const response = await requestGithubApi(session, { path: blobPath, accept: "application/vnd.github.raw+json" })
	if (!response.ok) {
		await response.body?.cancel()
		throw new InspectionError("github-unavailable", "GitHub could not return a file listed at this commit. Try again.")
	}

	// enforce the bound again on the bytes that arrive
	return readBody({
		session,
		body: readBoundedText(response, maxBytes),
		toSizeError: () =>
			toLimitError({
				observed: `The file ${toPrintablePath(path)} is larger than expected`,
				bound: `${toMebibytes(maxBytes)} MiB of it`,
			}),
	})
}

// read a response body and name what ended it: the deadline, the caller or a broken answer
async function readBody<Body>({
	session,
	body,
	toSizeError,
}: {
	session: GithubSession
	body: Promise<Body>
	toSizeError?: () => Error
}): Promise<Body> {
	try {
		return await body
	} catch (error) {
		// name the deadline or the cancellation that ended the read
		if (session.signal.aborted) {
			throw toAbortError(session.signal)
		}

		// report a body over its bound, or an answer that could not be read
		if (error instanceof ResponseTooLargeError && toSizeError) {
			throw toSizeError()
		}
		throw new InspectionError("github-unavailable", "GitHub sent an answer that could not be read. Try again.")
	}
}

// name the bound and the value that passed it
function toLimitError({ observed, bound }: { observed: string; bound: string }): UnreadableRepositoryError {
	return new UnreadableRepositoryError({
		reason: "limit",
		message: `${observed}. The upgrade menu reads at most ${bound}.`,
	})
}

// show a repository path on one line of a log, without control characters
function toPrintablePath(path: string): string {
	return path.replace(/[^\x20-\x7e]/g, "?").slice(0, 200)
}

function toMebibytes(bytes: number): string {
	return (bytes / mebibyte).toFixed(1)
}

function sumFileBytes(files: Map<string, string>): number {
	return [...files.values()].reduce((sum, text) => sum + Buffer.byteLength(text), 0)
}
