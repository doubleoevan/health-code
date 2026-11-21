import { type ReactElement, type ReactNode, useState } from "react"
import { type Citation, type PublishedCard, toSummary, type UpgradeCard } from "./report.ts"

export function Link({ href, children }: { href?: string; children: ReactNode }): ReactElement {
	const external = href?.startsWith("https://")
	if (!href || (!external && !/^\/(?!\/)/.test(href))) {
		return <span>{children}</span>
	}
	return (
		<a href={href} target={external ? "_blank" : undefined} rel={external ? "noopener noreferrer" : undefined}>
			{children}
		</a>
	)
}
function Citations({ links }: { links: Citation[] }): ReactElement {
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
function Copy({ text, label, share = false }: { text: string; label: string; share?: boolean }): ReactElement {
	const [status, setStatus] = useState("")
	async function handleClick(): Promise<void> {
		try {
			if (share && navigator.share) {
				await navigator.share({ url: text })
				return
			}
			await navigator.clipboard.writeText(text)
			setStatus("Copied")
		} catch (error) {
			if (!(error instanceof DOMException && error.name === "AbortError")) {
				setStatus("Copy unavailable. Select the text below.")
			}
		}
	}
	return (
		<span>
			<button type="button" className="secondary" onClick={handleClick}>
				{label}
			</button>{" "}
			<small role="status">{status}</small>
			{status.startsWith("Copy unavailable") && <textarea readOnly value={text} aria-label={label} />}
		</span>
	)
}
function toPatchPath(digest: string): string {
	return `/patches/${digest}.patch`
}
function TestFileErrors({ errors }: { errors?: UpgradeCard["testFileErrors"] }): ReactElement | null {
	if (!errors) {
		return null
	}
	return (
		<>
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

function FeatureMatches({ matches }: { matches: UpgradeCard["matches"] }): ReactElement {
	if (!matches.length) {
		return <span>None recorded</span>
	}
	return (
		<ul>
			{matches.map((match) => (
				<li key={JSON.stringify([match.label, match.url, match.source, match.adoptionOutcome])}>
					<Link href={match.url}>{match.label}</Link>
					{match.replacement && <p>{match.replacement === "direct" ? "Direct replacement" : "Inferred replacement"}</p>}
					{match.quotation && (
						<blockquote>
							{match.quotation} <Link href={match.source}>Release notes</Link>
						</blockquote>
					)}
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
					{match.adoptionOutcome && <p>Adoption outcome · {match.adoptionOutcome}</p>}
				</li>
			))}
		</ul>
	)
}

function PatchDetails({ patch }: { patch: UpgradeCard["patches"][number] }): ReactElement {
	return (
		<section>
			<h4>{patch.role === "upgrade" ? "Upgrade patch" : "Feature patch"}</h4>
			<dl>
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
				{patch.prerequisite && (
					<>
						<dt>Required upgrade patch</dt>
						<dd>
							<Link href={toPatchPath(patch.prerequisite)}>{patch.prerequisite}</Link>
						</dd>
					</>
				)}
				{patch.checks && (
					<>
						<dt>Patch verification</dt>
						<dd>
							Install · {patch.checks.install}. Typecheck · {patch.checks.typecheck}. Tests · {patch.checks.tests}.
						</dd>
					</>
				)}
			</dl>
			<Link href={toPatchPath(patch.digest)}>Download patch</Link>
		</section>
	)
}

const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 6 })

function UsageDetails({ usage }: { usage: UpgradeCard["usage"] }): ReactElement {
	return (
		<>
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

function Upgrade({ card, origin, commit }: { card: UpgradeCard; origin: string; commit: string }): ReactElement {
	// Preserve the dependency order in both the links and the application prompt.
	const patches = card.patches.toSorted((a, b) => Number(a.role === "feature") - Number(b.role === "feature"))
	const prompt = patches
		.map(
			(patch) =>
				`${patch.prompt}\nApplies to commit: ${patch.base}${patch.testedTip ? "\nTested commit: " + patch.testedTip : ""}${patch.prerequisite ? "\nRequired upgrade patch: " + patch.prerequisite : ""}\n${patch.role} patch: ${origin}${toPatchPath(patch.digest)}\nSHA-256: ${patch.digest}`,
		)
		.join("\n\n")
	return (
		<article>
			<header>
				<h3>{card.dependency}</h3>
				<strong
					className={card.verdict?.startsWith("Fixed") || card.verdict === "Passes as is" ? "positive" : "neutral"}
				>
					{card.verdict ?? "Verdict unavailable"}
				</strong>
			</header>
			<p className="mono">
				{Object.entries(card.from)
					.map(([workspace, version]) => `${workspace} · ${version}`)
					.join(", ")}{" "}
				→ {card.to}
			</p>
			{card.reason && (
				<p>
					<strong>Why repair stopped</strong> · {card.reason}
				</p>
			)}
			{card.testChanges?.map((change) => (
				<p key={change}>Test change · {change}</p>
			))}
			<p>{card.summary ?? "Release summary unavailable."}</p>
			<dl>
				<dt>Feature matches</dt>
				<dd>
					<FeatureMatches matches={card.matches} />
				</dd>
				<dt>Installation findings</dt>
				<dd>
					{card.observation.findings
						.map((finding) =>
							finding.kind === "connection"
								? `${finding.outcome} · ${finding.destination}`
								: `File written · ${finding.path}`,
						)
						.join("; ")}
					{card.observation.complete && !card.observation.findings.length && "No findings."}
					{!card.observation.complete && (
						<p>
							Some install activity could not be recorded.{card.observation.reason && ` ${card.observation.reason}`}
						</p>
					)}
				</dd>
				<dt>Install check</dt>
				<dd>{card.checks.install}</dd>
				<dt>Typecheck and tests</dt>
				<dd>
					{card.checks.typecheck} · {card.checks.tests}
				</dd>
				<TestFileErrors errors={card.testFileErrors} />
				<dt>Source locations</dt>
				<dd>
					<Citations links={card.diagnostics} />
				</dd>
				<dt>Installed size change</dt>
				<dd>
					{card.sizeBytes === undefined ? "Unmeasured" : `${card.sizeBytes > 0 ? "+" : ""}${card.sizeBytes} bytes`}
				</dd>
				{!!card.addedDependencies?.length && (
					<>
						<dt>Added dependencies</dt>
						<dd>
							<ul>
								{card.addedDependencies.map((dep) => (
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
				<UsageDetails usage={card.usage} />
			</dl>
			{patches.map((patch) => (
				<PatchDetails key={patch.digest} patch={patch} />
			))}
			{prompt && (
				<Copy
					label="Copy patch instructions"
					text={`Inspected commit: ${commit}\n${prompt}\nIf your Health Code MCP has a local inspection with this exact patch digest, you can call get_tested_patch with the local inspectionId and sha256. Follow nextOffset and concatenate the text pages verbatim. Otherwise download the URL above. Compute SHA-256 for each downloaded file and stop if any digest differs. Use one branch from the inspected commit. Apply the upgrade patch first. Continue on that branch for its dependent feature patch and skip any prerequisite already applied.`}
				/>
			)}
		</article>
	)
}
export function ReportView({ card, url }: { card: PublishedCard; url: string }): ReactElement {
	return (
		<>
			<h1>{toSummary(card)}</h1>
			<div className="buttons">
				<Copy label="Copy link" text={url} />
				<Copy label="Share" text={url} share />
			</div>
			<p>
				<Link href={`${card.repository.url}/tree/${card.repository.commit}`}>
					{card.repository.url.slice(19)} · {card.repository.commit.slice(0, 8)}
				</Link>
			</p>
			{card.detection && (
				<p role="status">
					Health Code inspects JavaScript and TypeScript projects. Project detection · {card.detection}
				</p>
			)}
			<details>
				<summary>Checks before the upgrade</summary>
				<dl>
					{Object.entries(card.baseline).map(([name, status]) => (
						<div key={name}>
							<dt>{name}</dt>
							<dd>{status}</dd>
						</div>
					))}
					<TestFileErrors errors={card.baselineTestFileErrors} />
				</dl>
			</details>
			{card.turnLimits && (
				<details>
					<summary>Turn limit</summary>
					<dl>
						<dt>Repair</dt>
						<dd>{card.turnLimits.repair}</dd>
						<dt>Feature adoption</dt>
						<dd>{card.turnLimits.featureAdoption}</dd>
					</dl>
				</details>
			)}
			{!card.license && <p>Findings only. GitHub could not confirm an OSI-approved license at the inspected commit.</p>}
			<section>
				<h2>Dependency upgrades</h2>
				{card.upgrades.length ? (
					card.upgrades.map((upgrade) => (
						<Upgrade
							key={upgrade.dependency + upgrade.to}
							card={upgrade}
							origin={new URL(url).origin}
							commit={card.repository.commit}
						/>
					))
				) : (
					<p>No upgrades inspected.</p>
				)}
			</section>
			<section>
				<h2>Continue in Claude Code or Codex</h2>
				<p>
					<Link href="https://github.com/doubleoevan/health-code#mcp-setup">Health Code MCP setup</Link> ·{" "}
					<Link href="https://dashboard.runta.com/">Sign up for Runta</Link>
				</p>
			</section>
		</>
	)
}
