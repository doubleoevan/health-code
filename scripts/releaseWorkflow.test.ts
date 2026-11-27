import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

type Step = { uses?: string; run?: string; env?: Record<string, string> }
type Job = { needs?: string | string[]; permissions?: Record<string, string>; steps: Step[] }
type Workflow = { permissions: Record<string, string>; jobs: Record<string, Job> }

const workflowText = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8")
const workflow = Bun.YAML.parse(workflowText) as Workflow

test("only the publish job can write to the repository, and it runs no repository code", () => {
	expect(workflow.permissions).toEqual({ contents: "read" })

	// find every job that grants contents write
	const writingJobs = Object.entries(workflow.jobs).filter(([, job]) => job.permissions?.contents === "write")
	expect(writingJobs.map(([name]) => name)).toEqual(["publish-executables"])

	// keep the checkout and every build or test command out of the publish job
	const publishSteps = workflow.jobs["publish-executables"]?.steps ?? []
	expect(publishSteps.some((step) => step.uses?.startsWith("actions/checkout"))).toBe(false)
	expect(publishSteps.some((step) => /^\s*(bun|bunx|npm|npx|node|bash scripts)\b/m.test(step.run ?? ""))).toBe(false)
})

test("the executables build and publish before npm staging, and only staging sees the npm token", () => {
	expect(workflow.jobs["build-executable"]?.permissions).toEqual({ contents: "read" })
	expect(workflow.jobs["publish-executables"]?.needs).toBe("build-executable")
	expect(workflow.jobs.stage?.needs).toBe("publish-executables")

	// name each job whose text mentions the npm token
	const tokenJobs = Object.entries(workflow.jobs).filter(([, job]) => JSON.stringify(job).includes("NPM_TOKEN"))
	expect(tokenJobs.map(([name]) => name)).toEqual(["stage"])
})
