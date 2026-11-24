import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { parseArgs } from "node:util"
import type { ModelRequestSandboxInspectionReport } from "health-code"
import { z } from "zod"
import { inspectWithAccount } from "./inspectWithAccount.ts"
import { accountToken, requireSettings, UserError } from "./modelSettings.ts"
import { type PersonalProvider, personalProvider } from "./personalModelRequestSandboxes.ts"
import { toEventLine } from "./toEventLine.ts"
import type { Inspect } from "./trackInspections.ts"

type CheckArguments = {
	repositoryUrl: string
	revision?: string
	dependency?: string
	to?: string
	output: string
	applicationEnvironment?: Record<string, string>
}

// the arguments shown for an invalid command
export const checkUsage =
	"Usage: health-code check <repo-url> [--dependency <name> --to <version>] [--revision <sha>] [--env NAME=value] [--output <folder>]"

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
	}: {
		environment: NodeJS.ProcessEnv
		signal: AbortSignal
		sandboxProvider?: PersonalProvider
		log?: (line: string) => void
	},
): Promise<{ isComplete: boolean }> {
	const request = readCheckArguments(args)
	requireSettings(environment)
	const provider = sandboxProvider ?? (await personalProvider(accountToken(environment)))

	// print step and sandbox progress without command output
	const inspect = (choice: Partial<Parameters<Inspect>[0]>): Promise<ModelRequestSandboxInspectionReport> =>
		inspectWithAccount(
			{
				...choice,
				repositoryUrl: request.repositoryUrl,
				sandboxProvider: provider,
				applicationEnvironment: request.applicationEnvironment,
				signal,
				onEvent: (event) => {
					if (event.type !== "detail") {
						log(toEventLine(event))
					}
				},
			},
			environment,
		)
	const report = await inspect(await selectTarget(request, inspect))

	// save the complete evidence beside each replayable patch
	await mkdir(request.output, { recursive: true })
	await removePreviousPatches(request.output)
	await writeFile(join(request.output, "inspection-report.json"), `${JSON.stringify(report, null, 2)}\n`)
	for (const upgrade of report.upgrades) {
		for (const patch of upgrade.patches) {
			await writeFile(join(request.output, patch.filename), patch.mailbox)
		}
		log(
			`${upgrade.dependency} ${upgrade.to}: ${upgrade.verdict} · ${upgrade.patches.length} ${upgrade.patches.length === 1 ? "patch" : "patches"}`,
		)
	}
	log(`Report written to ${request.output}`)
	return { isComplete: !report.stoppedReason }
}

// remove only the patches that the folder's previous report lists
async function removePreviousPatches(output: string): Promise<void> {
	const text = await readFile(join(output, "inspection-report.json"), "utf8").catch(() => undefined)
	if (!text) {
		return
	}
	const previous = z
		.object({ upgrades: z.array(z.object({ patches: z.array(z.object({ filename: z.string() })) })) })
		.parse(JSON.parse(text))

	// keep deletion inside the output folder
	for (const { filename } of previous.upgrades.flatMap((upgrade) => upgrade.patches)) {
		if (basename(filename) === filename && filename.endsWith(".patch")) {
			await rm(join(output, filename), { force: true })
		}
	}
}

// pin a requested dependency to the commit that lists it as eligible
async function selectTarget(
	{ revision, dependency, to }: CheckArguments,
	inspect: (choice: Partial<Parameters<Inspect>[0]>) => Promise<ModelRequestSandboxInspectionReport>,
): Promise<Partial<Parameters<Inspect>[0]>> {
	if (!dependency) {
		return { revision, limits: { maxUpgrades: 1 } }
	}

	// reject a target missing from the upgrade menu
	const menu = await inspect({ revision, mode: "listUpgrades" })
	const upgrade = menu.selection.eligible.find((target) => target.dependency === dependency && target.to === to)
	if (!upgrade) {
		throw new UserError(`${dependency} ${to} is not an eligible upgrade at ${menu.repository.commit}.`)
	}
	return { revision: menu.repository.commit, upgrade, mode: "inspectUpgrades" }
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
	}
}

// the options before target validation
type ParsedArguments = {
	values: { dependency?: string; to?: string; revision?: string; output: string; env: string[] }
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
			},
		})
	} catch {
		throw new UserError(checkUsage)
	}
}
