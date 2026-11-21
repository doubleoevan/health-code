import { createHash } from "node:crypto"
import { z } from "zod"
import type { FeatureMatch, Patch } from "./agentContracts.ts"
import { attemptUpgrade } from "./attemptUpgrade.ts"
import { bumpManifest } from "./bumpManifest.ts"
import { redact, rethrowInspectionFailure } from "./collectEvents.ts"
import { InspectionError } from "./contracts.ts"
import type { ModelInspection } from "./inspectModels.ts"
import {
	cleanInstall,
	type PatchEvidence,
	recordCommit,
	requireBaseline,
	type State,
	trackedLockfile,
	verifyManifest,
	verifyTree,
	workspace,
} from "./verifyCandidate.ts"

export async function evaluatePatch(
	engine: ModelInspection,
	evidence: PatchEvidence,
	match?: FeatureMatch,
): Promise<void> {
	const { report, card, context } = evidence
	const confirmed = hasConfirmedFailure(report)
	const actions: string[] = []
	let attemptStart: number | undefined
	try {
		// require independently verified baseline and upgrade evidence
		requireBaseline(evidence)
		if (!match && report.result.status !== "passed" && !confirmed) {
			throw new Error("Upgrade lacks a confirmed result")
		}
		const parent = match ? report.patches[0]?.testedTip : card.repository.commit
		// require a tested upgrade commit before feature adoption
		if (!parent) {
			throw new Error("Feature patch requires a verified upgrade")
		}
		const state: State = {
			base: parent,
			tip: parent,
			commits: [],
			dependencies: [],
			files: new Map(),
			actions,
			testChanged: false,
			expectedCases: [],
		}
		// restore the verified prerequisite or build the initial upgrade
		if (match) {
			await workspace(evidence, { kind: "restore", tip: parent })
		} else {
			await commitUpgrade(evidence, state)
			state.bumpTip = state.tip
		}
		// invoke an agent only for a confirmed failure or adoption
		if (confirmed || match) {
			attemptStart = Date.now()
			await attemptUpgrade(engine, evidence, state, match)
		}
		const patch = await context.group("setup", "Final patch check", () => preparePatch(evidence, state, match))
		acceptPatch({ report, state, confirmed, match, patch })
	} catch (error) {
		// distinguish terminal inspection failures from patch rejection
		rethrowInspectionFailure(error, context)
		recordRejection({ error, report, match, confirmed, actions })
	} finally {
		if (attemptStart !== undefined) {
			report.attemptDurationMs ??= {}
			report.attemptDurationMs[match ? "featureAdoption" : "repair"] = Date.now() - attemptStart
		}
		// clear attempt state before evaluating another upgrade
		engine.attempt = undefined
		evidence.context.attemptEnd = undefined
	}
}

function acceptPatch({
	report,
	state,
	confirmed,
	match,
	patch,
}: {
	report: PatchEvidence["report"]
	state: State
	confirmed: boolean
	match?: FeatureMatch
	patch: Patch
}): void {
	// attach the verified patch to its upgrade report
	report.patches.push(patch)
	if (match) {
		report.newDependencies.push(...state.dependencies)
		match.patchId = patch.id
		match.disposition = "adopted"
	} else {
		// distinguish a successful repair from an unchanged passing upgrade
		report.verdict = confirmed ? (state.testChanged ? "Fixed with test changes" : "Fixed") : "Passes as is"
		report.newDependencies = state.dependencies
	}
}

async function preparePatch(evidence: PatchEvidence, state: State, match?: FeatureMatch): Promise<Patch> {
	const { report } = evidence
	// require an independently resolved initial lockfile
	if (state.unresolvedBump) {
		throw new Error("The initial upgrade lockfile could not be independently resolved")
	}
	await orderCommits(evidence, state)
	await workspace(evidence, { kind: "restore", tip: state.tip })
	// verify the restored candidate before exporting replayed mailbox bytes
	const verification = await verifyTree(evidence, state)
	const mailbox = await workspace(evidence, { kind: "export", base: state.base, tip: state.tip })
	if (!mailbox.startsWith("From ") || redact(mailbox) !== mailbox) {
		throw new Error("Patch replay unavailable")
	}
	// bind patch identity to the exact exported bytes
	const digest = createHash("sha256").update(mailbox, "utf8").digest("hex")
	const role = match ? "feature" : "upgrade"
	return {
		id: digest,
		verification,
		role,
		base: state.base,
		testedTip: state.tip,
		commits: state.commits,
		mailbox,
		digest,
		filename: `${role}-${digest.slice(0, 12)}.patch`,
		...(match ? { prerequisite: report.patches[0]?.id } : {}),
		prompt:
			"Create a branch at " +
			state.base +
			". Apply this mailbox with git am. For a feature series, reach this tested base by applying its prerequisite upgrade series at the upgrade's base. If the branch moved, adapt minimally and disclose the exact changes. Run typecheck and tests without editing tests. Fork first if needed, then open a pull request using the patch commit messages.",
	}
}

async function commitUpgrade(evidence: PatchEvidence, state: State): Promise<void> {
	const { adapter, report } = evidence
	requireBaseline(evidence)
	// recreate the initial version bump from the baseline
	await adapter.resetProject()
	const bumped = await adapter.bumpDependency(report)
	const failedInstall =
		bumped.check.status === "failed" && report.install.status === "failed" && hasConfirmedFailure(report)
	if ((!failedInstall && bumped.check.status !== "passed") || !cleanInstall(bumped.observation, evidence.baseInstall)) {
		throw new Error("Bump installation failed its independent check")
	}
	// determine the workspace manifests and lockfile affected by the bump
	const manifests = Object.keys(report.from).map((dir) => (dir === "." ? "package.json" : `${dir}/package.json`))
	const lock = trackedLockfile(evidence)
	if (failedInstall) {
		await adapter.resetProject()
	}
	const expected = new Map<string, unknown>()
	// reconstruct the allowed manifest edits from each committed original
	for (const file of manifests) {
		const original = JSON.parse(await workspace(evidence, { kind: "read", file, revision: state.base }))
		bumpManifest({
			dir: file === "package.json" ? "." : file.slice(0, -13),
			manifest: original,
			name: report.dependency,
			target: report.to,
		})
		expected.set(file, original)
		// write the expected manifest when the initial install failed
		if (failedInstall) {
			await workspace(evidence, { kind: "edit", file, contents: JSON.stringify(original, null, 2) + "\n" })
		}
	}
	if (failedInstall) {
		state.unresolvedBump = !(await resolvedUpgradeLock(evidence))
	}
	// verify each resulting manifest before recording the version change
	for (const [file, manifest] of expected) {
		await verifyManifest(evidence, file, manifest)
	}
	const files = state.unresolvedBump ? manifests : [...manifests, lock]
	await recordCommit(evidence, state, `chore: upgrade ${report.dependency} to ${report.to}`, files)
}
async function resolvedUpgradeLock(evidence: PatchEvidence): Promise<boolean> {
	// resolve the lockfile independently under baseline observation rules
	requireBaseline(evidence)
	const { adapter, report } = evidence
	const resolved = await adapter.resolveLock()
	if (!cleanInstall(resolved.observation, evidence.baseInstall)) {
		throw new Error("Lockfile resolution observation failed")
	}
	// require the intended version in every declaring workspace
	if (resolved.check.status !== "passed") {
		return false
	}
	const project = await adapter.data(["detect"]).catch((error: unknown) => {
		rethrowInspectionFailure(error, evidence.context)
		return undefined
	})
	// validate detected workspace versions against the target
	const metadata = z.object({ sources: z.record(z.string(), z.record(z.string(), z.string())) }).safeParse(project)
	const versions = metadata.success ? metadata.data.sources[report.dependency] : undefined
	return Object.keys(report.from).every((dir) => versions?.[dir] === report.to)
}
function hasConfirmedFailure(report: PatchEvidence["report"]): boolean {
	// use confirmed install, typecheck or test evidence to identify a repair candidate
	return (
		report.result.status === "failed" &&
		[report.install, report.typecheck, report.tests].some(
			(stage) =>
				stage.status === "failed" &&
				stage.attempts?.length === 2 &&
				stage.attempts.every((attempt) => attempt.status === "failed"),
		)
	)
}
function recordRejection({
	error,
	report,
	match,
	confirmed,
	actions,
}: {
	error: unknown
	report: PatchEvidence["report"]
	match?: FeatureMatch
	confirmed: boolean
	actions: string[]
}): void {
	// record why a feature adoption attempt stopped
	const reason = error instanceof Error ? error.message.slice(0, 600) : "Patch evidence unavailable"
	if (match) {
		match.disposition = reason
		return
	}
	if (
		// classify credential and provider failures as untested
		error instanceof InspectionError &&
		["credential-binding", "patch-workspace", "sandbox-unavailable"].includes(error.code)
	) {
		confirmed = false
	}
	report.verdict = confirmed && actions.length ? "Can't fix" : "Untested"
	// retain the bounded diagnosis and attempted repairs
	report.diagnosis = { stopReason: reason, actions, breakingChange: report.releaseSummary.text }
}
async function orderCommits(evidence: PatchEvidence, state: State): Promise<void> {
	const [first, ...rest] = state.commits
	if (!first) {
		throw new Error("Empty patch series")
	}
	// keep the initial upgrade first and order the remaining commits by role
	const rank = (commit: State["commits"][number]): number =>
		commit.flag === "dependency" ? 0 : commit.flag === "test" ? 2 : 1
	const ordered = [first, ...rest.sort((a, b) => rank(a) - rank(b))]
	if (ordered.every((commit, i) => commit === state.commits[i])) {
		return
	}
	// ask the protected workspace to rebuild the series in the requested order
	const answer: unknown = JSON.parse(
		await workspace(evidence, {
			kind: "order",
			base: state.base,
			tip: state.tip,
			commits: ordered.map((commit) => commit.sha),
		}),
	)
	// verify the number and format of the rewritten commit ids
	if (
		!Array.isArray(answer) ||
		answer.length !== ordered.length ||
		!answer.every((sha) => typeof sha === "string" && /^[0-9a-f]{40}$/.test(sha))
	) {
		throw new Error("Invalid reordered patch history")
	}
	for (const [i, commit] of ordered.entries()) {
		// update dependency evidence to reference each rewritten commit
		const dependency = state.dependencies.find((entry) => entry.commit === commit.sha)
		commit.sha = answer[i]
		if (dependency) {
			dependency.commit = commit.sha
		}
	}
	// point the candidate at the rewritten commit series
	state.commits = ordered
	state.tip = answer.at(-1)
}
