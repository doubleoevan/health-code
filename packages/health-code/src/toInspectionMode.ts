import { InspectionError } from "./contracts.ts"

export type InspectionMode = "listUpgrades" | "inspectUpgrades"

export type InspectionModeOptions = {
	mode?: InspectionMode

	/**
	 * @deprecated Use mode to select the inspection operation.
	 */
	discoveryOnly?: boolean
}

/**
 * Resolves the operation for a new inspection or a previously recorded selection.
 */
export function toInspectionMode({ mode, discoveryOnly }: InspectionModeOptions): InspectionMode {
	if (discoveryOnly !== undefined && typeof discoveryOnly !== "boolean") {
		throw new InspectionError("invalid-mode", "discoveryOnly must be a boolean.")
	}
	if (mode !== undefined && mode !== "listUpgrades" && mode !== "inspectUpgrades") {
		throw new InspectionError("invalid-mode", "Choose listUpgrades or inspectUpgrades.")
	}

	// Reject conflicting instructions before a listing can start a paid inspection.
	const previousMode = discoveryOnly ? "listUpgrades" : "inspectUpgrades"
	if (mode !== undefined && discoveryOnly !== undefined && mode !== previousMode) {
		throw new InspectionError("invalid-mode", "The mode and discoveryOnly options specify different operations.")
	}
	return mode ?? previousMode
}
