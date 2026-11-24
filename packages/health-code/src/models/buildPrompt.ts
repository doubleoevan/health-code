import { randomUUID } from "node:crypto"
import type { ModelRole } from "../agentContracts.ts"
import { redactEvidence } from "../collectEvents.ts"
import { InspectionPrompts, readInvestigationPromptTemplate } from "../readPrompt.ts"

// the most serialized evidence one prompt can hold
export const maxEvidenceBytes = 80_000

export async function buildPrompt(
	role: ModelRole,
	evidence: unknown,
	prompts = new InspectionPrompts(),
): Promise<string> {
	// Resolve the effective source for this inspection.
	return toEvidencePrompt(prompts.template(role).body, evidence)
}

/**
 * Builds downstream investigation instructions with bounded, fenced inspection evidence.
 */
export function buildInvestigationPrompt(evidence: unknown): string {
	return toEvidencePrompt(readInvestigationPromptTemplate(), evidence, 2)
}

function toEvidencePrompt(content: string, evidence: unknown, indent = 0): string {
	// remove embedded fence markers before serializing redacted evidence
	const nonce = randomUUID()
	const serialized = JSON.stringify(
		redactEvidence(evidence),
		(_key, value: unknown) =>
			typeof value === "string" ? value.replace(/<\/?untrusted-data-[A-Za-z0-9_-]*>?/gi, "") : value,
		indent,
	).replaceAll(String.fromCharCode(96), "\\u0060")

	// cap the evidence in bytes before enclosing it in a fresh fence
	const bytes = Buffer.from(serialized)
	const material =
		bytes.length > maxEvidenceBytes
			? `${bytes.subarray(0, maxEvidenceBytes).toString("utf8")}\n[Remaining evidence omitted at ${maxEvidenceBytes.toLocaleString("en-US")} bytes]`
			: serialized
	return content.replace("{{evidence}}", () => `<untrusted-data-${nonce}>\n${material}\n</untrusted-data-${nonce}>`)
}

/**
 * Parses a single structured answer, including JSON fenced for display.
 */
export function parseAnswer(text: string): unknown {
	const fence = String.fromCharCode(96).repeat(3)
	const answer = text.trim()
	if (answer.startsWith(`${fence}json`) && answer.endsWith(fence)) {
		return JSON.parse(answer.slice(fence.length + 4, -fence.length).trim())
	}
	return JSON.parse(answer)
}
