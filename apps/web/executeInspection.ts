import { EventEmitter } from "node:events"
import { InspectionError, toRepositoryUrl } from "health-code"
import { type InspectionOutput, publishReport } from "./publishReport.ts"
import type { SiteEvent } from "./report.ts"
import type { InspectionStore } from "./storeInspections.ts"

export class SiteError extends Error {}
export interface InspectionSource<Output extends InspectionOutput = InspectionOutput> {
	verify(repositoryUrl: string): Promise<void>
	inspect(repositoryUrl: string, emit: (event: SiteEvent) => void): Promise<Output>
	license(repository: { url: string; commit: string }): Promise<string | null>
	recover(): Promise<void>
}
export class Inspections {
	readonly changes = new EventEmitter()
	private active = 0
	private ready = false
	constructor(
		readonly store: InspectionStore,
		private readonly source: InspectionSource,
		private readonly concurrency = 2,
	) {
		if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
			throw new Error("Invalid inspection concurrency")
		}
		this.changes.setMaxListeners(0)
	}
	async start(sleep: (milliseconds: number) => Promise<void> = Bun.sleep): Promise<void> {
		// Interrupt stale inspections before reclaiming their sandboxes.
		this.store.interrupt()
		let delay = 1000
		for (;;) {
			try {
				await this.source.recover()
				break
			} catch {
				console.error("Deployment sandbox cleanup failed. Retrying before starting inspections.")
				await sleep(delay)
				delay = Math.min(60000, delay * 2)
			}
		}
		this.ready = true
		this.drain()
	}
	submit(input: string): string {
		const url = toRepositoryUrl(input)
		if (this.store.queueFull()) {
			throw new InspectionError("queue-full", "The inspection queue is full. Try again after an inspection starts.")
		}
		const id = this.store.enqueue(url)
		// Let the submission return its durable ID before starting external work.
		setTimeout(() => this.drain(), 0)
		return id
	}
	private drain(): void {
		while (this.ready && this.active < this.concurrency) {
			const row = this.store.claim()
			if (!row) {
				return
			}
			this.active++
			this.changes.emit(row.id)
			void this.execute(row).finally(() => {
				this.active--
				this.drain()
			})
		}
	}
	private async execute(row: { id: string; repositoryUrl: string }): Promise<void> {
		const emit = (event: SiteEvent): void => {
			this.store.append(row.id, event)
			this.changes.emit(row.id)
		}
		try {
			await this.source.verify(row.repositoryUrl)
			const output = await this.source.inspect(row.repositoryUrl, emit)
			// Keep findings available if GitHub cannot identify the license at the pinned commit.
			const license = await this.source.license(output.report.repository).catch(() => null)
			this.store.finish(row.id, publishReport(output, license))
		} catch (error) {
			if (error instanceof InspectionError) {
				for (const event of error.timeline) {
					emit(event)
				}
			}
			this.store.fail(
				row.id,
				error instanceof SiteError
					? error.message
					: "The inspection could not finish. Review the recorded steps and start a new inspection.",
			)
		}
		this.changes.emit(row.id)
	}
}
