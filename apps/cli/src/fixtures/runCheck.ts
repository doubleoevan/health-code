import assert from "node:assert/strict"
import { mkdtemp, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFakeSandboxProvider, type FixtureCommand } from "health-code"
import { checkRepository } from "../checkRepository.ts"
import type { RunCommand } from "../openPullRequest.ts"
import { modelSettings } from "./inspectionSettings.ts"
import { modelRequestSandboxFixture } from "./modelRequestSandboxInspection.ts"
import { createPublicProject } from "./publicProject.ts"

// the repository the recorded project is served as
export const repositoryUrl = "https://github.com/example/project"

// the settings a CI job supplies after setup
export const environment = { ...modelSettings, RUNTA_TOKEN: "runta-token" }

type CheckOutcome = {
	isComplete: boolean
	lines: string[]
	files: string[]
	output: string

	// the sandboxes allocated, the caller-side model roles and the guest model phases
	sandboxCount: number
	roles: unknown[]
	phases: string[]
}
type CheckProject = {
	versions?: Record<string, object>
	project?: "npm" | "bun-binary"
	selectedUpgrade?: { to: string }

	// whether the upgrade fails its tests until an agent repairs it. the git and gh commands the check may run
	shouldRepair?: boolean
	run?: RunCommand
}

/**
 * Runs a check against a recorded project and counts the sandboxes it allocates.
 */
export async function runCheck(
	args: string[],
	{ versions, project, selectedUpgrade, shouldRepair, run }: CheckProject = {},
): Promise<CheckOutcome> {
	const makeProvider: typeof createFakeSandboxProvider = (fixture) =>
		createFakeSandboxProvider(shouldRepair ? { ...fixture, commands: toFailingUpgrade(fixture.commands) } : fixture)
	const { provider, restore, phases } = await modelRequestSandboxFixture({ makeProvider, selectedUpgrade })
	if (shouldRepair) {
		answerRepair(provider)
	}

	// write the results to a temporary folder and keep the printed lines
	const output = await mkdtemp(join(tmpdir(), "health-code-check-"))
	const lines: string[] = []

	// count each sandbox the provider is asked to create
	let sandboxCount = 0
	const createSandbox = provider.createSandbox.bind(provider)
	provider.createSandbox = (name, options) => {
		sandboxCount++
		return createSandbox(name, options)
	}

	// leave a report and a patch from an earlier check in the output folder
	await writeFile(
		join(output, "inspection-report.json"),
		JSON.stringify({ upgrades: [{ patches: [{ filename: "earlier.patch" }] }] }),
	)
	await writeFile(join(output, "earlier.patch"), "old")
	try {
		const { isComplete } = await checkRepository([repositoryUrl, "--output", output, ...args], {
			environment,
			signal: new AbortController().signal,
			sandboxProvider: provider,
			request: (await createPublicProject(versions, project)).request,
			log: (line) => lines.push(line),
			run,
		})
		const roles = provider.modelRequestSandboxEvents.map((item) => item.request?.role ?? item.action)
		return { isComplete, lines, files: await readdir(output), sandboxCount, output, roles, phases }
	} finally {
		restore()
	}
}

// fail the recorded upgrade's tests on both runs, then replay its passing checks for the repaired tree
function toFailingUpgrade(commands: readonly FixtureCommand[]): FixtureCommand[] {
	const bumpIndex = commands.findLastIndex((entry) => entry.argv[2] === "install" && entry.argv.length > 3)
	const [tests, report] = commands.slice(bumpIndex - 2, bumpIndex)
	const bump = commands[bumpIndex]
	assert.ok(tests && report && bump)

	// fail one named case after the bump
	const counts = { passed: 0, failed: 1, skipped: 0, todo: 0 }
	const failures = [{ file: "a.test.ts", workspace: ".", name: "example" }]
	const failingTests = { ...tests, result: { stdout: JSON.stringify({ counts, testFileErrors: [] }), exitCode: 1 } }
	const failingReport = {
		...report,
		result: { stdout: JSON.stringify({ complete: true, granularity: "case", failures }) },
	}

	// repeat the failure after a second install, then replay the passing checks for the repair and the final patch
	const failedRuns = [failingTests, failingReport, bump, failingTests, failingReport]
	const passingChecks = commands.slice(bumpIndex + 1)
	return [...commands.slice(0, bumpIndex - 2), ...failedRuns, bump, ...passingChecks, ...passingChecks]
}

// answer the first agent session with one source edit and let the patch workspace take it
function answerRepair(provider: ReturnType<typeof createFakeSandboxProvider>): void {
	const { patchWorkspace, openCredentialSession } = provider
	assert.ok(patchWorkspace && openCredentialSession)
	provider.patchWorkspace = async (sandbox, request, operation) =>
		request.kind === "edit" ? null : patchWorkspace(sandbox, request, operation)

	// propose one edit to the source file the recorded usage cites
	const edits = [{ file: "index.ts", search: "widget()", replacement: "widget({})" }]
	const text = JSON.stringify({ reason: "Adapt the call", edits })

	// give that reply to the first session. a later session keeps the recorded reply, which declines to edit
	let sessionCount = 0
	provider.openCredentialSession = async (sandbox, route, operation) => {
		const session = await openCredentialSession(sandbox, route, operation)
		return sessionCount++
			? session
			: { ...session, generate: async (prompt, turn) => ({ ...(await session.generate(prompt, turn)), text }) }
	}
}
