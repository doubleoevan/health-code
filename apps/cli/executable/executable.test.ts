import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { libraryVersion, readPackageFileDigests } from "health-code"
import { type CommandRun, npmCliPath, toExecutablePath, toPlatformName } from "./checkExecutable.ts"

// the two builds under test, skipped until both exist
const platformName = toPlatformName(process.platform, process.arch)
const executablePath = toExecutablePath(platformName)
const hasBuilds = platformName !== undefined && existsSync(executablePath) && existsSync(npmCliPath)
const skip = hasBuilds ? false : "Run bun run test:executable to build the executable and the npm command first."

// the arguments whose output must match the npm command's
const parityCases = [
	["--version"],
	[],
	["help"],
	["setup", "--extra"],
	["check"],
	["check", "https://github.com/example/project", "--unknown"],
	["check", "https://github.com/example/project", "--dependency", "zod"],
	["check", "https://github.com/example/project"],
	["setup"],
	["target"],
	["target", "https://github.com/example/project"],
	["target", "https://github.com/example/project/pull/7", "--unknown"],
	["wait", "--extra"],
	["dependency-pull-request"],
	["dependency-pull-request", "merge"],
]

test("the executable prints the same output and exit codes as the npm command", { skip }, () => {
	for (const args of parityCases) {
		const executableRun = runCommand(executablePath, args)
		const npmRun = runCommand("node", [npmCliPath, ...args])
		assert.deepEqual(executableRun, npmRun, `health-code ${args.join(" ")}`)
	}
	assert.equal(runCommand(executablePath, ["--version"]).stdout, `health-code ${libraryVersion}\n`)
})

test("the executable embeds every package file with the workspace bytes", { skip }, () => {
	const description = JSON.parse(runCommand(executablePath, ["--version", "--json"]).stdout)
	const digests = readPackageFileDigests()
	assert.match(description.runtime, /^bun /)
	assert.deepEqual(description.files, Object.fromEntries(digests.map(({ path, sha256 }) => [path, sha256])))
})

test("the executable ignores runtime configuration in its working directory", { skip }, () => {
	const checkout = mkdtempSync(join(tmpdir(), "health-code-checkout-"))
	try {
		// write a preload script that leaves a marker, and a setting the command would read
		const markerPath = join(checkout, "preloaded")
		writeFileSync(join(checkout, "preload.js"), `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "")\n`)
		writeFileSync(join(checkout, "bunfig.toml"), 'preload = ["./preload.js"]\n')
		writeFileSync(join(checkout, ".env"), "HEALTH_CODE_MODEL=claude-opus-5-5\n")

		// run a check that stops at the missing settings
		const checkRun = runCommand(executablePath, ["check", "https://github.com/example/project"], checkout)
		assert.equal(checkRun.status, 1)
		assert.match(checkRun.stderr, /HEALTH_CODE_MODEL in your environment/)
		assert.equal(existsSync(markerPath), false)
	} finally {
		rmSync(checkout, { recursive: true, force: true })
	}
})

// run a command with no settings in its environment
function runCommand(command: string, args: string[], cwd?: string): CommandRun {
	const home = mkdtempSync(join(tmpdir(), "health-code-home-"))
	try {
		// give the command an empty home and only the path to find tools
		const environment = { PATH: process.env.PATH, HOME: home }
		const commandRun = spawnSync(command, args, { cwd, env: environment, encoding: "utf8", timeout: 30_000 })
		return { status: commandRun.status, stdout: commandRun.stdout, stderr: commandRun.stderr }
	} finally {
		rmSync(home, { recursive: true, force: true })
	}
}
