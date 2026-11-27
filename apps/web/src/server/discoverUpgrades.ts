import type { EventEmitter } from "node:events"
import { type InspectionReport, toRepositoryUrl, toUpgradeMenuReport } from "health-code"
import type { SiteEvent } from "../report.ts"
import type { AdmissionRequest, LaunchService } from "./admitInspections.ts"
import {
	maxUpgradeMenuRequests,
	toUpgradeMenuFailureMessage,
	upgradeMenuUnavailableMessage,
} from "./buildUpgradeMenu.ts"
import type { InspectionSource } from "./inspectionSource.ts"
import { publishReport } from "./publishReport.ts"
import { AdmissionError, type RepositoryHead, toUtcDay, toUtcTime, type Visitor } from "./recordAdmissions.ts"
import type { InspectionStore } from "./storeInspections.ts"
import type { StartUpgradeMenuOptions } from "./storeUpgradeMenus.ts"

// the builds allowed to wait for a free slot before a submission is refused
const maxWaitingBuilds = 8
const savedUpgradeMenusMessage = "Saved upgrade menus stay open."

// the GitHub requests one head lookup sends
const headLookupRequests = 2

// how long a resolved head answers repeat submissions, and how many heads are kept
const headLifetimeMs = 60000
const maxSavedHeads = 500

/**
 * Builds upgrade menus in the server and reuses saved ones.
 */
export class UpgradeMenuBuilds {
	private runningBuildCount = 0
	private readonly waitingBuilds: (() => void)[] = []

	// the GitHub requests admitted builds may still send, and the heads resolved in the last minute
	private pendingRequestCount = 0
	private readonly heads = new Map<string, { head: RepositoryHead; expires: number }>()
	constructor(
		private readonly store: InspectionStore,
		private readonly source: InspectionSource,
		private readonly changes: EventEmitter,
		private readonly launch?: LaunchService,
	) {}

	/**
	 * Returns a saved or running upgrade menu for the repository's head, or starts a fresh build.
	 */
	async discover(input: string, request?: AdmissionRequest): Promise<{ id: string; reused: boolean }> {
		const repositoryUrl = toRepositoryUrl(input)
		if (!this.source.upgradeMenu) {
			throw new AdmissionError(503, upgradeMenuUnavailableMessage)
		}

		// build from the default branch head without visitor limits on a local site
		const day = toUtcDay()
		if (!this.launch || !request) {
			return this.startBuild({ repositoryUrl, day })
		}

		// answer a repeat submission from a head resolved in the last minute, without a GitHub request
		const recentHead = this.heads.get(repositoryUrl)
		const isRecentHeadFresh = recentHead !== undefined && recentHead.expires > Date.now()
		const recentUpgradeMenuId = isRecentHeadFresh ? this.findSavedUpgradeMenu(recentHead.head, day) : undefined
		if (recentUpgradeMenuId) {
			return { id: recentUpgradeMenuId, reused: true }
		}

		// read the head once so the menu, its cache key and a later selection agree on one commit
		const head = await this.resolveHeadWithinFloor(repositoryUrl)
		const savedUpgradeMenuId = this.findSavedUpgradeMenu(head, day)
		if (savedUpgradeMenuId) {
			return { id: savedUpgradeMenuId, reused: true }
		}

		// check the visitor, capacity and GitHub request limits before a fresh build
		const identity = request.identify()
		this.requireCapacity(identity, day)
		return this.startBuild({
			repositoryUrl: head.canonicalUrl ?? repositoryUrl,
			revision: head.revision,
			cacheKey: this.launch.toUpgradeMenuCacheKey(head),
			identity,
			day,
		})
	}

	// find a saved upgrade menu or sandbox listing for the head and count the reuse
	private findSavedUpgradeMenu(head: RepositoryHead, day: string): string | undefined {
		if (!this.launch) {
			return undefined
		}
		const sandboxListingId = this.store.admission.reuse(this.launch.toSandboxListingCacheKey(head), day)?.id

		// fall back to the upgrade menu the server built for the head
		const upgradeMenuCacheKey = this.launch.toUpgradeMenuCacheKey(head)
		const savedUpgradeMenuId = sandboxListingId ?? this.store.upgradeMenus.reuse(upgradeMenuCacheKey)
		if (savedUpgradeMenuId) {
			this.store.admission.count("menuReuses", day)
		}
		return savedUpgradeMenuId
	}

	private async resolveHead(repositoryUrl: string): Promise<RepositoryHead> {
		if (!this.source.resolve || !this.launch) {
			throw new AdmissionError(503, upgradeMenuUnavailableMessage)
		}

		// reject a private, missing or oversized repository
		const head = await this.source.resolve(repositoryUrl)
		this.launch.requireHostedSize(head)

		// remember the head for a minute and drop the oldest past the limit
		this.heads.delete(repositoryUrl)
		this.heads.set(repositoryUrl, { head, expires: Date.now() + headLifetimeMs })
		const oldestHeadKey = this.heads.size > maxSavedHeads ? this.heads.keys().next() : undefined
		if (oldestHeadKey && !oldestHeadKey.done) {
			this.heads.delete(oldestHeadKey.value)
		}
		return head
	}

	// hold the lookup's requests against the floor while it runs, so submissions at once cannot cross it together
	private async resolveHeadWithinFloor(repositoryUrl: string): Promise<RepositoryHead> {
		this.requireGithubRequests(headLookupRequests)
		this.pendingRequestCount += headLookupRequests

		// release the hold however the lookup ends
		try {
			return await this.resolveHead(repositoryUrl)
		} finally {
			this.pendingRequestCount -= headLookupRequests
		}
	}

	// keep the last requests of the hour for paid inspections, counting what admitted builds may still send
	private requireGithubRequests(neededRequestCount: number): void {
		const githubQuota = this.source.githubQuota?.()
		const githubQuotaFloor = this.launch?.settings.current.githubQuotaFloor
		if (!githubQuota || githubQuotaFloor === undefined || githubQuota.resetAt <= Date.now()) {
			return
		}

		// pause fresh menus until GitHub resets the count
		if (githubQuota.remaining - this.pendingRequestCount - neededRequestCount < githubQuotaFloor) {
			const resetTime = toUtcTime(githubQuota.resetAt)
			throw new AdmissionError(503, `New upgrade menus are paused until ${resetTime} UTC. ${savedUpgradeMenusMessage}`)
		}
	}

	private requireCapacity(identity: Visitor, day: string): void {
		// offer the sandbox listing while the operator has paused fresh menus
		const { dailyVisitorUpgradeMenus, upgradeMenuConcurrency } = this.launch?.settings.current ?? {}
		if (upgradeMenuConcurrency === 0) {
			throw new AdmissionError(503, `New upgrade menus are paused. ${savedUpgradeMenusMessage}`, {
				shouldOfferSandboxListing: true,
			})
		}

		// refuse a visitor at the daily limit and count the refusal
		const freshUpgradeMenuCount = this.store.upgradeMenus.countFreshUpgradeMenus(identity, day)
		if (dailyVisitorUpgradeMenus !== undefined && freshUpgradeMenuCount >= dailyVisitorUpgradeMenus) {
			this.store.admission.count("menuLimitHits", day)
			throw new AdmissionError(
				429,
				`You have reached today’s limit of ${dailyVisitorUpgradeMenus} upgrade menus. It resets at 00:00 UTC. ${savedUpgradeMenusMessage}`,
			)
		}

		this.requireGithubRequests(maxUpgradeMenuRequests)

		// refuse a submission when the waiting builds are at their limit
		const buildCount = this.runningBuildCount + this.waitingBuilds.length
		if (buildCount >= (upgradeMenuConcurrency ?? 1) + maxWaitingBuilds) {
			throw new AdmissionError(429, "The upgrade menu is busy. Try again in a minute.")
		}
	}

	private startBuild(startOptions: Omit<StartUpgradeMenuOptions, "makeId">): { id: string; reused: boolean } {
		// hand a simultaneous submission the build that won the cache key
		const startResult = this.store.upgradeMenus.start({ ...startOptions, makeId: this.store.makeId })
		if (startResult.reused) {
			return startResult
		}

		// count the fresh build, hold back the GitHub requests it may send and build in the background
		this.store.admission.count("menus", startOptions.day)
		this.pendingRequestCount += maxUpgradeMenuRequests
		const { repositoryUrl, revision } = startOptions
		const build = this.build({ id: startResult.id, repositoryUrl, revision })
		void build.catch(() => console.error("An upgrade menu could not be saved."))
		return startResult
	}

	private async build({
		id,
		repositoryUrl,
		revision,
	}: {
		id: string
		repositoryUrl: string
		revision?: string
	}): Promise<void> {
		// save each event, then announce the change
		const timeline: SiteEvent[] = []
		const onEvent = (event: SiteEvent): void => {
			timeline.push(event)
			this.store.append(id, event)
			this.changes.emit(id)
		}
		try {
			// wait for a free slot, then build the menu
			await this.takeSlot()
			const { maxUpgradeMenuResponseMiB, maxUpgradeMenuMemoryMiB } = this.launch?.settings.current ?? {}
			const upgradeMenu = await this.source.upgradeMenu?.(repositoryUrl, {
				revision,
				maxRegistryResponseMiB: maxUpgradeMenuResponseMiB,
				maxMemoryMiB: maxUpgradeMenuMemoryMiB,
				onEvent,
			})
			if (!upgradeMenu) {
				throw new Error(upgradeMenuUnavailableMessage)
			}

			// save the menu in the shape a sandbox listing publishes
			const upgradeMenuReport = toUpgradeMenuReport(upgradeMenu, timeline as InspectionReport["timeline"])
			this.store.finish(id, publishReport({ report: upgradeMenuReport, upgradeMenu }, null))

			// let the next submission build again after an incomplete registry lookup
			if (upgradeMenuReport.selection.registryLookupIssue) {
				this.store.upgradeMenus.release(id)
			}
		} catch (error) {
			// let the next submission build again
			this.store.upgradeMenus.release(id)
			this.store.fail({ id, message: toUpgradeMenuFailureMessage(error), dispatched: true })
		} finally {
			this.pendingRequestCount -= maxUpgradeMenuRequests
			this.releaseSlot()
			this.changes.emit(id)
		}
	}

	// run at most the configured number of builds and let the rest wait in order
	private async takeSlot(): Promise<void> {
		if (this.runningBuildCount >= this.slotCount) {
			await new Promise<void>((resolve) => this.waitingBuilds.push(resolve))
		} else {
			this.runningBuildCount++
		}
	}

	// free the slot, then start waiting builds up to the limit the operator set last
	private releaseSlot(): void {
		this.runningBuildCount--
		while (this.runningBuildCount < this.slotCount && this.waitingBuilds.length) {
			this.runningBuildCount++
			this.waitingBuilds.shift()?.()
		}
	}

	private get slotCount(): number {
		return Math.max(1, this.launch?.settings.current.upgradeMenuConcurrency ?? 1)
	}
}
