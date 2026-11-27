import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

type Step = { uses?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, string> }
type Job = {
	if?: string
	uses?: string
	permissions?: Record<string, string>
	steps?: Step[]

	// what a calling job passes to a reusable workflow
	with?: Record<string, unknown>
	secrets?: Record<string, string>
}
type Workflow = { on: Record<string, unknown>; permissions?: Record<string, string>; jobs: Record<string, Job> }

const readText = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8")
const workflowText = readText("../.github/workflows/dependency-pull-requests.yml")
const callerText = readText("../.github/workflows/health-code.yml")
const waitActionText = readText("../action/wait/action.yml")
const guideText = readText("../apps/cli/README.md")

// the only job that may hold a secret or a permission to write
const inspectionJob = "inspect"
const eventPattern = /github\.event|github\[|github\.head_ref|toJSON\(|refs\/pull|gh pr checkout|GITHUB_EVENT_PATH/
const secretPattern = /secrets[.[]|toJSON\(/
const commitReference = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/
const ownSource = { repository: "${{ job.workflow_repository }}", ref: "${{ job.workflow_sha }}" }

/**
 * Lists every rule a workflow's steps break: an action reference, an expression in a run step or a checkout.
 */
function findStepProblems(steps: Step[], place: string): string[] {
	const problems: string[] = []
	for (const [index, step] of steps.entries()) {
		// reference every action by a full commit SHA
		const name = `${place} step ${index + 1}`
		if (step.uses !== undefined && !commitReference.test(step.uses)) {
			problems.push(`${name} references an action by something other than a commit SHA`)
		}
		if (step.run?.includes("${{")) {
			problems.push(`${name} holds a workflow expression in its run step`)
		}

		problems.push(...findCheckoutProblems(step, name))
	}
	return problems
}

// check out the default branch or this workflow's own source, never a pull request
function findCheckoutProblems(step: Step, name: string): string[] {
	if (!step.uses?.startsWith("actions/checkout@")) {
		return []
	}
	const checkout = step.with ?? {}
	const isOwnSource = checkout.repository === ownSource.repository && checkout.ref === ownSource.ref
	const isDefaultBranch = checkout.repository === undefined && checkout.ref === undefined

	// keep the token out of the checkout of the workflow's own source
	if (isOwnSource && checkout["persist-credentials"] !== false) {
		return [`${name} leaves credentials in the checkout of the workflow's own source`]
	}
	return isOwnSource || isDefaultBranch
		? []
		: [`${name} checks out a ref other than the default branch or the workflow's own commit`]
}

/**
 * Lists every rule the reusable workflow breaks.
 */
function findWorkflowProblems(text: string): string[] {
	const workflow = Bun.YAML.parse(text) as Workflow
	const problems: string[] = []

	// keep event fields and pull request refs out of the whole file
	if (eventPattern.test(text)) {
		problems.push("the workflow reads an event field or a pull request ref")
	}

	// grant nothing at the top
	if (Object.keys(workflow.permissions ?? { any: "write" }).length) {
		problems.push("the workflow grants permissions outside its jobs")
	}
	for (const [name, job] of Object.entries(workflow.jobs)) {
		problems.push(...findStepProblems(job.steps ?? [], name))

		// keep secrets and write permissions in the inspection job
		const canWrite = Object.values(job.permissions ?? { any: "write" }).some((access) => access !== "read")
		if (name !== inspectionJob && (canWrite || secretPattern.test(JSON.stringify(job)))) {
			problems.push(`${name} holds a secret or a write permission`)
		}
	}
	return problems
}

/**
 * Lists every rule a calling workflow breaks.
 */
function findCallerProblems(text: string): string[] {
	const caller = Bun.YAML.parse(text) as Workflow
	const problems: string[] = []
	// start only from events that run the default branch's workflow
	const events = Object.keys(caller.on)
	if (events.some((event) => !["pull_request_target", "workflow_run", "workflow_dispatch"].includes(event))) {
		problems.push("the caller starts from an event that runs a pull request's own workflow")
	}

	// pass one secret and no other
	const secretReferences = text.match(/secrets\.\w+/g) ?? []
	if (secretReferences.join() !== "secrets.RUNTA_TOKEN") {
		problems.push("the caller references a secret other than RUNTA_TOKEN")
	}
	for (const [name, job] of Object.entries(caller.jobs)) {
		// call the reusable workflow by local path or by commit SHA, and run no step of its own
		const isLocal = job.uses === "./.github/workflows/dependency-pull-requests.yml"
		if (!isLocal && !commitReference.test(job.uses ?? "")) {
			problems.push(`${name} calls a workflow by something other than a local path or a commit SHA`)
		}
		problems.push(...findStepProblems(job.steps ?? [], name))

		// report any checkout in a caller
		if (job.steps?.some((step) => step.uses?.startsWith("actions/checkout@"))) {
			problems.push(`${name} checks out code`)
		}
	}
	return problems
}

test("the reusable workflow keeps every rule", () => {
	expect(findWorkflowProblems(workflowText)).toEqual([])
	const workflow = Bun.YAML.parse(workflowText) as Workflow
	expect(Object.keys(workflow.jobs)).toEqual(["select", inspectionJob])
	expect(workflowText.match(/secrets\.\w+/g)).toEqual(["secrets.RUNTA_TOKEN"])
})

test("a broken copy of the reusable workflow fails each rule", () => {
	const breaks: [string, string, string][] = [
		["ref: ${{ job.workflow_sha }}", "ref: ${{ github.event.pull_request.head.sha }}", "checks out a ref other than"],
		["path: repository\n", "path: repository\n          ref: refs/pull/7/head\n", "checks out a ref other than"],
		[
			"run: health-code dependency-pull-request select",
			"run: echo ${{ github.head_ref }}",
			"holds a workflow expression",
		],
		[
			"run: health-code dependency-pull-request report",
			"run: health-code report ${{ inputs.label }}",
			"holds a workflow expression",
		],
		["      statuses: read\n", "      statuses: write\n", "select holds a secret or a write permission"],
		[
			"      HEALTH_CODE_MAJOR: ${{ inputs.major }}\n",
			"      RUNTA_TOKEN: ${{ secrets.RUNTA_TOKEN }}\n",
			"select holds a secret",
		],
		[
			"actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9",
			"actions/upload-artifact@v7",
			"other than a commit SHA",
		],
		["permissions: {}\n", "permissions:\n  contents: write\n", "grants permissions outside its jobs"],
		["run: health-code dependency-pull-request select", "run: gh pr checkout 7", "reads an event field"],
		["          persist-credentials: false\n", "", "leaves credentials"],
	]
	for (const [from, to, problem] of breaks) {
		// change one line and expect the rule that guards it to fail
		expect(workflowText).toContain(from)
		const problems = findWorkflowProblems(workflowText.replace(from, to))
		expect(problems.join("\n")).toContain(problem)
	}
})

test("the wait step holds no expression in a run step and references no action by tag", () => {
	const action = Bun.YAML.parse(waitActionText) as { runs: { steps: Step[] } }
	expect(findStepProblems(action.runs.steps, "wait")).toEqual([])
	expect(eventPattern.test(waitActionText) || waitActionText.includes("actions/checkout")).toBe(false)
})

test("this repository's caller passes one secret and the model settings only", () => {
	expect(findCallerProblems(callerText)).toEqual([])
	const caller = Bun.YAML.parse(callerText) as Workflow
	const job = caller.jobs["dependency-pull-requests"]
	expect(Object.keys(job?.with ?? {})).toEqual(["model-host", "model"])
	expect(job?.secrets).toEqual({ RUNTA_TOKEN: "${{ secrets.RUNTA_TOKEN }}" })

	// grant exactly what the inspection job asks for
	const workflow = Bun.YAML.parse(workflowText) as Workflow
	expect(job?.permissions).toEqual(workflow.jobs[inspectionJob]?.permissions ?? {})
	expect(caller.permissions).toEqual({})
})

test("a broken copy of the caller fails each rule", () => {
	const breaks: [string, string, string][] = [
		[
			"uses: ./.github/workflows/dependency-pull-requests.yml",
			"uses: doubleoevan/health-code/.github/workflows/dependency-pull-requests.yml@main",
			"other than a local path or a commit SHA",
		],
		[
			"RUNTA_TOKEN: ${{ secrets.RUNTA_TOKEN }}",
			"RUNTA_TOKEN: ${{ secrets.RUNTA_TOKEN }}\n      OTHER: ${{ secrets.NPM_TOKEN }}",
			"a secret other than RUNTA_TOKEN",
		],
		[
			"    uses: ./.github/workflows/dependency-pull-requests.yml",
			"    steps:\n      - uses: actions/checkout@v7\n        with:\n          ref: refs/pull/7/head",
			"checks out code",
		],
	]
	breaks.push(["  pull_request_target:", "  pull_request:", "runs a pull request's own workflow"])
	for (const [from, to, problem] of breaks) {
		expect(callerText).toContain(from)
		expect(findCallerProblems(callerText.replace(from, to)).join("\n")).toContain(problem)
	}
})

test("the CI guide's caller matches this repository's caller", () => {
	// find the guide's workflow that calls the reusable workflow by commit
	const blocks = [...guideText.matchAll(/```yaml\n([\s\S]*?)```/g)].map((match) => match[1] ?? "")
	const guideBlock = blocks.find((block) => block.includes("dependency-pull-requests.yml@"))
	expect(guideBlock).toBeDefined()
	const guide = Bun.YAML.parse(guideBlock ?? "") as Workflow
	const caller = Bun.YAML.parse(callerText) as Workflow
	const guideJob = guide.jobs["dependency-pull-requests"]
	const callerJob = caller.jobs["dependency-pull-requests"]

	// compare everything but the reference to the reusable workflow
	expect(guide.on).toEqual(caller.on)
	expect(guide.permissions).toEqual(caller.permissions)
	expect({ ...guideJob, uses: "" }).toEqual({ ...callerJob, uses: "" })
	expect(guideJob?.uses).toMatch(/^doubleoevan\/health-code\/\.github\/workflows\/dependency-pull-requests\.yml@/)
})

test("the CI guide's wait step is the action this repository ships", () => {
	const blocks = [...guideText.matchAll(/```yaml\n([\s\S]*?)```/g)].map((match) => match[1] ?? "")
	const waitBlock = blocks.find((block) => block.includes("action/wait@"))
	const steps = Bun.YAML.parse(waitBlock ?? "") as Step[]
	expect(steps[0]?.uses).toMatch(/^doubleoevan\/health-code\/action\/wait@/)

	// document every input the action declares
	const action = Bun.YAML.parse(waitActionText) as { inputs: Record<string, unknown> }
	for (const input of Object.keys(action.inputs).filter((name) => name !== "token")) {
		expect(guideText).toContain(`| \`${input}\` |`)
	}
})
