import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

const command = resolve("scripts/checkPackageBoundaries.ts")
let root: string

function write(path: string, text: string): void {
	const target = join(root, path)
	mkdirSync(dirname(target), { recursive: true })
	writeFileSync(target, text)
}

function check(): { status: number; output: string } {
	const result = Bun.spawnSync([process.execPath, command], { cwd: root })
	return { status: result.exitCode, output: result.stderr.toString() }
}

beforeEach(() => {
	// build an isolated set of workspace manifests
	root = mkdtempSync(join(tmpdir(), "health-code-boundaries-"))
	for (const [folder, name] of Object.entries({
		"packages/health-code": "health-code",
		"apps/web": "@health-code/web",
		"apps/mcp": "@health-code/mcp",
	})) {
		const app = folder.startsWith("apps/")
		write(
			`${folder}/package.json`,
			JSON.stringify({
				name,
				...(!app && { exports: "./public.ts" }),
				dependencies: app ? { "health-code": "workspace:*" } : {},
				devDependencies: { "test-tool": "1.0.0" },
			}),
		)

		// map a private-file alias alongside the public reference
		write(
			`${folder}/tsconfig.json`,
			JSON.stringify({
				references: app ? [{ path: "../../packages/health-code" }] : [],
				compilerOptions: {
					moduleResolution: "nodenext",
					paths: { "#internal": ["../../packages/health-code/private.ts"] },
				},
			}),
		)
	}

	// link the public package as the resolver would find it in a workspace
	mkdirSync(join(root, "node_modules"))
	symlinkSync("../packages/health-code", join(root, "node_modules/health-code"))
	write("packages/health-code/public.ts", 'export { value } from "./private.ts"')
	write("packages/health-code/private.ts", "export const value = 1")
})

afterEach(() => rmSync(root, { force: true, recursive: true }))

test("both apps can use the library's public entry and their own files", () => {
	for (const app of ["site", "mcp"]) {
		write(
			`apps/${app}/index.ts`,
			`export { value } from "health-code"\nimport "./local.ts"\n// import "@health-code/mcp"\n`,
		)
		write(`apps/${app}/local.ts`, `export type { Options } from "test-tool"`)
	}
	expect(check()).toEqual({ status: 0, output: "" })
})

test.each([
	["apps/web", 'import type { T } from "@health-code/mcp"', "@health-code/mcp"],
	["apps/mcp", 'export * from "@health-code/web/tools"', "@health-code/web"],
	["packages/health-code", 'require("@health-code/web")', "@health-code/web"],
	["apps/mcp", 'type T = import("health-code/private").T', "public entry"],
	["apps/web", 'import("health-code/private")', "public entry"],
	["apps/web", 'import "../../packages/health-code/private.ts"', "inside their workspace"],
	["apps/web", 'import "#internal"', "public package name"],
	["apps/web", 'import "../mcp/index.js"', "inside their workspace"],
	["apps/web", 'import "third-party"', "declare third-party"],
	["apps/mcp", 'import "test-tool"', "runtime imports"],
])("%s flags %s with its source location", (workspace, statement, message) => {
	// include the offending import and its source line in the diagnostic
	write(`${workspace}/index.ts`, `\n${statement}`)
	const result = check()
	expect(result.status).toBe(1)
	expect(result.output).toContain(`${workspace}/index.ts:2`)
	expect(result.output).toContain(message)
})

test("test files can import a declared development dependency", () => {
	write("apps/web/index.test.ts", 'import "test-tool"')
	expect(check().status).toBe(0)
})

test("manifest-only dependencies on another app fail", () => {
	write(
		"apps/mcp/package.json",
		JSON.stringify({ name: "@health-code/mcp", optionalDependencies: { "@health-code/web": "workspace:*" } }),
	)
	const result = check()
	expect(result.status).toBe(1)
	expect(result.output).toContain("apps/mcp/package.json: @health-code/web is an app")
})

test("a workspace dependency needs a matching TypeScript reference", () => {
	write("apps/web/tsconfig.json", "{}")
	const result = check()
	expect(result.status).toBe(1)
	expect(result.output).toContain("apps/web/tsconfig.json: align the reference to health-code")
})

test("an alias cannot redirect the public package name to an internal file", () => {
	write(
		"apps/web/tsconfig.json",
		JSON.stringify({
			references: [{ path: "../../packages/health-code" }],
			compilerOptions: { paths: { "health-code": ["../../packages/health-code/private.ts"] } },
		}),
	)
	write("apps/web/index.ts", 'import "health-code"')
	const result = check()
	expect(result.status).toBe(1)
	expect(result.output).toContain("public package name")
})

test("inherited JSONC paths resolve relative to the declaring config", () => {
	write(
		"configs/base.json",
		`{
		// Check the second mapping when the first has no matching file.
		"compilerOptions": { "paths": { "#library/*": ["./missing/*", "../packages/health-code/*"], }, },
		"references": [{ "path": "../apps/mcp" }],
	}`,
	)
	write("configs/site.json", '{"extends":"./base"}')
	write(
		"apps/web/tsconfig.json",
		`{
		"extends": "../../configs/site.json",
		"references": [{ "path": "../../packages/health-code" },],
	}`,
	)

	// resolve the inherited alias from its declaring directory
	write("apps/web/index.ts", 'import "#library/private.js"')
	const result = check()
	expect(result.status).toBe(1)
	expect(result.output.trim()).toBe(
		"apps/web/index.ts:1 imports #library/private.js: cross-workspace imports must use a public package name. Found packages/health-code",
	)
})

test("a child config overrides inherited aliases", () => {
	write("base.json", '{"compilerOptions":{"paths":{"#selected":["./packages/health-code/private.ts"]}}}')
	write(
		"apps/web/tsconfig.json",
		JSON.stringify({
			extends: "../../base.json",
			references: [{ path: "../../packages/health-code" }],
			compilerOptions: { paths: { "#selected": ["./own.ts"] } },
		}),
	)
	write("apps/web/own.ts", "export const value = 1")
	write("apps/web/index.ts", 'import "#selected"')
	expect(check()).toEqual({ status: 0, output: "" })
})

test("mixed imports count as runtime dependencies and type-only forms stay erased", () => {
	write(
		"apps/web/index.ts",
		[
			'import { type Options } from "test-tool"',
			'export { type MoreOptions } from "test-tool"',
			'import type Tool = require("test-tool")',
			'export type T = import("test-tool").Options',
			'import { type Config, create } from "test-tool"',
		].join("\r\n"),
	)

	// flag only the import that survives transpilation
	const result = check()
	expect(result.status).toBe(1)
	expect(result.output.trim()).toBe("apps/web/index.ts:5 imports test-tool: declare runtime imports in dependencies")
})
