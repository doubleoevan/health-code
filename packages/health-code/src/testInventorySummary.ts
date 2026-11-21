import { z } from "zod"

const count = z.number().int().nonnegative()
const counts = z.object({ passed: count, failed: count, skipped: count, todo: count })
const testFileErrors = z.array(z.object({ file: z.string(), reason: z.string() }))

/** Reads current and earlier test measurements into the public Report Card shape. */
export const testInventorySummarySchema = z.union([
	z.object({ counts, testFileErrors }),
	z
		.object({ counts, exclusions: testFileErrors, testFileErrors: z.undefined().optional() })
		.transform(({ counts, exclusions }) => ({ counts, testFileErrors: exclusions })),
])
