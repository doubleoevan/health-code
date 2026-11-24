import type { Patch } from "health-code"
import * as z from "zod"
import { UserError } from "./modelSettings.ts"
import { digest, type Outcome, type SavedReport, toHash } from "./storeInspection.ts"
import { textPage } from "./trackInspections.ts"

const artifact = z.object({
	filename: z.string().min(1),
	id: z.string().min(1),
	base: z.string().regex(/^[a-f0-9]{40}$/),
	testedTip: z.string().regex(/^[a-f0-9]{40}$/),
	digest,
	mailbox: z.string().min(1),
	prompt: z.string().min(1),
	role: z.enum(["upgrade", "feature"]),
	prerequisite: z.string().optional(),
	commits: z.array(z.object({ subject: z.string(), sha: z.string(), flag: z.enum(["dependency", "test"]).optional() })),
}) satisfies z.ZodType<Patch>
export const checkoutSchema = z.object({
	relationship: z.enum(["equal", "ahead", "behind", "diverged", "unknown"]),
	dirty: z.boolean(),
})
export const patchOutput = z.object({
	sha256: digest,
	text: z.string(),
	nextOffset: z.number().nullable(),
	verdict: z.string(),
	base: z.string(),
	inspectedCommit: z.string(),
	testedTip: z.string(),
	repository: z.string(),
	checkout: z.object({ relationship: z.string(), dirty: z.boolean().optional() }),
	prerequisiteSha256: digest.nullable(),
	agentPrompt: z.string(),
	action: z.string(),
})

type Fetch = { sha256: string; offset: number; checkout?: z.infer<typeof checkoutSchema> }
const verifiedBytes = new WeakMap<object, { mailbox: string; digest: string }>()
function verified(raw: object, patch: z.infer<typeof artifact>): boolean {
	// reuse verification only while the mailbox and digest still match
	const previous = verifiedBytes.get(raw)
	if (previous?.mailbox === patch.mailbox && previous.digest === patch.digest) {
		return true
	}

	// verify the complete mailbox before caching its digest
	if (toHash(patch.mailbox) !== patch.digest) {
		return false
	}
	verifiedBytes.set(raw, { mailbox: patch.mailbox, digest: patch.digest })
	return true
}
function findPatch(
	report: SavedReport,
	hash: string,
): { patch: z.infer<typeof artifact>; verdict: string; siblings: unknown[] } {
	// Validate stored evidence before returning Patch bytes to the coding agent.
	for (const upgrade of report.upgrades) {
		if (report.version !== 2 || !Array.isArray(upgrade.patches)) {
			continue
		}

		// locate the requested patch within this upgrade
		const raw = upgrade.patches.find((candidate) => candidate?.digest === hash)
		if (raw) {
			const parsed = artifact.safeParse(raw)
			if (!parsed.success || !verified(raw, parsed.data)) {
				throw new UserError("Patch is unreadable or its SHA-256 digest differs from the saved bytes.")
			}

			// require a library verdict before returning the patch
			if (typeof upgrade.verdict !== "string") {
				throw new UserError("Patch has no recorded Verdict.")
			}
			return { patch: parsed.data, verdict: upgrade.verdict, siblings: upgrade.patches }
		}
	}
	throw new UserError("This Inspection Report has no tested Patch with that digest.")
}

export function fetchPatch(report: SavedReport, input: Fetch): z.infer<typeof patchOutput> {
	const { patch, verdict, siblings } = findPatch(report, input.sha256)
	const page = textPage(patch.mailbox, input.offset)
	const checkout = input.checkout ?? { relationship: "unknown", dirty: undefined }

	// resolve the prerequisite within the same upgrade
	const raw =
		patch.prerequisite &&
		siblings.find(
			(candidate): candidate is object =>
				typeof candidate === "object" && candidate !== null && "id" in candidate && candidate.id === patch.prerequisite,
		)
	const prerequisite = raw ? artifact.safeParse(raw).data : undefined

	// verify that the feature patch follows its tested upgrade
	if (
		patch.prerequisite &&
		(prerequisite?.role !== "upgrade" ||
			patch.role !== "feature" ||
			prerequisite.prerequisite ||
			// require the feature base to match the verified prerequisite tip
			prerequisite.testedTip !== patch.base ||
			!raw ||
			!verified(raw, prerequisite))
	) {
		throw new UserError("Invalid required Patch order or digest.")
	}

	// stop the handoff if either patch changes tests
	const blocked = [...patch.commits, ...(prerequisite?.commits ?? [])].some((commit) => commit.flag === "test")

	return {
		sha256: patch.digest,
		text: page.text,
		nextOffset: page.nextOffset,
		verdict,
		base: patch.base,
		inspectedCommit: report.repository.commit,
		testedTip: patch.testedTip,
		repository: report.repository.url,
		checkout,
		prerequisiteSha256: prerequisite?.digest ?? null,
		agentPrompt: patch.prompt,
		action: blocked
			? "Stop. This series includes test edits."
			: "Compare the checkout to the inspected commit with local Git ancestry. Disclose ahead, behind, diverged or unknown history and preserve uncommitted work. Verify the SHA-256 of each complete mailbox, create a new branch, apply required patches in order, typecheck and test without editing tests, then open the authorized pull request.",
	}
}
export function validateOutcome(report: SavedReport, outcome: Outcome): void {
	// bind application results to a tested patch in this report
	findPatch(report, outcome.sha256)
	if (outcome.application === "adapted" && !outcome.adaptation) {
		throw new UserError("Describe what changed in the adapted Patch.")
	}

	// restrict pull request links to the inspected repository
	if (outcome.pullRequest) {
		const prefix = `${report.repository.url.toLowerCase()}/pull/`
		const url = outcome.pullRequest.toLowerCase()
		if (!url.startsWith(prefix) || !/^[1-9][0-9]*$/.test(url.slice(prefix.length))) {
			throw new UserError("Use an HTTPS GitHub pull request URL for the inspected repository.")
		}
	}
}
