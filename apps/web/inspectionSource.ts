import type { InspectionOptionsV2, Upgrade, UpgradeFeatures } from "health-code"
import type { LaunchLimits } from "./launchLimits.ts"
import type { InspectionOutput } from "./publishReport.ts"
import type { RepositoryHead } from "./recordAdmissions.ts"
import type { SiteEvent } from "./report.ts"

export class SiteError extends Error {}
export type InspectionChoice = Pick<InspectionOptionsV2, "mode" | "revision" | "upgrade">
type DispatchOptions = InspectionChoice & {
	reuseUpgrade?: InspectionOptionsV2["reuseUpgrade"]
	settings?: LaunchLimits
	signal?: AbortSignal
}

// Bind hosted work to the checkout verified at admission.
export interface InspectionSource<Output extends InspectionOutput = InspectionOutput> {
	verify(repositoryUrl: string, admission?: { repositoryId: string; maxSizeKiB: number }): Promise<void>

	// Bind the checkout to the revision selected at admission.
	resolve?(repositoryUrl: string): Promise<RepositoryHead>
	features?(upgrade: Upgrade): Promise<UpgradeFeatures>
	inspect(repositoryUrl: string, emit: (event: SiteEvent) => void, options?: DispatchOptions): Promise<Output>
	license(repository: { url: string; commit: string }): Promise<string | null>
	recover(options?: { liveInspectionIds: ReadonlySet<string>; createdBefore: number }): Promise<number>
	maxDurationMs?: number
}
