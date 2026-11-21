import { resolve } from "node:path"
import { serveStatic } from "hono/bun"
import { createSite } from "./createSite.tsx"
import { startInspections } from "./startInspections.ts"

const { replay, port, origin, inspections } = await startInspections()
// use the build manifest to locate the hashed client assets
const build = resolve(import.meta.dir, "dist")
const manifest = await Bun.file(resolve(build, ".vite/manifest.json")).json()
const entry = manifest["client.tsx"]
const app = createSite({
	inspections,
	origin,
	replay,
	assets: { script: `/${entry.file}`, styles: (entry.css ?? []).map((file: string) => `/${file}`) },
})
// serve the application and its assets from the same origin
app.get("/assets/*", serveStatic({ root: build }))
Bun.serve({
	hostname: process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1",
	port,
	fetch: app.fetch,
	idleTimeout: 60,
})
console.info(`Health Code listening on port ${port}`)
