import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { parseArgs } from "node:util"
import type { ModelRequestSandboxInspectionReport } from "health-code"
import { z } from "zod"
import { type InspectOptions, inspectWithAccount } from "./inspectWithAccount.ts"
import { openPullRequest, type RunCommand } from "./openPullRequest.ts"
import { parseJson } from "./parseJson.ts"
import { type PersonalProvider, personalProvider } from "./personalModelRequestSandboxes.ts"
import { accountToken, readGithubToken, requireSettings } from "./readEnvironmentSettings.ts"
import { selectCheckTarget } from "./selectCheckTarget.ts"
import { toEventLine } from "./toEventLine.ts"
import { UserError } from "./userError.ts"

type CheckArguments = {
	repositoryUrl: string
	revision?: string
	dependency?: string
	to?: string
	applicationEnvironment?: Record<string, string>

	// where the results go
	output: string
	shouldOpenPullRequest: boolean
	isUpgradeOnly: boolean
}

// the file that holds a check's Inspection Report
const inspectionReportFilename = "inspection-report.json"

// the arguments shown for an invalid command
export const checkUsage =
	"Usage: health-code check <repo-url> [--dependency <name> --to <version>] [--revision <sha>] [--env NAME=value] [--output <folder>] [--upgrade-only] [--pull-request]"

/**
 * Tests one upgrade and writes its Inspection Report and patches for a CI job.
 */
export async function checkRepository(
	args: string[],
	{
		environment,
		signal,
		sandboxProvider,
		log = console.log,
		run,
		request,
	}: {
		environment: NodeJS.ProcessEnv
		signal: AbortSignal
		sandboxProvider?: PersonalProvider
		log?: (line: string) => void
		run?: RunCommand
		request?: typeof fetch
	},
): Promise<{ isComplete: boolean }> {
	const checkArguments = readCheckArguments(args)
	requireSettings(environment)

	// decide what to test from GitHub and the registry before any sandbox exists
	const { repositoryUrl, revision, dependency, to, output } = checkArguments
	const target = await selectCheckTarget({
		repositoryUrl,
		revision,
		dependency,
		to,
		output,
		githubToken: readGithubToken(environment),
		signal,
		request,
		log,
	})
	if (target.kind === "none") {
		await removePreviousPatches(checkArguments.output)
		await rm(join(checkArguments.output, inspectionReportFilename), { force: true })
		return { isComplete: target.isComplete }
	}
	const provider = sandboxProvider ?? (await personalProvider(accountToken(environment)))
	const limits = { ...target.choice.limits, ...(checkArguments.isUpgradeOnly && { maxFeatureMatches: 0 }) }

	// print step and sandbox progress without command output
	const inspect = (choice: Partial<InspectOptions>): Promise<ModelRequestSandboxInspectionReport> =>
		inspectWithAccount(
			{
				...choice,
				repositoryUrl: checkArguments.repositoryUrl,
				sandboxProvider: provider,
				applicationEnvironment: checkArguments.applicationEnvironment,
				signal,
				onEvent: (event) => {
					if (event.type !== "detail") {
						log(toEventLine(event))
					}
				},
			},
			environment,
		)
	const report = await inspect({ ...target.choice, limits })

	// save the complete evidence beside each replayable patch
	await mkdir(checkArguments.output, { recursive: true })
	await removePreviousPatches(checkArguments.output)
	await writeFile(join(checkArguments.output, inspectionReportFilename), `${JSON.stringify(report, null, 2)}\n`)
	for (const upgrade of report.upgrades) {
		for (const patch of upgrade.patches) {
			await writeFile(join(checkArguments.output, patch.filename), patch.mailbox)
		}
		log(
			`${upgrade.dependency} ${upgrade.to}: ${upgrade.verdict} · ${upgrade.patches.length} ${upgrade.patches.length === 1 ? "patch" : "patches"}`,
		)
	}
	log(`Report written to ${checkArguments.output}`)

	// hand each tested patch to the repository as a pull request
	for (const upgrade of checkArguments.shouldOpenPullRequest ? report.upgrades : []) {
		if (upgrade.patches.length) {
			const branch = await openPullRequest({
				upgrade,
				output: checkArguments.output,
				packageManager: report.packageManager,
				run,
			})
			log(`Pull request ready from ${branch}`)
		}
	}
	return { isComplete: !report.stoppedReason }
}

// remove only the patches that the folder's previous report lists
async function removePreviousPatches(output: string): Promise<void> {
	const text = await readFile(join(output, inspectionReportFilename), "utf8").catch(() => undefined)
	if (!text) {
		return
	}

	// skip a report that an interrupted check left unreadable
	const previous = z
		.object({ upgrades: z.array(z.object({ patches: z.array(z.object({ filename: z.string() })) })) })
		.safeParse(parseJson(text))
	if (!previous.success) {
		return
	}

	// keep deletion inside the output folder
	for (const { filename } of previous.data.upgrades.flatMap((upgrade) => upgrade.patches)) {
		if (basename(filename) === filename && filename.endsWith(".patch")) {
			await rm(join(output, filename), { force: true })
		}
	}
}

/**
 * Parses the check command and rejects incomplete targets.
 */
export function readCheckArguments(args: string[]): CheckArguments {
	const { values, positionals } = parseCheckArguments(args)
	const [repositoryUrl, ...extra] = positionals
	if (!repositoryUrl || extra.length || Boolean(values.dependency) !== Boolean(values.to)) {
		throw new UserError(checkUsage)
	}

	// split each test value at its first equals sign
	const pairs = values.env.map((pair): [string, string] => {
		const separator = pair.indexOf("=")
		if (separator < 1) {
			throw new UserError(checkUsage)
		}
		return [pair.slice(0, separator), pair.slice(separator + 1)]
	})

	// keep placeholders when the caller supplies no test values
	return {
		repositoryUrl,
		revision: values.revision,
		dependency: values.dependency,
		to: values.to,
		output: values.output,
		applicationEnvironment: pairs.length ? Object.fromEntries(pairs) : undefined,
		shouldOpenPullRequest: values["pull-request"],
		isUpgradeOnly: values["upgrade-only"],
	}
}

// the options before target validation
type ParsedArguments = {
	values: {
		dependency?: string
		to?: string
		revision?: string
		env: string[]

		// where the results go
		output: string
		"pull-request": boolean
		"upgrade-only": boolean
	}
	positionals: string[]
}

// report invalid options with the usage line
function parseCheckArguments(args: string[]): ParsedArguments {
	try {
		return parseArgs({
			args,
			allowPositionals: true,
			options: {
				dependency: { type: "string" },
				to: { type: "string" },
				revision: { type: "string" },
				output: { type: "string", default: "health-code-report" },
				env: { type: "string", multiple: true, default: [] },
				"pull-request": { type: "boolean", default: false },
				"upgrade-only": { type: "boolean", default: false },
			},
		})
	} catch {
		throw new UserError(checkUsage)
	}
}
