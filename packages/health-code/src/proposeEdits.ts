import { z } from "zod"

const packageName = z.string().regex(/^(?:@[a-z0-9-]+\/)?[a-z0-9][\w.-]*$/)

const dependency = z.object({
	name: packageName,
	version: z.string().regex(/^\d+\.\d+\.\d+$/),
	reason: z.string().min(1),
})

export function readDecision(input: unknown): z.infer<typeof decision> {
	if (input && typeof input === "object" && "retry" in input) {
		throw new Error(
			input.retry === "output-limit"
				? "Response reached its token limit. Submit one short edit for one file."
				: "No edit tool call was submitted. Call proposeEdits with one action or a diagnosis.",
		)
	}
	return decision.parse(input)
}

export const decision = z.object({
	reason: z.string().min(1).max(4000),
	edits: z
		.array(
			z.union([
				z.object({ file: z.string(), search: z.string().min(1), replacement: z.string() }),
				z.object({ file: z.string(), contents: z.string().max(65536) }),
			]),
		)
		.max(24),
	dependency: dependency.optional(),
	dependencies: z.array(dependency).max(5).optional(),
	behaviorChange: z
		.object({
			source: z.string().min(1).max(2048),
			quote: z.string().min(8).max(800),
			symbol: z.string().regex(/^[A-Za-z_$][\w$]*$/),
		})
		.optional(),
	removeDependency: packageName.optional(),
	restart: z
		.literal(true)
		.optional()
		.describe(
			"Discard this attempt’s proposed commits and return to its original candidate tree. The same time, turn and cost ceilings continue.",
		),
	readTests: z.array(z.string().min(1).max(512)).min(1).max(3).optional(),
	lookup: z.array(packageName).min(1).max(5).optional(),
})

export const editToolBytes = Buffer.byteLength(JSON.stringify(z.toJSONSchema(decision))) + 512
