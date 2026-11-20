# Repository checks

Run these commands from the repository root. The root package manifest names the commands and README.md documents their use.

| Entry point | Scope |
| --- | --- |
| `inspect.ts` | Developer CLI for `bun run inspect <repo-url> [--fake]`. Uses the library’s public entry, renders progress, and saves JSON to the root logs directory. Fake mode reads `fixtures/recorded/`. |
| `preflight.sh` | Runs the offline checks in order. CI, /ship, and `bun run check` invoke this file. |
| `check-packed-library.sh` | Builds and packs the library and checks Node, Bun, and declaration consumers. |
| `check-structure.sh` | Checks tracked and untracked package manifests with Git. |
| `check-package-boundaries.ts` | Discovers app and package workspaces. Checks literal imports, declarations, and project references. |
| `check-dependency-pins.ts` | Compares the package manager with the Bun version file. Verifies each patched dependency exists at the specified version in the lockfile. |
| `check-dependency-advisories.ts` | Validates Bun's registry response and the reviewed advisory exceptions. Runs in its own CI job. |

`readImports.ts` uses Oxc to read literal imports, re-exports, type imports, and require calls. `readWorkspace.ts` uses get-tsconfig to read JSONC, follow `extends`, and resolve inherited path mappings. Project references belong to the workspace that declares them.

Keep check tests beside their entry points. Use temporary workspaces or saved inputs for negative cases. `tsconfig.json` enables Bun types for these scripts. The root typecheck and test commands build the public library first so CLI imports resolve on a fresh checkout.
