import type { InspectionOptionsV2, Upgrade, UpgradeFeatures, UpgradeMenu } from "health-code"
import type { SiteEvent } from "../report.ts"
import type { LaunchLimits } from "./launchLimits.ts"
import type { InspectionOutput } from "./publishReport.ts"
import type { RepositoryHead } from "./recordAdmissions.ts"

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

	// the upgrade menu built without a sandbox, and the GitHub requests left this hour
	upgradeMenu?(
		repositoryUrl: string,
		options: {
			revision?: string
			maxRegistryResponseMiB?: number
			maxMemoryMiB?: number
			onEvent: (event: SiteEvent) => void
		},
	): Promise<UpgradeMenu>
	githubQuota?(): { remaining: number; resetAt: number } | undefined
	inspect(repositoryUrl: string, emit: (event: SiteEvent) => void, options?: DispatchOptions): Promise<Output>
	license(repository: { url: string; commit: string }): Promise<string | null>
	recover(options?: { liveInspectionIds: ReadonlySet<string>; createdBefore: number }): Promise<number>
	maxDurationMs?: number
}
