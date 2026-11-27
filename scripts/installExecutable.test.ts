import { afterEach, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

// the options each install case changes
type InstallOptions = {
	runnerOs?: string
	checksum?: string
	isAttested?: boolean
	hasRelease?: boolean
	actionRef?: string
	versionInput?: string

	// whether a workflow names the checkout in place of an action's own path
	hasSourcePath?: boolean
	isSourceDigestRequired?: boolean
}

// what one install run left behind
type InstallRun = { status: number | null; stderr: string; workspace: string; githubPath: string; calls: string }

// the script under test, the gh stub and the stub release
const scriptPath = fileURLToPath(new URL("../action/install-executable.sh", import.meta.url))
const ghStubPath = fileURLToPath(new URL("./fixtures/stub-gh.sh", import.meta.url))
const version = "9.9.9"
const executableName = `health-code-${version}-linux-x64`
const executableText = `#!/bin/sh\necho "health-code ${version}"\n`
const workspaces: string[] = []

afterEach(() => {
	for (const workspace of workspaces.splice(0)) {
		rmSync(workspace, { recursive: true, force: true })
	}
})

test("installs a verified executable on PATH", () => {
	const installRun = runInstall()
	expect(installRun.status).toBe(0)

	// expect the executable on the recorded PATH folder and the exact attestation identity
	const bin = installRun.githubPath.trim()
	expect(bin).toBe(join(installRun.workspace, "runner", "health-code", "bin"))
	expect(spawnSync(join(bin, "health-code"), ["--version"]).stdout.toString()).toBe(`health-code ${version}\n`)
	expect(installRun.calls).toContain(
		`--signer-workflow doubleoevan/health-code/.github/workflows/release.yml --source-ref refs/tags/v${version} --deny-self-hosted-runners`,
	)
})

test("requires the build from the action's commit when the action is referenced by commit", () => {
	const actionCommit = "a".repeat(40)
	expect(runInstall({ actionRef: actionCommit }).calls).toContain(
		`--source-ref refs/tags/v${version} --source-digest ${actionCommit} --deny-self-hosted-runners`,
	)

	// skip the commit check for a tag reference or a named version
	expect(runInstall({ actionRef: "v9.9.9" }).calls).not.toContain("--source-digest")
	expect(runInstall({ actionRef: actionCommit, versionInput: version }).calls).not.toContain("--source-digest")
})

test("a workflow names its own checkout and requires its commit only when another repository calls it", () => {
	const workflowCommit = "b".repeat(40)
	const calledByCommit = runInstall({ hasSourcePath: true, actionRef: workflowCommit })
	expect(calledByCommit.status).toBe(0)
	expect(calledByCommit.calls).toContain(`--source-digest ${workflowCommit}`)

	// a call by local path installs the release the checkout's package version names, with the tag's provenance
	const calledByLocalPath = runInstall({ hasSourcePath: true })
	expect(calledByLocalPath.status).toBe(0)
	expect(calledByLocalPath.calls).toContain(`--source-ref refs/tags/v${version} --deny-self-hosted-runners`)
	expect(calledByLocalPath.calls).not.toContain("--source-digest")
})

test("stops when a caller requires the commit check and names no commit", () => {
	const installRun = runInstall({ hasSourcePath: true, isSourceDigestRequired: true })
	expectNothingInstalled(installRun, "The workflow's own commit is unknown")
	expect(runInstall({ hasSourcePath: true, isSourceDigestRequired: true, actionRef: "c".repeat(40) }).status).toBe(0)
})

test("refuses a download that does not match the release checksum", () => {
	expectNothingInstalled(runInstall({ checksum: "0".repeat(64) }), "does not match the checksum")
})

test("refuses an executable without build provenance from the release workflow", () => {
	expectNothingInstalled(runInstall({ isAttested: false }), "has no build provenance")
})

test("names the supported platforms and npx on another runner", () => {
	const installRun = runInstall({ runnerOs: "Windows" })
	expectNothingInstalled(installRun, "Linux x64, Linux arm64 and macOS arm64")
	expect(installRun.stderr).toContain(`npx health-code@${version} with Node 22.18 or later`)
})

test("names a release that has no executable", () => {
	expectNothingInstalled(runInstall({ hasRelease: false }), `Release v${version} of doubleoevan/health-code has no`)
})

// run the install script against a stub gh, a stub release and the action's default version
function runInstall({
	runnerOs = "Linux",
	checksum,
	isAttested = true,
	hasRelease = true,
	actionRef = "",
	versionInput = "",
	hasSourcePath = false,
	isSourceDigestRequired = false,
}: InstallOptions = {}): InstallRun {
	const workspace = mkdtempSync(join(tmpdir(), "health-code-action-"))
	workspaces.push(workspace)

	// lay out the action checkout, the runner folders and the stub folders
	const folders = ["action/packages/health-code", "runner", "release", "bin"].map((name) => join(workspace, name))
	for (const folder of folders) {
		mkdirSync(folder, { recursive: true })
	}
	writeFileSync(join(workspace, "action/packages/health-code/package.json"), JSON.stringify({ version }))
	copyFileSync(ghStubPath, join(workspace, "bin/gh"))
	chmodSync(join(workspace, "bin/gh"), 0o755)

	// publish the stub executable and its checksum file
	if (hasRelease) {
		const digest = checksum ?? createHash("sha256").update(executableText).digest("hex")
		writeFileSync(join(workspace, "release", executableName), executableText)
		writeFileSync(join(workspace, "release", `health-code-${version}.sha256`), `${digest}  ${executableName}\n`)
	}

	// run the script the way the composite action does
	const githubPath = join(workspace, "github-path")
	const calls = join(workspace, "gh-calls")
	writeFileSync(githubPath, "")
	writeFileSync(calls, "")
	const environment = {
		PATH: `${join(workspace, "bin")}:${process.env.PATH}`,
		...(hasSourcePath
			? { HEALTH_CODE_SOURCE_PATH: join(workspace, "action") }
			: { GITHUB_ACTION_PATH: join(workspace, "action") }),
		GITHUB_PATH: githubPath,
		RUNNER_OS: runnerOs,
		RUNNER_ARCH: "X64",
		RUNNER_TEMP: join(workspace, "runner"),
		STUB_RELEASE: join(workspace, "release"),
		STUB_ATTESTATION: isAttested ? "pass" : "fail",
		STUB_CALLS: calls,
		HEALTH_CODE_ACTION_REF: actionRef,
		HEALTH_CODE_VERSION: versionInput,
		HEALTH_CODE_SOURCE_DIGEST_REQUIRED: String(isSourceDigestRequired),
	}
	const scriptRun = spawnSync("bash", [scriptPath], { env: environment })
	return {
		status: scriptRun.status,
		stderr: scriptRun.stderr.toString(),
		workspace,
		githubPath: readFileSync(githubPath, "utf8"),
		calls: readFileSync(calls, "utf8"),
	}
}

// expect a failure that names its cause and leaves no executable or PATH entry behind
function expectNothingInstalled(installRun: InstallRun, cause: string): void {
	expect(installRun.status).toBe(1)
	expect(installRun.stderr).toContain(cause)
	expect(installRun.githubPath).toBe("")
	expect(existsSync(join(installRun.workspace, "runner", "health-code"))).toBe(false)
}
