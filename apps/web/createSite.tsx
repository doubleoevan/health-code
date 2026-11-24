import { InspectionError, toFeaturePage, toRepositoryUrl, toUpgradeMenu, type UpgradeMenuTarget } from "health-code"
import { type Context, Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { HTTPException } from "hono/http-exception"
import { renderToStaticMarkup, renderToString } from "react-dom/server"
import { adminPage } from "./adminPage.tsx"
import { buildReportInvestigationPrompt } from "./buildReportInvestigationPrompt.ts"
import type { Inspections } from "./executeInspection.ts"
import type { InspectionChoice } from "./inspectionSource.ts"
import { SiteError } from "./inspectionSource.ts"
import { Page, type PageProps } from "./Page.tsx"
import { AdmissionError, toUtcDay, type Visitor } from "./recordAdmissions.ts"
import { mcpSetupUrl, toSummary } from "./report.ts"
import { streamInspection } from "./streamInspection.ts"
import { identifyVisitor, isSecureRequest, verifyAdmin } from "./verifyVisitor.ts"

type Assets = { script: string; styles: string[] }
function render(props: PageProps, assets: Assets): string {
	// describe the inspected revision in the page metadata
	const report = props.snapshot?.card
	const title = props.upgradeMenu
		? "Health Code · Test an upgrade"
		: report
			? `Health Code: ${toSummary(report)}`
			: "Health Code · Dependency inspections"
	const description = report
		? `Dependency upgrade evidence for ${report.repository.url} at ${report.repository.commit.slice(0, 8)}.`
		: "Watch dependency upgrades being tested in a Runta sandbox."
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

type Submission = {
	repositoryUrl: string
	challenge?: unknown
	action?: unknown
	upgradeMenuId?: unknown
	menuId?: unknown
	dependency?: unknown
	to?: unknown
}

function resolveChoice(input: Submission, inspections: Inspections): InspectionChoice & { readyId?: string } {
	if (input.action === undefined) {
		return {}
	}
	if (input.action === "discover") {
		return { mode: "listUpgrades" }
	}
	const upgradeMenuId = input.upgradeMenuId ?? input.menuId
	if (
		input.action !== "select" ||
		typeof upgradeMenuId !== "string" ||
		(input.menuId !== undefined && input.menuId !== upgradeMenuId)
	) {
		throw new SiteError("Choose an upgrade from the upgrade menu.")
	}

	// Resolve the exact version against the server's saved upgrade menu.
	const report = inspections.store.snapshot(upgradeMenuId)?.card
	const target = report?.upgradeMenu?.find((item) => item.dependency === input.dependency && item.to === input.to)
	if (
		!report ||
		!target ||
		report.repository.url.toLowerCase() !== toRepositoryUrl(input.repositoryUrl).toLowerCase()
	) {
		throw new SiteError("Choose an available dependency and version from this repository’s upgrade menu.")
	}
	return {
		readyId: inspections.launch ? undefined : target.patch?.inspectionId,
		revision: report.repository.commit,
		upgrade: { dependency: target.dependency, from: target.from, to: target.to },
	}
}

function isChoiceField(value: unknown, maximum: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= maximum
}

function readFeatureQuery(context: Context): { dependency: string; to: string; offset: number } | undefined {
	const { dependency, to } = context.req.query()
	const offset = Number(context.req.query("offset") ?? "0")
	if (Number.isSafeInteger(offset) && offset >= 0 && isChoiceField(dependency, 214) && isChoiceField(to, 256)) {
		return { dependency, to, offset }
	}
}

function toUpgradeMenuView(
	targets: UpgradeMenuTarget[] | undefined,
	query: Record<string, string>,
): NonNullable<PageProps["upgradeMenu"]>["view"] | undefined {
	if (!targets) {
		return undefined
	}

	// Keep search and sorting in the upgrade menu URL across reloads and browser navigation.
	const order = query.order === "alphabetical" || query.order === "minor" ? query.order : "workspaces"
	const search = query.search?.slice(0, 256) ?? ""
	const hasTestedPatch = targets.some((target) => target.patch)
	const readyOnly = hasTestedPatch && query.ready === "on"
	const groups = toUpgradeMenu(targets, { order, search, readyOnly })

	// Paginate after sorting and filtering the full dependency list.
	const dependenciesPerPage = 5
	const pages = Math.max(1, Math.ceil(groups.length / dependenciesPerPage))
	const requested = Number(query.page)
	const page = Number.isSafeInteger(requested) ? Math.min(pages, Math.max(1, requested)) : 1
	return {
		order,
		search,
		hasTestedPatch,
		readyOnly,
		available: targets.length > 0,
		totalDependencies: groups.length,
		firstDependencyNumber: (page - 1) * dependenciesPerPage + 1,
		dependenciesOnPage: groups.slice((page - 1) * dependenciesPerPage, page * dependenciesPerPage),
		page,
		pages,
	}
}

async function readSubmission(context: Context): Promise<Submission | null> {
	const body: unknown = await context.req.json().catch(() => null)
	if (!body || typeof body !== "object" || !("repositoryUrl" in body) || typeof body.repositoryUrl !== "string") {
		return null
	}
	return { ...body, repositoryUrl: body.repositoryUrl }
}

function admissionFailure(context: Context, error: unknown, key?: string): Response {
	if (error instanceof AdmissionError) {
		return context.json(
			{
				message: error.message,
				...(error.status === 403 ? { siteKey: key } : {}),
				...(error.cap || error.status === 503 ? { mcpSetupUrl } : {}),
			},
			error.status,
		)
	}
	if (error instanceof SiteError) {
		return context.json({ message: error.message }, 400)
	}

	// translate queue and input failures into client responses
	if (error instanceof InspectionError && error.code === "queue-full") {
		return context.json({ message: error.message }, 429)
	}
	if (error instanceof InspectionError && error.code === "invalid-repository") {
		return context.json({ message: "Enter a public GitHub URL like https://github.com/owner/repository." }, 400)
	}
	throw error
}

export function createSite(options: {
	inspections: Inspections
	origin: string
	replay: boolean
	assets: Assets
}): Hono {
	const { inspections, replay, assets } = options
	const app = new Hono()

	// Keep external response bodies and request headers out of error logs.
	app.onError((error, context) =>
		error instanceof HTTPException
			? error.getResponse()
			: context.json({ message: "The service could not complete this request." }, 500),
	)
	const launch = inspections.launch
	const siteMode = replay ? "replay" : launch ? "hosted" : "local"
	const hostname = new URL(options.origin).hostname
	function visitor(context: Context): Visitor {
		if (!launch) {
			throw new Error("Missing visitor configuration")
		}
		const { cookie, identity } = identifyVisitor(context.req.raw, launch.visitorKey, replay)
		context.header(
			"Set-Cookie",
			`hc_visitor=${cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${replay ? "" : "; Secure"}`,
		)
		return identity
	}
	function readDemoCallsLeft(context: Context): number | undefined {
		if (siteMode !== "hosted" || !launch?.configured || !launch.settings.available) {
			return undefined
		}

		// Read the allowance without assigning a visitor cookie.
		try {
			const { identity } = identifyVisitor(context.req.raw, launch.visitorKey, replay)
			return inspections.store.admission.countRemainingInspections(identity, launch.settings.current, toUtcDay())
		} catch {
			// Keep pages available when visitor identity is unavailable.
			return undefined
		}
	}
	app.get("/health/live", (context) => context.json({ live: true }))
	app.get("/health/ready", (context) => {
		try {
			// Keep archived reports routable while paid admissions wait for recovery.
			inspections.store.database.query("SELECT id FROM inspections LIMIT 1").get()
			return context.json({ ready: true, recovered: inspections.recovered })
		} catch {
			return context.json({ ready: false }, 503)
		}
	})
	app.use("/admin/*", async (context, next) => {
		context.header("Cache-Control", "private, no-store")
		if (!isSecureRequest(context.req.raw, options.origin)) {
			return context.text("Use HTTPS to access administration.", 403)
		}
		if (!verifyAdmin(context.req.raw, launch?.adminPassword, options.origin)) {
			context.header("WWW-Authenticate", 'Basic realm="Health Code admin", charset="UTF-8"')
			return context.text("Authentication required", 401)
		}
		await next()
	})
	app.get("/admin", (context) => context.html(adminPage(inspections.store.admission, launch?.settings.updated ?? null)))
	app.post("/api/inspections/:id/view", (context) => {
		if (
			!launch ||
			context.req.header("origin") !== options.origin ||
			context.req.header("Authorization") ||
			/bot|crawler|preview|spider/i.test(context.req.header("user-agent") ?? "") ||
			!context.req.header("cookie")?.includes("hc_visitor=")
		) {
			return context.body(null, 204)
		}
		const identity = visitor(context)
		inspections.store.admission.view(context.req.param("id"), identity.visitor)
		return context.body(null, 204)
	})
	app.get("/", (context) => {
		context.header("Cache-Control", "no-store")
		const demoCallsLeft = readDemoCallsLeft(context)
		return context.html(
			render({ url: options.origin, siteMode, demoCallsLeft, snapshot: null, paused: inspections.paused }, assets),
		)
	})

	// accept bounded repository submissions
	app.post("/api/inspections", bodyLimit({ maxSize: 4096 }), async (context) => {
		const type = context.req.header("Content-Type")?.split(";")[0]?.trim().toLowerCase()
		if (type !== "application/json") {
			return context.json({ message: "Send the repository URL as JSON." }, 415)
		}

		// Accept public paid submissions only through the configured site hostname.
		if (launch && !replay && new URL(context.req.url).host !== new URL(options.origin).host) {
			return context.json({ message: "Submit this repository on the Health Code site." }, 403)
		}
		const input = await readSubmission(context)
		if (!input) {
			return context.json({ message: "Enter a public GitHub URL like https://github.com/owner/repository." }, 400)
		}

		// return a report location as soon as the inspection is queued
		try {
			const { readyId, ...choice } = resolveChoice(input, inspections)
			if (readyId) {
				context.header("Location", `/r/${readyId}`)
				return context.json({ id: readyId }, 200)
			}

			// Reserve the selected job under the normal visitor and spending limits.
			const { id, reused } = launch
				? await inspections.admit(
						input.repositoryUrl,
						{
							identify: () => visitor(context),
							challenge: input.challenge,
							hostname,
						},
						choice,
					)
				: { id: inspections.submit(input.repositoryUrl, choice), reused: false }
			context.header("Location", `/r/${id}`)
			return context.json({ id }, reused ? 200 : 202)
		} catch (error) {
			return admissionFailure(context, error, launch?.challengeKey)
		}
	})

	// render the latest snapshot on each visit to the report link
	app.get("/r/:id", (context) => {
		const id = context.req.param("id")
		const snapshot = inspections.store.snapshot(id)
		if (!snapshot) {
			return context.notFound()
		}
		context.header("Cache-Control", "no-store")
		if (launch && snapshot.card) {
			try {
				visitor(context)
			} catch {
				/* Report reads remain available when visitor identity is unavailable. */
			}
		}
		const report = snapshot.card
		const upgradeMenuView = toUpgradeMenuView(report?.upgradeMenu, context.req.query())
		const upgradeMenu =
			report && upgradeMenuView
				? {
						id,
						view: upgradeMenuView,
						commit: report.repository.commit,
						repositoryUrl: report.repository.url,
						issue: report.registryLookupIssue ?? report.stoppedReason ?? report.detection,
					}
				: undefined
		const url = `${options.origin}/r/${id}`
		snapshot.investigationPrompt = buildReportInvestigationPrompt(snapshot, url)
		const demoCallsLeft = readDemoCallsLeft(context)
		return context.html(
			render({ snapshot: upgradeMenu ? null : snapshot, upgradeMenu, siteMode, demoCallsLeft, url }, assets),
		)
	})

	// Load version-specific upstream features for each visible target on the dependency page.
	app.get("/api/inspections/:id/features", async (context) => {
		const query = readFeatureQuery(context)
		if (!query) {
			return context.json({ message: "Choose a dependency and version." }, 400)
		}
		const { dependency, to, offset } = query
		try {
			const features = await inspections.features({ upgradeMenuId: context.req.param("id"), dependency, to })
			context.header("Cache-Control", features.gaps.length ? "private, max-age=60" : "public, max-age=3600")
			return context.json(toFeaturePage(features, offset))
		} catch (error) {
			if (error instanceof SiteError || error instanceof AdmissionError) {
				return context.json({ message: error.message }, error instanceof SiteError ? 404 : error.status)
			}
			throw error
		}
	})

	// resume streaming after the last delivered event
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

	// serve recorded output for a single event
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

	// serve immutable patch downloads by verified digest
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
