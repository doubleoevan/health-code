import { execFile } from "node:child_process"
import { join } from "node:path"
import { promisify } from "node:util"
import { isExactVersion, type ModelRequestSandboxInspectionReport, packageManagerDisplayNames } from "health-code"
import { UserError } from "./userError.ts"

type Upgrade = ModelRequestSandboxInspectionReport["upgrades"][number]
type PackageManager = ModelRequestSandboxInspectionReport["packageManager"]
export type RunCommand = (file: string, args: string[]) => Promise<string>

// the committer for patches applied by the command. the checkout's hooks stay off while it holds model-written code
const gitSettings = [
	...["-c", "core.hooksPath=/dev/null"],
	...["-c", "user.name=Health Code", "-c", "user.email=health-code@users.noreply.github.com"],
]

/**
 * Applies an upgrade's tested patches on a new branch of the current checkout and opens or updates its pull request.
 */
export async function openPullRequest({
	upgrade,
	output,
	packageManager,
	run = runCommand,
}: {
	upgrade: Upgrade
	output: string
	packageManager?: PackageManager
	run?: RunCommand
}): Promise<string> {
	// apply the upgrade patch before any feature patch built on it
	const patches = [...upgrade.patches].sort(
		(first, second) => Number(first.role !== "upgrade") - Number(second.role !== "upgrade"),
	)
	const baseCommit = patches[0]?.base
	if (!baseCommit) {
		throw new UserError(`${upgrade.dependency} ${upgrade.to} has no tested patch to open a pull request with.`)
	}

	// start the branch at the commit the patches were tested on
	const branch = `health-code/${`${upgrade.dependency}-${upgrade.to}`.replace(/[^a-z0-9.]+/gi, "-").replace(/^-|-$/g, "")}`
	await run("git", [...gitSettings, "switch", "--force-create", branch, baseCommit])
	try {
		for (const patch of patches) {
			await run("git", [...gitSettings, "am", join(output, patch.filename)])
		}

		// replace the branch from an earlier run of the same upgrade
		await run("git", [...gitSettings, "push", "--force", "origin", branch])
	} catch (error) {
		// clear an unfinished patch so the next run can switch branches
		await run("git", [...gitSettings, "am", "--abort"]).catch(() => undefined)
		throw error
	} finally {
		// return the checkout to the commit the job started on
		await run("git", [...gitSettings, "checkout", "-"])
	}
	const pullRequestTitle = `Upgrade ${upgrade.dependency} to ${upgrade.to}`
	const pullRequestBody = toPullRequestDescription(upgrade, packageManager)

	// find the branch's open pull request. the owner filter leaves out forks with the same branch name
	const openPullRequestQuery = `repos/{owner}/{repo}/pulls?state=open&head={owner}:${branch}`
	const pullRequestNumber = (await run("gh", ["api", openPullRequestQuery, "--jq", ".[0].number // empty"])).trim()
	if (!pullRequestNumber) {
		await run("gh", ["pr", "create", "--head", branch, "--title", pullRequestTitle, "--body", pullRequestBody])
		return branch
	}

	// replace the earlier run's results
	const pullRequestPath = `repos/{owner}/{repo}/pulls/${pullRequestNumber}`
	const pullRequestFields = ["--raw-field", `title=${pullRequestTitle}`, "--raw-field", `body=${pullRequestBody}`]
	await run("gh", ["api", "--method", "PATCH", pullRequestPath, ...pullRequestFields])
	return branch
}

// describe the result only with values the library sets
function toPullRequestDescription(
	{ verdict, install, typecheck, tests }: Upgrade,
	packageManager?: PackageManager,
): string {
	return [
		"[Health Code](https://runhealthcode.dev) tried this upgrade in a [Runta](https://runta.com) sandbox and retested the patch in a fresh checkout.",
		"",
		`- Verdict: ${verdict}`,
		`- Install: ${install.status}`,
		`- Typecheck: ${typecheck.status}`,
		`- Tests: ${tests.status}`,
		...toLockfileLine(packageManager),
		"",
		"[Add it to another repository](https://github.com/doubleoevan/health-code#ci-setup)",
	].join("\n")
}

// say which package manager version wrote the lockfile, from a fixed name and a version number
function toLockfileLine(packageManager?: PackageManager): string[] {
	if (!packageManager || !("name" in packageManager) || !isExactVersion(packageManager.version)) {
		return []
	}
	const lockfileLine = `- Lockfile written by ${packageManagerDisplayNames[packageManager.name]} ${packageManager.version}`
	if (packageManager.source === "declared") {
		return [`${lockfileLine}, the version this repository declares.`]
	}

	// append the library's fallback reason
	const reason = packageManager.fallbackReason ? `, because ${packageManager.fallbackReason}` : ""
	return [`${lockfileLine}, bundled with Health Code${reason}.`]
}

const execute = promisify(execFile)

// name the missing tool or sign-in when a command fails or stalls
async function runCommand(file: string, args: string[]): Promise<string> {
	try {
		const { stdout } = await execute(file, args, { timeout: 120000 })
		return stdout
	} catch {
		const subcommand = args.find((argument) => !argument.startsWith("-") && !argument.includes("=")) ?? ""

		// point at the GitHub setting that blocks pull requests from Actions
		const actionsHint =
			file === "gh" ? " In GitHub Actions, allow it to create pull requests under Settings, Actions, General." : ""
		throw new UserError(
			`${file} ${subcommand} failed. Run --pull-request from a full checkout of the repository with git and gh signed in.${actionsHint}`,
		)
	}
}
