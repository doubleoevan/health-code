import type { ViteDevServer } from "vite"
import { createServer } from "vite"
import type { createSite } from "./createSite.tsx"
import { startInspections } from "./startInspections.ts"

const options = await startInspections()
let vite: ViteDevServer

// Keep the worker alive while Vite invalidates edited routes and React components.
const backend = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	idleTimeout: 60,
	async fetch(request): Promise<Response> {
		// reload the routes for each development request
		const routes = (await vite.ssrLoadModule("/createSite.tsx")) as { createSite: typeof createSite }
		const app = routes.createSite({ ...options, assets: { script: "/client.tsx", styles: ["/style.css"] } })
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
		host: "127.0.0.1",
		port: options.port,
		strictPort: true,
		fs: { allow: [import.meta.dir, new URL("../../node_modules", import.meta.url).pathname] },
		proxy: { "^/(?:$|\\?|r/|api/|admin(?:$|\\?|/)|health/|patches/)": { target: backend.url.origin } },
	},
})
await vite.listen()
vite.printUrls()
