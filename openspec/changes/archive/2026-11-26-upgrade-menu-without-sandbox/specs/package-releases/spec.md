# Spec Delta

## MODIFIED Requirements

### Requirement: Give reviewers a runnable introduction

The root README SHALL describe the product in a few lines, name the hosted URL and show site and CI quick starts, packages, architecture and license. The guides it links SHALL cover every CI setting, offline replay, Runta controls and tests. The README's architecture diagram and the guides SHALL state that testing an Upgrade needs a Runta account and that the Upgrade menu does not.

#### Scenario: Reviewer without credentials

- **WHEN** a reviewer follows the replay instructions in a clean checkout
- **THEN** the local interactive report opens without contacting Runta or a model

#### Scenario: Reviewer without a Runta account

- **WHEN** a reviewer follows the library quick start with no Runta account
- **THEN** the documented call returns an Upgrade menu for a public Repository, and the docs name the account as the requirement for the next step
