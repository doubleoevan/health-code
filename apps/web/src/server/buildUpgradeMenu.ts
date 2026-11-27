import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { explainedErrorCodes, InspectionError, type UpgradeMenu } from "health-code"
import type { SiteEvent } from "../report.ts"
import { defaultMaxUpgradeMenuMemoryMiB, defaultMaxUpgradeMenuResponseMiB } from "./launchLimits.ts"
import { toUtcTime } from "./recordAdmissions.ts"

const mebibyte = 1024 * 1024

// the limits for an upgrade menu the site builds
const upgradeMenuLimits = {
	maxDurationMs: 45000,
	maxWorkspaces: 100,
	maxLockfileBytes: 8 * mebibyte,
	maxTotalBytes: 12 * mebibyte,
	registryConcurrency: 4,
}

// the most GitHub requests one build sends. it reads the commit, visibility and tree, then each manifest and configuration file
export const maxUpgradeMenuRequests = 10 + upgradeMenuLimits.maxWorkspaces

// what the site tells a visitor about an upgrade menu it could not build
export const upgradeMenuFailedMessage = "The upgrade menu could not be built."
export const upgradeMenuUnavailableMessage = "The upgrade menu is unavailable."
export const upgradeMenuRetryMessage = "Click New features to try again."
const tookTooLongMessage = "The upgrade menu took too long to build."

// one upgrade menu to build, with the limits the operator set
type UpgradeMenuRequest = {
	repositoryUrl: string
	revision?: string
	githubToken?: string
	maxRegistryResponseMiB?: number
	maxMemoryMiB?: number
}

// the messages the build process sends back. each event comes first, then the upgrade menu or a typed failure
type ProcessMessage =
	| { kind: "event"; event: SiteEvent }
	| { kind: "upgradeMenu"; upgradeMenu: UpgradeMenu }
	| { kind: "failure"; code: string; message: string; retryAt?: string }

type BuildUpgradeMenuOptions = {
	request: UpgradeMenuRequest
	onEvent: (event: SiteEvent) => void
	entryPath?: string
	timeoutMs?: number
}

const defaultEntryPath = fileURLToPath(new URL("./upgradeMenuProcess.ts", import.meta.url))
const terminationGraceMs = 5000
// read the count from the kernel four times a second. another system asks ps, so check it once a second
const memoryCheckMs = process.platform === "linux" ? 250 : 1000

/**
 * Builds an upgrade menu in its own process and ends the process at its time or memory limit.
 */
export function buildUpgradeMenuInProcess({
	request,
	onEvent,
	entryPath = defaultEntryPath,
	timeoutMs = upgradeMenuLimits.maxDurationMs + terminationGraceMs,
}: BuildUpgradeMenuOptions): Promise<UpgradeMenu> {
	const { promise, resolve, reject } = Promise.withResolvers<UpgradeMenu>()
	const {
		maxRegistryResponseMiB = defaultMaxUpgradeMenuResponseMiB,
		maxMemoryMiB = defaultMaxUpgradeMenuMemoryMiB,
		...listUpgradesOptions
	} = request
	const maxMemoryBytes = maxMemoryMiB * mebibyte

	// start the build with no secret but the token in its request, and tell its collector the memory it has
	const child = Bun.spawn([process.execPath, entryPath], {
		env: { BUN_JSC_forceRAMSize: String(maxMemoryBytes) },
		stdio: ["ignore", "ignore", "ignore"],
		serialization: "json",
		ipc(message: ProcessMessage): void {
			if (message.kind === "upgradeMenu") {
				resolve(message.upgradeMenu)
			} else if (message.kind === "failure") {
				reject(Object.assign(new InspectionError(message.code, message.message), { retryAt: message.retryAt }))
			} else {
				// end the build when its event cannot be saved
				try {
					onEvent(message.event)
				} catch (error) {
					reject(error)
				}
			}
		},

		// end the build when the process cannot start or exits without an answer
		onExit: (): void => reject(new InspectionError("menu-failed", upgradeMenuFailedMessage)),
	})

	// reject the build at its time limit. a parser that never returns would hold the process
	const timer = setTimeout(() => reject(new InspectionError("deadline", tookTooLongMessage)), timeoutMs)

	// answer a build past its memory limit as a repository the upgrade menu cannot read
	const memoryCheck = setInterval(() => {
		if (readResidentBytes(child.pid) > maxMemoryBytes) {
			settleOverMemory({ request, maxMemoryMiB, resolve, reject })
		}
	}, memoryCheckMs)

	// send the request with the site limits
	const limits = { ...upgradeMenuLimits, maxRegistryResponseBytes: maxRegistryResponseMiB * mebibyte }
	child.send({ ...listUpgradesOptions, limits })

	// end the process and free its memory however the build ended
	return promise.finally(() => {
		clearTimeout(timer)
		clearInterval(memoryCheck)
		child.kill("SIGKILL")
	})
}

// read the memory a process holds, from the kernel on linux and from ps elsewhere
function readResidentBytes(processId: number): number {
	try {
		const kibibytes = /^VmRSS:\s+(\d+) kB$/m.exec(readFileSync(`/proc/${processId}/status`, "utf8"))?.[1]
		return Number(kibibytes ?? 0) * 1024
	} catch {
		// ask ps where the kernel exposes no status file
		const output = Bun.spawnSync(["ps", "-o", "rss=", "-p", String(processId)]).stdout.toString()
		return Number(output) * 1024 || 0
	}
}

// offer the sandbox listing for a known commit, and fail a build that names no commit
function settleOverMemory({
	request,
	maxMemoryMiB,
	resolve,
	reject,
}: {
	request: UpgradeMenuRequest
	maxMemoryMiB: number
	resolve: (upgradeMenu: UpgradeMenu) => void
	reject: (error: Error) => void
}): void {
	// fail a build that names no commit
	const message = `Reading this repository took more than ${maxMemoryMiB} MiB of memory. List upgrades in a sandbox instead.`
	if (!request.revision) {
		reject(new InspectionError("menu-failed", message))
		return
	}

	// answer a known commit as a repository the upgrade menu cannot read
	resolve({
		repository: { url: request.repositoryUrl, commit: request.revision },
		packageManager: { reason: message },
		dependencies: [],
		skipped: [],
		issue: message,
		unreadable: { reason: "limit", message },
	})
}

/**
 * Describes an upgrade menu that could not be built, with what the visitor can do next.
 */
export function toUpgradeMenuFailureMessage(error: unknown): string {
	if (!(error instanceof InspectionError)) {
		return `${upgradeMenuFailedMessage} ${upgradeMenuRetryMessage}`
	}
	if (error.code === "deadline") {
		return `${tookTooLongMessage} ${upgradeMenuRetryMessage}`
	}

	// say when GitHub's rate limit lifts without naming the server's token
	const retryTime = Date.parse(error.retryAt ?? "")
	if (error.code === "github-rate-limit" && !Number.isNaN(retryTime)) {
		return `GitHub is limiting requests until ${toUtcTime(retryTime)} UTC. Try again then.`
	}

	// keep the library's own next step for a repository or a commit GitHub could not serve
	return explainedErrorCodes.has(error.code) ? error.message : `${upgradeMenuFailedMessage} ${upgradeMenuRetryMessage}`
}
