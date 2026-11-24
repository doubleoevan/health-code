import assert from "node:assert/strict"
import type { CodeFeatureMatch, InspectionModels, UpgradeReportV2 } from "../src/agentContracts.ts"
import { NodeAdapter } from "../src/checkProject.ts"
import { InspectionContext } from "../src/collectEvents.ts"
import type { CheckResult, InspectionReport } from "../src/contracts.ts"
import { createFakeSandboxProvider } from "../src/createFakeSandboxProvider.ts"
import { ModelInspection } from "../src/inspectModels.ts"
import { registryHosts } from "../src/networkPolicy.ts"
import type { PatchEvidence, PatchVerificationInputs } from "../src/verifyCandidate.ts"
import { evaluatePatch } from "../src/verifyPatch.ts"

const base = "a".repeat(40)
const oldTest = 'test("behavior", () => expect(api()).toBe("old"))'
const green: CheckResult = { status: "passed", evidence: [] }

// a typecheck whose error already exists on the original commit
const typeError: CheckResult = {
	status: "failed",
	evidence: [],
	failingTests: [{ workspace: ".", file: "other.ts", name: "TS2322: Type mismatch." }],
}
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

// select install and dependency changes for replay
export type PatchReplay =
	| "install-break"
	| "type-errors"
	| "new-type-error"
	| "unresolved-lock"
	| "new-test"
	| "dependency"

	// select dependencies that move together
	| "linked"
	| "linked-downgrade"
	| "linked-duplicate"
	| "linked-conflict"

	// select unsafe dependency changes
	| "undeclared"
	| "new-hook"

	// select the repair result or credential and network failure
	| "passes"
	| "repair"
	| "test"
	| "decline"
	| "binding"
	| "new-host"

// identify replays that upgrade dependencies alongside the target
function isLinkedReplay(mode: PatchReplay): boolean {
	return mode.startsWith("linked")
}

// list the dependencies the fixture reply asks to change
function toRequestedDependencies(mode: PatchReplay): { name: string; version: string; reason: string }[] {
	if (isLinkedReplay(mode)) {
		const version = mode === "linked-downgrade" ? "0.9.0" : "2.0.0"
		const names = mode === "linked-duplicate" ? ["linked-a", "linked-a"] : ["linked-a", "linked-b"]
		const linkedDependencies = names.map((name) => ({ name, version, reason: "Move with widget" }))

		// list the target at its upgraded version alongside the linked set
		return mode === "linked"
			? [{ name: "widget", version: "2.0.0", reason: "Keep the target" }, ...linkedDependencies]
			: linkedDependencies
	}

	// add a dependency the project does not declare
	return ["dependency", "undeclared", "new-hook"].includes(mode)
		? [{ name: "replacement", version: "2.0.0", reason: "Replace the removed module" }]
		: []
}

// declare the linked dependencies only for their replays
function toOriginalTree(mode: PatchReplay): typeof origin {
	const linked = '{"dependencies":{"widget":"1.0.0","linked-a":"^1.0.0","linked-b":"^1.0.0"}}'
	return isLinkedReplay(mode) ? { ...origin, "package.json": linked } : { ...origin }
}

// list versions after the requested dependency change
function toRefreshedVersions(mode: PatchReplay): Record<string, string> {
	return isLinkedReplay(mode) ? { "linked-a": "2.0.0", "linked-b": "2.0.0" } : { replacement: "2.0.0" }
}

// list versions before the linked upgrade
function toLinkedSources(mode: PatchReplay): Record<string, Record<string, string>> {
	return isLinkedReplay(mode) ? { "linked-a": { ".": "1.0.0" }, "linked-b": { ".": "1.0.0" } } : {}
}

// build the fixture model reply
function repairReply(mode: PatchReplay): { text: string; modelId: string; inputTokens: number; outputTokens: number } {
	// choose a production edit or a change to the test expectation
	const change =
		mode === "test"
			? { file: "widget.test.ts", search: '"old"', replacement: '"new"' }
			: { file: "index.ts", search: "oldApi()", replacement: "newApi()" }
	return {
		text: JSON.stringify({
			reason: "Adapt the changed API",

			// cite the behavior change when proposing a test edit
			behaviorChange:
				mode === "test"
					? { source: "https://example.org/notes", quote: "api now returns new instead of old", symbol: "api" }
					: undefined,
			dependencies: toRequestedDependencies(mode),

			// vary the proposed edit set to cover a declined repair and added coverage
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
	inspectionReport: InspectionReport
}> {
	// replay a repair reply and optionally a feature adoption reply
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

	// prepare the synthetic checkout with registry access
	const sandbox = await provider.createSandbox("fixture", { timeoutMs: 1000 })
	await provider.setNetworkPolicy(sandbox, registryHosts, { timeoutMs: 1000 })
	let restoredTip: string | undefined
	const start = toOriginalTree(mode)
	let tree: Record<string, string> = { ...start }
	const history = new Map([[base, { ...tree }]])

	// track edits separately from committed file snapshots
	provider.patchWorkspace = async (_, request): Promise<string | null> => {
		switch (request.kind) {
			case "verify":
				assert.deepEqual(tree, history.get(request.tip))
				return request.tip

			// restore a saved tree before checking or modifying a candidate
			case "restore":
				restoredTip = request.tip
				tree = { ...history.get(request.tip) }
				return null
			case "read":
				return (request.revision ? history.get(request.revision) : tree)?.[request.file] ?? null

			// stage edits in the in-memory tree
			case "edit":
				tree[request.file] = request.contents
				return null
			case "commit": {
				// construct a commit from the selected files and its parent
				restoredTip = undefined
				const sha = history.size.toString(16).padStart(40, "0")
				const next = { ...history.get(request.parent) }
				for (const path of request.files) {
					const contents = tree[path]
					assert.ok(contents)
					next[path] = contents
				}

				// save the resulting tree under its synthetic commit id
				history.set(sha, next)
				return sha
			}
			case "order":
				throw new Error("Unexpected fixture reordering")

			// export a fixture mailbox for the verified history
			case "export":
				return "From fixture\nSubject: [PATCH] verified\n"
		}
	}

	// price the four model roles using the same fixture rates
	const pricing = { inputUsdPerMillion: 1, outputUsdPerMillion: 1, maxInputTokens: 32000 }
	const route = {
		protocol: "anthropic" as const,
		baseUrl: "https://model.example/v1",
		modelId: "fixture",
		credential: { name: "stored", header: "x-api-key", valueTemplate: `\${credential}` },
		pricing,
	}

	// reject unexpected requests to the host model
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

	// connect the model engine and adapter to the fake sandbox
	const options = { repositoryUrl: "https://github.com/example/project", sandboxProvider: provider }
	const context = new InspectionContext(options)
	const engine = new ModelInspection({ ...options, models })
	const adapter = new NodeAdapter(context, sandbox)
	const sources = toLinkedSources(mode)
	adapter.project = { manager: "npm", version: "1", sources, skipped: [], typecheck: "check", environment: [] }

	// seed the upgrade report with the chosen initial failure
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
	const baseline: PatchVerificationInputs = {
		projectFilePaths: Object.keys(origin),
		cases: [["widget.test.ts", "behavior", "passed"]],
		lifecycleHookSignatures: [],
		testFileErrors: [],
	}

	// derive test behavior from the installed version and working tree
	const version = (): string => JSON.parse(tree["package.json"] ?? "{}").dependencies.widget
	const passes = (): boolean => {
		if (mode === "test") {
			return tree["widget.test.ts"]?.includes('"new"') === (version() === "2.0.0")
		}

		// recognize a successful production repair or feature adoption
		return (
			mode === "passes" ||
			mode === "new-host" ||
			tree["index.ts"]?.includes("newApi()") === true ||
			tree["index.ts"] === "const answer = 2"
		)
	}

	// restore the original tree for each clean trial
	adapter.resetProject = async (): Promise<void> => {
		tree = { ...start }
	}

	// replay the upgrade install and its observed network scope
	adapter.bumpDependency = async () => {
		tree["package.json"] = (tree["package.json"] ?? "").replace('"widget":"1.0.0"', '"widget":"2.0.0"')
		return { check: installBreak ? failed : green, observation: scope }
	}

	// simulate offline lockfile recovery after a broken install
	adapter.resolveLock = async () => {
		assert.equal(version(), "2.0.0")
		tree["package-lock.json"] = mode === "install-break" ? "widget@2.0.0" : ""
		return { check: mode === "install-break" ? green : failed, observation: scope }
	}
	adapter.refreshInstallation = async () => {
		// check the refreshed manifest against the restored candidate
		assert.ok(restoredTip, "Dependency refresh requires a restored candidate")
		const expected = { ...history.get(restoredTip) }
		const manifest = JSON.parse(expected["package.json"] ?? "{}")
		Object.assign(manifest.dependencies, toRefreshedVersions(mode))
		assert.deepEqual(JSON.parse(tree["package.json"] ?? "{}"), manifest)
		assert.deepEqual(tree, { ...expected, "package.json": tree["package.json"] })

		// inject an undeclared change for patch verification
		restoredTip = undefined
		if (mode === "undeclared") {
			tree["package.json"] = JSON.stringify({
				...JSON.parse(tree["package.json"] ?? "{}"),
				dependencies: { widget: "2.0.0", surprise: "1.0.0" },
			})
		}

		// name the conflict before npm's closing advice
		if (mode === "linked-conflict") {
			const stderr = `npm error Conflicting peer dependency: linked-b@3.0.0\n${"npm error advice\n".repeat(60)}`
			const command = { stdout: "", stderr, exitCode: 1, durationMs: 1, stdoutTruncated: false, stderrTruncated: false }
			return { check: { ...failed, evidence: [command] }, observation: scope }
		}
		return { check: green, observation: scope }
	}

	// replay clean installation and typecheck evidence
	adapter.install = async (): Promise<CheckResult> => {
		adapter.lastObservation = scope
		return green
	}
	adapter.typecheck = async (): Promise<CheckResult> =>
		mode === "type-errors" || mode === "new-type-error" ? typeError : green

	// return the test outcome and observed destinations for the current tree
	adapter.test = async (): Promise<CheckResult> => {
		adapter.lastObservation = mode === "new-host" ? { ...scope, destinations: ["registry.yarnpkg.com"] } : scope
		return passes() ? green : failed
	}
	adapter.data = async (args): Promise<unknown> => {
		// report the installed version for project discovery
		if (args[0] === "detect") {
			return { sources: { widget: { ".": version() } } }
		}

		// expose the simulated lifecycle hook when requested
		const hooks = mode === "new-hook" ? ["new postinstall"] : []
		if (args[0] === "lifecycle") {
			return hooks
		}

		// build the case inventory from the current tree
		const cases: PatchVerificationInputs["cases"] = [["widget.test.ts", "behavior", passes() ? "passed" : "failed"]]
		if (tree["added.test.ts"]) {
			cases.push(["added.test.ts", "new behavior", "passed"])
		}
		return { files: baseline.projectFilePaths, hooks, cases, testFileErrors: baseline.testFileErrors }
	}

	// assemble inspected usage and Baseline inputs for patch evaluation
	const inspectionReport = {
		repository: { url: options.repositoryUrl, commit: base },
		baseline: { install: green, typecheck: mode === "type-errors" ? typeError : green, tests: green },
	} as InspectionReport
	const evidence: PatchEvidence = {
		report,
		inspectionReport,
		adapter,
		context,
		sandbox,
		baseInstall: scope,
		baseTests: scope,
		baselinePatchVerificationInputs: baseline,
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

	// evaluate the ranked feature against the accepted upgrade
	if (adoption) {
		const match: CodeFeatureMatch = {
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
		inspectionReport,
		starts: engine.timeline.filter((event) => event.type === "sandbox.event" && event.action === "agent-started")
			.length,
	}
}
