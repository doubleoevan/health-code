import type { ReactElement } from "react"
import { Copy, Link } from "./ReportControls.tsx"
import type { Citation, UpgradeCard } from "./report.ts"

function Citations({ links }: { links: Citation[] }): ReactElement {
	// deduplicate citations by label and destination
	const unique = new Map(links.map((link) => [JSON.stringify([link.label, link.url]), link]))
	return (
		<>
			{unique.size
				? Array.from(unique, ([key, link]) => (
						<Link key={key} href={link.url}>
							{link.label}{" "}
						</Link>
					))
				: "None recorded"}
		</>
	)
}
function toPatchPath(digest: string): string {
	return `/patches/${digest}.patch`
}
export function TestFileErrors({ errors }: { errors?: UpgradeCard["testFileErrors"] }): ReactElement | null {
	if (!errors) {
		return null
	}
	return (
		<>
			{/* test files that could not run */}
			<dt>Test file errors</dt>
			<dd>
				{errors.length ? (
					<ul>
						{errors.map(({ file, reason }) => (
							<li key={JSON.stringify([file, reason])}>
								<code>{file}</code> · {reason}
							</li>
						))}
					</ul>
				) : (
					"None recorded"
				)}
			</dd>
		</>
	)
}

function CodeFeatureMatches({ matches }: { matches: UpgradeCard["matches"] }): ReactElement {
	if (!matches.length) {
		return <span>No matching use in this repository was recorded.</span>
	}
	return (
		<ul>
			{matches.map((match) => (
				<li key={JSON.stringify([match.label, match.url, match.source, match.adoptionOutcome])}>
					{/* release feature and supporting quotation */}
					<Link href={match.url}>{match.label}</Link>
					{match.replacement && <p>{match.replacement === "direct" ? "Direct replacement" : "Inferred replacement"}</p>}
					{match.quotation && (
						<blockquote>
							{match.quotation} <Link href={match.source}>Release notes</Link>
						</blockquote>
					)}

					{/* source location and affected call sites */}
					{match.location && (
						<p>
							Source location · <Citations links={[match.location]} />
						</p>
					)}
					{!!match.callSites?.length && (
						<p>
							Affected call sites · <Citations links={match.callSites} />
						</p>
					)}

					{/* feature adoption outcome */}
					{match.adoptionOutcome && <p>Adoption outcome · {match.adoptionOutcome}</p>}
				</li>
			))}
		</ul>
	)
}

function PatchDetails({
	patch,
	upgrade,
	origin,
	commit,
}: {
	patch: UpgradeCard["patches"][number]
	upgrade: UpgradeCard
	origin: string
	commit: string
}): ReactElement {
	// Number only the patches with a recorded application order for this target.
	let heading = patch.role === "upgrade" ? "Upgrade patch" : "Optional feature patch"
	if (patch.prerequisite) {
		heading = `2. ${heading}`
	} else if (upgrade.patches.some((other) => other.prerequisite === patch.digest)) {
		heading = `1. ${heading}`
	}

	// Identify the selected target and its prerequisite in the copied instructions.
	const prerequisite = patch.prerequisite
		? `Required upgrade patch: ${origin}${toPatchPath(patch.prerequisite)} (SHA-256: ${patch.prerequisite}). Verify and apply it first if needed.
`
		: ""
	const prompt = `${patch.prompt}
Dependency upgrade: ${upgrade.dependency}@${upgrade.to}
Inspected commit: ${commit}
Applies to commit: ${patch.base}${patch.testedTip ? `\nTested commit: ${patch.testedTip}` : ""}
${prerequisite}${patch.role} patch: ${origin}${toPatchPath(patch.digest)}
SHA-256: ${patch.digest}
If your Health Code MCP has this patch, fetch it with get_tested_patch using its inspectionId and sha256. Follow nextOffset and concatenate the pages verbatim. Otherwise use the patch URL. Verify the SHA-256 of each mailbox before applying it. Use a branch for this upgrade. If other upgrades have changed the checkout, check compatibility and rerun typecheck and tests on the combined tree.`

	return (
		<section id={`patch-${patch.digest}`}>
			<h4>{heading}</h4>
			<dl>
				{/* patch base and tested commit */}
				<dt>Applies to commit</dt>
				<dd>
					<code>{patch.base}</code>
				</dd>
				{patch.testedTip && (
					<>
						<dt>Tested commit</dt>
						<dd>
							<code>{patch.testedTip}</code>
						</dd>
					</>
				)}

				{/* prerequisite patch */}
				{patch.prerequisite && (
					<>
						<dt>Required upgrade patch</dt>
						<dd>
							<Link href={toPatchPath(patch.prerequisite)}>{patch.prerequisite}</Link>
						</dd>
					</>
				)}

				{/* verification results */}
				{patch.checks && (
					<>
						<dt>Patch verification</dt>
						<dd>
							Install · {patch.checks.install}. Typecheck · {patch.checks.typecheck}. Tests · {patch.checks.tests}.
						</dd>
					</>
				)}
			</dl>

			{/* verified patch download */}
			<Link href={toPatchPath(patch.digest)}>Download patch</Link>
			<Copy label="Copy patch instructions" text={prompt} />
		</section>
	)
}

const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 6 })

function UsageDetails({ usage }: { usage: UpgradeCard["usage"] }): ReactElement {
	return (
		<>
			{/* recorded charges and reserved cost */}
			{usage?.modelCost !== undefined && (
				<>
					<dt>Model cost</dt>
					<dd>{dollars.format(usage.modelCost)}</dd>
				</>
			)}
			{usage?.reserved !== undefined && (
				<>
					<dt>Reserved upper bound</dt>
					<dd>{dollars.format(usage.reserved)}</dd>
				</>
			)}

			{/* reported output tokens */}
			{usage?.outputTokens !== undefined && (
				<>
					<dt>Output tokens</dt>
					<dd>
						{usage.outputTokens.toLocaleString("en-US")}
						{usage.partialTokens && " recorded (some usage unavailable)"}
					</dd>
				</>
			)}
		</>
	)
}

function UpgradeCoverage({ upgrade }: { upgrade: UpgradeCard }): ReactElement {
	return (
		<>
			{upgrade.coverage === "skipped" && <p>Skipped before checking this upgrade.</p>}
			{upgrade.reusedFromInspectionId && (
				<p>
					Previously tested in{" "}
					<Link href={`/r/${encodeURIComponent(upgrade.reusedFromInspectionId)}`}>this inspection</Link>.
				</p>
			)}
		</>
	)
}

export function UpgradeView({
	upgrade,
	origin,
	commit,
}: {
	upgrade: UpgradeCard
	origin: string
	commit: string
}): ReactElement {
	// Preserve the dependency order in both the links and the application prompt.
	const patches = upgrade.patches.toSorted((a, b) => Number(a.role === "feature") - Number(b.role === "feature"))

	return (
		<article>
			{/* upgrade verdict and version change */}
			<header>
				<h3>{upgrade.dependency}</h3>
				<strong
					className={
						upgrade.verdict?.startsWith("Fixed") || upgrade.verdict === "Passes as is" ? "positive" : "neutral"
					}
				>
					{upgrade.verdict ?? "Verdict unavailable"}
				</strong>
			</header>
			<p className="mono">
				{Object.entries(upgrade.from)
					.map(([workspace, version]) => `${workspace} · ${version}`)
					.join(", ")}{" "}
				→ {upgrade.to}
			</p>

			<UpgradeCoverage upgrade={upgrade} />

			{/* repair outcome and test changes */}
			{(!upgrade.verdict || upgrade.verdict === "Untested") && upgrade.untestedReason && (
				<p>
					<strong>Why this upgrade was untested</strong> · {upgrade.untestedReason}
				</p>
			)}
			{upgrade.reason && (
				<p>
					<strong>Why no tested patch is available</strong> · {upgrade.reason}
				</p>
			)}
			{upgrade.testChanges?.map((change) => (
				<p key={change}>Test change · {change}</p>
			))}

			{/* results from the upgraded checkout */}
			<h4>What we could verify</h4>
			<dl>
				<dt>Upgrade install</dt>
				<dd>{upgrade.checks.install}</dd>
				<dt>Upgraded typecheck</dt>
				<dd>{upgrade.checks.typecheck}</dd>
				<dt>Upgraded tests</dt>
				<dd>{upgrade.checks.tests}</dd>
				<TestFileErrors errors={upgrade.testFileErrors} />

				{/* observed installation activity */}
				<dt>Installation findings</dt>
				<dd>
					{upgrade.observation.findings
						.map((finding) =>
							finding.kind === "connection"
								? `${finding.outcome} · ${finding.destination}`
								: `File written · ${finding.path}`,
						)
						.join("; ")}
					{upgrade.observation.complete && !upgrade.observation.findings.length && "No findings."}
					{!upgrade.observation.complete && (
						<p>
							Some install activity could not be recorded.
							{upgrade.observation.reason && ` ${upgrade.observation.reason}`}
						</p>
					)}
				</dd>
			</dl>

			{/* release summary and feature matches */}
			<p>{upgrade.summary ?? "Release summary unavailable."}</p>
			<dl>
				<dt>Where this fits in your code</dt>
				<dd>
					<CodeFeatureMatches matches={upgrade.matches} />
				</dd>

				{/* diagnostic source locations */}
				<dt>Source locations</dt>
				<dd>
					<Citations links={upgrade.diagnostics} />
				</dd>

				{/* installed size and added dependencies */}
				<dt>Installed size change</dt>
				<dd>
					{upgrade.sizeBytes === undefined
						? "Unmeasured"
						: `${upgrade.sizeBytes > 0 ? "+" : ""}${upgrade.sizeBytes} bytes`}
				</dd>
				{!!upgrade.addedDependencies?.length && (
					<>
						<dt>Added dependencies</dt>
						<dd>
							<ul>
								{upgrade.addedDependencies.map((dep) => (
									<li key={dep.commit}>
										{dep.name}@{dep.version} · {dep.reason}{" "}
										<Link href={dep.patch && toPatchPath(dep.patch)}>
											<code>{dep.commit}</code>
										</Link>
									</li>
								))}
							</ul>
						</dd>
					</>
				)}

				{/* model usage for this upgrade */}
				<UsageDetails usage={upgrade.usage} />
			</dl>

			{/* tested patches and application instructions */}
			{patches.map((patch) => (
				<PatchDetails key={patch.digest} patch={patch} upgrade={upgrade} origin={origin} commit={commit} />
			))}
		</article>
	)
}
