import assert from "node:assert/strict"
import type { FeatureMatch, InspectionModels, UpgradeReportV2 } from "../src/agentContracts.ts"
import { NodeAdapter } from "../src/checkProject.ts"
import { InspectionContext } from "../src/collectEvents.ts"
import type { CheckResult, ReportCard } from "../src/contracts.ts"
import { createFakeSandboxProvider } from "../src/createFakeSandboxProvider.ts"
import { ModelInspection } from "../src/inspectModels.ts"
import { registryHosts } from "../src/networkPolicy.ts"
import type { Integrity, PatchEvidence } from "../src/verifyCandidate.ts"
import { evaluatePatch } from "../src/verifyPatch.ts"

const base = "a".repeat(40)
const oldTest = 'test("behavior", () => expect(api()).toBe("old"))'
const green: CheckResult = { status: "passed", evidence: [] }
const failed: CheckResult = {
	status: "failed",
	evidence: [],
	failingTests: [{ file: "widget.test.ts", workspace: ".", name: "behavior" }],
	attempts: [
		{ status: "failed", failingTests: [] },
		{ status: "failed", failingTests: [] },
	],
}
const origin = {
	"package.json": '{"dependencies":{"widget":"1.0.0"}}',
	"package-lock.json": "lock",
	"index.ts": "const answer = oldApi()",
	"widget.test.ts": oldTest,
}
const scope = { complete: true, findings: [], destinations: ["registry.npmjs.org"] }
export type PatchReplay =
	| "install-break"
	| "unresolved-lock"
	| "new-test"
	| "dependency"
	| "undeclared"
	| "new-hook"
	| "passes"
	| "repair"
	| "test"
	| "decline"
	| "binding"
	| "new-host"
function repairReply(mode: PatchReplay): { text: string; modelId: string; inputTokens: number; outputTokens: number } {
	const change =
		mode === "test"
			? { file: "widget.test.ts", search: '"old"', replacement: '"new"' }
			: { file: "index.ts", search: "oldApi()", replacement: "newApi()" }
	return {
		text: JSON.stringify({
			reason: "Adapt the changed API",
			behaviorChange:
				mode === "test"
					? { source: "https://example.org/notes", quote: "api now returns new instead of old", symbol: "api" }
					: undefined,
			dependencies: ["dependency", "undeclared", "new-hook"].includes(mode)
				? [{ name: "replacement", version: "2.0.0", reason: "Replace the removed module" }]
				: [],
			edits:
				mode === "decline"
					? []
					: mode === "new-test"
						? [
								change,
								{
									file: "added.test.ts",
									contents:
										'import { test, expect } from "bun:test"\ntest("new behavior", () => expect(newApi()).toBe("new"))',
								},
							]
						: [change],
		}),
		modelId: "fixture",
		inputTokens: 1,
		outputTokens: 1,
	}
}
export async function replayPatch(
	mode: PatchReplay,
	adoption?: "simplify" | "decline" | "no-benefit",
): Promise<{
	report: UpgradeReportV2
	starts: number
	engine: ModelInspection
	adapter: NodeAdapter
	card: ReportCard
}> {
	const reply = repairReply(mode)
	const provider = createFakeSandboxProvider({
		commit: base,
		commands: [],
		verifiedStub: mode !== "binding",
		agentReplies: adoption
			? [
					reply,
					{
						...reply,
						text: JSON.stringify({
							reason: "Reuse the new default",
							edits:
								adoption === "decline"
									? []
									: [
											{
												file: "index.ts",
												contents: adoption === "no-benefit" ? "const result = newApi()" : "const answer = 2",
											},
										],
						}),
					},
				]
			: [reply],
	})
	const sandbox = await provider.createSandbox("fixture", { timeoutMs: 1000 })
	await provider.setNetworkPolicy(sandbox, registryHosts, { timeoutMs: 1000 })
	let restoredTip: string | undefined
	let tree: Record<string, string> = { ...origin }
	const history = new Map([[base, { ...tree }]])
	provider.patchWorkspace = async (_, request): Promise<string | null> => {
		switch (request.kind) {
			case "verify":
				assert.deepEqual(tree, history.get(request.tip))
				return request.tip
			case "restore":
				restoredTip = request.tip
				tree = { ...history.get(request.tip) }
				return null
			case "read":
				return (request.revision ? history.get(request.revision) : tree)?.[request.file] ?? null
			case "edit":
				tree[request.file] = request.contents
				return null
			case "commit": {
				restoredTip = undefined
				const sha = history.size.toString(16).padStart(40, "0")
				const next = { ...history.get(request.parent) }
				for (const path of request.files) {
					const contents = tree[path]
					assert.ok(contents)
					next[path] = contents
				}
				history.set(sha, next)
				return sha
			}
			case "order":
				throw new Error("Unexpected fixture reordering")
			case "export":
				return "From fixture\nSubject: [PATCH] verified\n"
		}
	}
	const pricing = { inputUsdPerMillion: 1, outputUsdPerMillion: 1, maxInputTokens: 32000 }
	const route = {
		protocol: "anthropic" as const,
		baseUrl: "https://model.example/v1",
		modelId: "fixture",
		credential: { name: "stored", header: "x-api-key", valueTemplate: `\${credential}` },
		pricing,
	}
	const host = {
		model: {
			modelId: "fixture",
			specificationVersion: "v4" as const,
			provider: "fixture",
			supportedUrls: {},
			async doStream(): Promise<never> {
				throw Error("Unexpected host call")
			},
			async doGenerate(): Promise<never> {
				throw Error("Unexpected host call")
			},
		},
		pricing,
	}
	const models = {
		releaseSummary: host,
		featureMatch: host,
		repair: route,
		featureAdoption: route,
	} satisfies InspectionModels
	const options = { repositoryUrl: "https://github.com/example/project", sandboxProvider: provider }
	const context = new InspectionContext(options)
	const engine = new ModelInspection({ ...options, models })
	const adapter = new NodeAdapter(context, sandbox)
	adapter.project = { manager: "npm", version: "1", sources: {}, skipped: [], typecheck: "check", environment: [] }
	const installBreak = mode === "install-break" || mode === "unresolved-lock"
	const initialFailure = mode === "passes" || mode === "new-host" ? green : failed
	const report: UpgradeReportV2 = {
		dependency: "widget",
		to: "2.0.0",
		from: { ".": "1.0.0" },
		kind: "major",
		install: installBreak ? failed : green,
		typecheck: green,
		tests: installBreak ? { status: "untested", reason: "install failed", evidence: [] } : initialFailure,
		result: initialFailure,
		observation: scope,
		verdict: "Untested",
		newDependencies: [],
		modelUsage: [],
		featureMatches: [],
		patches: [],
		installSize: {},
		locators: [
			{ file: "widget.test.ts", line: 1, url: options.repositoryUrl + "/blob/" + base + "/widget.test.ts#L1" },
		],
		releaseSummary: { text: "Return value changed.", sources: ["https://example.org/notes"] },
	}
	const baseline: Integrity = {
		files: Object.keys(origin),
		cases: [["widget.test.ts", "behavior", "passed"]],
		hooks: [],
		testFileErrors: [],
	}
	const version = (): string => JSON.parse(tree["package.json"] ?? "{}").dependencies.widget
	const passes = (): boolean => {
		if (mode === "test") {
			return tree["widget.test.ts"]?.includes('"new"') === (version() === "2.0.0")
		}
		return (
			mode === "passes" ||
			mode === "new-host" ||
			tree["index.ts"]?.includes("newApi()") === true ||
			tree["index.ts"] === "const answer = 2"
		)
	}
	adapter.resetProject = async (): Promise<void> => {
		tree = { ...origin }
	}
	adapter.bumpDependency = async () => {
		tree["package.json"] = '{"dependencies":{"widget":"2.0.0"}}'
		return { check: installBreak ? failed : green, observation: scope }
	}
	adapter.resolveLock = async () => {
		assert.equal(version(), "2.0.0")
		tree["package-lock.json"] = mode === "install-break" ? "widget@2.0.0" : ""
		return { check: mode === "install-break" ? green : failed, observation: scope }
	}
	adapter.refreshInstallation = async () => {
		assert.ok(restoredTip, "Dependency refresh requires a restored candidate")
		const expected = { ...history.get(restoredTip) }
		const manifest = JSON.parse(expected["package.json"] ?? "{}")
		manifest.dependencies.replacement = "2.0.0"
		assert.deepEqual(JSON.parse(tree["package.json"] ?? "{}"), manifest)
		assert.deepEqual(tree, { ...expected, "package.json": tree["package.json"] })
		restoredTip = undefined
		if (mode === "undeclared") {
			tree["package.json"] = JSON.stringify({
				...JSON.parse(tree["package.json"] ?? "{}"),
				dependencies: { widget: "2.0.0", surprise: "1.0.0" },
			})
		}
		return { check: green, observation: scope }
	}
	adapter.install = async (): Promise<CheckResult> => {
		adapter.lastObservation = scope
		return green
	}
	adapter.typecheck = async (): Promise<CheckResult> => green
	adapter.test = async (): Promise<CheckResult> => {
		adapter.lastObservation = mode === "new-host" ? { ...scope, destinations: ["registry.yarnpkg.com"] } : scope
		return passes() ? green : failed
	}
	adapter.data = async (args): Promise<unknown> => {
		if (args[0] === "detect") {
			return { sources: { widget: { ".": version() } } }
		}
		const hooks = mode === "new-hook" ? ["new postinstall"] : []
		if (args[0] === "lifecycle") {
			return hooks
		}
		const cases: Integrity["cases"] = [["widget.test.ts", "behavior", passes() ? "passed" : "failed"]]
		if (tree["added.test.ts"]) {
			cases.push(["added.test.ts", "new behavior", "passed"])
		}
		return { ...baseline, hooks, cases }
	}
	const card = { repository: { url: options.repositoryUrl, commit: base } } as ReportCard
	const evidence: PatchEvidence = {
		report,
		card,
		adapter,
		context,
		sandbox,
		baseInstall: scope,
		baseTests: scope,
		baselineIntegrity: baseline,
		releaseNotes: [
			{ source: "https://example.org/notes", text: "api now returns new instead of old", workspaces: ["."] },
		],
		usage: {
			changelog: "",
			unresolved: [],
			usage: [
				{
					file: "index.ts",
					symbol: adoption === "simplify" ? "newApi" : "oldApi",
					line: 1,
					workspace: ".",
					text: origin["index.ts"],
				},
			],
		},
	}
	await evaluatePatch(engine, evidence)
	if (adoption) {
		const match: FeatureMatch = {
			feature: "Use the new default",
			source: "release",
			location: { file: "index.ts", line: 1 },
			kind: "deprecated",
			disposition: "ranked",
		}
		report.featureMatches.push(match)
		await evaluatePatch(engine, evidence, match)
	}
	return {
		report,
		engine,
		adapter,
		card,
		starts: engine.timeline.filter((event) => event.type === "sandbox.event" && event.action === "agent-started")
			.length,
	}
}
