import { stripVTControlCharacters } from "node:util"
import { type CallToolResult, McpServer } from "@modelcontextprotocol/server"
import * as z from "zod"
import { checkoutSchema, fetchPatch, patchOutput, validateOutcome } from "./fetchPatch.ts"
import { UserError } from "./modelSettings.ts"
import { digest, inspectionId, outcomeSchema } from "./storeInspection.ts"
import { type Inspections, readOutput, toEventLine } from "./trackInspections.ts"

const offset = z.number().int().nonnegative().default(0)
function toHints(
	readOnlyHint: boolean,
	openWorldHint: boolean,
): { readOnlyHint: boolean; openWorldHint: boolean; destructiveHint: boolean; idempotentHint: boolean } {
	return { readOnlyHint, openWorldHint, destructiveHint: false, idempotentHint: !openWorldHint }
}

type ToolContext = Parameters<Parameters<McpServer["registerTool"]>[2]>[1]

function progressReporter({ mcpReq }: ToolContext): (step: string) => Promise<void> {
	const progressToken = mcpReq._meta?.progressToken
	let progress = 0
	return async (message) => {
		if (progressToken !== undefined && !mcpReq.signal.aborted) {
			// Preserve the tool result when a client drops an optional notification.
			await mcpReq
				.notify({ method: "notifications/progress", params: { progressToken, progress: ++progress, message } })
				.catch(() => {})
		}
	}
}

export function createServer(inspections: Inspections, version: string): McpServer {
	const server = new McpServer({ name: "health-code", version })
	async function respond(
		action: () => Promise<{ summary: string; details: Record<string, unknown>; lines?: string[] }>,
	): Promise<CallToolResult> {
		try {
			const { summary, details, lines } = await action()
			const body = JSON.stringify(details, null, 2)
			inspections.store.guard(body)
			const readable = [summary, ...(lines ?? [])].map((line) =>
				stripVTControlCharacters(line).replace(/[\p{Cc}\p{Cf}]/gu, " "),
			)
			// Escape terminal controls while keeping canonical bytes in structured content.
			const printable = body.replace(/[\u007f-\u009f\p{Cf}]/gu, (character) =>
				character
					.split("")
					.map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`)
					.join(""),
			)
			const text = [...readable, printable].join("\n")
			inspections.store.guard(text)
			return { content: [{ type: "text", text }], structuredContent: details }
		} catch (error) {
			const message =
				error instanceof UserError
					? error.message
					: "Request failed. Check the inspection ID, cursor and local storage."
			return { content: [{ type: "text", text: message }], isError: true }
		}
	}
	server.registerTool(
		"start_inspection",
		{
			title: "Start an inspection",
			description:
				"Inspect a public GitHub repository using your Runta and model accounts. Poll the returned ID in this process.",
			annotations: toHints(false, true),
			inputSchema: z.object({
				repositoryUrl: z
					.string()
					.max(256)
					.regex(/^https:\/\/github\.com\/[a-z\d-]+\/[\w.-]+\/?$/i),
			}),
			outputSchema: z.object({ inspectionId, pollAfterMs: z.number() }),
		},
		async ({ repositoryUrl }, ctx) =>
			respond(async () => {
				const id = await inspections.start(repositoryUrl)
				await progressReporter(ctx)(inspections.currentStep(id))
				return {
					summary: "Inspection accepted. Keep this server open and call read_inspection.",
					details: { inspectionId: id, pollAfterMs: 2000 },
				}
			}),
	)
	server.registerTool(
		"read_inspection",
		{
			title: "Read inspection progress and report card",
			description: "Read status, rolling events, pinned Runta moments, saved results and Report Card JSON pages.",
			annotations: toHints(true, false),
			inputSchema: z.object({
				inspectionId,
				afterSequence: offset,
				waitMs: z.number().int().min(0).max(5000).default(0),
				reportOffset: offset,
			}),
			outputSchema: readOutput,
		},
		async (input, ctx) =>
			respond(async () => {
				const details = await inspections.read(input, { signal: ctx.mcpReq.signal, progress: progressReporter(ctx) })
				return {
					summary: `${details.status} · ${details.failure ?? details.currentStep}`,
					lines: details.events.map(toEventLine),
					details,
				}
			}),
	)
	server.registerTool(
		"get_tested_patch",
		{
			title: "Get a tested patch by SHA-256",
			description:
				"Retrieve exact mailbox text by digest. Supply local checkout ancestry when available. Join pages without separators before verifying.",
			annotations: toHints(true, false),
			inputSchema: z.object({ inspectionId, sha256: digest, offset, checkout: checkoutSchema.optional() }),
			outputSchema: patchOutput,
		},
		async (input) =>
			respond(async () => {
				const card = await inspections.store.load(input.inspectionId)
				const details = fetchPatch(card, input)
				return {
					summary: `${details.verdict} · checkout ${details.checkout.relationship} · ${details.action}`,
					details,
				}
			}),
	)
	server.registerTool(
		"report_patch_result",
		{
			title: "Record a patch result",
			description:
				"Save the developer-reported application, test outcome and optional pull request under this inspection.",
			annotations: toHints(false, false),
			inputSchema: outcomeSchema,
			outputSchema: outcomeSchema,
		},
		async (input) =>
			respond(async () => {
				const card = await inspections.store.load(input.inspectionId)
				validateOutcome(card, input)
				await inspections.store.record(input)
				return { summary: `Recorded ${input.application} application · tests ${input.tests}`, details: input }
			}),
	)
	return server
}
