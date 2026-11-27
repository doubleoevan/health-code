import type { UpgradeMenuTarget } from "health-code"
import { type FormEvent, type KeyboardEvent, type ReactElement, useCallback, useState } from "react"
import { continuousIntegrationSetupUrl, replayRepositoryUrl } from "../report.ts"
import { Challenge } from "./Challenge.tsx"
import { Link } from "./ReportControls.tsx"
import { UpgradeMenu, type UpgradeMenuView } from "./UpgradeMenu.tsx"

// the upgrade menu a page shows in place of the repository form
type UpgradeMenuPageProps = {
	id: string
	view: UpgradeMenuView
	repositoryUrl: string
	commit: string
	issue?: string

	// the menu could not read the project without a checkout, or assumed its minimum release age
	isUnreadable?: boolean
	releaseAgeNotice?: string
}

export type HomeProps = {
	upgradeMenu?: UpgradeMenuPageProps
	paused?: boolean
	siteMode: "local" | "hosted" | "replay"
}

// one submission to the server, and the same submission while it waits for the visitor's verification
type SubmitOptions = {
	repositoryUrl: string
	target?: UpgradeMenuTarget
	challenge?: string
	isSandboxListing?: boolean
}
type Submit = (options: SubmitOptions) => Promise<void>
type Verification = Omit<SubmitOptions, "challenge"> & { siteKey: string }

const submissionFailedMessage = "Could not start the inspection."

export function Home({ siteMode, paused, upgradeMenu }: HomeProps): ReactElement {
	const replay = siteMode === "replay"
	const [error, setError] = useState("")
	const [verification, setVerification] = useState<Verification | null>(null)
	const [pending, setPending] = useState(false)
	const [sandboxListingUrl, setSandboxListingUrl] = useState(toSandboxListingUrl(upgradeMenu))
	const [shouldOfferContinuousIntegration, setShouldOfferContinuousIntegration] = useState(false)
	const submit = useSubmit(upgradeMenu?.id, {
		setPending,
		setError,
		setShouldOfferContinuousIntegration,
		setVerification,
		setSandboxListingUrl,
	})
	const verified = useCallback(
		(token: string): void => {
			if (verification) {
				setVerification(null)
				void submit({ ...verification, challenge: token })
			}
		},
		[submit, verification],
	)
	const retry = useCallback((): void => {
		setVerification(null)
		setPending(false)
		setShouldOfferContinuousIntegration(true)
		setError("Verification could not finish. Retry the inspection or run Health Code in CI.")
	}, [])
	function handleSubmit(event: FormEvent<HTMLFormElement>): void {
		event.preventDefault()
		void submit({ repositoryUrl: String(new FormData(event.currentTarget).get("repositoryUrl")) })
	}
	function handleSandboxListing(): void {
		void submit({ repositoryUrl: sandboxListingUrl, isSandboxListing: true })
	}

	// Show how the server answered a submission that did not start an inspection.
	const inspectionSubmissionResponse = (
		<InspectionSubmissionResponse
			error={error}
			shouldOfferContinuousIntegration={shouldOfferContinuousIntegration}
			challenge={verification && <Challenge siteKey={verification.siteKey} onToken={verified} onFailure={retry} />}
			sandboxListing={
				sandboxListingUrl && !verification
					? { isDebited: siteMode === "hosted", pending, onList: handleSandboxListing }
					: undefined
			}
		/>
	)
	return (
		<section className={upgradeMenu ? "home" : "home landing"}>
			{/* inspection overview */}
			{upgradeMenu ? (
				<>
					<header className="inspection-heading">
						<h1>Try an upgrade</h1>
						<p className="mono">
							<Link href={upgradeMenu.repositoryUrl}>{upgradeMenu.repositoryUrl.slice(19)}</Link> ·{" "}
							{upgradeMenu.commit.slice(0, 8)}
						</p>
					</header>
					<UpgradeMenuSection isUnreadable={upgradeMenu.isUnreadable} response={inspectionSubmissionResponse}>
						<UpgradeMenu
							view={upgradeMenu.view}
							issue={upgradeMenu.issue}
							releaseAgeNotice={upgradeMenu.releaseAgeNotice}
							upgradeMenuId={upgradeMenu.id}
							pending={pending}
							onSelect={(target) => void submit({ repositoryUrl: upgradeMenu.repositoryUrl, target })}
						/>
					</UpgradeMenuSection>
				</>
			) : (
				<>
					<h1>
						Inspect your code
						<span>for new features</span>
					</h1>
					<p className="intro">
						AI health inspectors show you new dependency features and try an upgrade on your codebase inside a Runta
						sandbox. The network is locked, model keys stay outside and successful upgrades return tested patches.
					</p>

					{/* repository inspection steps */}
					<ol className="steps">
						<li>Enter your public GitHub repo URL (Node.js or Bun) and click New features</li>
						<li>Choose a dependency and click Try upgrade to try it on your codebase in a Runta sandbox.</li>
					</ol>

					{/* public repository submission */}
					{paused && (
						<p role="status">
							The hosted budget is reserved or temporarily unavailable. The daily allowance resets at 00:00 UTC. Cached
							reports remain available.{" "}
							<Link href={continuousIntegrationSetupUrl}>Run it in CI with your Runta account</Link>.
						</p>
					)}
					<form onSubmit={handleSubmit}>
						<div className="field">
							<input
								id="repository"
								aria-label="Public GitHub repository"
								name="repositoryUrl"
								type="url"
								required
								maxLength={200}
								autoComplete="off"
								spellCheck={false}
								placeholder="https://github.com/owner/repository"
								readOnly={pending || replay}
								onKeyDown={handleRepositoryKeyDown}
								onChange={() => {
									setVerification(null)
									setError("")
									setShouldOfferContinuousIntegration(false)
								}}
								defaultValue={replay ? replayRepositoryUrl : ""}
							/>
							<button type="submit" disabled={pending}>
								{pending ? "Starting inspection…" : replay ? "Play recorded inspection" : "New features"}
							</button>
						</div>
					</form>
				</>
			)}
			{!upgradeMenu && inspectionSubmissionResponse}
		</section>
	)
}

function handleRepositoryKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
	const input = event.currentTarget

	// Preserve caret navigation and text selection when a repository has been entered.
	if (
		event.key === "ArrowRight" &&
		!input.readOnly &&
		!input.value &&
		!event.shiftKey &&
		!event.altKey &&
		!event.ctrlKey &&
		!event.metaKey
	) {
		event.preventDefault()
		input.value = "https://github.com/"
	}
}

// place the sandbox listing under the reason a menu could not be read
function UpgradeMenuSection({
	isUnreadable,
	response,
	children,
}: {
	isUnreadable?: boolean
	response: ReactElement
	children: ReactElement
}): ReactElement {
	return isUnreadable ? (
		<>
			{children}
			{response}
		</>
	) : (
		<>
			{response}
			{children}
		</>
	)
}

// name the repository whose upgrade menu needs a sandbox listing
function toSandboxListingUrl(upgradeMenu: UpgradeMenuPageProps | undefined): string {
	return upgradeMenu?.isUnreadable ? upgradeMenu.repositoryUrl : ""
}

function InspectionSubmissionResponse({
	error,
	shouldOfferContinuousIntegration,
	challenge,
	sandboxListing,
}: {
	error: string
	shouldOfferContinuousIntegration: boolean
	challenge: ReactElement | null
	sandboxListing?: { isDebited: boolean; pending: boolean; onList: () => void }
}): ReactElement {
	return (
		<div className="inspection-submission-response">
			{/* visitor verification */}
			{challenge}

			{/* submission error */}
			{error && (
				<p role="alert">
					{error} {shouldOfferContinuousIntegration && <Link href={continuousIntegrationSetupUrl}>CI setup</Link>}
				</p>
			)}

			{/* sandbox listing for a repository the upgrade menu cannot read */}
			{sandboxListing && (
				<p className="button-row">
					<button type="button" className="secondary" disabled={sandboxListing.pending} onClick={sandboxListing.onList}>
						List upgrades in a sandbox
					</button>{" "}
					{sandboxListing.isDebited && "This uses one of today’s demo calls."}
				</p>
			)}
		</div>
	)
}

function useSubmit(
	upgradeMenuId: string | undefined,
	{
		setPending,
		setError,
		setShouldOfferContinuousIntegration,
		setVerification,
		setSandboxListingUrl,
	}: {
		setPending: (pending: boolean) => void
		setError: (message: string) => void
		setShouldOfferContinuousIntegration: (offer: boolean) => void
		setVerification: (input: Verification) => void
		setSandboxListingUrl: (repositoryUrl: string) => void
	},
): Submit {
	// say why the server refused and what the visitor can do instead
	const explainRefusal = useCallback(
		({
			body,
			isChallenged,
			repositoryUrl,
		}: {
			body: Record<string, unknown>
			isChallenged: boolean
			repositoryUrl: string
		}): never => {
			if (body.shouldOfferSandboxListing) {
				setSandboxListingUrl(repositoryUrl)
			}
			setShouldOfferContinuousIntegration(Boolean(body.continuousIntegrationSetupUrl) || isChallenged)
			throw new Error(typeof body.message === "string" ? body.message : submissionFailedMessage)
		},
		[setSandboxListingUrl, setShouldOfferContinuousIntegration],
	)
	return useCallback<Submit>(
		async ({ repositoryUrl, target, challenge, isSandboxListing }): Promise<void> => {
			setPending(true)
			setError("")
			setShouldOfferContinuousIntegration(false)
			try {
				const response = await fetch("/api/inspections", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						repositoryUrl,
						challenge,
						action: target ? "select" : "discover",
						isSandboxListing: isSandboxListing || undefined,
						upgradeMenuId,
						dependency: target?.dependency,
						to: target?.to,
					}),
				})
				const body = await response.json()
				if (response.ok) {
					window.location.assign(`/r/${body.id}`)
					return
				}

				// Verify only a new submission and resume the same repository after success.
				if (!challenge && body.siteKey) {
					setVerification({ siteKey: body.siteKey, repositoryUrl, target, isSandboxListing })
					return
				}
				explainRefusal({ body, isChallenged: Boolean(challenge), repositoryUrl })
			} catch (failure) {
				setError(failure instanceof Error ? failure.message : submissionFailedMessage)
				setPending(false)
			}
		},
		[upgradeMenuId, setPending, setError, setShouldOfferContinuousIntegration, setVerification, explainRefusal],
	)
}
