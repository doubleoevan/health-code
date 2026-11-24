## MODIFIED Requirements

### Requirement: Discover and start inspections

Both clients SHALL discover ten titled tools with input and output schemas, plain summary-first text, accurate read-only and open-world hints, and usable structured success results. `start_inspection` SHALL accept a public GitHub repository as a URL, a Git remote address or `owner/repository`, return an Inspection ID immediately and continue work in the local server process.

#### Scenario: Inspect a slow repository

- **WHEN** the library emits its start event but the sandbox has yet to finish its first operation
- **THEN** the client receives the ID and polling guidance, and can issue another tool call while the Inspection proceeds

#### Scenario: No repository named

- **WHEN** the developer names no repository
- **THEN** the tool descriptions direct the agent to pass the GitHub origin of the current checkout. A call without one returns how to find it.

#### Scenario: Named repository

- **WHEN** the developer names a repository
- **THEN** the inspection uses that repository

#### Scenario: Repository is not public

- **WHEN** GitHub shows no public repository at the address
- **THEN** the caller receives a message that names the repository and says it must be public. No sandbox starts.

#### Scenario: Unacceptable source

- **WHEN** a caller supplies an address outside GitHub or the public clone cannot access the Repository
- **THEN** the caller receives a readable start error or a terminal failure under the issued ID, respectively

## ADDED Requirements

### Requirement: Explain failures

Every failed tool call or inspection SHALL return its cause and a next step the coding agent can take. An inspection error SHALL include its code for bug reports. Unexpected errors SHALL expose no internal text.

#### Scenario: Account problem

- **WHEN** Runta rejects the token or its permissions
- **THEN** the message names the token or the missing access and where to fix it

#### Scenario: Temporary problem

- **WHEN** an inspection times out or Runta is unavailable
- **THEN** the message says to try again and what to change if it repeats

#### Scenario: Unfinished inspection

- **WHEN** a caller asks for the results of an inspection that is still running
- **THEN** the message says to poll it and no second inspection starts
