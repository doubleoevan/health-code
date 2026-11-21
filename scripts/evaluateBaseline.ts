import { randomUUID } from "node:crypto"
import { readFile, rename, unlink, writeFile } from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"
import { type ReportCard, testInventorySummarySchema } from "health-code"
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
	finish: (card: ReportCard) => Promise<z.infer<typeof testInventorySummarySchema>>
}> {
	const original = await readFile(path, "utf8")
	const fixture = baselineCase.parse(JSON.parse(original))
	if (!record && (fixture.review !== "reviewed" || !fixture.expected)) {
		throw new Error("CarlNotes Baseline awaits review")
	}
	return {
		fixture,
		finish: async (card: ReportCard): Promise<z.infer<typeof testInventorySummarySchema>> => {
			const parsed = testInventorySummarySchema.safeParse(card.baseline.tests.inventory)
			const observed = parsed.data
			if (
				card.repository.commit !== fixture.commit ||
				card.upgrades.length ||
				card.baseline.install.status !== "passed" ||
				!observed ||
				card.baseline.tests.status === "untested" ||
				!card.timeline.some((event) => event.type === "sandbox.event" && event.action === "deleted")
			) {
				const result = card.baseline.tests
				const incomplete = [card.baseline.install, result].find((check) => check.status !== "passed")
				const evidence = incomplete?.evidence.at(-1)
				throw new Error(
					"Incomplete Baseline: " +
						JSON.stringify({
							packageManager: card.packageManager,
							install: card.baseline.install.status,
							tests: result.status,
							reason: result.status === "untested" ? result.reason : undefined,
							diagnostic: evidence?.stderr.slice(-500),
						}),
				)
			}
			const sorted = {
				...observed,
				testFileErrors: [...observed.testFileErrors].sort((a, b) => a.file.localeCompare(b.file)),
			}
			if (record) {
				const temporary = new URL(`${path.href}.${randomUUID()}`)
				try {
					await writeFile(
						temporary,
						`${JSON.stringify({ ...JSON.parse(original), review: "pending-review", expected: sorted }, null, "\t")}\n`,
						{ flag: "wx" },
					)
					if ((await readFile(path, "utf8")) !== original) {
						throw new Error("Case file changed during measurement")
					}
					await rename(temporary, path)
				} finally {
					await unlink(temporary).catch(() => {})
				}
			} else if (!isDeepStrictEqual(sorted, fixture.expected)) {
				throw new Error(`Baseline drift: ${JSON.stringify({ expected: fixture.expected, observed })}`)
			}
			return sorted
		},
	}
}
