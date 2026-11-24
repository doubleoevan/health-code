import { renderToStaticMarkup, renderToString } from "react-dom/server"
import { Page, type PageProps } from "../client/Page.tsx"
import { toSummary } from "../report.ts"

export type Assets = { script: string; styles: string[] }

/**
 * Renders the HTML document for one page with its link previews and hydration state.
 */
export function renderPage(props: PageProps, assets: Assets): string {
	// describe the inspected revision in the page metadata
	const report = props.snapshot?.card
	const title = props.upgradeMenu
		? "Health Code · Try an upgrade"
		: report
			? `Health Code: ${toSummary(report)}`
			: "Health Code · Dependency inspections"
	const description = report
		? `Dependency upgrade evidence for ${report.repository.url} at ${report.repository.commit.slice(0, 8)}.`
		: "Try dependency upgrades in a Runta sandbox."
	const head = renderToStaticMarkup(
		<head>
			{/* document metadata and canonical address */}
			<meta charSet="utf-8" />
			<link rel="icon" type="image/svg+xml" href="/assets/favicon.svg" />
			<meta name="viewport" content="width=device-width,initial-scale=1" />
			<title>{title}</title>
			<link rel="canonical" href={props.url} />

			{/* link previews */}
			<meta property="og:type" content="website" />
			<meta property="og:title" content={title} />
			<meta property="og:description" content={description} />
			<meta property="og:url" content={props.url} />
			<meta name="twitter:card" content="summary" />
			<meta name="twitter:title" content={title} />
			<meta name="twitter:description" content={description} />

			{/* page stylesheets */}
			{assets.styles.map((style) => (
				<link key={style} rel="stylesheet" href={style} />
			))}
		</head>,
	)

	// Escape the script closing delimiter in repository-controlled text.
	const state = JSON.stringify(props).replaceAll("<", "\\u003c")
	return `<!doctype html><html lang="en">${head}<body><div id="app">${renderToString(<Page {...props} />)}</div><script id="page-state" type="application/json">${state}</script><script type="module" src="${assets.script}"></script></body></html>`
}
