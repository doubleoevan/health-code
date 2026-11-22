import { toPinnedUpgradeKey, type Upgrade, type UpgradeFeatures } from "health-code"
import { AdmissionError } from "./recordAdmissions.ts"

export class ReleaseFeatureCache {
	private readonly active = new Map<string, Promise<UpgradeFeatures>>()
	private readonly saved = new Map<string, { expires: number; features: UpgradeFeatures }>()
	constructor(private readonly now: () => number = Date.now) {}

	async read(target: Upgrade, load: (target: Upgrade) => Promise<UpgradeFeatures>): Promise<UpgradeFeatures> {
		const key = toPinnedUpgradeKey(target)
		const saved = this.saved.get(key)
		if (saved && saved.expires > this.now()) {
			return saved.features
		}

		// Join the existing lookup before claiming an upstream request slot.
		const active = this.active.get(key)
		if (active) {
			return active
		}
		if (this.active.size >= 8) {
			throw new AdmissionError(503, "Release notes are busy. Try again shortly.")
		}

		// Share one pending upstream request across visitors.
		const request = load(target)
			.then((features) => {
				this.saved.delete(key)
				if (canRetain(features, key)) {
					// Evict in insertion order before retaining another package.
					if (this.saved.size >= 64) {
						const oldest = this.saved.keys().next()
						if (!oldest.done) {
							this.saved.delete(oldest.value)
						}
					}

					// Retry incomplete notes sooner than a fully documented release.
					const lifetime = features.gaps.length ? 60000 : 3600000
					this.saved.set(key, { features, expires: this.now() + lifetime })
				}
				return features
			})
			.finally(() => this.active.delete(key))

		// Publish the in-flight lookup before another visitor requests the same target.
		this.active.set(key, request)
		return request
	}
}

function canRetain(preview: UpgradeFeatures, key: string): boolean {
	// Count shared workspace lists once without materializing a serialized preview.
	const workspaces = new Set(preview.features.map((feature) => feature.workspaces))
	let size = key.length + preview.sources.join("").length + preview.gaps.join("").length
	for (const group of workspaces) {
		for (const name of group) {
			size += name.length + 8
		}
	}

	// Allow for string storage and per-entry overhead within a bounded cache.
	for (const feature of preview.features) {
		size += feature.text.length + feature.source.length + 64
	}
	return size <= 65536
}
