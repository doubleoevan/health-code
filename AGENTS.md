# Health Code

Health Code inspects dependency upgrades in public GitHub repositories inside a Runta sandbox.
The TypeScript library owns inspections. The site and MCP server expose the library to people and tools.

## Module map

| Path | Responsibility |
| --- | --- |
| `packages/health-code/` | Library workspace. Owns inspection behavior and the public package entry. Read its AGENTS.md for the boundary. |
| `apps/web/` | Web application (`@health-code/web`). Owns submission, SQLite persistence, SSE, browser interactions and Report Card publication. |
| `apps/mcp/` | Private source for the `health-code mcp` Node command. Owns account setup, MCP tools, Inspection storage and Patch handoff. |
| `evals/` | On-demand, pinned inspection cases and the CarlNotes Baseline inventory for maintainer review. |
| `scripts/` | Repository checks, preflight, and the developer inspection CLI. Use `bun run inspect <repo-url> [--fake]` for a rolling log and a local JSON Report Card. |
| `.github/` | CI, CodeQL, weekly dependency updates, and shared Bun setup. |
| `openspec/` | Specifications and change artifacts. |
| `.agents/` | Project skills and commands. Claude Code uses the links under `.claude/`. |

The library ships the inspection engine. The site and MCP workspaces consume the public library entry. A workspace imports a sibling package by its public name. Apps never import another app. Packages never depend on an app.

## Route work

| When changing | Start here | Guidance |
| --- | --- | --- |
| Baseline, install or upgrade checks, feature matching, agent attempts, patches, verdicts, events, or report cards | `packages/health-code/` | domain-model, code-style |
| Sandbox creation, network policy, command execution, teardown, or the fake provider | `packages/health-code/` | Sandbox Provider boundary. Use provider names in identifiers only inside their provider. |
| Package-manager detection, install, bump, typecheck, tests, or upgrade discovery | `packages/health-code/` | Ecosystem Adapter boundary. |
| Model-facing instructions, evidence interpolation, or model calls | `packages/health-code/` | prompt-authoring, ai-sdk |
| Hosted submission, recovery, SSE, live log, timeline, or Report Card publication | `apps/web/` | jsx-conventions, vercel-react-best-practices, web-design-guidelines |
| MCP tools, arguments, or protocol responses | `apps/mcp/` | Consume the library through its public entry. |
| Lint, types, dependency policy, import rules, or test discovery | `scripts/` and root tool configs | See scripts/AGENTS.md and the README Development section. |
| CI or dependency updates | `.github/` | CI and /ship both invoke `bash scripts/preflight.sh`. |
| Naming or documentation | `.agents/skills/` and the affected module guide | domain-model, write-docs |

## Paths never to read

Keep secret files such as `.env` and `.env.*` out of agent context. Skip installed dependencies (`node_modules`), builds (`.tsbuild`, `build`, `dist`), coverage, logs, and archived OpenSpec changes during source discovery. Read source checks and tests for behavior. Load a vendored skill only for work it governs.

## Verification

Run `bash scripts/preflight.sh` from the repository root before handoff. It stops at the first failure. It checks Biome, manifest placement, package boundaries, dependency pins, Knip, the TypeScript projects, and tests.

The independent CI advisories job runs `bun run check:advisories` against the registry. Record a reviewed exception in `dependency-advisories.json` with its advisory ID, package, reason, and review date. Remove it once the advisory clears.

## Working rules

- **Local development.** Start site development and preview sessions with hot reload enabled by default. Use the site’s development command and verify an edit appears in the open browser.

- **Comments.** Use imperative voice for inline comments and third person for JSDoc. Keep a short why for a non-obvious choice. Delete restatements, decision history, NOT-X notes, trailing “since” or “because” justifications, definitions by negation, and notes about other modules. Rewrite a comment when its claim changes.
- **Code style.** Follow code-style. Use verb-plus-noun names for modules that perform an action and a `to` prefix for cheap synchronous transforms. Write explicit return types. Use an options object for three or more parameters. Use only abbreviations on the skill's whitelist. Write multi-line `if` blocks with braces. Give a second copy one shared home. Review any file past about 400 lines and split distinct responsibilities.
- **Vocabulary.** Follow domain-model in code, comments, and specs. Add a new domain noun to the skill in the same change. Use descriptive identifiers and keep branding in customer copy. Highlight and pin Sandbox Events in the live log and timeline.
- **Documentation.** Give every module its own `AGENTS.md` when you create it. Keep it current alongside the README in the same change. Document ownership, folders, public entry points, commands, and verification. Update the root map and routing entries when ownership changes.
- **Git.** Work on `main` only. Suggest a Conventional Commit message that makes sense without project context. Get explicit approval before committing and separate explicit approval before pushing.
- **Agent prompts.** State the task and reference the relevant skills in one line. Leave conventions in the skills and omit commit instructions.
- **Secrets.** Use Doppler for the app and GitHub secrets for CI only. Never put secrets in the repository, a dotenv file, a log, a tool result, a prompt, or a report card.
- **Tests.** Unit tests use a fake Sandbox Provider and recorded evidence. They never call Runta or a model. Contract tests that need Runta skip when `RUNTA_TOKEN` is absent. Model evaluations run separately and report results without gating preflight.
- **Untrusted text.** Fence release notes, repository files, and command output in every model prompt with a fresh per-call nonce. Follow prompt-authoring for interpolation, bounds, and tests.
- **Shipping order.** Implement the approved design and update its module guides and README. Run `/ship` and complete its review. Archive the change with the OpenSpec CLI, commit the implementation and archive together on `main`, then push to `origin/main` with authorization. Follow `.agents/commands/ship.md` for the checks and handoff.

## Skills

Load the relevant skill from `.agents/skills/`. Domain-model and prompt-authoring own the project vocabulary and prompt contract. Use code-style for TypeScript, git-discipline for Git, write-docs for prose, and ponytail when reviewing the size of a change. The routing table identifies the model and site skills.
