import type { LanguageModel } from "ai"
import type {
	Baseline,
	InspectionEvent,
	InspectionOptions,
	InspectionReport,
	Observation,
	Operation,
	Sandbox,
	UpgradeReport,
} from "./contracts.ts"

export type AgentRole = "repair" | "featureAdoption"
export const agentRoleLabels = { repair: "Repair", featureAdoption: "Feature adoption" } as const
export type ModelRole = AgentRole | "releaseSummary" | "featureMatch"

// price each request against the caller's token ceiling
export type Pricing = {
	inputUsdPerMillion: number
	outputUsdPerMillion: number
	fixedUsd?: number
	maxInputTokens: number
}

// describe a guest model route and its scoped credential
export type ModelRoute = {
	protocol: "anthropic" | "openai-compatible"
	effort?: "low" | "medium" | "high"
	baseUrl: string
	modelId: string
	credential: { name: string; header: string; valueTemplate: string }
}

// distinguish caller-owned models from sandbox routes
type HostModel = { model: Exclude<LanguageModel, string>; pricing: Pricing }
export type InspectionModels = {
	releaseSummary: HostModel
	featureMatch: HostModel
	repair: ModelRoute & { pricing: Pricing }
	featureAdoption: ModelRoute & { pricing: Pricing }
}

// bound each role by turns, duration and cost
type AttemptLimits = { maxTurns: number; maxDurationMs: number; maxCostUsd: number }
export type InspectionOptionsV2 = Omit<InspectionOptions, "models" | "onEvent" | "limits"> & {
	// Read previously verified results for the inspected repository from the caller's cache.
	reuseUpgrade?: (
		repository: InspectionReport["repository"],
		upgrade: import("./contracts.ts").Upgrade,
	) => UpgradeReportV2 | undefined

	models: InspectionModels
	githubToken?: string

	// Keep existing limit overrides available to local callers.
	limits?: InspectionOptions["limits"] & {
		maxFeatureMatches?: number
		agent?: Partial<Record<AgentRole, Partial<AttemptLimits>>>
	}

	// deliver events using the version two envelope
	onEvent?: (event: InspectionEventV2) => void | Promise<void>
}

type CompatibleAgentLimits = Partial<AttemptLimits> & { maxIterations?: number }

// accept earlier role and limit names at the package boundary
export type PreviousInspectionOptions = Omit<InspectionOptionsV2, "models" | "limits"> & {
	models: Pick<InspectionModels, "releaseSummary" | "featureMatch"> &
		(Pick<InspectionModels, "repair"> | { fix: InspectionModels["repair"] }) &
		(Pick<InspectionModels, "featureAdoption"> | { adoption: InspectionModels["featureAdoption"] })
	limits?: Omit<NonNullable<InspectionOptionsV2["limits"]>, "agent"> & {
		agent?: Partial<Record<AgentRole | "fix" | "adoption", CompatibleAgentLimits>>
	}
}

type VersionTwo<T> = T extends unknown
	? Omit<T, "version"> & { version: 2; attemptId?: string; role?: ModelRole } & (T extends { type: "inspection.failed" }
				? { cleanupIds?: string[]; runtimeUsage?: import("./models/modelRequestSandbox.ts").RuntimeUsage }
				: unknown)
	: never

// extend inspection events with verified agent startup
export type InspectionEventV2 =
	| VersionTwo<InspectionEvent>
	| (Omit<Extract<InspectionEvent, { type: "sandbox.event" }>, "version" | "action"> & {
			version: 2
			action: "agent-started"
			role: AgentRole
			attemptId: string
	  })

// record usage and cost for each model role
export type ModelUsage = {
	execution?: "modelRequestSandbox"
	role: ModelRole
	step: string
	modelId: string
	durationMs: number
	inputTokens?: number
	outputTokens?: number

	// distinguish recorded charges from outstanding reservations
	costUsd?: number
	reservedUsd?: number
	requestId?: string
}

// capture model output and provider usage identifiers
export type ModelReply = {
	timing?: { modelCallId: string; durationMs: number }
	text: string
	modelId: string
	inputTokens?: number
	outputTokens?: number
	requestId?: string
}

// define verification, generation and revocation for a scoped session
export type CredentialSession = {
	verify(operation: Operation): Promise<ModelReply>
	generate(prompt: string, operation: Operation): Promise<ModelReply>
	close(operation: Operation): Promise<void>
}

export type AgentCapability = (
	sandbox: Sandbox,
	route: ModelRoute,
	operation: Operation & { cleanupDeadline?: number },
) => Promise<CredentialSession>
export type Locator = { file: string; line?: number; url?: string; reason?: string }

// tie a suggested replacement to its evidence
export type CodeFeatureMatch = {
	rank?: number
	replacement?: "direct" | "inferred"
	directQuote?: string
	callSites?: Locator[]
	feature: string
	source: string

	// classify the replacement and record its measured benefit
	location: Locator
	kind: "workaround" | "dependency" | "deprecated" | "option"
	benefit?: {
		kind: "production-lines" | "deprecated-call" | "direct-dependency"
		before: number
		after: number
		name?: string
	}

	// track whether the proposed match produced a patch
	disposition: string
	patchId?: string
}

export type PatchVerification = Baseline & {
	installation: Observation
	testNetwork: Observation
	addedCases: { file: string; name: string }[]
}

// bind tested changes to their base and verified tip
export type Patch = {
	verification?: PatchVerification
	id: string
	role: "upgrade" | "feature"
	base: string
	testedTip: string
	prerequisite?: string

	// carry replayable mailbox bytes and their digest
	filename: string
	mailbox: string
	digest: string
	prompt: string
	commits: { subject: string; sha: string; reason?: string; flag?: "dependency" | "test" }[]
}

export type Verdict = "Passes as is" | "Fixed" | "Fixed with test changes" | "Can't fix" | "Untested"

// summarize upgrade evidence and the resulting verdict
export type UpgradeReportV2 = UpgradeReport & {
	reusedFromInspectionId?: string

	/**
	 * @deprecated Read reusedFromInspectionId on new inspection reports.
	 */
	reusedFrom?: string
	usageLimitations?: string[]
	releaseSummary: { text: string; sources: string[]; gaps?: string[] }
	featureMatches: CodeFeatureMatch[]
	locators: Locator[]
	installSize: { before?: number; after?: number; delta?: number; reason?: string; method?: string }
	verdict: Verdict

	// record the commits and model usage behind each outcome
	newDependencies: {
		name: string
		version: string
		reason: string
		commit: string

		// identify a linked dependency that the repository already declared
		from?: Record<string, string>
	}[]
	patches: Patch[]
	diagnosis?: { breakingChange: string; actions: string[]; stopReason: string }
	attemptDurationMs?: Partial<Record<AgentRole, number>>
	modelUsage: ModelUsage[]
}

// preserve the report envelope with version two results
export type InspectionReportV2 = Omit<InspectionReport, "version" | "timeline" | "upgrades"> & {
	version: 2
	limits?: { maxDurationMs: number; maxCostUsd: number; agent: Record<AgentRole, AttemptLimits> }
	runtimeUsage?: import("./models/modelRequestSandbox.ts").RuntimeUsage
	timeline: InspectionEventV2[]
	upgrades: UpgradeReportV2[]
}

export type PatchOperation =
	| { kind: "read"; file: string; revision?: string }
	| { kind: "edit"; file: string; contents: string; protectTests?: string[]; createTest?: boolean }
	| { kind: "commit"; parent: string; subject: string; files: string[] }
	| { kind: "restore"; tip: string }
	| { kind: "verify"; tip: string }
	| { kind: "order"; base: string; tip: string; commits: string[] }
	| { kind: "export"; base: string; tip: string }
