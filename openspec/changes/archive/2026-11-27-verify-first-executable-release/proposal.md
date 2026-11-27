# Verify the first executable release

## Why

`ship-standalone-executable` built and tested the standalone executable, the release jobs and the GitHub Action on one machine. Four checks need a real release: the matrix build on each runner, the attested publication, the action on each platform and the CI guide's download commands. They cannot run before the code reaches `main` and a `v*` tag exists.

## What Changes

- Watch the v0.4.0 tag run `build-executable`, `publish-executables` and `stage`.
- Run `verify-public` against the tag.
- Install the executable with the action on Linux x64, Linux arm64 and macOS arm64 from a scratch workflow.
- Run the CI guide's download and verification commands as written.
- Record the Linux executable sizes and the macOS quarantine result in the archived design.

## Capabilities

No capability changes. The release only exercises behavior `ship-standalone-executable` specified.

## Impact

A failed check reopens its code in a new change. A passing run changes only the recorded measurements.
