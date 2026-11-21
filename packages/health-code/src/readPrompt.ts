import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { parse } from "yaml"
import { z } from "zod"
import type { ModelRole } from "./agentContracts.ts"

export type PromptName = ModelRole | "applyPatch" | "verifyCredential"
export type PromptOverrides = Partial<Record<PromptName, string>>
export type PromptReference = { name: PromptName; version: number; sha256: string }
type Template = { reference: PromptReference; body: string }
const names = ["releaseSummary", "featureMatch", "repair", "featureAdoption", "applyPatch", "verifyCredential"] as const
const metadata = z.strictObject({
	title: z.string().trim().min(1),
	version: z.number().int().positive(),
	"model tier": z.string().trim().min(1),
	description: z.string().trim().min(1),
	updated: z.iso.date(),
})

function bundledSource(name: PromptName): string {
	return readFileSync(new URL(`../prompts/${name}.md`, import.meta.url), "utf8")
}

export function credentialProbePrompt(): string {
	return readTemplate("verifyCredential", bundledSource("verifyCredential")).body
}

function readTemplate(name: PromptName, source: string | undefined): Template {
	// Reject malformed templates before any paid operation.
	if (typeof source !== "string" || Buffer.byteLength(source) > 128000) {
		throw new Error(`Invalid prompt source for ${name}`)
	}

	// Split the YAML header from the instructions.
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]+)$/.exec(source)
	if (!match?.[1] || !match[2]) {
		throw new Error(`Invalid prompt template for ${name}`)
	}
	const { version } = metadata.parse(parse(match[1]))
	const body = match[2].trim()
	const placeholder = name === "verifyCredential" ? "" : name === "applyPatch" ? "{{base}}" : "{{evidence}}"

	// Remove the allowed insertion before looking for extra placeholders.
	const remaining = placeholder ? body.replace(placeholder, "") : body
	const unsafe = /{{|}}|<\/?untrusted-data-/i.test(remaining)
	if (!body || !body.includes(placeholder) || unsafe) {
		throw new Error(`Invalid prompt instructions for ${name}`)
	}

	// Identify the source supplied by the caller or bundled with the library.
	return { body, reference: { name, version, sha256: createHash("sha256").update(source).digest("hex") } }
}

export class InspectionPrompts {
	private readonly templates = new Map<PromptName, Template>()
	private readonly dispatched = new Map<PromptName, PromptReference>()
	private readonly rendered = new Map<PromptName, PromptReference>()
	constructor(overrides: PromptOverrides = {}) {
		// Reject misspelled names even when their role never runs.
		if (
			!overrides ||
			typeof overrides !== "object" ||
			// Reject unknown names even when supplied with valid Markdown.
			Array.isArray(overrides) ||
			Object.keys(overrides).some((name) => !names.includes(name as PromptName))
		) {
			throw new Error("Unknown inspection prompt")
		}

		for (const name of names) {
			const source = bundledSource(name)
			const customized = Object.hasOwn(overrides, name)
			const selected = customized ? overrides[name] : source
			let template = readTemplate(name, selected)
			if (customized && name === "verifyCredential" && template.body !== readTemplate(name, source).body) {
				throw new Error("Invalid credential probe instructions")
			}

			// Preserve the packaged output contract after caller-supplied instructions.
			if (name !== "verifyCredential" && name !== "applyPatch" && customized) {
				const suffix = readTemplate(name, source).body.split("{{evidence}}")[1]?.trim()
				if (suffix && !template.body.endsWith(suffix)) {
					template = readTemplate(name, `${selected?.trimEnd()}\n\n${suffix}\n`)
				}
			}

			this.templates.set(name, template)
		}
	}

	// Return the validated template associated with the public name.
	template(name: PromptName): Template {
		const template = this.templates.get(name)
		if (!template) {
			throw new Error("Unknown inspection prompt")
		}
		return template
	}

	// Keep model dispatches separate from downstream patch instructions.
	record(name: PromptName): void {
		const target = name === "applyPatch" ? this.rendered : this.dispatched
		target.set(name, this.template(name).reference)
	}

	get references(): { model: PromptReference[]; handoff: PromptReference[] } {
		return { model: [...this.dispatched.values()], handoff: [...this.rendered.values()] }
	}
}
