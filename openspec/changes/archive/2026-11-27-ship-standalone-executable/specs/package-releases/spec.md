# Spec Delta

## ADDED Requirements

### Requirement: Publish the standalone executables

A version tag SHALL build the standalone executable for Linux x64, Linux arm64 and macOS arm64 from the frozen lockfile and the tagged commit. Each build SHALL run its own tests on its own platform before release. The GitHub release for the tag SHALL carry each executable, named with the version and platform, a SHA-256 checksum file and a signed build provenance attestation that names the release workflow, the tag and the commit.

#### Scenario: Verify a downloaded executable

- **WHEN** a user downloads an executable and the checksum file from the release and runs the documented checksum and provenance commands
- **THEN** both pass and the provenance names `.github/workflows/release.yml`, the tag and its commit

#### Scenario: A file changed after release

- **WHEN** a release executable differs from the attested bytes
- **THEN** the checksum and provenance commands fail

### Requirement: Keep the executables and the npm package in step

The executables and the npm package of one version SHALL carry identical package files: `package.json`, the prompt templates and the Guest bundles. The npm package SHALL be staged only after every executable built, passed its tests and was published.

#### Scenario: Identical package files

- **WHEN** the release builds the executables and packs the npm tarball
- **THEN** the release compares the file digests each executable reports with the tarball's and stops before staging on any difference

#### Scenario: An executable build fails

- **WHEN** any platform's executable fails to build or fails its tests
- **THEN** the release publishes no executable and stages no npm package for that version

### Requirement: Limit release write access

Only the job that uploads release files SHALL hold `contents: write`. The jobs that build and test the executables SHALL hold read access only and receive no npm token.

#### Scenario: Review the workflow permissions

- **WHEN** a reviewer reads the release workflow
- **THEN** exactly one job grants `contents: write`, and it runs no repository build or test command
