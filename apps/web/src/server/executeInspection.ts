import { EventEmitter } from "node:events"
import { InspectionError, toRepositoryUrl, type UpgradeFeatures } from "health-code"
import type { SiteEvent } from "../publishedReport.ts"
import type { AdmissionRequest, LaunchService } from "./admitInspections.ts"
import { ReleaseFeatureCache } from "./cacheReleaseFeatures.ts"
import { type InspectionChoice, type InspectionSource, SiteError } from "./inspectionSource.ts"
import type { LaunchLimits } from "./launchLimits.ts"
import { logInspection } from "./logInspection.ts"
import { type InspectionOutput, publishReport } from "./publishReport.ts"
import { AdmissionError, toUtcDay } from "./recordAdmissions.ts"
import { InspectionStops, stoppedMessage } from "./stopInspections.ts"
import type { InspectionStore } from "./storeInspections.ts"

// coordinate queued inspections and notify subscribers when their state changes
export class Inspections {
	readonly changes = new EventEmitter()
	readonly stops: InspectionStops
	private timers: ReturnType<typeof setInterval>[] = []

	// Share pending release requests for the same package versions.
	private readonly featureLookups = new ReleaseFeatureCache()
	private sweeping = false
	private inventoryHealthy = true
	private maintenanceHealthy = true
	private cleanupRevision = 0
	private lifecycle = 0

	// Track live leases independently of durable inspection state.
	private active = 0
	private ready = false
	private readonly leases = new Map<string, number>()
	constructor(
		readonly store: InspectionStore,
		private readonly source: InspectionSource,
		private readonly concurrency = 2,
		readonly launch?: LaunchService,
	) {
		if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
			throw new Error("Invalid inspection concurrency")
		}
		this.stops = new InspectionStops(store)
		this.changes.setMaxListeners(0)
	}

	async features(choice: Parameters<InspectionStore["upgradeMenuTarget"]>[0]): Promise<UpgradeFeatures> {
		// Accept only an exact target from a published upgrade menu.
		const target = this.store.upgradeMenuTarget(choice)
		if (!target || !this.source.features) {
			throw new SiteError("Release notes are unavailable for this target.")
		}

		return this.featureLookups.read(target, (upgrade) => this.source.features!(upgrade))
	}

	// Expose completion of startup cleanup to the readiness probe.
	get recovered(): boolean {
		return this.ready
	}

	// Require both inventory and accounting to be healthy before offering a paid slot.
	private get workerAvailable(): boolean {
		return this.ready && this.inventoryHealthy && this.maintenanceHealthy
	}
	get paused(): boolean {
		if (!this.launch) {
			return false
		}

		// Account for pending reservations when showing the daily budget.
		const { current, available } = this.launch.settings
		return (
			!this.workerAvailable ||
			!this.launch.configured ||
			!available ||
			// Reserve room for one full inspection before offering a paid start.
			current.maxCostUsd <= 0 ||
			this.store.admission.liability(toUtcDay()) + Math.ceil(current.maxCostUsd * 1e6) > current.dailyMicros
		)
	}
	async admit(
		input: string,
		request: AdmissionRequest,
		choice?: InspectionChoice,
	): Promise<{ id: string; reused: boolean }> {
		if (!this.launch) {
			throw new AdmissionError(503, "Paid admission is unavailable.")
		}

		return this.launch.admit({
			input,
			choice,
			request,
			source: this.source,
			store: this.store,

			// Recheck the worker after the external challenge resolves.
			workerAvailable: () => this.workerAvailable,
			wake: () => this.drain(),
		})
	}
	async start(sleep: (milliseconds: number) => Promise<void> = Bun.sleep): Promise<void> {
		// Interrupt stale inspections before reclaiming their sandboxes.
		const lifecycle = ++this.lifecycle

		// Defer claims until the previous worker’s runtimes have been reconciled.
		await this.recoverAtStartup(lifecycle, sleep)
		if (lifecycle !== this.lifecycle) {
			return
		}

		// start claiming work after sandbox recovery succeeds
		const settings = this.launch?.settings
		if (settings) {
			const refresh = async (): Promise<void> => {
				try {
					await settings.refresh()
				} catch {
					console.error("Launch limits refresh failed")
				}

				// Keep persisted reservations within the new ceilings.
				if (lifecycle !== this.lifecycle) {
					return
				}
				try {
					this.store.admission.tightenQueued(settings.current.maxCostUsd)
					this.store.admission.prune()
					this.maintenanceHealthy = true
				} catch {
					// Suspend paid work while accounting maintenance cannot reach the store.
					this.pauseAccounting()
					return
				}
				this.drain()
			}

			// Avoid installing timers on a worker stopped during limits refresh.
			await refresh()
			if (lifecycle !== this.lifecycle) {
				return
			}
			this.timers.push(setInterval(() => void refresh(), 60000).unref())
		}

		// Reap for every worker that can allocate a sandbox.
		this.timers.push(setInterval(() => void this.reap(), 300000).unref())
		this.ready = true
		this.drain()
	}
	private async recoverAtStartup(lifecycle: number, sleep: (milliseconds: number) => Promise<void>): Promise<void> {
		let delay = 1000

		// retry deployment cleanup before accepting queued work
		for (;;) {
			try {
				this.launch?.resumeQueued(this.store)
				const interrupted = this.store.interrupt()

				// Record interrupted inspections before reconciling their runtimes.
				if (this.launch) {
					for (const row of interrupted) {
						logInspection({ row, state: "interrupted", durationMs: row.durationMs })
					}
				}

				// Verify provider inventory before settling abandoned reservations.
				const remaining = await this.source.recover()
				if (lifecycle !== this.lifecycle) {
					return
				}

				// Release the old holds only after inventory confirms deletion.
				if (remaining !== 0) {
					throw new Error("Cleanup still pending")
				}
				this.store.admission.closeInterrupted()
				break
			} catch {
				// back off between recovery attempts for up to one minute
				console.error("Deployment sandbox cleanup failed. Retrying before starting inspections.")
				await sleep(delay)

				// Drop the retry when recovery belongs to a stopped worker.
				if (lifecycle !== this.lifecycle) {
					return
				}
				delay = Math.min(60000, delay * 2)
			}
		}
	}

	// Skip overlapping inventory sweeps.
	async reap(now = Date.now()): Promise<void> {
		if (this.sweeping) {
			return
		}
		this.sweeping = true
		const revision = this.cleanupRevision
		const lifecycle = this.lifecycle
		const createdBefore = now - (this.source.maxDurationMs ?? 1800000) - 60000

		// An active lease expires after the worker deadline and teardown allowance.
		const liveInspectionIds = new Set(
			[...this.leases].filter(([, started]) => started >= createdBefore).map(([id]) => id),
		)
		try {
			const remaining = await this.source.recover({ liveInspectionIds, createdBefore })

			// Discard inventory taken before a newer cleanup failure or worker restart.
			if (revision !== this.cleanupRevision || lifecycle !== this.lifecycle) {
				return
			}

			// Settle interrupted work only after the scoped inventory confirms deletion.
			this.inventoryHealthy = remaining === 0
			if (this.inventoryHealthy) {
				this.store.admission.closeInterrupted(createdBefore)
			}
			this.drain()
		} catch {
			// Discard a late failure from a stopped worker.
			if (lifecycle !== this.lifecycle) {
				return
			}

			// Keep paid admission closed until a fresh inventory succeeds.
			this.inventoryHealthy = false
			console.error("Scheduled deployment sandbox cleanup failed. Retrying next sweep.")
		} finally {
			this.sweeping = false
		}
	}

	// stop one inspection and wake its subscribers
	stopInspection(id: string): void {
		this.stops.stop(id)
		this.changes.emit(id)
		this.changes.emit("queue")
	}

	stop(): void {
		this.lifecycle++
		this.ready = false
		for (const timer of this.timers) {
			clearInterval(timer)
		}
		this.timers = []
	}

	submit(input: string, choice?: InspectionChoice): string {
		// validate the repository and queue capacity before persisting a submission
		const url = toRepositoryUrl(input)
		if (this.launch) {
			throw new Error("Hosted inspections require visitor admission")
		}
		const id = this.store.enqueue(url, choice)

		// Let the submission return its durable ID before starting external work.
		setTimeout(() => this.drain(), 0)
		return id
	}

	private pauseAccounting(): void {
		this.maintenanceHealthy = !this.launch
		console.error("Inspection accounting unavailable. Retrying.")
	}
	private claimNext(): ReturnType<InspectionStore["claim"]> {
		try {
			// Keep unfunded inspections in FIFO order until the operator restores spending.
			const launch = this.launch
			if (
				launch &&
				(!launch.configured ||
					!launch.settings.available ||
					// Recheck funding against all current holds at the moment of dispatch.
					launch.settings.current.maxCostUsd <= 0 ||
					!this.store.admission.canDispatch(launch.settings.current.dailyMicros))
			) {
				return null
			}

			return this.store.claim()
		} catch {
			// Preserve the queue when funding or the durable claim cannot be read.
			this.pauseAccounting()
			return null
		}
	}
	private drain(): void {
		// Claim queued work only while a worker slot is free.
		while (this.workerAvailable && this.active < (this.launch?.settings.current.concurrency ?? this.concurrency)) {
			const row = this.claimNext()
			if (!row) {
				return
			}
			this.active++
			this.changes.emit("queue")

			// notify subscribers and refill the slot when execution settles
			this.changes.emit(row.id)
			void this.execute(row).finally(() => {
				this.active--
				this.drain()
			})
		}
	}

	// Compare the worker and settings that admitted this claim with their current state.
	private canStartVerified(lifecycle: number, settings?: LaunchLimits): boolean {
		if (!this.workerAvailable || lifecycle !== this.lifecycle) {
			return false
		}
		return !this.launch || (this.launch.settings.available && settings === this.launch.settings.current)
	}

	// Save the license at the inspected commit for live output.
	private async recordInspectedLicense(
		row: { id: string; repositoryUrl: string },
		commit?: string,
	): Promise<string | null> {
		const license = commit ? await this.lookUpLicense({ url: row.repositoryUrl, commit }) : null
		this.store.saveInspectedLicense(row.id, license)
		return license
	}

	// Keep findings available if GitHub cannot identify the license.
	private async lookUpLicense(
		repository: { url: string; commit: string },
		knownLicense: string | null = null,
	): Promise<string | null> {
		return knownLicense ?? this.source.license(repository).catch(() => null)
	}

	private async execute(row: { id: string; repositoryUrl: string }): Promise<void> {
		// persist each event before waking its subscribers
		const started = Date.now()
		const lifecycle = this.lifecycle
		let libraryId: string | undefined
		let dispatched = false
		const stopSignal = this.stops.register(row.id)
		const emit = (event: SiteEvent): void => {
			// Register the library identity as soon as its first event arrives.
			if (event.type === "inspection.started") {
				libraryId = event.inspectionId
				this.leases.set(libraryId, started)
			}
			this.store.append(row.id, event)
			this.changes.emit(row.id)
		}
		try {
			// confirm repository visibility before starting an inspection
			const checkout = this.store.checkout(row.id)
			const choice = this.store.requestedWork(row.id, checkout)
			const { revision } = choice
			const settings = this.launch?.settings.current
			const limits = settings && this.store.admission.workerLimits(row.id, settings)
			await this.source.verify(
				row.repositoryUrl,
				checkout && limits ? { repositoryId: checkout.repositoryId, maxSizeKiB: limits.maxSizeKiB } : undefined,
			)

			// Show live output when GitHub confirms the license at the inspected commit.
			const inspectedLicense = await this.recordInspectedLicense(row, revision)

			// honor a stop requested before the sandbox starts
			stopSignal.throwIfAborted()

			// Recheck a claimed job if admission changed while GitHub verified its repository.
			if (!this.canStartVerified(lifecycle, settings)) {
				// Keep the reservation while the job waits for current settings.
				this.store.requeue(row.id)
				this.changes.emit(row.id)
				this.changes.emit("queue")
				return
			}
			dispatched = true
			const deadlineSignal = AbortSignal.timeout(this.source.maxDurationMs ?? 1800000)

			// Verify checkout identity before publishing a cached report.
			let output: InspectionOutput
			try {
				output = await this.source.inspect(row.repositoryUrl, emit, {
					...choice,
					revision,
					settings: limits,
					signal: AbortSignal.any([deadlineSignal, stopSignal]),
					reuseUpgrade: this.store.upgrades.reader(row.id),
				})
			} finally {
				// Let inventory reclaim a failed deletion even while terminal writes retry.
				if (libraryId) {
					this.leases.delete(libraryId)
				}
			}

			if (
				revision &&
				(revision !== output.report.repository.commit || row.repositoryUrl !== output.report.repository.url)
			) {
				throw new Error("Inspection repository or commit mismatch")
			}

			// Look up the license again only when the start of the inspection left it unverified.
			const license = await this.lookUpLicense(output.report.repository, inspectedLicense)
			const publication = publishReport(output, license)
			this.store.finish(row.id, publication)

			// Write a terminal log after report publication commits.
			if (this.launch) {
				logInspection({
					row,
					state: "complete",
					durationMs: Date.now() - started,
					usage: output.report.version === 2 ? output.report.runtimeUsage : undefined,
					upgrades: publication.card.upgrades,
				})
			}
		} catch (error) {
			await this.recordFailure({ row, error, started, dispatched, lifecycle })
		} finally {
			// forget the stop request before waking subscribers
			this.stops.unregister(row.id)
			this.changes.emit(row.id)
		}
	}

	private async recordFailure(input: {
		row: { id: string; repositoryUrl: string }
		error: unknown
		started: number
		dispatched: boolean
		lifecycle: number
	}): Promise<void> {
		const { row, error, started, dispatched, lifecycle } = input

		// name the outcome before any write can release this slot
		const failure = error instanceof InspectionError ? error : undefined
		const state = this.stops.isStopping(row.id) ? "stopped" : "failed"
		const message = toFailureMessage(error, state)

		// Invalidate inventory before any fallible writes can release this slot.
		if (failure && (failure.cleanupId || failure.runtimeUsage?.runtimes.some((item) => !item.deleted))) {
			this.cleanupRevision++
			this.inventoryHealthy = false
		}

		let delay = 1000
		while (lifecycle === this.lifecycle) {
			try {
				this.store.fail({ id: row.id, state, dispatched, failure, message })

				// Emit the terminal log after the transaction commits.
				if (this.launch) {
					logInspection({
						row,
						state,
						durationMs: Date.now() - started,
						usage: failure?.runtimeUsage,
					})
				}
				break
			} catch {
				// Retain the slot and reservation until SQLite accepts the terminal updates.
				this.pauseAccounting()
				await Bun.sleep(delay)
				delay = Math.min(delay * 2, 60000)
			}
		}
	}
}

// keep internal diagnostics out of the public message
function toFailureMessage(error: unknown, state: "failed" | "stopped"): string {
	if (state === "stopped") {
		return stoppedMessage
	}
	return error instanceof SiteError
		? error.message
		: "The inspection could not finish. Review the recorded steps and start a new inspection."
}
