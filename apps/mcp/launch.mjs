#!/usr/bin/env node
import { readFileSync } from "node:fs"

// Resolve the installed library's declared CLI, including in a hoisted npm installation.
const root = new URL("../", import.meta.resolve("health-code"))
const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8"))
process.argv.splice(2, 0, "mcp")
await import(new URL(manifest.bin["health-code"], root).href)
