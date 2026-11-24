# Repository checks

Run these commands from the repository root. The root package manifest names the commands and DEVELOPMENT.md documents their use.

| Entry point | Scope |
| --- | --- |
| `evaluate.ts`, `evaluateUpgrade.ts` | Development runners for the cases in `../evals/`. Record one Baseline or score pinned inputs with the public library. |
| `inspect.ts` | Developer CLI for `bun run inspect <repo-url> [--fake]`. Uses the library’s public entry, renders progress, and saves JSON to the root logs directory. Fake mode reads `fixtures/recorded/`. |
| `check-comment-groups.sh` | Check tracked TypeScript, JavaScript and shell files with `--tracked`, one path as an argument, or a Claude Code edit event on stdin. The project hook lives in `../.claude/settings.json`. |
| `preflight.sh` | Runs the offline checks in order. CI, /ship, and `bun run check` invoke this file. |
| `check-packed-library.sh` | Packs the release through its prepack hook and checks Node, Bun, and declaration consumers. |
| `check-structure.sh` | Checks tracked and untracked package manifests with Git. |
| `check-package-boundaries.ts` | Discovers app and package workspaces. Checks literal imports, declarations, and project references. The bundled app view can import development dependencies. |
| `check-dependency-pins.ts` | Compares the package manager with the Bun version file. Verifies each patched dependency exists at the specified version in the lockfile. |
| `check-dependency-advisories.ts` | Validates Bun's registry response and the reviewed advisory exceptions. Runs in its own CI job. |

`readImports.ts` uses Oxc to read literal imports, re-exports, type imports, and require calls. `readWorkspace.ts` uses get-tsconfig to read JSONC, follow `extends`, and resolve inherited path mappings. Project references belong to the workspace that declares them.

Keep check tests beside their entry points. Use temporary workspaces or saved inputs for negative cases. `tsconfig.json` enables Bun types for these scripts. The root typecheck and test commands build the public library first so CLI imports resolve on a fresh checkout.

`evaluate.ts` dispatches pinned cases. `evaluateUpgrade.ts` grades the confirmed regression and final patch. `scoreBudget.ts` compares observed usage and reservations with the public defaults. `evaluateBaseline.ts` writes a complete Baseline atomically in record mode and compares reviewed measurements in score mode. `check-packed-library.sh` compiles both public return types and replays both event versions under Node and Bun.

The development log displays Model Request Sandbox startup details. The cost grader uses both independently rounded runtime quotes when an Inspection Report contains runtime usage.

`release-packages.sh --dry-run` builds and inspects the release tarballs. The GitHub tag workflow verifies registry integrity and signed provenance for already public siblings before staging missing versions. The verification job checks both public releases after maintainer approval. `inspectHosted.ts` runs the four hosted browser cases and checks Runta inventory through its read API.
