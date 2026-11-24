import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { toAdvisoryViolations } from "./checkDependencyAdvisories.ts"

const entry = {
	advisoryId: "GHSA-abcd-1234-5678",
	packageName: "example",
	reason: "Only the unused optional transport is affected.",
	reviewedAt: "2026-11-20",
}

function toAudit(severity: string): string {
	return JSON.stringify({
		example: [
			{
				id: 12345,
				url: `https://github.com/advisories/${entry.advisoryId}`,
				title: "Affected transport",
				severity,
				vulnerable_versions: "<1.1.0",
			},
		],
	})
}

test.each(["high", "critical"])("an unreviewed %s advisory fails and a reviewed match passes", (severity) => {
	expect(toAdvisoryViolations(toAudit(severity), "[]")).toHaveLength(1)
	expect(toAdvisoryViolations(toAudit(severity), JSON.stringify([entry]))).toEqual([])
})

test("the package and stable advisory ID must both match", () => {
	const violations = toAdvisoryViolations(toAudit("high"), JSON.stringify([{ ...entry, packageName: "other" }]))
	expect(violations).toHaveLength(2)
	expect(violations.join("\n")).toContain(`remove stale exception: other ${entry.advisoryId}`)
})

test("a registry identifier covers an advisory without a GHSA URL", () => {
	const audit = toAudit("critical").replace(entry.advisoryId, "12345")
	expect(toAdvisoryViolations(audit, JSON.stringify([{ ...entry, advisoryId: "12345" }]))).toEqual([])
})

test.each(["low", "moderate", "info"])("%s advisories need no exception", (severity) => {
	expect(toAdvisoryViolations(toAudit(severity), "[]")).toEqual([])
})

test("a clean audit passes and a stale exception fails", () => {
	expect(toAdvisoryViolations("{}", "[]")).toEqual([])
	expect(toAdvisoryViolations("{}", JSON.stringify([entry]))).toEqual([
		`remove stale exception: example ${entry.advisoryId}`,
	])
})

test.each(["", "connection refused", "[]", '{"example":[{}]}'])("invalid audit output fails closed", (output) => {
	expect(() => toAdvisoryViolations(output, "[]")).toThrow()
})

test.each([{ reason: " " }, { reviewedAt: "2026-02-30" }, { advisoryId: "" }, { packageName: "" }, { extra: true }])(
	"invalid exception metadata fails",
	(fields) => {
		expect(() => toAdvisoryViolations("{}", JSON.stringify([{ ...entry, ...fields }]))).toThrow()
	},
)

test("the advisory job runs independently of preflight", () => {
	const workflow = Bun.YAML.parse(readFileSync(".github/workflows/ci.yml", "utf8")) as {
		jobs: Record<string, { needs?: string | string[]; steps: { run?: string }[] }>
	}

	// require the registry job to report failures independently of the offline gate
	expect(workflow.jobs.advisories?.steps.map((step) => step.run)).toContain("bun run check:advisories")
	expect(JSON.stringify(workflow.jobs.advisories)).not.toContain("continue-on-error")
	expect(workflow.jobs.gate?.needs).toBeUndefined()
	expect(workflow.jobs.gate?.steps.map((step) => step.run)).toContain("bash scripts/preflight.sh")
})
