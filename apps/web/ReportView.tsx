import type { ReactElement } from "react"
import { PromptVersions } from "./PromptVersions.tsx"
import { ReportActions } from "./ReportActions.tsx"
import { Link } from "./ReportControls.tsx"
import { mcpSetupUrl, type PublishedReport, toSummary } from "./report.ts"
import { TestFileErrors, UpgradeView } from "./UpgradeView.tsx"

export function ReportView({
	report,
	url,
	investigationPrompt,
}: {
	report: PublishedReport
	url: string
	investigationPrompt?: string
}): ReactElement {
	return (
		<>
			{/* inspection summary and sharing controls */}
			<header className="inspection-heading">
				<h1>Inspection complete</h1>
				<p>{toSummary(report)}</p>
				<ReportActions report={report} url={url} investigationPrompt={investigationPrompt} />
			</header>
			{report.stoppedReason && <p>{report.stoppedReason}</p>}

			{/* inspected revision and project type */}
			<p>
				<Link href={`${report.repository.url}/tree/${report.repository.commit}`}>
					{report.repository.url.slice(19)} · {report.repository.commit.slice(0, 8)}
				</Link>
			</p>
			{report.detection && (
				<p role="status">
					Health Code inspects JavaScript and TypeScript projects. Project detection · {report.detection}
				</p>
			)}

			{/* runtime usage cutoff */}
			{report.usageAsOf && (
				<details>
					<summary>Usage details</summary>
					<p>
						Usage measured through{" "}
						<time dateTime={report.usageAsOf}>
							{report.usageAsOf.replace("T", " ").replace(/(?:\.\d+)?Z$/, " UTC")}
						</time>
					</p>
				</details>
			)}

			{/* baseline checks */}
			<details>
				<summary>Checks before the upgrade</summary>
				<dl>
					{Object.entries(report.baseline).map(([name, status]) => (
						<div key={name}>
							<dt>{name}</dt>
							<dd>{status}</dd>
						</div>
					))}
					<TestFileErrors errors={report.baselineTestFileErrors} />
				</dl>
			</details>
			<PromptVersions versions={report.promptVersions} />

			{/* agent turn limits */}
			{report.turnLimits && (
				<details>
					<summary>Turn limit</summary>
					<dl>
						<dt>Repair</dt>
						<dd>{report.turnLimits.repair}</dd>
						<dt>Feature adoption</dt>
						<dd>{report.turnLimits.featureAdoption}</dd>
					</dl>
				</details>
			)}

			{/* publication scope */}
			{!report.license && (
				<p>Findings only. GitHub could not confirm an OSI-approved license at the inspected commit.</p>
			)}

			{/* per-dependency results */}
			<section>
				<h2>Dependency upgrades</h2>
				{report.upgrades.filter((upgrade) => upgrade.patches.length > 0).length > 1 && (
					<p>Each upgrade was tested separately. If you combine patches, rerun your typecheck and tests.</p>
				)}
				{report.registryLookupIssue && report.upgrades.length > 0 && <p>{report.registryLookupIssue}</p>}
				{report.upgrades.map((upgrade) => (
					<UpgradeView key={upgrade.dependency + upgrade.to} upgrade={upgrade} />
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

			{/* local inspection setup */}
			<section>
				<h2>Continue in Claude Code or Codex</h2>
				<p>
					<Link href={mcpSetupUrl}>Health Code MCP setup</Link> ·{" "}
					<Link href="https://dashboard.runta.com/">Sign up for Runta</Link>
				</p>
			</section>
		</>
	)
}
