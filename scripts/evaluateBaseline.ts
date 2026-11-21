import { randomUUID } from "node:crypto"
import { readFile, rename, unlink, writeFile } from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"
import { type InspectionReport, testInventorySummarySchema } from "health-code"
import { z } from "zod"

const baselineCase = z.object({
	version: z.literal(1),
	id: z.literal("carlnotes-baseline"),
	kind: z.literal("baseline"),
	repositoryUrl: z.string().url(),
	commit: z.string().regex(/^[\da-f]{40}$/),
	review: z.enum(["unmeasured", "pending-review", "reviewed"]),
	expected: testInventorySummarySchema.nullable(),
})

export async function openBaseline(
	path: URL,
	record: boolean,
): Promise<{
	fixture: z.infer<typeof baselineCase>
	finish: (report: InspectionReport) => Promise<z.infer<typeof testInventorySummarySchema>>
}> {
	// load the original case and require review before scoring
	const original = await readFile(path, "utf8")
	const fixture = baselineCase.parse(JSON.parse(original))
	if (!record && (fixture.review !== "reviewed" || !fixture.expected)) {
		throw new Error("CarlNotes Baseline awaits review")
	}
	return {
		fixture,
		finish: async (report: InspectionReport): Promise<z.infer<typeof testInventorySummarySchema>> => {
			// parse the observed test inventory
			const parsed = testInventorySummarySchema.safeParse(report.baseline.tests.inventory)
			const observed = parsed.data

			// require a complete inspection of the pinned baseline
			if (
				report.repository.commit !== fixture.commit ||
				report.upgrades.length ||
				report.baseline.install.status !== "passed" ||
				!observed ||
				report.baseline.tests.status === "untested" ||
				!report.timeline.some((event) => event.type === "sandbox.event" && event.action === "deleted")
			) {
				// include the last diagnostic from the incomplete check
				const result = report.baseline.tests
				const incomplete = [report.baseline.install, result].find((check) => check.status !== "passed")
				const evidence = incomplete?.evidence.at(-1)
				throw new Error(
					"Incomplete Baseline: " +
						JSON.stringify({
							packageManager: report.packageManager,
							install: report.baseline.install.status,
							tests: result.status,
							reason: result.status === "untested" ? result.reason : undefined,
							diagnostic: evidence?.stderr.slice(-500),
						}),
				)
			}

			// normalize file order before recording or comparing results
			const sorted = {
				...observed,
				testFileErrors: [...observed.testFileErrors].sort((a, b) => a.file.localeCompare(b.file)),
			}
			if (record) {
				// stage the new measurement beside the original case
				const temporary = new URL(`${path.href}.${randomUUID()}`)
				try {
					await writeFile(
						temporary,
						`${JSON.stringify({ ...JSON.parse(original), review: "pending-review", expected: sorted }, null, "\t")}\n`,
						{ flag: "wx" },
					)

					// preserve concurrent changes to the case file
					if ((await readFile(path, "utf8")) !== original) {
						throw new Error("Case file changed during measurement")
					}
					await rename(temporary, path)
				} finally {
					// remove the temporary file after success or failure
					await unlink(temporary).catch(() => {})
				}
			} else if (!isDeepStrictEqual(sorted, fixture.expected)) {
				// report differences from the reviewed inventory
				throw new Error(`Baseline drift: ${JSON.stringify({ expected: fixture.expected, observed })}`)
			}
			return sorted
		},
	}
}
