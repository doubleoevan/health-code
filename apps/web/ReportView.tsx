import type { ReactElement } from "react"
import { ReportActions } from "./ReportActions.tsx"
import { Link, UpgradeMenuLink } from "./ReportControls.tsx"
import { type PublishedReport, toReportHeading, toSummary } from "./report.ts"
import { UpgradeView } from "./UpgradeView.tsx"

export function ReportView({
	report,
	url,
	durationMs,
	upgradeMenuId,
	investigationPrompt,
}: {
	report: PublishedReport
	url: string
	durationMs?: number
	upgradeMenuId?: string
	investigationPrompt?: string
}): ReactElement {
	return (
		<>
			{/* link back, inspection summary and coding agent handoff */}
			<header className="inspection-heading">
				<UpgradeMenuLink id={upgradeMenuId} repositoryUrl={report.repository.url} />
				<h1>{toReportHeading(report)}</h1>
				<p>{toSummary(report)}</p>
				{durationMs !== undefined && <p>Inspection time · {toDuration(durationMs)}</p>}
				<ReportActions report={report} url={url} investigationPrompt={investigationPrompt} />
			</header>
			{report.stoppedReason && <p>{report.stoppedReason}</p>}

			{/* project type */}
			{report.detection && (
				<p role="status">
					Health Code inspects JavaScript and TypeScript projects. Project detection · {report.detection}
				</p>
			)}

			{/* publication scope */}
			{!report.license && (
				<p>Findings only. GitHub could not confirm an OSI-approved license at the inspected commit.</p>
			)}

			{/* per-dependency results */}
			<section>
				<div className="section-heading">
					<h2>Dependency upgrades</h2>
					<Link href={`${report.repository.url}/tree/${report.repository.commit}`}>
						{report.repository.url.slice(19)} · {report.repository.commit.slice(0, 8)}
					</Link>
				</div>
				{report.upgrades.filter((upgrade) => upgrade.patches.length > 0).length > 1 && (
					<p>Each upgrade was tested separately. If you combine patches, rerun your typecheck and tests.</p>
				)}
				{report.registryLookupIssue && report.upgrades.length > 0 && <p>{report.registryLookupIssue}</p>}
				{report.upgrades.map((upgrade) => (
					<UpgradeView key={upgrade.dependency + upgrade.to} upgrade={upgrade} repositoryUrl={report.repository.url} />
				))}
				{report.upgrades.length === 0 && !report.registryLookupIssue && !report.stoppedReason && (
					<p>No upgrades inspected.</p>
				)}
			</section>

			{/* eligible targets outside the inspection limit */}
			{Boolean(report.omitted?.length) && (
				<details>
					<summary>Outside the upgrade limit ({report.omitted?.length})</summary>
					<ul>
						{report.omitted?.map((name) => (
							<li key={name}>{name}</li>
						))}
					</ul>
				</details>
			)}
		</>
	)
}

// show whole minutes and seconds
function toDuration(milliseconds: number): string {
	const seconds = Math.round(milliseconds / 1000)
	const minutes = Math.floor(seconds / 60)
	return minutes ? `${minutes} min ${seconds % 60} sec` : `${seconds} sec`
}
