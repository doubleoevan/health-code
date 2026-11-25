import { execFile } from "node:child_process"
import { join } from "node:path"
import { promisify } from "node:util"
import type { ModelRequestSandboxInspectionReport } from "health-code"
import { UserError } from "./userError.ts"

type Upgrade = ModelRequestSandboxInspectionReport["upgrades"][number]
export type RunCommand = (file: string, args: string[]) => Promise<void>

// the committer for patches applied by the command
const committer = ["-c", "user.name=Health Code", "-c", "user.email=health-code@users.noreply.github.com"]

/**
 * Applies an upgrade's tested patches on a new branch of the current checkout and opens a pull request.
 */
export async function openPullRequest({
	upgrade,
	output,
	run = runCommand,
}: {
	upgrade: Upgrade
	output: string
	run?: RunCommand
}): Promise<string> {
	// apply the upgrade patch before any feature patch built on it
	const patches = [...upgrade.patches].sort(
		(first, second) => Number(first.role !== "upgrade") - Number(second.role !== "upgrade"),
	)
	const base = patches[0]?.base
	if (!base) {
		throw new UserError(`${upgrade.dependency} ${upgrade.to} has no tested patch to open a pull request with.`)
	}

	// start the branch at the commit the patches were tested on
	const branch = `health-code/${`${upgrade.dependency}-${upgrade.to}`.replace(/[^a-z0-9.]+/gi, "-").replace(/^-|-$/g, "")}`
	await run("git", ["switch", "--force-create", branch, base])
	for (const patch of patches) {
		await run("git", [...committer, "am", join(output, patch.filename)])
	}

	// replace the branch from an earlier run of the same upgrade
	await run("git", ["push", "--force", "origin", branch])
	const title = `Upgrade ${upgrade.dependency} to ${upgrade.to}`
	await run("gh", ["pr", "create", "--head", branch, "--title", title, "--body", toDescription(upgrade)])
	return branch
}

// describe the result only with values the library sets
function toDescription({ verdict, install, typecheck, tests }: Upgrade): string {
	return [
		"Health Code tried this upgrade in a Runta sandbox and retested the patch in a fresh checkout.",
		"",
		`- Verdict: ${verdict}`,
		`- Install: ${install.status}`,
		`- Typecheck: ${typecheck.status}`,
		`- Tests: ${tests.status}`,
	].join("\n")
}

const execute = promisify(execFile)

// name the missing tool or sign-in when a command fails
async function runCommand(file: string, args: string[]): Promise<void> {
	try {
		await execute(file, args)
	} catch {
		const step = args.find((argument) => !argument.startsWith("-") && !argument.includes("=")) ?? ""
		throw new UserError(
			`${file} ${step} failed. Run --pull-request from a full checkout of the repository with git and gh signed in.`,
		)
	}
}
