# Tasks

Run each check against the first tagged release of the standalone executable. Turn on immutable releases in the repository settings before tagging.

## 1. Release workflow

- [ ] 1.1 Push the v0.4.0 tag and watch `release.yml`. Verify each `build-executable` leg uploads the executable and its `.files.json`, `publish-executables` publishes the three executables, `health-code-0.4.0.sha256` and `health-code-0.4.0.sigstore.json`, and `stage` stages the npm tarball.
- [ ] 1.2 Rerun `publish-executables` on the same tag. Verify it checks the published files and uploads nothing.
- [ ] 1.3 Approve the npm stage, then run the workflow manually against the tag. Verify `verify-public` passes.

## 2. Action and CI guide

- [ ] 2.1 Use the action at the v0.4.0 commit in a scratch workflow on `ubuntu-latest`, `ubuntu-24.04-arm` and `macos-latest`. Verify `health-code --version` prints `health-code 0.4.0` on each.
- [ ] 2.2 Run the "Verify a download" commands from `apps/cli/README.md` as written on Linux and with `shasum` on macOS. Verify the executable reaches `/usr/local/bin`, and that a changed checksum file stops the commands before the install.
- [ ] 2.3 Download the macOS executable in a browser and run it. Verify the documented `xattr` command lets it run.

## 3. Record

- [ ] 3.1 Record the Linux x64 and Linux arm64 executable sizes in decision 9 and the quarantine result under "Verify during implementation" in `openspec/changes/archive/2026-11-27-ship-standalone-executable/design.md`.
