import { randomBytes } from "node:crypto"
import { libraryVersion, toRepositoryUrl } from "health-code"
import type { InspectionSource } from "./executeInspection.ts"
import { LaunchSettings } from "./launchLimits.ts"
import { AdmissionError, toUtcDay, type Visitor } from "./recordAdmissions.ts"
import type { InspectionStore } from "./storeInspections.ts"
import { verifyChallenge } from "./verifyVisitor.ts"

export type AdmissionRequest = { identify: () => Visitor; challenge: unknown; hostname: string }

export class LaunchService {
	readonly settings: LaunchSettings
	readonly visitorKey: string
	readonly challengeKey: string
	readonly challengeSecret: string
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
		this.configured = replay || Boolean(key && key.length >= 32 && site && secret && token)
		this.settings = new LaunchSettings(environment, token)

		// Keep the widget key and verification secret on their respective sides of the request.
		this.visitorKey = key ?? randomBytes(32).toString("hex")
		this.challengeKey = site ?? ""
		this.challengeSecret = secret ?? ""
		this.adminPassword = environment.HEALTH_CODE_ADMIN_PASSWORD
	}

	async admit(options: {
		input: string
		request: AdmissionRequest
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
		const key = JSON.stringify([head.repositoryId, head.revision, libraryVersion])
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
			const limits = this.settings.current
			if (!workerAvailable() || !this.settings.available || head.sizeKiB > limits.maxSizeKiB) {
				throw new AdmissionError(503, "Admission settings changed. Retry.")
			}

			// Commit admission and enqueue under one SQLite write lock.
			const result = store.admission.admit({
				key,
				head,
				limits,
				identity,
				now,
				enqueue: () => store.enqueue(head.canonicalUrl ?? url),
			})
			setTimeout(wake, 0)
			return result
		} catch (error) {
			return store.admission.handleRejection({ key, day, error })
		}
	}
}
