import assert from "node:assert/strict"
import { test } from "node:test"
import type { ModelReply } from "../src/agentContracts.ts"
import { attemptBudget, type Ledger, paidRequest } from "../src/modelBudget.ts"

test("budget admission considers turns, elapsed time, cancellation and both cost ceilings before dispatch", async () => {
	// price a fixture response against separate role and inspection balances
	const pricing = { inputUsdPerMillion: 1, outputUsdPerMillion: 2, maxInputTokens: 1024 }
	const reply: ModelReply = { modelId: "fixture", text: "ok", inputTokens: 10, outputTokens: 3 }
	let calls = 0
	const ledger: Ledger = { end: Date.now() + 60000, remainingMicros: 3000, usage: [] }
	const role = attemptBudget("repair", { agent: { repair: { maxTurns: 2, maxCostUsd: 0.002, maxDurationMs: 30000 } } })
	const request = {
		ledger,
		attempt: role,
		role: "repair" as const,
		step: "repair",
		modelId: "fixture",
		prompt: "x",
		output: 4,
		pricing,
		send: async (): Promise<ModelReply> => {
			calls++
			return reply
		},
	}
	// settle the first turn from its reported token usage
	await paidRequest(request)
	assert.equal(ledger.remainingMicros, 2984)
	assert.equal(role.remainingMicros, 1984)
	assert.equal(role.turns, 1)
	// reject expired attempts and exhausted balances before dispatch
	await assert.rejects(paidRequest({ ...request, attempt: { ...role, end: Date.now() - 1 } }))
	await assert.rejects(paidRequest({ ...request, attempt: { ...role, remainingMicros: 0 } }))
	await assert.rejects(paidRequest({ ...request, ledger: { ...ledger, remainingMicros: 0 } }))
	assert.equal(calls, 1)
	// consume the last turn and reject a third request
	await paidRequest(request)
	await assert.rejects(paidRequest(request))
	assert.equal(calls, 2)
	// check that cancellation preserves the remaining budget
	const before = ledger.remainingMicros
	await assert.rejects(paidRequest({ ...request, attempt: undefined, signal: AbortSignal.abort() }))
	assert.equal(calls, 2)
	assert.equal(ledger.remainingMicros, before)
})
