# Repository checks

Run these commands from the repository root. The root package manifest names the commands and README.md documents their use.

| Entry point | Scope |
| --- | --- |
| `preflight.sh` | Runs the offline checks in order. CI, /ship, and `bun run check` invoke this file. |
| `check-structure.sh` | Checks tracked and untracked package manifests with Git. |
| `check-package-boundaries.ts` | Discovers app and package workspaces. Checks literal imports, declarations, and project references. |
| `check-dependency-pins.ts` | Compares the package manager with the Bun version file. Verifies each patched dependency exists at the specified version in the lockfile. |
| `check-dependency-advisories.ts` | Validates Bun's registry response and the reviewed advisory exceptions. Runs in its own CI job. |

`readImports.ts` reads module specifiers from the TypeScript syntax tree, including type imports, re-exports, dynamic imports, and literal require calls. `readWorkspace.ts` reads manifests and compiler resolution settings.

Keep check tests beside their entry points. Use temporary workspaces or saved inputs for negative cases. `tsconfig.json` enables Bun types for these scripts. The root scripts for Biome, Knip, TypeScript, and tests invoke their tools directly.
