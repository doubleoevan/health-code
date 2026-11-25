import { execFile } from "node:child_process"
import { join } from "node:path"
import { promisify } from "node:util"
import type { ModelRequestSandboxInspectionReport } from "health-code"
import { UserError } from "./userError.ts"

type Upgrade = ModelRequestSandboxInspectionReport["upgrades"][number]
export type RunCommand = (file: string, args: string[]) => Promise<string>

// the committer for patches applied by the command
const committer = ["-c", "user.name=Health Code", "-c", "user.email=health-code@users.noreply.github.com"]

/**
 * Applies an upgrade's tested patches on a new branch of the current checkout and opens or updates its pull request.
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
	const body = toDescription(upgrade)

	// find the branch's open pull request. the owner filter leaves out forks with the same branch name
	const query = `repos/{owner}/{repo}/pulls?state=open&head={owner}:${branch}`
	const openNumber = (await run("gh", ["api", query, "--jq", ".[0].number // empty"])).trim()
	if (!openNumber) {
		await run("gh", ["pr", "create", "--head", branch, "--title", title, "--body", body])
		return branch
	}

	// replace the earlier run's results
	const path = `repos/{owner}/{repo}/pulls/${openNumber}`
	await run("gh", ["api", "--method", "PATCH", path, "--raw-field", `title=${title}`, "--raw-field", `body=${body}`])
	return branch
}

// describe the result only with values the library sets
function toDescription({ verdict, install, typecheck, tests }: Upgrade): string {
	return [
		"[Health Code](https://runhealthcode.dev) tried this upgrade in a [Runta](https://runta.com) sandbox and retested the patch in a fresh checkout.",
		"",
		`- Verdict: ${verdict}`,
		`- Install: ${install.status}`,
		`- Typecheck: ${typecheck.status}`,
		`- Tests: ${tests.status}`,
		"",
		"[Add it to another repository](https://github.com/doubleoevan/health-code#ci-setup)",
	].join("\n")
}

const execute = promisify(execFile)

// name the missing tool or sign-in when a command fails
async function runCommand(file: string, args: string[]): Promise<string> {
	try {
		const { stdout } = await execute(file, args)
		return stdout
	} catch {
		const step = args.find((argument) => !argument.startsWith("-") && !argument.includes("=")) ?? ""

		// point at the GitHub setting that blocks pull requests from Actions
		const setting =
			file === "gh" ? " In GitHub Actions, allow it to create pull requests under Settings, Actions, General." : ""
		throw new UserError(
			`${file} ${step} failed. Run --pull-request from a full checkout of the repository with git and gh signed in.${setting}`,
		)
	}
}
