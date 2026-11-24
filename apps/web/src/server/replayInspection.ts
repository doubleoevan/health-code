import type { InspectionReportV2, UpgradeFeatures } from "health-code"
import { replayRepositoryUrl, type SiteEvent } from "../report.ts"
import { type InspectionSource, SiteError } from "./inspectionSource.ts"
import type { RepositoryHead } from "./recordAdmissions.ts"

// Use the fixture URL to prevent a recording being attributed to another repository.
const recording = new URL("./fixtures/recorded/inspection-report-v2.json", import.meta.url)

export function createReplaySource(
	sleep: (milliseconds: number) => Promise<void> = Bun.sleep,
): InspectionSource<{ report: InspectionReportV2 }> {
	return {
		async recover(): Promise<number> {
			return 0
		},
		async verify(url: string): Promise<void> {
			if (url !== replayRepositoryUrl) {
				throw new SiteError(`Replay uses ${replayRepositoryUrl}. Paste that URL to inspect the recording.`)
			}
		},
		async resolve(url): Promise<RepositoryHead> {
			await this.verify(url)
			const report: InspectionReportV2 = await Bun.file(recording).json()
			return { repositoryId: "fixture", revision: report.repository.commit, sizeKiB: 1 }
		},
		async features(target): Promise<UpgradeFeatures> {
			// Use the recorded release notes for this exact replay target.
			const report: InspectionReportV2 = await Bun.file(recording).json()
			const upgrade = report.upgrades.find((item) => item.dependency === target.dependency && item.to === target.to)
			const source = upgrade?.releaseSummary.sources[0]
			if (!source || !upgrade) {
				return { features: [], sources: [], gaps: ["No recorded release notes"] }
			}
			return {
				features: [{ text: upgrade.releaseSummary.text, source, workspaces: Object.keys(target.from) }],
				sources: [source],
				gaps: [],
			}
		},
		async license(): Promise<string> {
			return "MPL-2.0"
		},
		async inspect(
			_url: string,
			emit: (event: SiteEvent) => void,
			options = {},
		): Promise<{ report: InspectionReportV2 }> {
			// align the recording's first event with the start of this replay
			const report: InspectionReportV2 = await Bun.file(recording).json()
			if (options.mode === "listUpgrades") {
				report.selection = { ...report.selection, mode: "listUpgrades", selected: [], omitted: [] }
				report.upgrades = []
				const untested = { status: "untested" as const, reason: "discovery-only", evidence: [] }
				report.baseline = { install: untested, typecheck: untested, tests: untested }
				report.runtimeUsage = {
					usageAsOf: new Date().toISOString(),
					modelCostUsd: 0,
					modelReservedUsd: 0,
					totalUpperBoundUsd: 0,
					runtimes: [],
				}

				// Replay setup and the registry lookup through sandbox teardown.
				const boundary = report.timeline.findIndex(
					(event) => event.type === "step.finished" && event.summary === "registry",
				)
				report.timeline = report.timeline.filter(
					(event, index) =>
						index <= boundary ||
						(event.type === "sandbox.event" && event.action === "deleted") ||
						event.type === "inspection.finished",
				)

				// Restore consecutive replay cursors after omitting the upgrade checks.
				for (const [index, event] of report.timeline.entries()) {
					event.sequence = index + 1
					if (event.type === "inspection.finished") {
						event.inspected = 0
					}
				}
			}

			// Keep targeted replay tied to a version present in the recording.
			if (
				options.upgrade &&
				!report.upgrades.some(
					(target) => target.dependency === options.upgrade?.dependency && target.to === options.upgrade.to,
				)
			) {
				throw new SiteError("This target is unavailable in the recording.")
			}

			// Replay the steps belonging to the chosen operation.
			const first = Date.parse(report.timeline[0]?.timestamp ?? "")
			let previous = first
			const start = Date.now()

			// preserve the intervals between recorded events
			for (const event of report.timeline) {
				const time = Date.parse(event.timestamp)
				await sleep(Math.max(0, time - previous))
				options.signal?.throwIfAborted()

				// shift the event to the start of this replay
				event.timestamp = new Date(start + time - first).toISOString()
				emit(event)
				previous = time
			}
			return { report }
		},
	}
}
