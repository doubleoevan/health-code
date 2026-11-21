import { renderToStaticMarkup } from "react-dom/server"
import type { AdmissionLedger } from "./recordAdmissions.ts"

function toRateLabel(numerator: number, denominator: number): string {
	return denominator ? `${numerator}/${denominator} (${Math.round((100 * numerator) / denominator)}%)` : "—"
}

export function adminPage(ledger: AdmissionLedger, updated: string | null): string {
	const rows = ledger.daily()
	const usd = (micros: number): string => `$${(micros / 1e6).toFixed(2)}`
	return (
		"<!doctype html>" +
		renderToStaticMarkup(
			<html lang="en">
				<head>
					<title>Health Code administration</title>
					<meta name="viewport" content="width=device-width,initial-scale=1" />
				</head>
				<body>
					<main>
						<h1>Daily inspection activity</h1>
						<p>UTC. Limits refreshed {updated ?? "pending"}.</p>
						<table>
							<thead>
								<tr>
									{[
										"Day",
										"Starts",
										"Cache hits",
										"Visitor / budget cap hits",
										"Shared / completed",
										"Viewers who started an inspection (7 days)",
										"Model cost",
										"Sandbox upper bound",
										"Settled upper bound",
										"Pending holds",
									].map((label) => (
										<th key={label}>{label}</th>
									))}
								</tr>
							</thead>
							<tbody>
								{rows.map((row) => {
									const count: Record<string, number> = JSON.parse(row.counts ?? "{}")
									const immature = Date.parse(`${row.day}T00:00:00Z`) + 8 * 86400000 > Date.now()
									return (
										<tr key={row.day}>
											<td>{row.day}</td>
											<td>{count.starts ?? 0}</td>
											<td>{count.cache ?? 0}</td>
											<td>
												{count.visitorHits ?? 0} / {count.budgetHits ?? 0}
											</td>
											<td>{toRateLabel(count.shared ?? 0, row.completed)}</td>
											<td>
												{toRateLabel(count.converted ?? 0, count.viewers ?? 0)} {immature ? "(open)" : ""}
											</td>
											<td>{usd(row.modelMicros)}</td>
											<td>{usd(row.sandboxUpperMicros)}</td>
											<td>{usd(row.settledUpperMicros)}</td>
											<td>{usd(row.pendingMicros)}</td>
										</tr>
									)
								})}
							</tbody>
						</table>
					</main>
				</body>
			</html>,
		)
	)
}
