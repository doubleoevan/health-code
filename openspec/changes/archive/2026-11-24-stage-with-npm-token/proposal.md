# Stage releases with an npm token

## Why

npm rejects trusted publishing from repositories with immutable GitHub sign-in subjects (npm/cli#9969). Version 0.1.0 cannot be staged.

## What Changes

- Accept a short-lived `NPM_TOKEN` in the staging step only.
- Keep provenance and maintainer approval.

## Capabilities

### Modified Capabilities

- `package-releases` accepts a temporary token while npm rejects the workflow identity.

## Impact

The release script and workflow change. Package contents stay the same.
