import type { ReactElement } from "react"
import { type Citation, toOrderedPatches, toPatchPath, type UpgradeCard } from "../report.ts"
import { PatchPreview } from "./PatchPreview.tsx"
import { CommitLink, Link } from "./ReportControls.tsx"

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
	const checkOutcome = text.replace(/&(?:lt|gt|quot|apos|amp);/g, (entity) => xmlEntities[entity] ?? entity)
	if (checkOutcome.length <= 160 && !checkOutcome.includes("\n")) {
		return <>{checkOutcome}</>
	}

	// show test counts before the long list of names
	const testCountsMatch = /(\d+) passed, (\d+) failed, (\d+) skipped, (\d+) todo/.exec(checkOutcome)
	if (!testCountsMatch) {
		return (
			<details>
				<summary>{`${checkOutcome.slice(0, 100)}…`}</summary>
				<p>{checkOutcome}</p>
			</details>
		)
	}
	const counts = testCountsMatch.slice(1).map(Number)
	const total = counts.reduce((sum, count) => sum + count, 0)

	// separate the totals from the failing test names. a saved report joins the names with commas
	const testTotalsEnd = testCountsMatch.index + testCountsMatch[0].length
	const failingTestNamesText = checkOutcome.slice(testTotalsEnd).replace(/^ · /, "")
	const failingTestNames = failingTestNamesText
		? failingTestNamesText.split(failingTestNamesText.includes("\n") ? "\n" : ", ")
		: []
	return (
		<details>
			{/* total and failed counts */}
			<summary>
				{`${checkOutcome.startsWith("failed") ? "failed · " : ""}${total.toLocaleString("en")} ${total === 1 ? "test" : "tests"} · ${counts[1]?.toLocaleString("en")} failed`}
			</summary>

			{/* measured totals */}
			<p>{checkOutcome.slice(0, testTotalsEnd)}</p>

			{/* failing test names */}
			<ul className="test-names">
				{failingTestNames.map((testName, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: test names repeat and never reorder
					<li key={index}>{testName}</li>
				))}
			</ul>
		</details>
	)
}

// the XML entities a saved report can hold in test names
const xmlEntities: Record<string, string> = { "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&amp;": "&" }

// Show a release summary with its section headings and list entries set apart.
function ReleaseSummary({ text }: { text: string }): ReactElement {
	return (
		// biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users scroll the box
		<div className="release-summary" tabIndex={0}>
			{text.split("\n").map((line, index) => {
				const entry = /^(\s*)- (.*)$/.exec(line)
				if (entry) {
					return (
						// biome-ignore lint/suspicious/noArrayIndexKey: summary lines have no identity and never reorder
						<p key={index} className={entry[1] ? "entry nested" : "entry"}>
							{entry[2]}
						</p>
					)
				}

				// treat a line in capitals as a section heading
				const heading = /^[A-Z][A-Z ]+$/.test(line.trim())
				// biome-ignore lint/suspicious/noArrayIndexKey: summary lines have no identity and never reorder
				return heading ? <h4 key={index}>{line.trim()}</h4> : <p key={index}>{line}</p>
			})}
		</div>
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
							{/* each check on its own line with long results collapsed */}
							{Object.entries({
								Install: patch.checks.install,
								Typecheck: patch.checks.typecheck,
								Tests: patch.checks.tests,
							}).map(([label, text]) => (
								<div key={label}>
									<strong>{label}</strong> · <CheckOutcome text={text} />
								</div>
							))}
						</dd>
					</>
				)}
			</dl>
			{/* verified patch text and download */}
			<div className="button-row">
				<PatchPreview digest={patch.digest} title={`${upgrade.dependency} ${patch.role} patch`} />
				<Link href={toPatchPath(patch.digest)}>Download patch</Link>
			</div>
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
			{upgrade.summary ? <ReleaseSummary text={upgrade.summary} /> : <p>Release summary unavailable.</p>}
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
