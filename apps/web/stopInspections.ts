import type { InspectionStore } from "./storeInspections.ts"

export const stoppedMessage = "This inspection was stopped. You can start a new inspection."

/**
 * Stops queued and running inspections.
 */
export class InspectionStops {
	// abort controllers for the inspections this worker is running
	private readonly controllers = new Map<string, AbortController>()
	constructor(private readonly store: InspectionStore) {}

	// register an inspection before its first external request
	register(id: string): AbortSignal {
		const controller = new AbortController()
		this.controllers.set(id, controller)
		return controller.signal
	}

	// forget an inspection after its terminal state is saved
	unregister(id: string): void {
		this.controllers.delete(id)
	}

	isStopping(id: string): boolean {
		return this.controllers.get(id)?.signal.aborted ?? false
	}

	// check that work can still stop and that a hosted visitor may stop it
	canStop(id: string, visitor?: string): boolean {
		const state = this.store.state(id)
		const isCancellable = state === "running" && this.controllers.has(id) && !this.isStopping(id)
		if (state !== "queued" && !isCancellable) {
			return false
		}
		return visitor === undefined || this.store.admission.isOnlySubmitter(id, visitor)
	}

	stop(id: string): void {
		// remove waiting work or cancel the running inspection
		if (!this.store.stopQueued(id, stoppedMessage)) {
			this.store.admission.preventReuse(id)
			this.controllers.get(id)?.abort()
		}
	}
}
