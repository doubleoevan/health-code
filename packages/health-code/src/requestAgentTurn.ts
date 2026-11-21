import { type AgentRole, agentRoleLabels } from "./agentContracts.ts"
import { bounded } from "./collectEvents.ts"
import { InspectionError } from "./contracts.ts"
import type { ModelInspection } from "./inspectModels.ts"
import { agentOutputTokens, type attemptBudget, paidRequest } from "./modelBudget.ts"
import { editToolBytes } from "./proposeEdits.ts"
import type { PatchEvidence } from "./verifyCandidate.ts"

export async function requestAgentTurn({
	engine,
	evidence,
	role,
	prompt,
	started,
	budget,
}: {
	engine: ModelInspection
	evidence: PatchEvidence
	role: AgentRole
	prompt: string
	started: boolean
	budget: ReturnType<typeof attemptBudget>
}): Promise<string> {
	const { context, sandbox } = evidence
	const provider = context.options.sandboxProvider
	if (!provider.openCredentialSession) {
		throw new InspectionError("credential-binding", "Provider lacks a verified credential capability")
	}
	const route = engine.options.models[role]
	const operation = {
		timeoutMs: Math.max(1, Math.min(120000, budget.end - Date.now(), engine.ledger.end - Date.now())),
		signal: context.options.signal,
		cleanupDeadline: context.end,
	}
	const open = provider.openCredentialSession.bind(provider)
	const session = await bounded((signal) => open(sandbox, route, { ...operation, signal }), operation)

	try {
		await paidRequest({
			ledger: engine.ledger,
			role,
			step: "verify credential",
			modelId: route.modelId,
			pricing: route.pricing,
			prompt: "Reply OK.",
			output: 1,
			signal: operation.signal,
			send: (op) => session.verify(op),
			attempt: budget,
			verification: true,
		})
		if (!started) {
			await engine.emitAgentStarted(context, sandbox)
		}
		return await context.step("setup", agentRoleLabels[role], (step) =>
			paidRequest({
				ledger: engine.ledger,
				attempt: budget,
				role,
				step: role,
				modelId: route.modelId,
				pricing: route.pricing,
				prompt,
				output: agentOutputTokens,
				toolBytes: editToolBytes,
				signal: step.signal,
				send: (op) => session.generate(prompt, op),
			}),
		)
	} finally {
		const cleanup = { timeoutMs: context.cleanupWindow() }
		await bounded((signal) => session.close({ ...cleanup, signal }), cleanup)
	}
}
