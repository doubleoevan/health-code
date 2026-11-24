# Restructure folders and rename misleading files

## Why

`apps/web` holds 64 files at its root, the library `src/` holds 53 and `apps/mcp` holds 33. About 40 file names contradict what the file exports. A reader cannot find a module by its folder or its name.

## What Changes

- Split `apps/web` into `src/client`, `src/server` and a shared report module.
- Group the library `src/` into `inspection`, `upgrades`, `models`, `patches` and `sandbox`.
- Move the `apps/mcp` sources under `src/`.
- Rename files to match their main export, and give `scripts/` one casing for TypeScript files.
- Split modules that held two jobs, share the duplicated syntax reader and move check comparison to `src/checks/`.
- Give the recorded sandbox fixture one shared home and record the repository's file conventions in the root guide.

## Capabilities

No capability changes. Behavior, the public library exports and the launcher stay the same. The library tarball’s internal `dist/` layout and the package build scripts change.

## Impact

File paths, import specifiers, build and tool configuration, and module guides change. No specification changes.
