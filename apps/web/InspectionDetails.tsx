import type { ReactElement, ReactNode } from "react"
import type { PublishedReport } from "./report.ts"
import { CheckOutcome, TestFileErrorList } from "./UpgradeView.tsx"

export function InspectionDetails({ report }: { report: PublishedReport }): ReactElement {
	const { baseline, baselineTestFileErrors } = report
	return (
		<section>
			<h2>Inspection details</h2>
			<table>
				{/* baseline checks */}
				<tbody>
					<tr>
						<th colSpan={2} scope="rowgroup">
							Checks before the upgrade
						</th>
					</tr>
					<Row label="Install">
						<CheckOutcome text={baseline.install} />
					</Row>
					<Row label="Typecheck">
						<CheckOutcome text={baseline.typecheck} />
					</Row>
					<Row label="Tests">
						<CheckOutcome text={baseline.tests} />
					</Row>
					{baselineTestFileErrors && (
						<Row label="Test file errors">
							<TestFileErrorList errors={baselineTestFileErrors} />
						</Row>
					)}
				</tbody>
			</table>
		</section>
	)
}

function Row({ label, children }: { label: string; children: ReactNode }): ReactElement {
	return (
		<tr>
			<th scope="row">{label}</th>
			<td>{children}</td>
		</tr>
	)
}
