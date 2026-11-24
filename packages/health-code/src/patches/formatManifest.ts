import { applyEdits, modify } from "jsonc-parser"
import { applyManifestChanges } from "./applyManifestChanges.ts"

/**
 * Applies manifest changes to the original text and keeps its formatting.
 */
export function formatManifest(original: string, manifest: object): string {
	return applyManifestChanges({ applyEdits, modify }, original, manifest)
}
