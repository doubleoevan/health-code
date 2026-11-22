import { randomBytes } from "node:crypto"
import { libraryVersion, toRepositoryUrl } from "health-code"
import type { InspectionChoice, InspectionSource } from "./inspectionSource.ts"
import { LaunchSettings } from "./launchLimits.ts"
import { AdmissionError, type RepositoryHead, toUtcDay, type Visitor } from "./recordAdmissions.ts"
import type { InspectionStore } from "./storeInspections.ts"
import { verifyChallenge } from "./verifyVisitor.ts"

export type AdmissionRequest = { identify: () => Visitor; challenge: unknown; hostname: string }

export class LaunchService {
	private readonly releaseRevision: string
	readonly settings: LaunchSettings
	readonly visitorKey: string
	readonly challengeKey: string
	readonly challengeSecret: string

	// Keep the service availability and operator access settings together.
	readonly configured: boolean
	readonly adminPassword?: string
	constructor(
		environment: NodeJS.ProcessEnv,
		readonly replay: boolean,
	) {
		// Production admission stays closed until its independent limits feed is working.
		const {
			HEALTH_CODE_LIMITS_TOKEN: token,
			HEALTH_CODE_VISITOR_KEY: key,
			TURNSTILE_SITE_KEY: site,
			TURNSTILE_SECRET_KEY: secret,
		} = environment
		this.releaseRevision = environment.NF_DEPLOYMENT_SHA ?? "local"
		this.configured = replay || Boolean(key && key.length >= 32 && site && secret && token)
		this.settings = new LaunchSettings(environment, token)

		// Keep the widget key and verification secret on their respective sides of the request.
		this.visitorKey = key ?? randomBytes(32).toString("hex")
		this.challengeKey = site ?? ""
		this.challengeSecret = secret ?? ""
		this.adminPassword = environment.HEALTH_CODE_ADMIN_PASSWORD
	}

	resumeQueued(store: InspectionStore): void {
		store.admission.updateQueuedRelease(libraryVersion, this.releaseRevision)
	}

	private cacheKeys(head: RepositoryHead, choice?: InspectionChoice): { report: string; scope: string } {
		if (choice?.revision && choice.revision !== head.revision) {
			throw new AdmissionError(
				400,
				"The repository has changed. Find upgrades again to choose from its current commit.",
			)
		}

		// Separate discovery and each target from automatic inspections in the cache.
		const scope = [
			head.repositoryId,
			head.revision,
			libraryVersion,
			this.releaseRevision,
			this.settings.current.maxUpgrades,
		]
		const job = choice?.mode === "listUpgrades" ? "menu" : choice?.upgrade
		return { report: JSON.stringify(job ? [...scope, job] : scope), scope: JSON.stringify(scope.slice(0, 4)) }
	}

	async admit(options: {
		input: string
		choice?: InspectionChoice
		request: AdmissionRequest

		// Resolve and queue the verified repository.
		source: Pick<InspectionSource, "resolve">
		store: InspectionStore
		workerAvailable: () => boolean
		wake: () => void
	}): Promise<{ id: string; reused: boolean }> {
		// Resolve GitHub metadata before any paid admission checks.
		const { input, request, source, store, workerAvailable, wake } = options
		const url = toRepositoryUrl(input)
		if (!source.resolve) {
			throw new AdmissionError(503, "Paid admission is unavailable.")
		}
		const head = await source.resolve(url)

		// Join an existing inspection before challenging or charging its visitor.
		const maxUpgrades = this.settings.current.maxUpgrades
		const choice = options.choice
		const { report: key, scope } = this.cacheKeys(head, choice)
		const ready = store.upgrades.readyReport(scope, choice?.upgrade)
		if (ready) {
			store.admission.count("cache", toUtcDay())
			return { id: ready, reused: true }
		}

		// Join queued work or a complete report for the same operation.
		const day = toUtcDay()
		const cached = store.admission.reuse(key, day)
		if (cached) {
			return cached
		}

		// Check metadata and the current settings before requesting a paid-work challenge.
		if (head.sizeKiB > this.settings.current.maxSizeKiB) {
			throw new AdmissionError(413, "Repository exceeds the hosted size limit.")
		}
		if (!workerAvailable() || !this.configured || !this.settings.available) {
			throw new AdmissionError(503, "Inspection limits are temporarily unavailable. Use the local MCP.")
		}

		// Derive quota identities only for fresh work.
		if (choice?.upgrade && maxUpgrades === 0) {
			throw new AdmissionError(503, "Upgrade testing is paused. Existing patches remain available.")
		}

		// Identify the visitor before reserving fresh work.
		const identity = request.identify()
		try {
			store.admission.checkAllowance(identity, this.settings.current, day)
			if (!this.replay) {
				await verifyChallenge(request.challenge, this.challengeSecret, request.hostname)
			}

			// Debit the same UTC window used for the network identity.
			const now = Date.now()
			if (toUtcDay(now) !== day) {
				throw new AdmissionError(503, "The daily allowance just reset. Retry this inspection.")
			}

			// Match the reservation to the coverage used for the cache lookup.
			const limits = this.settings.current
			const changed = head.sizeKiB > limits.maxSizeKiB || limits.maxUpgrades !== maxUpgrades
			if (changed || !workerAvailable() || !this.settings.available) {
				throw new AdmissionError(503, "Admission settings changed. Retry.")
			}

			// Commit admission and enqueue under one SQLite write lock.
			const result = store.admission.admit({
				key,
				head,
				limits,
				identity,
				now,
				enqueue: () => store.enqueue(head.canonicalUrl ?? url, choice),
			})
			setTimeout(wake, 0)
			return result
		} catch (error) {
			return store.admission.handleRejection({ key, day, error })
		}
	}
}
