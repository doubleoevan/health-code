import type { ViteDevServer } from "vite"
import { createServer } from "vite"
import { createLocalSiteRuntime } from "./createLocalSiteRuntime.ts"
import type { createSite } from "./createSite.tsx"

const runtime = createLocalSiteRuntime(process.env)
let vite: ViteDevServer

// Keep the worker alive while Vite invalidates edited routes and React components.
const backend = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	idleTimeout: 60,
	async fetch(request): Promise<Response> {
		// Accept live submissions only from the local development origin.
		if (!runtime.replay && request.method === "POST" && request.headers.get("origin") !== runtime.origin) {
			return new Response("Submit from the local Health Code page.", { status: 403 })
		}

		// reload the routes for each development request
		const routes = (await vite.ssrLoadModule("/src/server/createSite.tsx")) as { createSite: typeof createSite }
		const app = routes.createSite({
			...runtime,
			assets: { script: "/src/client/client.tsx", styles: ["/src/client/style.css"] },
		})
		const response = await app.fetch(request)
		if (!response.headers.get("Content-Type")?.includes("text/html")) {
			return response
		}

		// Inject the same refresh runtime into direct visits and restored report pages.
		const html = await vite.transformIndexHtml(new URL(request.url).pathname, await response.text())
		return new Response(html, response)
	},
})

// forward backend routes while serving frontend modules through vite
vite = await createServer({
	appType: "custom",
	ssr: { external: ["health-code"] },
	server: {
		host: runtime.replay ? "127.0.0.1" : "localhost",
		port: runtime.port,
		strictPort: true,
		fs: {
			allow: [
				new URL("../..", import.meta.url).pathname,
				new URL("../../../../node_modules", import.meta.url).pathname,
			],
		},
		proxy: { "^/(?:$|\\?|r/|api/|admin(?:$|\\?|/)|health/|patches/)": { target: backend.url.origin } },
	},
})

// Claim the development port before recovering jobs in its sandbox namespace.
await vite.listen()
void runtime.inspections.start()
console.info(`Health Code listening at ${runtime.origin}`)
