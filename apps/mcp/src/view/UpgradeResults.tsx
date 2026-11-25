import { type ReactElement, type ReactNode, useEffect, useState } from "react"
import type { z } from "zod"
import type { selectedOutput, upgradeResultsOutput } from "../browseUpgrades.ts"
import type { patchOutput } from "../fetchPatch.ts"
import { type Host, toFailureText } from "./connectHost.ts"
import { toVersionChange } from "./labels.ts"

type Results = z.infer<typeof upgradeResultsOutput>
type Upgrade = Results["upgrades"][number]
type Patch = Pick<Upgrade["patches"][number], "sha256" | "role">
type UpgradeSummary = Omit<Upgrade, "patches">

// the upgrade returned with the tool result that opened the page
export type SelectedUpgrade = z.infer<typeof selectedOutput> & { dependency: string; to: string }
type InspectionSource = { host: Host; inspectionId: string }

export function UpgradeResults({ host, inspectionId }: InspectionSource): ReactElement {
	const [results, setResults] = useState<Results>()
	const [failure, setFailure] = useState<string>()
	useEffect(() => {
		host
			.callTool<Results>("read_upgrade_results", { inspectionId })
			.then(setResults, (error) => setFailure(toFailureText(error)))
	}, [host, inspectionId])

	if (failure) {
		return <p role="alert">{failure}</p>
	}
	if (!results) {
		return <p role="status">Reading results…</p>
	}
	return (
		<>
			{results.stoppedReason && <p role="status">{results.stoppedReason}</p>}
			{results.upgrades.length === 0 && <p role="status">No upgrades were tested.</p>}
			{results.upgrades.map((upgrade) => (
				<UpgradeResult key={`${upgrade.dependency} ${upgrade.to}`} upgrade={upgrade}>
					{upgrade.patches.map((patch) => (
						<PatchView key={patch.sha256} host={host} inspectionId={inspectionId} patch={patch} />
					))}
				</UpgradeResult>
			))}
		</>
	)
}

/**
 * Reads the selected upgrade from a tool result and its input.
 */
export function toSelectedUpgrade(
	details: Record<string, unknown>,
	{ dependency, to }: Record<string, unknown>,
): SelectedUpgrade | undefined {
	const isSelected = typeof dependency === "string" && typeof to === "string" && "checks" in details
	return isSelected ? ({ ...details, dependency, to } as SelectedUpgrade) : undefined
}

export function SelectedUpgradeResult({
	host,
	inspectionId,
	selected,
}: InspectionSource & { selected: SelectedUpgrade }): ReactElement {
	const { patch, ...upgrade } = selected
	const text = patch?.nextOffset === null ? patch.text : undefined
	return (
		<UpgradeResult upgrade={upgrade}>
			{patch && (
				<PatchView
					host={host}
					inspectionId={inspectionId}
					patch={{ sha256: patch.sha256, role: "upgrade" }}
					savedText={text}
				/>
			)}
		</UpgradeResult>
	)
}

function UpgradeResult({ upgrade, children }: { upgrade: UpgradeSummary; children: ReactNode }): ReactElement {
	const { dependency, verdict, reason, checks } = upgrade
	const isPositive = verdict?.startsWith("Fixed") || verdict === "Passes as is"
	return (
		<article>
			{/* upgrade and verdict */}
			<header className="button-row">
				<h2>{dependency}</h2>
				<strong className={isPositive ? "verdict positive" : "verdict"}>{verdict ?? "Verdict unavailable"}</strong>
			</header>
			<p>
				<code>{upgrade.from ? toVersionChange(upgrade.from, upgrade.to ?? "unknown") : upgrade.to}</code>
			</p>
			{reason && <p>{`Why no tested patch is available · ${reason}`}</p>}

			{/* check results */}
			<dl>
				{(
					[
						["Install", checks.install],
						["Typecheck", checks.typecheck],
						["Tests", checks.tests],
					] as const
				).map(([label, check]) => (
					<div key={label}>
						<dt>{label}</dt>
						<dd>{check ? [check.status, check.detail ?? check.reason].filter(Boolean).join(" · ") : "Not recorded"}</dd>
					</div>
				))}
			</dl>

			{/* tested patches */}
			{children}
		</article>
	)
}

// keep the page responsive on a large patch
const maximumShownCharacters = 100_000

function PatchView({
	host,
	inspectionId,
	patch,
	savedText,
}: InspectionSource & { patch: Patch; savedText?: string }): ReactElement {
	const [text, setText] = useState<string>()
	const [status, setStatus] = useState<string>()
	const [isPending, setIsPending] = useState(false)

	// name the patch only by values with a checked format
	const applyRequest = `Apply the tested patch ${patch.sha256} from Health Code inspection ${inspectionId}. Call get_tested_patch with both values and follow its action.`

	async function handleApply(): Promise<void> {
		setIsPending(true)
		try {
			await host.sendMessage(applyRequest)
			setStatus("Sent to your coding agent.")
		} catch (error) {
			setStatus(toFailureText(error))
		}
		setIsPending(false)
	}

	async function handleShow(): Promise<void> {
		setIsPending(true)
		try {
			setText(savedText ?? (await readPatch({ host, inspectionId, sha256: patch.sha256 })))
		} catch (error) {
			setStatus(toFailureText(error))
		}
		setIsPending(false)
	}
	return (
		<div className="target">
			{/* request that applies the patch */}
			<h3>
				{patch.role === "upgrade" ? "Upgrade prompt for your coding agent" : "Feature prompt for your coding agent"}
			</h3>
			<div className="prompt">
				<p>{applyRequest}</p>
				{host.canMessage() && (
					<button type="button" disabled={isPending} onClick={handleApply}>
						Apply
					</button>
				)}
			</div>

			{/* patch preview control */}
			<div className="button-row">
				<button
					type="button"
					className="secondary"
					disabled={isPending}
					onClick={() => (text === undefined ? handleShow() : setText(undefined))}
				>
					{text === undefined ? "Show patch" : "Hide patch"}
				</button>
			</div>
			{status && <p role="status">{status}</p>}

			{/* patch text */}
			{text !== undefined && (
				// biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users scroll the patch.
				<pre tabIndex={0}>
					{toPatchLines(text).map(({ text, className }, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: Patch lines keep their order.
						<span key={index} className={className}>{`${text}\n`}</span>
					))}
				</pre>
			)}
		</div>
	)
}

async function readPatch({ host, inspectionId, sha256 }: InspectionSource & { sha256: string }): Promise<string> {
	let text = ""
	let offset: number | null = 0
	while (offset !== null && text.length < maximumShownCharacters) {
		const input = { inspectionId, sha256, offset }
		const page: z.infer<typeof patchOutput> = await host.callTool("get_tested_patch", input)
		text += page.text
		offset = page.nextOffset
	}
	return offset === null ? text : `${text}\nAsk your coding agent for the rest of this patch.`
}

// show invisible formatting characters as escapes
function toVisible(line: string): string {
	return line.replace(/[\p{Cc}\p{Cf}]/gu, (character) =>
		character === "\t" ? character : `\\u{${character.codePointAt(0)?.toString(16)}}`,
	)
}

function toPatchLines(patchText: string): { text: string; className?: string }[] {
	const lines = patchText.split("\n")

	// color code between the first changed range and the closing signature
	const codeStart = lines.findIndex((line) => line.startsWith("@@ "))
	const signature = lines.lastIndexOf("-- ")
	return lines.map((line, index) => {
		const text = toVisible(line)
		if (/^(?:diff --git |@@ )/.test(line)) {
			return { text, className: "heading" }
		}

		// leave file names uncolored
		const isCode = codeStart >= 0 && index > codeStart && (signature < 0 || index < signature)
		const isFileName = /^(?:\+\+\+ b\/|--- a\/|(?:\+\+\+|---) \/dev\/null)/.test(line)
		return isCode && !isFileName ? { text, className: { "+": "added", "-": "removed" }[line.charAt(0)] } : { text }
	})
}
