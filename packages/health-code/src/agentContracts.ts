import type { LanguageModel } from "ai"
import type {
	Baseline,
	InspectionEvent,
	InspectionOptions,
	Observation,
	Operation,
	ReportCard,
	Sandbox,
	UpgradeReport,
} from "./contracts.ts"

export type AgentRole = "repair" | "featureAdoption"
export const agentRoleLabels = { repair: "Repair", featureAdoption: "Feature adoption" } as const
export type ModelRole = AgentRole | "releaseSummary" | "featureMatch"
export type Pricing = {
	inputUsdPerMillion: number
	outputUsdPerMillion: number
	fixedUsd?: number
	maxInputTokens: number
}
export type ModelRoute = {
	protocol: "anthropic" | "openai-compatible"
	effort?: "low" | "medium" | "high"
	baseUrl: string
	modelId: string
	credential: { name: string; header: string; valueTemplate: string }
}
type HostModel = { model: Exclude<LanguageModel, string>; pricing: Pricing }
export type InspectionModels = {
	releaseSummary: HostModel
	featureMatch: HostModel
	repair: ModelRoute & { pricing: Pricing }
	featureAdoption: ModelRoute & { pricing: Pricing }
}
type AttemptLimits = { maxTurns: number; maxDurationMs: number; maxCostUsd: number }
export type InspectionOptionsV2 = Omit<InspectionOptions, "models" | "onEvent" | "limits"> & {
	models: InspectionModels
	githubToken?: string
	limits?: InspectionOptions["limits"] & {
		maxFeatureMatches?: number
		agent?: Partial<Record<AgentRole, Partial<AttemptLimits>>>
	}
	onEvent?: (event: InspectionEventV2) => void | Promise<void>
}
type CompatibleAgentLimits = Partial<AttemptLimits> & { maxIterations?: number }
export type PreviousInspectionOptions = Omit<InspectionOptionsV2, "models" | "limits"> & {
	models: Pick<InspectionModels, "releaseSummary" | "featureMatch"> &
		(Pick<InspectionModels, "repair"> | { fix: InspectionModels["repair"] }) &
		(Pick<InspectionModels, "featureAdoption"> | { adoption: InspectionModels["featureAdoption"] })
	limits?: Omit<NonNullable<InspectionOptionsV2["limits"]>, "agent"> & {
		agent?: Partial<Record<AgentRole | "fix" | "adoption", CompatibleAgentLimits>>
	}
}

type VersionTwo<T> = T extends unknown
	? Omit<T, "version"> & { version: 2; attemptId?: string; role?: ModelRole }
	: never
export type InspectionEventV2 =
	| VersionTwo<InspectionEvent>
	| (Omit<Extract<InspectionEvent, { type: "sandbox.event" }>, "version" | "action"> & {
			version: 2
			action: "agent-started"
			role: AgentRole
			attemptId: string
	  })
export type ModelUsage = {
	role: ModelRole
	step: string
	modelId: string
	durationMs: number
	inputTokens?: number
	outputTokens?: number
	costUsd?: number
	reservedUsd?: number
	requestId?: string
}
export type ModelReply = {
	text: string
	modelId: string
	inputTokens?: number
	outputTokens?: number
	requestId?: string
}
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
export type FeatureMatch = {
	rank?: number
	replacement?: "direct" | "inferred"
	directQuote?: string
	callSites?: Locator[]
	feature: string
	source: string
	location: Locator
	kind: "workaround" | "dependency" | "deprecated" | "option"
	benefit?: {
		kind: "production-lines" | "deprecated-call" | "direct-dependency"
		before: number
		after: number
		name?: string
	}
	disposition: string
	patchId?: string
}
export type PatchVerification = Baseline & {
	installation: Observation
	testNetwork: Observation
	addedCases: { file: string; name: string }[]
}
export type Patch = {
	verification?: PatchVerification
	id: string
	role: "upgrade" | "feature"
	base: string
	testedTip: string
	prerequisite?: string
	filename: string
	mailbox: string
	digest: string
	prompt: string
	commits: { subject: string; sha: string; reason?: string; flag?: "dependency" | "test" }[]
}
export type Verdict = "Passes as is" | "Fixed" | "Fixed with test changes" | "Can't fix" | "Untested"
export type UpgradeReportV2 = UpgradeReport & {
	usageLimitations?: string[]
	releaseSummary: { text: string; sources: string[]; gaps?: string[] }
	featureMatches: FeatureMatch[]
	locators: Locator[]
	installSize: { before?: number; after?: number; delta?: number; reason?: string; method?: string }
	verdict: Verdict
	newDependencies: { name: string; version: string; reason: string; commit: string }[]
	patches: Patch[]
	diagnosis?: { breakingChange: string; actions: string[]; stopReason: string }
	attemptDurationMs?: Partial<Record<AgentRole, number>>
	modelUsage: ModelUsage[]
}
export type ReportCardV2 = Omit<ReportCard, "version" | "timeline" | "upgrades"> & {
	version: 2
	limits?: { maxDurationMs: number; maxCostUsd: number; agent: Record<AgentRole, AttemptLimits> }
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
