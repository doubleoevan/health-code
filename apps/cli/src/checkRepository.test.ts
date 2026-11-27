import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { createFakeSandboxProvider } from "health-code"
import { checkRepository, readCheckArguments } from "./checkRepository.ts"
import { modelSettings } from "./fixtures/inspectionSettings.ts"
import { modelRequestSandboxFixture } from "./fixtures/modelRequestSandboxInspection.ts"
import { createPublicProject } from "./fixtures/publicProject.ts"
import { repositoryUrl, runCheck } from "./fixtures/runCheck.ts"
import { openPullRequest, type RunCommand } from "./openPullRequest.ts"
import { readGithubToken } from "./readEnvironmentSettings.ts"

test("check arguments require a complete target and keep equals signs in test values", () => {
	const parsed = readCheckArguments([repositoryUrl, "--env", "URL=a=b", "--env", "BUDGET=1"])
	assert.deepEqual(parsed.applicationEnvironment, { URL: "a=b", BUDGET: "1" })
	assert.equal(readCheckArguments([repositoryUrl]).applicationEnvironment, undefined)

	// reject missing, partial and unknown arguments
	for (const args of [[], [repositoryUrl, "--to", "2.0.0"], [repositoryUrl, "--env", "BUDGET"], ["--unknown"]]) {
		assert.throws(() => readCheckArguments(args), /Usage: health-code check/)
	}
})

test("check writes the report and its verified patch", async () => {
	const { provider, mailbox, restore } = await modelRequestSandboxFixture({
		makeProvider: createFakeSandboxProvider,
		githubToken: "github-token",
		selectedUpgrade: { to: "1.3.0" },
	})
	const publicProject = await createPublicProject()
	const output = await mkdtemp(join(tmpdir(), "health-code-check-"))
	const lines: string[] = []
	try {
		// leave a patch from an earlier check beside an unrelated one
		const earlier = { upgrades: [{ patches: [{ filename: "earlier.patch" }, { filename: "../escape.patch" }] }] }
		await writeFile(join(output, "inspection-report.json"), JSON.stringify(earlier))
		await writeFile(join(output, "earlier.patch"), "old")
		await writeFile(join(output, "kept.txt"), "kept")

		// run the same paid entry point a CI job uses
		const commands: string[] = []
		const result = await checkRepository([repositoryUrl, "--output", output, "--pull-request"], {
			environment: { ...modelSettings, RUNTA_TOKEN: "runta-token", GITHUB_TOKEN: "github-token" },
			signal: new AbortController().signal,
			sandboxProvider: provider,
			request: publicProject.request,
			log: (line) => lines.push(line),
			run: async (file, args) => {
				// keep the checkout's hooks away from the patched code
				assert.ok(file !== "git" || args.includes("core.hooksPath=/dev/null"))
				commands.push([file, ...args.filter((argument) => !/^(-c|(core|user)\..*)$/.test(argument))].join(" "))
				return ""
			},
		})
		assert.equal(result.isComplete, true)

		// compare the saved patch with the verified bytes
		const files = await readdir(output)
		const patch = files.find((file) => file.endsWith(".patch"))
		assert.ok(patch && files.includes("inspection-report.json") && files.includes("upgrade-menu.json"))
		assert.ok(files.includes("kept.txt") && !files.includes("earlier.patch"))
		assert.equal(await readFile(join(output, patch), "utf8"), mailbox)

		// report the number of saved patches
		assert.ok(lines.some((line) => line.endsWith("1 patch")))

		// apply the saved patch on its own branch and open one pull request
		const branch = commands[0]?.split(" ")[3]
		assert.match(branch ?? "", /^health-code\/[a-z0-9.-]+$/)
		assert.deepEqual(
			commands.map((command) => command.split(" ").slice(0, 2).join(" ")),
			["git switch", "git am", "git push", "git checkout", "gh api", "gh pr"],
		)
		assert.ok(commands[1]?.endsWith(join(output, patch)))
		assert.ok(commands[4]?.includes(`state=open&head={owner}:${branch}`))
		assert.ok(commands[5]?.includes(`--head ${branch}`) && commands[5].includes("Verdict: "))

		// update the pull request a second run finds open
		const { upgrades } = JSON.parse(await readFile(join(output, "inspection-report.json"), "utf8"))
		const reruns: string[] = []
		await openPullRequest({
			upgrade: upgrades[0],
			output,
			run: async (file, args) => {
				reruns.push([file, ...args].join(" "))
				return args.includes("--jq") ? "7\n" : ""
			},
		})
		assert.ok(reruns.at(-1)?.startsWith("gh api --method PATCH repos/{owner}/{repo}/pulls/7 "))
		assert.ok(reruns.at(-1)?.includes("Verdict: ") && !reruns.some((command) => command.startsWith("gh pr create")))

		// say which package manager version wrote the lockfile
		const describe = async (packageManager: object): Promise<string> => {
			const described: string[] = []
			await openPullRequest({
				upgrade: upgrades[0],
				output,
				packageManager: packageManager as Parameters<typeof openPullRequest>[0]["packageManager"],
				run: async (file, args) => {
					described.push([file, ...args].join(" "))
					return ""
				},
			})
			return described.at(-1) ?? ""
		}
		const declared = {
			name: "bun",
			version: "1.4.4",
			source: "declared",
			declared: { version: "1.4.4", file: ".bun-version" },
		}
		assert.ok(
			(await describe(declared)).includes("- Lockfile written by Bun 1.4.4, the version this repository declares."),
		)
		const bundled = {
			name: "bun",
			version: "1.4.3",
			source: "bundled",
			fallbackReason: "the declared 1.4.9 was published less than a day ago",
		}
		assert.ok(
			(await describe(bundled)).includes(
				"- Lockfile written by Bun 1.4.3, bundled with Health Code, because the declared 1.4.9 was published less than a day ago.",
			),
		)
		assert.ok(!(await describe({ name: "npm", version: "11; rm -rf /" })).includes("Lockfile written"))

		// clear a patch that fails to apply and return to the starting commit
		const failures: string[] = []
		const failing = openPullRequest({
			upgrade: upgrades[0],
			output,
			run: async (_file, args) => {
				failures.push(args.slice(6).join(" "))
				if (failures.length === 2) {
					throw new Error("patch does not apply")
				}
				return ""
			},
		})
		await assert.rejects(failing, /patch does not apply/)
		assert.deepEqual(failures.slice(2), ["am --abort", "checkout -"])
	} finally {
		restore()
		await rm(output, { recursive: true, force: true })
	}
})

test("upgrade only requests no feature match and runs no feature adoption", async () => {
	const result = await runCheck(["--upgrade-only"], { selectedUpgrade: { to: "1.3.0" } })
	const complete = await runCheck([], { selectedUpgrade: { to: "1.3.0" } })
	try {
		assert.deepEqual(complete.roles, ["open", "releaseSummary", "featureMatch", "close"])
		assert.deepEqual(result.roles, ["open", "releaseSummary", "close"])
		assert.deepEqual(result.phases, [])
		assert.ok(complete.phases.length)

		// check that the report holds no match and no feature patch
		const report = JSON.parse(await readFile(join(result.output, "inspection-report.json"), "utf8"))
		assert.deepEqual(report.upgrades[0].featureMatches, [])
		assert.ok(report.upgrades[0].patches.length <= 1)
		assert.equal(readCheckArguments([repositoryUrl, "--upgrade-only"]).isUpgradeOnly, true)
	} finally {
		// remove both output folders
		await rm(result.output, { recursive: true, force: true })
		await rm(complete.output, { recursive: true, force: true })
	}
})

test("upgrade only repairs a failing upgrade and opens the pull request with the upgrade patch alone", async () => {
	const commands: string[] = []
	const run: RunCommand = async (file, args) => {
		commands.push([file, ...args.filter((argument) => !/^(-c|(core|user)\..*)$/.test(argument))].join(" "))
		return ""
	}

	// check the same failing upgrade with the flag and with the default limit
	const selectedUpgrade = { to: "1.3.0" }
	const result = await runCheck(["--upgrade-only", "--pull-request"], { selectedUpgrade, shouldRepair: true, run })
	const complete = await runCheck([], { selectedUpgrade, shouldRepair: true })
	try {
		// check that the repair ran and the only model requests were the release summary and the repair
		const report = JSON.parse(await readFile(join(result.output, "inspection-report.json"), "utf8"))
		const [upgrade] = report.upgrades
		const usage: { role: string; costUsd: number }[] = upgrade.modelUsage
		assert.equal(upgrade.verdict, "Fixed")
		assert.deepEqual([...new Set(usage.map((entry) => entry.role))], ["releaseSummary", "repair"])
		assert.deepEqual(result.roles, ["open", "releaseSummary", "close"])
		assert.deepEqual(upgrade.featureMatches, [])

		// check that the upper bound holds those requests and nothing reserved for a feature adoption
		const cost = usage.reduce((sum, entry) => sum + entry.costUsd, 0)
		assert.equal(report.runtimeUsage.modelReservedUsd, 0)
		assert.equal(report.runtimeUsage.totalUpperBoundUsd.toFixed(9), cost.toFixed(9))

		// check that the output holds the report and the upgrade patch
		const patches = result.files.filter((file) => file.endsWith(".patch"))
		assert.deepEqual(patches, [upgrade.patches[0].filename])
		assert.match(patches[0] ?? "", /^upgrade-[0-9a-f]{12}\.patch$/)
		assert.ok(result.files.includes("inspection-report.json"))

		// check that the branch receives that one patch before the pull request opens
		const applied = commands.filter((command) => command.startsWith("git am "))
		assert.deepEqual(applied, [`git am ${join(result.output, patches[0] ?? "")}`])
		assert.ok(commands.at(-1)?.startsWith("gh pr create --head health-code/widget-1.3.0 "))
		assert.ok(commands.at(-1)?.includes("Verdict: Fixed"))

		// check that the default limit matches the same upgrade and attempts a feature adoption
		const completeReport = JSON.parse(await readFile(join(complete.output, "inspection-report.json"), "utf8"))
		const completeUsage: { role: string }[] = completeReport.upgrades[0].modelUsage
		assert.deepEqual(
			[...new Set(completeUsage.map((entry) => entry.role))],
			["releaseSummary", "featureMatch", "repair", "featureAdoption"],
		)
		assert.equal(completeReport.upgrades[0].featureMatches.length, 1)
	} finally {
		// remove both output folders
		await rm(result.output, { recursive: true, force: true })
		await rm(complete.output, { recursive: true, force: true })
	}
})

test("the documented command for a failing pull request parses", () => {
	const parsed = readCheckArguments([
		repositoryUrl,
		"--dependency",
		"zod",
		"--to",
		"4.0.5",
		"--revision",
		"a".repeat(40),
		"--upgrade-only",
		"--pull-request",
	])
	assert.deepEqual(
		[parsed.dependency, parsed.to, parsed.revision, parsed.isUpgradeOnly, parsed.shouldOpenPullRequest],
		["zod", "4.0.5", "a".repeat(40), true, true],
	)
})

test("the GitHub token comes from the Actions variable and otherwise from the GitHub CLI's", () => {
	assert.equal(readGithubToken({ GITHUB_TOKEN: "actions", GH_TOKEN: "cli" }), "actions")
	assert.equal(readGithubToken({ GH_TOKEN: "cli" }), "cli")
	assert.equal(readGithubToken({ GITHUB_TOKEN: "${GITHUB_TOKEN}", GH_TOKEN: "cli" }), "cli")
	assert.equal(readGithubToken({}), undefined)
})
