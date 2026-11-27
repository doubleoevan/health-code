import { randomUUID } from "node:crypto"
import {
	defaultStageTimeouts,
	type StepStatus,
	toEventDeliveryError,
	toInspectionEvent,
	trackStep,
} from "../collectEvents.ts"
import {
	type EventPayload,
	InspectionError,
	type InspectionEvent,
	type InspectionLimits,
	type InspectionReport,
	type PackageManager,
} from "../contracts.ts"
import { toSandboxPackageManagerVersion } from "../sandbox/packageManagerVersions.ts"
import { toRepositoryUrl } from "../toRepositoryUrl.ts"
import { checkRegistryTarget, type TargetCheck } from "../upgrades/checkUpgradeTarget.ts"
import { fetchRegistryVersions, type RegistryOptions } from "../upgrades/fetchRegistryVersions.ts"
import { parseRegistryVersions, toPartialLookupIssue } from "../upgrades/parseRegistryVersions.ts"
import {
	type MinimumReleaseAge,
	type ReleaseAge,
	readCommittedReleaseAge,
} from "../upgrades/readCommittedReleaseAge.ts"
import {
	type LockedDependencies,
	ProjectDetectionError,
	readLockedDependencies,
} from "../upgrades/readLockedDependencies.ts"
import {
	defaultRepositoryFileLimits,
	isGitObjectId,
	type RepositoryFileLimits,
	readRepositoryFiles,
	resolveRepositoryCommit,
	type UnreadableRepository,
	UnreadableRepositoryError,
} from "../upgrades/readRepositoryFiles.ts"
import { type GithubSession, throwIfCancelled, toAbortError } from "../upgrades/requestGithubApi.ts"

// the stage timeouts an upgrade menu accepts and ignores
type DeprecatedStageTimeouts = {
	/**
	 * @deprecated Ignored by the upgrade menu.
	 */
	setup?: number

	/**
	 * @deprecated Ignored by the upgrade menu.
	 */
	detect?: number

	/**
	 * @deprecated Ignored by the upgrade menu.
	 */
	install?: number

	/**
	 * @deprecated Ignored by the upgrade menu.
	 */
	typecheck?: number

	/**
	 * @deprecated Ignored by the upgrade menu.
	 */
	tests?: number
}

// the bounds a caller can lower for an upgrade menu built in its own process
export type UpgradeMenuLimits = Pick<InspectionLimits, "maxDurationMs"> &
	Partial<RepositoryFileLimits> &
	Pick<RegistryOptions, "registryConcurrency" | "maxRegistryResponseBytes"> & {
		timeouts?: { registry?: number } & DeprecatedStageTimeouts
	}

export type UpgradeMenuOptions = {
	// the public repository and the commit to read, which defaults to the default branch head
	repositoryUrl: string
	revision?: string
	githubToken?: string
	request?: typeof fetch
	limits?: UpgradeMenuLimits
	onEvent?: (event: InspectionEvent) => void | Promise<void>
	signal?: AbortSignal
}

export type UpgradeMenuPackageManager = { name: PackageManager; version?: string } | { reason: string }

// what the committed files say about a project, or why they could not be read
export type UpgradeMenuProject = {
	repository: InspectionReport["repository"]
	packageManager: UpgradeMenuPackageManager
	lockedDependencies?: LockedDependencies

	// the age applied to the registry lookup and the reason the files could not be read
	releaseAge?: ReleaseAge
	minimumReleaseAge?: MinimumReleaseAge
	unreadableRepository?: UnreadableRepository
}

// one named version of a dependency with the locked versions and the release age it is checked against
type UpgradeMenuTargetLookup = { dependency: string; to: string; lockedVersions: string[]; releaseAge?: ReleaseAge }

// the registry versions an upgrade menu found, the packages over the size limit and what is missing
type UpgradeMenuVersions = { versions: Record<string, string[]>; oversizedPackageNames: string[]; issue?: string }

// the default bounds on the whole call and on its github reads
const defaultUpgradeMenuDurationMs = 120000
const githubTimeoutMs = 30000

/**
 * Holds one upgrade menu call's deadline and delivers its Inspection Events.
 */
export class UpgradeMenuContext {
	readonly repositoryUrl: string
	readonly started = Date.now()
	readonly deadline: number
	readonly signal: AbortSignal
	private readonly inspectionId = randomUUID()
	private sequence = 0
	constructor(readonly options: UpgradeMenuOptions) {
		// validate the caller's input before any request
		this.repositoryUrl = toRepositoryUrl(options.repositoryUrl)
		if (options.revision !== undefined && !isGitObjectId(options.revision)) {
			throw new InspectionError("invalid-revision", "Expected a full commit SHA")
		}

		// bound the whole call and keep the caller's cancellation
		const durationMs = options.limits?.maxDurationMs ?? defaultUpgradeMenuDurationMs
		this.deadline = this.started + durationMs
		const timeout = AbortSignal.timeout(Math.max(0, durationMs))
		this.signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
	}
	async emit(payload: EventPayload): Promise<void> {
		const event = toInspectionEvent(payload, { inspectionId: this.inspectionId, sequence: ++this.sequence })

		// end the call when the callback fails
		try {
			await this.options.onEvent?.(event)
		} catch {
			throw toEventDeliveryError()
		}
	}

	// track one step under the sequence number of its started event
	async step<T>(label: string, work: () => Promise<T>, toStatus?: (value: T) => StepStatus): Promise<T> {
		const emit = (payload: EventPayload): Promise<void> => this.emit(payload)
		return trackStep({ emit, stepId: String(this.sequence + 1), label, work, toStatus })
	}
}

/**
 * Performs an upgrade menu operation between its started event and its finished or failed event.
 */
export async function withUpgradeMenuContext<T>(
	options: UpgradeMenuOptions,
	work: (context: UpgradeMenuContext) => Promise<T>,
): Promise<T> {
	const context = new UpgradeMenuContext(options)
	try {
		await context.emit({ type: "inspection.started", repositoryUrl: context.repositoryUrl })
		const value = await work(context)
		await context.emit({ type: "inspection.finished", inspected: 0, durationMs: Date.now() - context.started })
		return value
	} catch (error) {
		// report a typed failure and hide unexpected text
		const failure = toUpgradeMenuFailure(error, context)
		const { code, message } = failure
		await context.emit({ type: "inspection.failed", code, message }).catch(() => undefined)
		throw failure
	}
}

/**
 * Reads the commit, the locked dependencies and the minimum release age through GitHub.
 */
export async function readUpgradeMenuProject(context: UpgradeMenuContext): Promise<UpgradeMenuProject> {
	// give the github reads a share of the deadline
	const { options } = context
	const session: GithubSession = {
		repository: context.repositoryUrl.slice("https://github.com/".length),
		githubToken: options.githubToken,
		request: options.request ?? fetch,
		signal: AbortSignal.any([context.signal, AbortSignal.timeout(githubTimeoutMs)]),
		requestCount: 0,
	}

	// emit the commit step only when the default branch head is resolved
	const commit = options.revision
		? await resolveRepositoryCommit(session, options.revision)
		: await context.step("Resolve commit", () => resolveRepositoryCommit(session))
	const repository = { url: context.repositoryUrl, commit }
	const isRevisionSupplied = Boolean(options.revision)
	return context.step(
		"detect",
		() => detectUpgradeMenuProject({ session, repository, isRevisionSupplied, limits: options.limits }),
		toDetectionStatus,
	)
}

/**
 * Looks up registry versions for the locked dependencies inside the remaining time.
 */
export async function lookUpUpgradeMenuVersions(
	context: UpgradeMenuContext,
	project: Pick<UpgradeMenuProject, "releaseAge"> & { lockedDependencies: LockedDependencies },
): Promise<UpgradeMenuVersions> {
	// bound the lookup by its timeout and the whole call
	const { limits, request, signal: callerSignal } = context.options
	const names = Object.keys(project.lockedDependencies.sources)
	const registryTimeoutMs = limits?.timeouts?.registry ?? defaultStageTimeouts.registry
	const timeoutMs = Math.max(0, Math.min(registryTimeoutMs, context.deadline - Date.now()))
	const timeout = AbortSignal.timeout(timeoutMs)
	const registryResults = await context.step(
		"registry",
		() =>
			fetchRegistryVersions(names, {
				releaseAge: project.releaseAge,
				request,
				signal: callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout,
				registryConcurrency: limits?.registryConcurrency,
				maxRegistryResponseBytes: limits?.maxRegistryResponseBytes,
			}),
		(results) => toLookupStatus(Object.values(results)),
	)
	throwIfCancelled(callerSignal)

	// separate the packages over the caller's size limit and explain what the rest are missing
	const oversizedPackageNames = names.filter((name) => registryResults[name] === "too-large")
	const remainingNames = names.filter((name) => registryResults[name] !== "too-large")
	const registryVersions = parseRegistryVersions(registryResults, remainingNames)
	const issue = toPartialLookupIssue({ names: remainingNames, registryVersions, timeoutMs })
	return { versions: registryVersions.versions, oversizedPackageNames, ...(issue && { issue }) }
}

/**
 * Looks up one package and checks a named version against the rule for a target.
 */
export async function lookUpUpgradeMenuTarget(
	context: UpgradeMenuContext,
	{ dependency, to, lockedVersions, releaseAge }: UpgradeMenuTargetLookup,
): Promise<TargetCheck> {
	const { limits, request, signal: callerSignal } = context.options
	const { maxRegistryResponseBytes } = limits ?? {}
	const registry = { releaseAge, request, signal: context.signal, maxRegistryResponseBytes }
	const check = await context.step(
		"registry",
		() => checkRegistryTarget({ dependency, to, lockedVersions, registry }),
		(result) => (typeof result === "string" ? "failed" : "passed"),
	)
	throwIfCancelled(callerSignal)

	// report a name the registry cannot hold as unpublished
	if (check === "invalid-name") {
		return { status: "unpublished", eligibleDependencyVersions: [] }
	}

	// fail when the registry returns no record
	if (typeof check === "string") {
		throw new InspectionError(
			"registry-unavailable",
			`The npm registry did not return ${dependency}. Check the package name and try again.`,
		)
	}
	return check
}

function toLookupStatus(results: unknown[]): StepStatus {
	const availableCount = results.filter(Array.isArray).length
	return availableCount === results.length ? "passed" : availableCount ? "untested" : "failed"
}

function toDetectionStatus(project: UpgradeMenuProject): StepStatus {
	if (project.unreadableRepository) {
		return "untested"
	}
	return project.lockedDependencies ? "passed" : "failed"
}

async function detectUpgradeMenuProject({
	session,
	repository,
	isRevisionSupplied,
	limits,
}: {
	session: GithubSession
	repository: InspectionReport["repository"]
	isRevisionSupplied: boolean
	limits?: UpgradeMenuLimits
}): Promise<UpgradeMenuProject> {
	try {
		// read the committed files and derive the locked dependencies from their text
		const repositoryFiles = await readRepositoryFiles({
			session,
			commit: repository.commit,
			isRevisionSupplied,
			limits: {
				maxWorkspaces: limits?.maxWorkspaces ?? defaultRepositoryFileLimits.maxWorkspaces,
				maxLockfileBytes: limits?.maxLockfileBytes ?? defaultRepositoryFileLimits.maxLockfileBytes,
				maxTotalBytes: limits?.maxTotalBytes ?? defaultRepositoryFileLimits.maxTotalBytes,
			},
		})
		const lockedDependencies = readLockedDependencies(repositoryFiles)

		// name the version the sandbox would run and the age its defaults imply
		const { manager, declaredPackageManager } = lockedDependencies
		const { files } = repositoryFiles
		const version = toSandboxPackageManagerVersion({
			manager,
			declaredPackageManagerVersion: declaredPackageManager?.version,
			files,
		})
		const releaseAges = readCommittedReleaseAge({ manager, packageManagerVersion: version, files })
		const packageManager = { name: manager, ...(version && { version }) }
		return { repository, packageManager, lockedDependencies, ...releaseAges }
	} catch (error) {
		// turn an unreadable or unsupported project into a reason
		return toUndetectedProject(repository, error)
	}
}

// keep a typed reason and hide the text of an unexpected parser error
function toUndetectedProject(repository: InspectionReport["repository"], error: unknown): UpgradeMenuProject {
	if (error instanceof InspectionError) {
		throw error
	}
	if (error instanceof UnreadableRepositoryError) {
		const { unreadableRepository } = error
		return { repository, packageManager: { reason: error.message }, unreadableRepository }
	}

	// hide a parser message, which can quote repository text
	const reason = error instanceof ProjectDetectionError ? error.message : "Unreadable project file"
	return { repository, packageManager: { reason } }
}

// name a passed deadline or a cancellation before falling back to a generic failure
function toUpgradeMenuFailure(error: unknown, context: UpgradeMenuContext): InspectionError {
	if (error instanceof InspectionError) {
		return error
	}

	// name the deadline or the cancellation that ended the call
	if (context.signal.aborted) {
		return toAbortError(context.signal)
	}
	return new InspectionError("menu-failed", "The upgrade menu could not be built. Try again.")
}
