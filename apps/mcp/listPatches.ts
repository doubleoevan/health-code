import * as z from "zod"
import { digest, type SavedReport } from "./storeInspection.ts"

const storedPatch = z.object({
	id: z.string(),
	role: z.enum(["upgrade", "feature"]),
	digest,
	prerequisite: z.string().optional(),
})
export const patchReference = z.object({
	dependency: z.string(),
	to: z.string().optional(),
	role: storedPatch.shape.role,
	sha256: digest,
	prerequisiteSha256: digest.nullable(),
})

/**
 * Lists patch references for selection before retrieving mailbox bytes.
 */
export function listPatches(report: SavedReport): z.infer<typeof patchReference>[] {
	if (report.version !== 2) {
		return []
	}

	// Read artifact metadata without loading mailbox bytes into the response.
	return report.upgrades.flatMap((upgrade) => {
		const patches = z.array(storedPatch).safeParse(upgrade.patches)
		if (!patches.success) {
			return []
		}

		// Resolve each prerequisite within its own upgrade.
		const target = typeof upgrade.to === "string" ? upgrade.to : undefined
		const byId = new Map(patches.data.map((patch) => [patch.id, patch.digest]))
		return patches.data.flatMap((patch) => {
			// Keep references usable with the digest-based retrieval tool.
			const prerequisite = patch.prerequisite && byId.get(patch.prerequisite)
			if (patch.prerequisite && !prerequisite) {
				return []
			}
			return [
				{
					dependency: upgrade.dependency,
					to: target,
					role: patch.role,
					sha256: patch.digest,
					prerequisiteSha256: prerequisite || null,
				},
			]
		})
	})
}
