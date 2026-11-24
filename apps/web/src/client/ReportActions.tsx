import { type ReactElement, useState } from "react"
import { type PatchLink, type PublishedReport, toOrderedPatches, toPatchPath } from "../report.ts"
import { PromptBox, type PromptLinks, TroubleshootingPrompt } from "./PromptBox.tsx"

function toPatchPrompt({
	patch,
	dependency,
	url,
	commit,
}: {
	patch: PatchLink
	dependency: string
	url: string
	commit: string
}): string {
	const reportUrl = new URL(url)

	// Identify the selected target and its prerequisite in the copied instructions.
	const prerequisite = patch.prerequisite
		? `Required upgrade patch: ${reportUrl.origin}${toPatchPath(patch.prerequisite)} (SHA-256: ${patch.prerequisite}). Verify and apply it first if needed.
`
		: ""
	return `${patch.prompt}
Dependency upgrade: ${dependency}
Inspected commit: ${commit}
Applies to commit: ${patch.base}${patch.testedTip ? `\nTested commit: ${patch.testedTip}` : ""}
${prerequisite}${patch.role === "upgrade" ? "Upgrade" : "Feature"} patch: ${reportUrl.origin}${toPatchPath(patch.digest)}
SHA-256: ${patch.digest}
If your Health Code MCP has this patch, fetch it with get_tested_patch using the MCP inspection's own inspectionId and sha256 ${patch.digest}. Follow nextOffset and concatenate the pages verbatim. Otherwise use the patch URL. Verify the SHA-256 of each mailbox before applying it. Use a branch for this upgrade. If other upgrades have changed the checkout, check compatibility and rerun typecheck and tests on the combined tree.`
}

// link public destinations. a tested commit exists only in the sandbox
function toPatchLinks({
	patch,
	dependency,
	url,
	repository,
}: {
	patch: PatchLink
	dependency: string
	url: string
	repository: PublishedReport["repository"]
}): PromptLinks {
	const links: PromptLinks = {
		[repository.commit]: `${repository.url}/commit/${repository.commit}`,
		[dependency]: `https://www.npmjs.com/package/${dependency.replace(/@([^@]+)$/, "/v/$1")}`,
	}

	// link each patch address and its digest to the saved patch
	for (const digest of [patch.digest, patch.prerequisite]) {
		if (digest) {
			const path = toPatchPath(digest)
			links[digest] = path
			links[new URL(url).origin + path] = path
		}
	}
	return links
}

export function ReportActions({
	report,
	url,
	investigationPrompt,
}: {
	report: PublishedReport
	url: string
	investigationPrompt?: string
}): ReactElement {
	const [selectedPatchIndex, setSelectedPatchIndex] = useState(0)

	// Keep each handoff tied to one dependency and one verified patch.
	const availablePatches = report.upgrades.flatMap((upgrade) =>
		toOrderedPatches(upgrade.patches).map((patch) => ({ dependency: `${upgrade.dependency}@${upgrade.to}`, patch })),
	)
	const selectedPatch = availablePatches[selectedPatchIndex]
	return (
		<>
			{/* primary coding agent handoff */}
			{availablePatches.length > 1 && (
				<label>
					Patch to apply{" "}
					<select
						value={selectedPatchIndex}
						onChange={(event) => setSelectedPatchIndex(Number(event.currentTarget.value))}
					>
						{availablePatches.map(({ dependency, patch }, index) => (
							<option key={dependency + patch.role + patch.digest} value={index}>
								{dependency} · {patch.role} patch
							</option>
						))}
					</select>
				</label>
			)}
			{selectedPatch ? (
				<PromptBox
					key={selectedPatch.patch.digest}
					title="Upgrade prompt for your coding agent"
					text={toPatchPrompt({ ...selectedPatch, url, commit: report.repository.commit })}
					links={toPatchLinks({ ...selectedPatch, url, repository: report.repository })}
				/>
			) : (
				investigationPrompt && <TroubleshootingPrompt text={investigationPrompt} />
			)}
		</>
	)
}
