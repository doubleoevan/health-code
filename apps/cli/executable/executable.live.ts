import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { Runta } from "@runta/runta-sdk"
import type { ModelRequestSandboxInspectionReport } from "health-code"
import { type CommandRun, npmCliPath, toExecutablePath, toPlatformName } from "./checkExecutable.ts"

// the Verdict and check statuses of one tested upgrade
type UpgradeSummary = { dependency: string; to: string; verdict: string; checks: string[] }

// the paths a prepared checkout test uses
type PreparedCheckout = {
	checkout: string
	remote: string
	stubFolder: string
	markerPath: string
	ghCallsPath: string
}

// the library's live fixture, where both builds must reach the same Verdict
const fixtureUrl = "https://github.com/ai/nanoid"
const fixtureCommit = "055d1700cc67ac843e3efb5235d806b419ec7b2b"
const checkArgs = ["check", fixtureUrl, "--dependency", "vite", "--to", "8.4.0", "--revision", fixtureCommit]

// an upgrade that passes as is with a patch, so the executable opens a pull request
const pullRequestUrl = "https://github.com/runta-dev/jot"
const pullRequestCommit = "55c3082e88955cd24da2bf5417af0d8ae3c4c7af"
const pullRequestArgs = ["check", pullRequestUrl, "--dependency", "@types/node", "--to", "24.19.4"]

// the two builds under test
const platformName = toPlatformName(process.platform, process.arch)
const executablePath = toExecutablePath(platformName)

// skip without the live settings or the built executable
const settingNames = ["RUNTA_TOKEN", "HEALTH_CODE_MODEL_HOST", "HEALTH_CODE_MODEL"]
const missingSettings = settingNames.filter((name) => !process.env[name])
const skip = missingSettings.length
	? `Set ${missingSettings.join(", ")} to run the live executable checks.`
	: !existsSync(executablePath) && "Run bun run test:executable to build the executable first."

// the marker every Git hook writes when it runs
const hookNames = ["pre-push", "post-checkout", "applypatch-msg", "pre-applypatch", "post-applypatch", "post-commit"]

test("the executable reaches the npm command's Verdict", { skip, timeout: 3_600_000 }, async (context) => {
	const workspace = mkdtempSync(join(tmpdir(), "health-code-live-"))
	try {
		// test the upgrade through the npm command on Node and through the executable
		const npmOutput = join(workspace, "npm-report")
		const executableOutput = join(workspace, "executable-report")
		const npmRun = await runCommand("node", [npmCliPath, ...checkArgs, "--upgrade-only", "--output", npmOutput], {
			testSignal: context.signal,
		})
		assert.equal(npmRun.status, 0, npmRun.stderr)
		const executableRun = await runCommand(
			executablePath,
			[...checkArgs, "--upgrade-only", "--output", executableOutput],
			{ testSignal: context.signal },
		)
		assert.equal(executableRun.status, 0, executableRun.stderr)

		// compare the Verdicts and check statuses
		const npmUpgrades = readUpgradeSummaries(npmOutput)
		assert.deepEqual(readUpgradeSummaries(executableOutput), npmUpgrades)
		console.log(JSON.stringify({ upgrades: npmUpgrades }))
	} finally {
		rmSync(workspace, { recursive: true, force: true })
	}
})

test("the executable opens the pull request with hooks off", { skip, timeout: 3_600_000 }, async (context) => {
	const workspace = mkdtempSync(join(tmpdir(), "health-code-live-"))
	try {
		// test the upgrade through the executable from a checkout that can open a pull request
		const { checkout, remote, stubFolder, markerPath, ghCallsPath } = prepareCheckout(workspace)
		const output = join(workspace, "report")
		const args = [
			...pullRequestArgs,
			"--revision",
			pullRequestCommit,
			"--upgrade-only",
			"--output",
			output,
			"--pull-request",
		]
		const executableRun = await runCommand(executablePath, args, {
			cwd: checkout,
			path: `${stubFolder}:${process.env.PATH}`,
			testSignal: context.signal,
		})
		assert.equal(executableRun.status, 0, executableRun.stderr)
		console.log(JSON.stringify({ upgrades: readUpgradeSummaries(output) }))

		// confirm the branch reached the remote
		const branch = executableRun.stdout.match(/Pull request ready from (\S+)/)?.[1]
		assert.ok(branch, executableRun.stdout)
		execFileSync("git", ["--git-dir", remote, "rev-parse", "--verify", `refs/heads/${branch}`])

		// confirm the stub saw the pull request and no hook ran
		assert.match(readFileSync(ghCallsPath, "utf8"), /^pr create --head /m)
		assert.equal(existsSync(markerPath), false)
	} finally {
		rmSync(workspace, { recursive: true, force: true })
	}
})

for (const signal of ["SIGTERM", "SIGINT"] as const) {
	test(`${signal} stops the executable and deletes its sandboxes`, { skip, timeout: 900_000 }, async (context) => {
		const runta = new Runta({ token: process.env.RUNTA_TOKEN, endpoint: "https://api.runta.com", timeoutMs: 30_000 })
		const sandboxNamesBefore = await listSandboxNames(runta)

		// send the signal once the log shows the sandbox
		const signalRun = await runCommand(executablePath, checkArgs, {
			signal,
			signalAfter: "◆ Sandbox created",
			testSignal: context.signal,
		})
		assert.equal(signalRun.status, 1, signalRun.stdout + signalRun.stderr)
		assert.match(signalRun.stdout, /◆ Sandbox created/)
		assert.match(signalRun.stderr, /The inspection was stopped/)
		assert.match(signalRun.stdout, /◆ Sandbox deleted/)

		// confirm no sandbox from this run is left
		assert.deepEqual(await waitForLeftoverSandboxNames(runta, sandboxNamesBefore), [])
	})
}

// wait up to a minute for Runta to finish deleting the sandboxes created after a listing
async function waitForLeftoverSandboxNames(runta: Runta, sandboxNamesBefore: Set<string>): Promise<string[]> {
	let leftoverSandboxNames: string[] = []
	for (let i = 0; i < 12; i++) {
		// list the new sandboxes and stop once none is left
		const sandboxNamesAfter = await listSandboxNames(runta)
		leftoverSandboxNames = [...sandboxNamesAfter].filter((name) => !sandboxNamesBefore.has(name))
		if (!leftoverSandboxNames.length) {
			return leftoverSandboxNames
		}

		// check again in five seconds
		await new Promise((resolve) => setTimeout(resolve, 5_000))
	}
	return leftoverSandboxNames
}

// clone the pull request fixture at its commit with a local remote, a stub gh and hooks that leave a marker
function prepareCheckout(workspace: string): PreparedCheckout {
	// place the checkout, the remote, the stub and the records inside the workspace
	const checkout = join(workspace, "checkout")
	const remote = join(workspace, "remote.git")
	const stubFolder = join(workspace, "bin")
	const markerPath = join(workspace, "hook-ran")
	const ghCallsPath = join(workspace, "gh-calls")

	// fetch the inspected commit with its history, as --pull-request needs, and point origin at a bare local repository
	execFileSync("git", ["init", "--quiet", "--bare", remote])
	execFileSync("git", ["init", "--quiet", checkout])
	execFileSync("git", ["-C", checkout, "fetch", "--quiet", pullRequestUrl, pullRequestCommit])
	execFileSync("git", ["-C", checkout, "checkout", "--quiet", "--detach", "FETCH_HEAD"])
	execFileSync("git", ["-C", checkout, "remote", "add", "origin", remote])

	// install hooks that would record any run
	for (const hookName of hookNames) {
		const hookPath = join(checkout, ".git", "hooks", hookName)
		writeFileSync(hookPath, `#!/bin/sh\ntouch ${JSON.stringify(markerPath)}\n`)
		chmodSync(hookPath, 0o755)
	}

	// record each gh call and report no open pull request
	mkdirSync(stubFolder)
	writeFileSync(join(stubFolder, "gh"), `#!/bin/sh\necho "$*" >> ${JSON.stringify(ghCallsPath)}\n`)
	chmodSync(join(stubFolder, "gh"), 0o755)
	return { checkout, remote, stubFolder, markerPath, ghCallsPath }
}

// summarize each tested upgrade by its Verdict and check statuses
function readUpgradeSummaries(output: string): UpgradeSummary[] {
	const reportText = readFileSync(join(output, "inspection-report.json"), "utf8")
	const report = JSON.parse(reportText) as ModelRequestSandboxInspectionReport
	return report.upgrades.map((upgrade) => ({
		dependency: upgrade.dependency,
		to: upgrade.to,
		verdict: upgrade.verdict,
		checks: [upgrade.install.status, upgrade.typecheck.status, upgrade.tests.status],
	}))
}

// name the account's Health Code sandboxes
async function listSandboxNames(runta: Runta): Promise<Set<string>> {
	const runtimes = await runta.runtimes.list()
	return new Set(runtimes.map((runtime) => String(runtime.name)).filter((name) => name.startsWith("health-code-")))
}

// the options of one command run. testSignal sends SIGTERM when the test times out, so the executable still deletes its sandbox
type RunCommandOptions = {
	cwd?: string
	path?: string
	signal?: NodeJS.Signals
	signalAfter?: string
	testSignal?: AbortSignal
}

// run a command to its end, optionally sending a signal once a line appears
function runCommand(command: string, args: string[], options: RunCommandOptions = {}): Promise<CommandRun> {
	const environment = { ...process.env, PATH: options.path ?? process.env.PATH }
	const child = spawn(command, args, {
		cwd: options.cwd,
		env: environment,
		stdio: ["ignore", "pipe", "pipe"],
		signal: options.testSignal,
	})
	const commandRun: CommandRun = { status: null, stdout: "", stderr: "" }

	// collect the output and send the signal at most once
	let isSignalSent = false
	child.stdout.on("data", (chunk: Buffer) => {
		commandRun.stdout += chunk.toString("utf8")
		if (options.signal && options.signalAfter && !isSignalSent && commandRun.stdout.includes(options.signalAfter)) {
			isSignalSent = true
			child.kill(options.signal)
		}
	})

	// collect errors and resolve with the exit code
	child.stderr.on("data", (chunk: Buffer) => {
		commandRun.stderr += chunk.toString("utf8")
	})
	return new Promise((resolve, reject) => {
		child.on("error", reject)
		child.on("close", (status) => resolve({ ...commandRun, status }))
	})
}
