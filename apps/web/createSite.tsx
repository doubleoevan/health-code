import { InspectionError } from "health-code"
import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { renderToStaticMarkup, renderToString } from "react-dom/server"
import type { Inspections } from "./executeInspection.ts"
import { Page, type PageProps } from "./Page.tsx"
import { toSummary } from "./report.ts"
import { streamInspection } from "./streamInspection.ts"

type Assets = { script: string; styles: string[] }
function render(props: PageProps, assets: Assets): string {
	const card = props.snapshot?.card
	const title = card ? `Health Code: ${toSummary(card)}` : "Health Code · Dependency inspections"
	const description = card
		? `Dependency upgrade evidence for ${card.repository.url} at ${card.repository.commit.slice(0, 8)}.`
		: "Watch dependency upgrades being tested in a Runta sandbox."
	const head = renderToStaticMarkup(
		<head>
			<meta charSet="utf-8" />
			<meta name="viewport" content="width=device-width,initial-scale=1" />
			<title>{title}</title>
			<link rel="canonical" href={props.url} />
			<meta property="og:type" content="website" />
			<meta property="og:title" content={title} />
			<meta property="og:description" content={description} />
			<meta property="og:url" content={props.url} />
			<meta name="twitter:card" content="summary" />
			<meta name="twitter:title" content={title} />
			<meta name="twitter:description" content={description} />
			{assets.styles.map((style) => (
				<link key={style} rel="stylesheet" href={style} />
			))}
		</head>,
	)
	// Escape the script closing delimiter in repository-controlled text.
	const state = JSON.stringify(props).replaceAll("<", "\\u003c")
	return `<!doctype html><html lang="en">${head}<body><div id="app">${renderToString(<Page {...props} />)}</div><script id="page-state" type="application/json">${state}</script><script type="module" src="${assets.script}"></script></body></html>`
}

export function createSite(options: {
	inspections: Inspections
	origin: string
	replay: boolean
	assets: Assets
}): Hono {
	const { inspections, replay, assets } = options
	const app = new Hono()
	app.get("/", (context) => context.html(render({ url: options.origin, replay, snapshot: null }, assets)))
	app.post("/api/inspections", bodyLimit({ maxSize: 1024 }), async (context) => {
		const type = context.req.header("Content-Type")?.split(";")[0]?.trim().toLowerCase()
		if (type !== "application/json") {
			return context.json({ message: "Send the repository URL as JSON." }, 415)
		}
		const input: unknown = await context.req.json().catch(() => null)
		if (!input || typeof input !== "object" || !("repositoryUrl" in input) || typeof input.repositoryUrl !== "string") {
			return context.json({ message: "Enter a public GitHub URL like https://github.com/owner/repository." }, 400)
		}
		try {
			const id = inspections.submit(input.repositoryUrl)
			context.header("Location", `/r/${id}`)
			return context.json({ id }, 202)
		} catch (error) {
			if (error instanceof InspectionError && error.code === "queue-full") {
				return context.json({ message: error.message }, 429)
			}
			if (error instanceof InspectionError && error.code === "invalid-repository") {
				return context.json({ message: "Enter a public GitHub URL like https://github.com/owner/repository." }, 400)
			}
			throw error
		}
	})
	app.get("/r/:id", (context) => {
		const id = context.req.param("id")
		const snapshot = inspections.store.snapshot(id)
		if (!snapshot) {
			return context.notFound()
		}
		context.header("Cache-Control", "no-store")
		return context.html(render({ snapshot, replay, url: `${options.origin}/r/${id}` }, assets))
	})
	app.get("/api/inspections/:id/events", (context) => {
		const id = context.req.param("id")
		if (!inspections.store.state(id)) {
			return context.notFound()
		}
		const input = context.req.header("Last-Event-ID") ?? context.req.query("after") ?? "0"
		if (!/^\d{1,15}$/.test(input)) {
			return context.text("Invalid event cursor", 400)
		}
		return streamInspection({ inspections, id, after: Number(input), signal: context.req.raw.signal })
	})
	app.get("/api/inspections/:id/details/:sequence", (context) => {
		const sequence = context.req.param("sequence")
		if (!/^[1-9]\d{0,14}$/.test(sequence)) {
			return context.notFound()
		}
		const text = inspections.store.detail(context.req.param("id"), Number(sequence))
		if (text === null) {
			return context.notFound()
		}
		context.header("X-Content-Type-Options", "nosniff")
		return context.text(text)
	})
	app.get("/patches/:file", (context) => {
		const digest = /^([0-9a-f]{64})\.patch$/.exec(context.req.param("file"))?.[1]
		const bytes = digest && inspections.store.patch(digest)
		if (!bytes) {
			return context.notFound()
		}
		return new Response(new Uint8Array(bytes), {
			headers: {
				"Content-Type": "application/octet-stream",
				"Content-Disposition": `attachment; filename="${digest}.patch"`,
				"Cache-Control": "public,max-age=31536000,immutable",
				"X-Content-Type-Options": "nosniff",
			},
		})
	})
	return app
}
