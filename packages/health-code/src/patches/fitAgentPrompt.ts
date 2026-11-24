import { maxEvidenceBytes } from "../models/buildPrompt.ts"

export type AgentPromptEvidence = {
	diagnostics: string
	files: Record<string, string>
	availableTests: string[]
	releaseNotes?: { source: string; text: string }[]
	[key: string]: unknown
}

/**
 * Builds an agent prompt within its input bound and lists any omitted source files.
 */
export async function fitAgentPrompt({
	build,
	evidence,
	maxBytes,
}: {
	build: (evidence: AgentPromptEvidence) => Promise<string>
	evidence: AgentPromptEvidence
	maxBytes: number
}): Promise<string> {
	const limit = Math.min(maxBytes, maxEvidenceBytes)
	let files = rankFiles(evidence)
	const omitted: string[] = []

	// omit files that cannot fit before building the first prompt
	let bytes = 0
	files = files.filter(([file, text]) => {
		const size = Buffer.byteLength(text)

		// keep later files that still fit
		const isKept = bytes + size <= limit
		if (isKept) {
			bytes += size
		} else {
			omitted.push(file)
		}
		return isKept
	})

	// remove the least relevant material until the prompt fits
	const current = { ...evidence }
	while (true) {
		const prompt = await build({ ...current, files: Object.fromEntries(files), omittedFiles: omitted.slice(0, 100) })
		if (Buffer.byteLength(prompt) < limit) {
			return prompt
		}

		// drop one file at a time, starting with the lowest rank
		const last = files.pop()
		if (last) {
			omitted.unshift(last[0])
			continue
		}

		// shorten supporting evidence once every file is omitted
		if (!shorten(current)) {
			return prompt
		}
	}
}

// place files named by the checks or feature match first, then the smallest files
function rankFiles({ diagnostics, files, match }: AgentPromptEvidence): [string, string][] {
	const references = diagnostics + JSON.stringify(match ?? "")
	const isNamed = (file: string): number => Number(references.includes(file))
	return Object.entries(files).sort(
		([a, left], [b, right]) => isNamed(b) - isNamed(a) || left.length - right.length || a.localeCompare(b),
	)
}

// remove material in order from least to most relevant
function shorten(evidence: AgentPromptEvidence): boolean {
	if (evidence.availableTests.length) {
		evidence.availableTests = evidence.availableTests.slice(0, Math.floor(evidence.availableTests.length / 2))
		return true
	}

	// drop release notes after the test list is empty
	if (evidence.releaseNotes?.length) {
		evidence.releaseNotes = evidence.releaseNotes.slice(0, -1)
		return true
	}

	// keep the end of the diagnostics, where commands summarize failures
	if (evidence.diagnostics.length > 4000) {
		evidence.diagnostics = evidence.diagnostics.slice(-Math.floor(evidence.diagnostics.length / 2))
		return true
	}
	return false
}
