import { resolve } from "node:path"
import { serveStatic } from "hono/bun"
import { createSite } from "./createSite.tsx"
import { startInspections } from "./startInspections.ts"

// Resolve the immutable asset manifest once for both startup and live requests.
const build = resolve(import.meta.dir, "dist")
const manifest = await Bun.file(resolve(build, ".vite/manifest.json")).json()
const entry = manifest["client.tsx"]
const assets = { script: `/${entry.file}`, styles: (entry.css ?? []).map((file: string) => `/${file}`) }

function application(runtime: Awaited<ReturnType<typeof startInspections>>): ReturnType<typeof createSite> {
	const app = createSite({ ...runtime, assets })
	app.get("/assets/*", serveStatic({ root: build }))
	return app
}

const runtime = await startInspections({
	onConfigured: (ready) => {
		app = application(ready)
	},
})
let app = application(runtime)
// Resolve the active worker for each request while preserving open report streams.
Bun.serve({
	hostname: process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1",
	port: runtime.port,
	fetch: (request) => app.fetch(request),
	idleTimeout: 60,
})
console.info(`Health Code listening on port ${runtime.port}`)
