import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

const command = resolve("scripts/check-package-boundaries.ts")
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
	root = mkdtempSync(join(tmpdir(), "health-code-boundaries-"))
	for (const [folder, name] of Object.entries({
		"packages/health-code": "health-code",
		"apps/site": "@health-code/site",
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
	["apps/site", 'import type { T } from "@health-code/mcp"', "@health-code/mcp"],
	["apps/mcp", 'export * from "@health-code/site/tools"', "@health-code/site"],
	["packages/health-code", 'require("@health-code/site")', "@health-code/site"],
	["apps/mcp", 'type T = import("health-code/private").T', "public entry"],
	["apps/site", 'import("health-code/private")', "public entry"],
	["apps/site", 'import "../../packages/health-code/private.ts"', "inside their workspace"],
	["apps/site", 'import "#internal"', "public package name"],
	["apps/site", 'import "../mcp/index.js"', "inside their workspace"],
	["apps/site", 'import "third-party"', "declare third-party"],
	["apps/mcp", 'import "test-tool"', "runtime imports"],
])("%s flags %s with its source location", (workspace, statement, message) => {
	write(`${workspace}/index.ts`, `\n${statement}`)
	const result = check()
	expect(result.status).toBe(1)
	expect(result.output).toContain(`${workspace}/index.ts:2`)
	expect(result.output).toContain(message)
})

test("test files can import a declared development dependency", () => {
	write("apps/site/index.test.ts", 'import "test-tool"')
	expect(check().status).toBe(0)
})

test("manifest-only dependencies on another app fail", () => {
	write(
		"apps/mcp/package.json",
		JSON.stringify({ name: "@health-code/mcp", optionalDependencies: { "@health-code/site": "workspace:*" } }),
	)
	const result = check()
	expect(result.status).toBe(1)
	expect(result.output).toContain("apps/mcp/package.json: @health-code/site is an app")
})

test("a workspace dependency needs a matching TypeScript reference", () => {
	write("apps/site/tsconfig.json", "{}")
	const result = check()
	expect(result.status).toBe(1)
	expect(result.output).toContain("apps/site/tsconfig.json: align the reference to health-code")
})

test("an alias cannot redirect the public package name to an internal file", () => {
	write(
		"apps/site/tsconfig.json",
		JSON.stringify({
			references: [{ path: "../../packages/health-code" }],
			compilerOptions: { paths: { "health-code": ["../../packages/health-code/private.ts"] } },
		}),
	)
	write("apps/site/index.ts", 'import "health-code"')
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
		"apps/site/tsconfig.json",
		`{
		"extends": "../../configs/site.json",
		"references": [{ "path": "../../packages/health-code" },],
	}`,
	)
	write("apps/site/index.ts", 'import "#library/private.js"')
	const result = check()
	expect(result.status).toBe(1)
	expect(result.output.trim()).toBe(
		"apps/site/index.ts:1 imports #library/private.js: cross-workspace imports must use a public package name. Found packages/health-code",
	)
})

test("a child config overrides inherited aliases", () => {
	write("base.json", '{"compilerOptions":{"paths":{"#selected":["./packages/health-code/private.ts"]}}}')
	write(
		"apps/site/tsconfig.json",
		JSON.stringify({
			extends: "../../base.json",
			references: [{ path: "../../packages/health-code" }],
			compilerOptions: { paths: { "#selected": ["./own.ts"] } },
		}),
	)
	write("apps/site/own.ts", "export const value = 1")
	write("apps/site/index.ts", 'import "#selected"')
	expect(check()).toEqual({ status: 0, output: "" })
})

test("mixed imports count as runtime dependencies and type-only forms stay erased", () => {
	write(
		"apps/site/index.ts",
		[
			'import { type Options } from "test-tool"',
			'export { type MoreOptions } from "test-tool"',
			'import type Tool = require("test-tool")',
			'export type T = import("test-tool").Options',
			'import { type Config, create } from "test-tool"',
		].join("\r\n"),
	)
	const result = check()
	expect(result.status).toBe(1)
	expect(result.output.trim()).toBe("apps/site/index.ts:5 imports test-tool: declare runtime imports in dependencies")
})
