import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import type { ModelRole } from "./agentContracts.ts"

import { redactEvidence } from "./collectEvents.ts"

export async function buildPrompt(role: ModelRole, evidence: unknown): Promise<string> {
	// load the role's prompt and strip its metadata
	const template = await readFile(new URL(`../prompts/${role}.md`, import.meta.url), "utf8")
	const content = template.replace(/^---\n[\s\S]*?\n---\n/, "").trim()
	// remove embedded fence markers before serializing redacted evidence
	const nonce = randomUUID()
	const serialized = JSON.stringify(redactEvidence(evidence), (_key, value: unknown) =>
		typeof value === "string" ? value.replace(/<\/?untrusted-data-[A-Za-z0-9_-]*>?/gi, "") : value,
	).replaceAll(String.fromCharCode(96), "\\u0060")
	// cap the evidence in bytes before enclosing it in a fresh fence
	const bytes = Buffer.from(serialized)
	const material =
		bytes.length > 80000
			? `${bytes.subarray(0, 80000).toString("utf8")}\n[Remaining evidence omitted at 80,000 bytes]`
			: serialized
	return content.replace("{{evidence}}", () => `<untrusted-data-${nonce}>\n${material}\n</untrusted-data-${nonce}>`)
}

/** Parses a single structured answer, including JSON fenced for display. */
export function parseAnswer(text: string): unknown {
	const fence = String.fromCharCode(96).repeat(3)
	const answer = text.trim()
	if (answer.startsWith(`${fence}json`) && answer.endsWith(fence)) {
		return JSON.parse(answer.slice(fence.length + 4, -fence.length).trim())
	}
	return JSON.parse(answer)
}
