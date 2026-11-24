import assert from "node:assert/strict"
import { test } from "node:test"
import { protectedTestFiles } from "../guest/protectTestSupport.ts"
import { reviewTestEdit } from "../src/patches/reviewTestEdit.ts"

function protect(config: string, extra: Record<string, string> = {}): Set<string> {
	const files: Record<string, string> = { "vite.config.ts": config, "src/a.test.ts": 'import "@/a"', ...extra }
	return protectedTestFiles(Object.keys(files), ["src/a.test.ts"], (file) => files[file] ?? "")
}

test("Vite settings that cannot be read statically are rejected", () => {
	for (const config of [
		"export default { resolve: settings }",
		"export default { resolve: { ...settings } }",
		"export default { resolve: { alias: { '@': resolve(root, 'src') } } }",
		"export default { resolve: { alias: { '@': `src` } } }",
		"export default { plugins: [{ name: 'local', load() {} }] }",
		"export default { plugins: makePlugins() }",
	]) {
		assert.throws(() => protect(config), /Dynamic|Unresolved/, config)
	}
})

test("a Vite plugin from a workspace package must resolve to a protected file", () => {
	const manifest = { "packages/plugin/package.json": '{"name":"local-plugin"}' }
	assert.throws(
		() => protect('import plugin from "local-plugin"\nexport default { plugins: [plugin()] }', manifest),
		/Unresolved test configuration module/,
	)
})

test("moved mocks stay distinct and keep their test directives", () => {
	const review = (before: string, after: string): unknown => reviewTestEdit({ before, after, mockDependency: "widget" })
	assert.deepEqual(review('vi.mock("widget/old")', 'vi.mock("widget/new")'), { kind: "mock" })
	assert.throws(() => review('vi.mock("widget/a")\nvi.mock("widget/b")', 'vi.mock("widget/a")\nvi.mock("widget/a")'))
	assert.throws(() => review('vi.mock("widget/old")', '// @vitest-environment node\nvi.mock("widget/new")'))
})

test("inspected runner setup and test-only helpers stay protected outside test folders", () => {
	const files: Record<string, string> = {
		"package.json": JSON.stringify({ scripts: { test: "jest --config ./configuration.json" } }),
		"configuration.json": JSON.stringify({ rootDir: "./src", setupFiles: ["<rootDir>/jestSetup.ts"] }),
		"src/jestSetup.ts": "",
		"src/alternative.ts": "",
		"pkg/tsconfig.json": '{"extends":["../tsconfig.json","../other.json"],"compilerOptions":{"baseUrl":"."}}',
		"other.json": '{"compilerOptions":{"paths":{"choice":["one","two"]}}}',
		"pkg/one.ts": "",
		"pkg/two.ts": "",
		"pkg/main.ts": 'import "choice"; import "@support/alternative"',
		"pkg/main.test.ts": 'import "./two"; import "../src/alternative"',

		"tsconfig.json": '{"extends":"./config/base"}',
		"config/base.json": '{"compilerOptions":{"baseUrl":"..","paths":{"@support/*":["src/*"]}}}',
		"bunfig.toml": '[test]\npreload=["./src/bootstrap.ts"]',
		"src/bootstrap.ts": 'import "./environment"',
		"src/environment.ts": "",
		"src/widget.ts": "export const widget = 1",
		"src/fixtureHelper.ts": "",
		"src/app.ts": 'import "./widget"',
		"src/widget.test.ts": 'import "./widget"; import "@support/fixtureHelper"',
	}

	// find test support through runner configuration and import aliases
	const blocked = protectedTestFiles(
		Object.keys(files),
		["src/widget.test.ts", "pkg/main.test.ts"],
		(file) => files[file] ?? "",
	)

	// require the runner's setup dependencies to remain protected
	assert.ok(blocked.has("src/bootstrap.ts"))
	assert.ok(blocked.has("src/environment.ts"))
	assert.ok(blocked.has("src/jestSetup.ts"))
	assert.ok(blocked.has("configuration.json"))

	// distinguish test-only imports from shared production dependencies
	assert.ok(blocked.has("pkg/two.ts"))
	assert.ok(blocked.has("src/alternative.ts"))
	assert.equal(blocked.has("pkg/one.ts"), false)
	assert.ok(blocked.has("src/fixtureHelper.ts"))
	assert.equal(blocked.has("src/widget.ts"), false)
	assert.throws(() => protectedTestFiles(["vitest.config.ts"], [], () => "export default loadConfig()"), /Dynamic/)
})

test("a Vite project with plugins keeps its setup, plugins and aliased helpers protected", () => {
	const config = `import react from "@vitejs/plugin-react"
import { resolve } from "node:path"
import local from "./plugin"
export default defineConfig({ plugins: [react(), local()], resolve: { alias: { "@": resolve(__dirname, "src") } },
	test: { environment: "jsdom", setupFiles: ["src/setup.ts"], css: true } })`
	const sources: Record<string, string> = {
		"vitest.config.ts": config,
		"plugin.ts": "export default () => ({})",
		"src/setup.ts": "",
		"src/a.test.ts": 'import "@/helper"\nimport "@/widget"',

		// separate a test helper from shared production source
		"src/helper.ts": "export {}",
		"src/widget.ts": "export {}",
		"src/main.ts": 'import "@/widget"',
	}
	const protect = (overrides: Record<string, string> = {}): Set<string> => {
		const files = { ...sources, ...overrides }
		return protectedTestFiles(Object.keys(files), ["src/a.test.ts"], (file) => files[file as keyof typeof files] ?? "")
	}
	const blocked = protect()
	assert.deepEqual([...blocked].sort(), ["plugin.ts", "src/a.test.ts", "src/helper.ts", "src/setup.ts"])

	// reject settings whose test modules cannot be read statically
	for (const dynamic of ['["src/setup.ts"]', '{ "@": resolve(__dirname, "src") }', '"./plugin"']) {
		const replacement = dynamic === '"./plugin"' ? '"./missing"' : "load()"
		assert.throws(() => protect({ "vitest.config.ts": config.replace(dynamic, replacement) }))
	}
})
