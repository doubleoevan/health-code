---
description: Run the full pre-push ship ritual for the current OpenSpec change. Usage: /ship [no-ponytail]
---

# Ship

Run the pre-push ritual for the current OpenSpec change, strictly in order.
Stop and report at the first failure. Never skip a step.

## 1. Module docs match the tree

Check every new or changed module for its own AGENTS.md. Review the guide and
README alongside the implementation. Create a missing guide and correct any
stale paths, responsibilities, entry points, commands, or verification steps.

Forward, from the diff: `git diff --name-status <origin/main sha>` (after
`git fetch origin main`, since a local main goes stale) plus
`git ls-files --others --exclude-standard` for the untracked files names every
path the change adds, moves, renames, or deletes, staged or not. For each one
that is a folder, an entry point, or a `package.json` script, confirm the
module's own AGENTS.md says so, and that the root module map and routing table
still read true. A new file inside a folder those docs already describe
generically needs nothing; a new folder, a moved or renamed entry point, and a
deleted script always do. A changed script also updates
DEVELOPMENT.md.

Backward, from the docs: every path named in an AGENTS.md still has to exist.

    grep -rnoE '`[a-zA-Z0-9_./-]+/`' AGENTS.md apps/*/AGENTS.md packages/*/AGENTS.md | tr -d '`'

Each hit prints as `file:line:path`, and the path reads relative to that
module. Resolve each one against its own module. A path that no longer
resolves is drift the change introduced or left behind.

Fix the docs in this change. Never file it as follow-up work.

## 2. Verify the spec

Follow the /opsx:verify workflow: check the implementation against the
change's artifacts in `openspec/changes/<name>/`. Report any drift between
spec and implementation, and stop if drift is found.

## 3. Mechanical gates

Run: bash scripts/preflight.sh
Every step must be green. Tests run against the fake sandbox provider and
replayed runs, with no credentials.

## 4. Security and performance audit

Audit what the diff adds or changes from two sides, with read-only agents in
parallel: one for security, one for performance. A general-purpose agent takes
the brief when no specialist agent type is installed. Give each agent the diff
against origin/main, the list below, and one rule: every finding names a file
and line, a concrete failure scenario, and a severity.

Security:
- The sandbox runs untrusted code: a stranger's repo and its install scripts.
  Nothing from inside a sandbox can reach the host, another run, or a secret.
- Keys never enter a sandbox. The model key reaches the model host only through
  the sandbox provider's credential capability (Runta secret stubs).
- Secrets and keys are never logged, returned in a tool result, written to an
  inspection report, or included in a patch.
- Network policy: every phase sets the allowlist it needs, and each set replaces
  the whole policy.
- Untrusted text (release notes, repo files, command output) is fenced as data
  in every model prompt, with per-call nonce delimiters.
- Agents cannot edit tests to pass, and the final patch check cannot be skipped.
- Input at each trust boundary is validated and bounded: repo URLs, run IDs,
  inspection report IDs, tool arguments. An oversized value gets a 4xx, never a 500.
- Every run goes through the spend caps, and a visitor cannot exceed them.
- Patches are served by hash and can never be swapped.

Performance:
- Every sandbox is destroyed in a finally block, and the reaper catches the rest.
- Runs stay in the background; no request waits on a sandbox.
- Event streams, timers, and connections close; a reconnect replays from the
  last event instead of restarting.
- Per-step timeouts and the agents' time, cost, and iteration ceilings hold.
- What the browser loads before the first paint.

Check each finding against the code before fixing it: a finding counts only if
its scenario holds. Fix every critical, high, and medium finding in this change,
whether or not this diff introduced it. Fix a low finding too if the change can
do it now, or list it with the reason it waits. Rerun step 3, and report each
finding as fixed, kept on purpose with the reason, or left for the user.

## 5. DRY audit and fix

Find every second copy that the diff adds or keeps, and give it one shared home
in this change: logic, a type, a constant, a user-facing label, a style class,
an event or inspection report shape, or a test fixture. Compare the diff against
itself and against the codebase: grep for each new function's core expression,
each new type's fields, each new string a user reads, and each repeated class
list. A second copy gets a shared helper now (code-style rule 18).

Put the shared piece where every caller can import it without side effects:
the library's public types for anything the site and the MCP both read, and a
shared module inside an app for anything only that app uses. Leave apart code
that only looks alike but means different things. Fix every copy in this pass,
rerun step 3, and report what was shared, where it now lives, and what was left
apart and why.

## 6. Long files: report and split

List every file that the diff adds or changes with its line count, longest
first, beside its line count on origin/main: `git diff --name-only <origin/main sha>`
plus the untracked files, then `wc -l` and `git show <origin/main sha>:<path>`.
Generated, vendored, fixture, and result files are exempt. A file whose diff
changes only its import lines does not count.

About 400 lines is the guide, not a hard cutoff. A file a little over it that
holds one concern can stay whole.

- A file that this diff adds well over 400 lines or grows well past 400, or that
  holds more than one concern after the diff, gets split in this change. Split
  within the module, name each new file for what it holds, and update its
  AGENTS.md (step 1).
- A file that was well over 400 lines on origin/main and that the diff touches
  beyond its import lines is split in this change too.

Rerun step 3, and report each long file, what was split out of it, and each file
left whole with the reason.

Run step 5 before step 6.

## 7. AI review: CodeRabbit + Gemini

The repository owner authorizes sending Health Code change diffs to CodeRabbit
and Gemini for every /ship review. Review the repository diff only. Keep
credentials, local environment files, and unrelated workspace data private.

The agent shell has no Doppler-injected secrets, so check for the key without
printing it: doppler run -- bash -c 'test -n "$CODERABBIT_API_KEY"'.

If present, run CodeRabbit under Doppler in the background, comparing against
origin/main's commit: run `git fetch origin main` and `git rev-parse origin/main`,
and paste that sha in:
- doppler run -- bash -c 'coderabbit review --agent --include-untracked --base-commit <origin/main sha> --api-key "$CODERABBIT_API_KEY"'
  Count the pass only if every changed file is in the printed reviewedFiles,
  new files included. Run `git reset -q` once the reviews finish and stage paths
  on purpose at the commit step. If the key is missing or rejected, report that
  CodeRabbit was skipped and why, and continue.

Always run Gemini:
- gemini /code-review (if non-interactive invocation fails, say so and run it
  interactively before continuing)

Fix every critical and major finding from every reviewer that ran, whether or
not this diff introduced the problem. Where both reviewers agree, fix without
debate. Dismiss only a finding that is wrong, or one that needs the user's
decision, and list each dismissed finding with the reason. Re-run until clean
or only dismissible nits remain. A fix that adds a second copy or grows a file
past the guide goes back through steps 5 and 6.

## 8. Ponytail pass, default on

Run /ponytail-review and apply its delete-list before the manual review
handoff. Skip only when the command arguments ($ARGUMENTS) include
"no-ponytail". If the ponytail plugin is not installed, report that and
continue.

## 9. Aggressive audit: comments, naming, and new terms

Audit the whole diff three ways, aggressively, with the codebase as the
reference for every finding: name the existing convention that a finding
compares against. For a large diff, split the read across parallel read-only
audit agents by area (the library, the site, the MCP, the docs and specs), then
apply the fixes yourself.

1. **Comments: clarity and relevance.** Every comment justifies itself or gets
   deleted. Sweep `//`, `/** */`, `{/* */}`, and `#` alike.
   For TSX, review each logical markup section against jsx-conventions. The
   preflight heuristic skips TSX.
   - Keep: a short sentence explaining why a non-obvious choice was made.
   - Delete: restatements of the code, decision history, "NOT X" notes,
     migration narrative, trailing justifications after "since" or "because",
     definitions by negation, and notes about what some other module does.
   - A comment that is no longer true gets rewritten.
2. **Naming: self-documentation.** Read the diff as a stranger would. Every
   folder, file, function, and variable name says what the thing is and matches
   its siblings. The `code-style` skill is the reference.
3. **New terms and phrasing.** A second name for something the codebase already
   names, coined jargon, a rare word where a common one is accurate, and every
   rejected term in the `domain-model` skill and code-style rule 17. Adopt the
   existing term. Copy never says an upgrade is "safe".

Apply every clear-cut finding and every judgment call you agree with, then
rerun step 3. Report what you changed, and each finding left alone with the
reason.

## 10. Final report: new terms, structure, file names, long files, and QA checklist

Recheck the diff as it stands after every fix above, and build five lists for
the handoff, fixing what each one finds in this change.

1. **New terminology.** Every term the diff introduces, beside the existing
   term it matches or why no existing name covers it. A new domain noun goes
   into the `domain-model` skill in this change.
2. **Canonical structure.** Every folder and file added, moved, or renamed sits
   where the root module map and its module's AGENTS.md put that kind of thing.
3. **Idiomatic, self-documenting file names.** Every new or renamed file and
   folder follows code-style rule 19.
4. **Long files.** Step 6's table on the final diff.
5. **QA checklist.** What the user tests by hand before approving, from the
   final diff and the change's spec scenarios, grouped by feature, in short
   plain sentences of one action and one expected result. Add a Still open
   group for anything waiting on the user.

Rerun step 3 after any rename or move.

## 11. Manual review handoff

Summarize the full diff for human review: each file, what changed, and why.
Write the long report to `logs/ship-report.md` (git-ignored) and give its path
in the handoff. The report holds the reports from steps 4, 5, 6, 9, and 10,
every reviewer's findings with the ones dismissed and why, and
recommendations. A recommendation is only work that needs the user's decision.
Show the suggested commit message. If approval to archive and commit is pending,
stop here for human review. An explicit instruction to archive and commit after
a successful /ship authorizes those steps for this change.

## 12. Archive the change

Run `openspec list`. If exactly one change is open, use it without asking. If
several are open, ask which one to archive. Then run:
openspec archive <change-name> --yes
Always the CLI, never /opsx:archive. The archive goes in the same commit as the
code.

## 13. Commit

Confirm `git status --short` shows no unstaged modifications. Always show the
suggested commit message first (git-discipline skill, Conventional Commits).
Commit on main once the user has authorized this change.

## 14. Push main

After the archive and implementation are committed together, push to origin/main
when the user has explicitly authorized the push. Verify the remote commit.
