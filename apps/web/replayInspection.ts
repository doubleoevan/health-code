import type { InspectionReportV2 } from "health-code"
import { type InspectionSource, SiteError } from "./executeInspection.ts"
import type { RepositoryHead } from "./recordAdmissions.ts"
import { replayRepositoryUrl, type SiteEvent } from "./report.ts"

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
		async license(): Promise<string> {
			return "MPL-2.0"
		},
		async inspect(_url: string, emit: (event: SiteEvent) => void): Promise<{ report: InspectionReportV2 }> {
			// align the recording's first event with the start of this replay
			const report: InspectionReportV2 = await Bun.file(recording).json()
			const first = Date.parse(report.timeline[0]?.timestamp ?? "")
			let previous = first
			const start = Date.now()

			// preserve the intervals between recorded events
			for (const event of report.timeline) {
				const time = Date.parse(event.timestamp)
				await sleep(Math.max(0, time - previous))
				event.timestamp = new Date(start + time - first).toISOString()
				emit(event)
				previous = time
			}
			return { report }
		},
	}
}
