import { readFile } from "node:fs/promises"
import { isExactVersion, isGitObjectId, isPackageName, pullRequestTargetReasons } from "health-code"
import { z } from "zod"
import { UserError } from "../userError.ts"

// the caller's settings for the dependency pull request workflow
export type PullRequestSettings = {
	isMajorPathOn: boolean
	isRedPathOn: boolean
	redChecks: string[]

	// the label of the asked path and whether the automatic paths include feature patches
	label: string
	hasFeaturePatches: boolean

	// the week's spending cap, what a pull request gets once it is reached and the job's time limit
	weeklyCapUsd: number
	atCap: "comment" | "status"
	timeoutMinutes: number
}

// the commit status context every step reads and writes
export const statusContext = "health-code"

/**
 * Reads the workflow's settings from the environment, with the default for each one that is unset.
 */
export function readPullRequestSettings(environment: NodeJS.ProcessEnv): PullRequestSettings {
	const read = (name: string): string => environment[`HEALTH_CODE_${name}`]?.trim() ?? ""
	const redChecks = read("RED_CHECKS")
		.split(",")
		.flatMap((name) => (name.trim() ? [name.trim()] : []))
	return {
		isMajorPathOn: read("MAJOR") !== "false",
		isRedPathOn: read("RED") !== "false",
		redChecks,
		label: read("LABEL") || "health-code",
		hasFeaturePatches: read("FEATURE_PATCHES") === "true",
		weeklyCapUsd: toPositiveNumber(read("WEEKLY_CAP_USD"), 25),
		atCap: read("AT_CAP") === "status" ? "status" : "comment",
		timeoutMinutes: toPositiveNumber(read("TIMEOUT_MINUTES"), 75),
	}
}

function toPositiveNumber(text: string, fallback: number): number {
	const value = Number(text)
	return text && Number.isFinite(value) && value > 0 ? value : fallback
}

// the values a decision may hold, each checked again where it is read
const commit = z.string().refine(isGitObjectId)
const dependency = z.string().refine((name) => isPackageName(name) && !name.startsWith("-"))
const exactVersion = z.string().refine(isExactVersion)
const lockedVersion = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,64})?(?:\\+[0-9A-Za-z.-]{1,64})?$/)
const movedDependency = z.object({ dependency, from: lockedVersion, to: exactVersion })
const pullRequest = z.number().int().positive()
const startPath = z.enum(["major", "red", "asked"])

// what the select step decided: nothing, an inspection or a report without one
export const decisionSchema = z.discriminatedUnion("outcome", [
	z.object({ outcome: z.literal("none"), reason: z.string() }),
	z.object({
		outcome: z.literal("inspect"),
		startPath,
		pullRequest,
		headCommit: commit,
		baseCommit: commit,
		upgrade: movedDependency,
		movedWith: z.array(movedDependency).max(300),
	}),
	z.object({
		outcome: z.literal("report"),
		note: z.enum(["status-copy", "cap", ...pullRequestTargetReasons]),
		startPath,
		pullRequest,
		headCommit: commit.optional(),
		baseCommit: commit.optional(),
		upgrade: movedDependency.optional(),
	}),
])
export type Decision = z.infer<typeof decisionSchema>
export type InspectDecision = Extract<Decision, { outcome: "inspect" }>
export type ReportDecision = Extract<Decision, { outcome: "report" }>

/**
 * Reads the select step's decision from the environment and checks every value in it again.
 */
export function readDecision(environment: NodeJS.ProcessEnv): Decision {
	try {
		return decisionSchema.parse(JSON.parse(environment.HEALTH_CODE_DECISION ?? ""))
	} catch {
		throw new UserError("HEALTH_CODE_DECISION holds no decision from the select step.")
	}
}

// the event a workflow run started from
export type WorkflowEvent = { name: string; payload: unknown }

/**
 * Reads the event's name and the payload file the runner wrote.
 */
export async function readWorkflowEvent(environment: NodeJS.ProcessEnv): Promise<WorkflowEvent> {
	const eventPath = environment.GITHUB_EVENT_PATH
	if (!eventPath || !environment.GITHUB_EVENT_NAME) {
		throw new UserError("Run this step in GitHub Actions. GITHUB_EVENT_NAME and GITHUB_EVENT_PATH are not set.")
	}
	const payload: unknown = JSON.parse(await readFile(eventPath, "utf8"))
	return { name: environment.GITHUB_EVENT_NAME, payload }
}
