import type { ReactElement } from "react"
import { PatchPreview } from "./PatchPreview.tsx"
import { CommitLink, Link } from "./ReportControls.tsx"
import { type Citation, toOrderedPatches, toPatchPath, type UpgradeCard } from "./report.ts"

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
function TestFileErrors({ errors }: { errors?: UpgradeCard["testFileErrors"] }): ReactElement | null {
	if (!errors) {
		return null
	}
	return (
		<>
			{/* test files that could not run */}
			<dt>Test file errors</dt>
			<dd>
				<TestFileErrorList errors={errors} />
			</dd>
		</>
	)
}

export function TestFileErrorList({ errors }: { errors: NonNullable<UpgradeCard["testFileErrors"]> }): ReactElement {
	if (!errors.length) {
		return <>None recorded</>
	}
	return (
		<details>
			<summary>
				{errors.length.toLocaleString("en")} {errors.length === 1 ? "error" : "errors"}
			</summary>
			<ul>
				{errors.map(({ file, reason }) => (
					<li key={JSON.stringify([file, reason])}>
						<code>{file}</code> · {reason}
					</li>
				))}
			</ul>
		</details>
	)
}

export function CheckOutcome({ text }: { text: string }): ReactElement {
	if (text.length <= 160) {
		return <>{text}</>
	}

	// show test counts before the long list of names
	const counts = /(\d+) passed, (\d+) failed, (\d+) skipped, (\d+) todo/.exec(text)?.slice(1).map(Number)
	const total = counts?.reduce((sum, count) => sum + count, 0)
	return (
		<details>
			<summary>
				{counts
					? `${text.startsWith("failed") ? "failed · " : ""}${total?.toLocaleString("en")} ${total === 1 ? "test" : "tests"} · ${counts[1]?.toLocaleString("en")} failed`
					: `${text.slice(0, 100)}…`}
			</summary>
			<p>{text}</p>
		</details>
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
	repositoryUrl,
}: {
	patch: UpgradeCard["patches"][number]
	upgrade: UpgradeCard
	repositoryUrl: string
}): ReactElement {
	// Number only the patches with a recorded application order for this target.
	let heading = patch.role === "upgrade" ? "Upgrade patch" : "Optional feature patch"
	if (patch.prerequisite) {
		heading = `2. ${heading}`
	} else if (upgrade.patches.some((other) => other.prerequisite === patch.digest)) {
		heading = `1. ${heading}`
	}

	return (
		<section id={`patch-${patch.digest}`}>
			<h4>{heading}</h4>
			<dl>
				{/* patch base and tested commit */}
				<dt>Applies to commit</dt>
				<dd>
					{/* link a commit published on GitHub */}
					<CommitLink commit={patch.base} repositoryUrl={patch.prerequisite ? undefined : repositoryUrl} />
				</dd>
				{patch.testedTip && (
					<>
						<dt>Tested commit</dt>
						<dd>
							<CommitLink commit={patch.testedTip} />
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
							{/* each check as its own sentence */}
							{Object.entries({
								Install: patch.checks.install,
								Typecheck: patch.checks.typecheck,
								Tests: patch.checks.tests,
							})
								.map(([label, text]) => `${label} · ${text.replace(/\.$/, "")}.`)
								.join(" ")}
						</dd>
					</>
				)}
			</dl>
			{/* verified patch text and download */}
			<PatchPreview digest={patch.digest} title={`${upgrade.dependency} ${patch.role} patch`} />{" "}
			<Link href={toPatchPath(patch.digest)}>Download patch</Link>
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

export function UpgradeView({ upgrade, repositoryUrl }: { upgrade: UpgradeCard; repositoryUrl: string }): ReactElement {
	// Preserve the dependency order in both the links and the application prompt.
	const patches = toOrderedPatches(upgrade.patches)

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
			<h4>What the health inspector could verify</h4>
			<dl>
				<dt>Upgrade install</dt>
				<dd>
					<CheckOutcome text={upgrade.checks.install} />
				</dd>
				<dt>Upgraded typecheck</dt>
				<dd>
					<CheckOutcome text={upgrade.checks.typecheck} />
				</dd>
				<dt>Upgraded tests</dt>
				<dd>
					<CheckOutcome text={upgrade.checks.tests} />
				</dd>
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
						<dt>Dependency changes</dt>
						<dd>
							<ul>
								{upgrade.addedDependencies.map((dep) => (
									<li key={dep.name}>
										{dep.name}@{dep.version} · {dep.from ? "Upgraded together" : "Added"} · {dep.reason}{" "}
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
				<PatchDetails key={patch.digest} patch={patch} upgrade={upgrade} repositoryUrl={repositoryUrl} />
			))}
		</article>
	)
}
