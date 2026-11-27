# launch-operations Specification

## Purpose
Operate a public, budgeted inspection service and measure whether shared evidence leads other developers to inspect their own repositories.

## Requirements

### Requirement: Serve and operate the public deployment

The web service SHALL serve HTTPS at runhealthcode.dev through a DNS-only Cloudflare record pointing to Northflank, terminate TLS on Northflank, use durable SQLite storage across container replacement, expose safe health probes and emit structured per-Inspection logs containing ID, repo, duration, verdict counts and cost basis. Secrets and raw visitor identifiers SHALL stay out of logs. Operators SHALL be able to change validated limits without deploying a new image or interrupting active work.

#### Scenario: Change a running limit

- **WHEN** an operator changes the approved deployment limit configuration
- **THEN** the service applies a valid snapshot within the documented refresh interval, existing reports stay available, and invalid configuration does not raise spending authority

#### Scenario: Replace the service

- **WHEN** a new container mounts the existing volume and becomes ready
- **THEN** a previously shared HTTPS link returns the same stored evidence and no secret appears in health or completion logs

### Requirement: Show daily first-party launch signals to authorized maintainers

The admin page SHALL show daily share rate, viewer-to-runner rate, denominators, starts, fresh and reused upgrade menus, cache hits, cap hits and spend. Starts SHALL count paid work only. It SHALL use only first-party records, discard raw IPs and cookie values, deduplicate qualifying visits, and authenticate every admin HTML and data route with HTTP Basic over HTTPS using the password supplied by Doppler as `HEALTH_CODE_ADMIN_PASSWORD`. An unset or empty password SHALL disable access.

#### Scenario: A teammate reads and then runs

- **WHEN** the creator and a link preview open the report, then another browser reads it twice and starts its own new Inspection within seven days
- **THEN** the report counts as shared once and the eligible viewer converts once

#### Scenario: Unauthenticated admin request

- **WHEN** a request arrives through the public hostname or provider origin without valid Basic credentials
- **THEN** the service returns a 401 Basic challenge on HTTPS and discloses no admin HTML or metrics

#### Scenario: Menus beside Inspections

- **WHEN** a day has ten fresh menus, five reused menus and three upgrade tests
- **THEN** the admin page shows 10, 5 and 3 for that day, so the share of menus that led to an upgrade test can be read from one row

### Requirement: Verify the hosted journey with public repositories

An explicit end-to-end command SHALL exercise the four approved public TypeScript repositories against the configured deployment, keep evidence of report rendering and runtime cleanup, and distinguish live verdicts from deterministic regression coverage.

#### Scenario: Collect acceptance evidence

- **WHEN** the maintainer runs the authorized suite
- **THEN** it reports repository commits, report URLs, prompt versions, verdicts and checked runtime deletion, flags timeouts or residual runtimes as failures, and shows how Untested and Can't fix render with their reasons

### Requirement: Require a GitHub token in production

The production service SHALL refuse to start without a GitHub token. Replay mode SHALL work with no credentials. The token SHALL stay out of logs, health output and reports. The hosting guide SHALL require a token limited to read-only access to public repositories and used for nothing else.

#### Scenario: Missing token

- **WHEN** the production service starts with no GitHub token
- **THEN** it exits with a message that names the missing setting

#### Scenario: Token scope

- **WHEN** an operator follows the hosting guide to create the token
- **THEN** the token can read public repositories and has no other permission

#### Scenario: Replay

- **WHEN** a developer starts the site in replay mode with no credentials
- **THEN** New features shows the fixture menu and the site makes no GitHub request

### Requirement: Operate upgrade menu limits

Operators SHALL be able to change the daily menu limit, the concurrent menu builds and the GitHub quota floor through the deployment limit configuration. Each SHALL have a default, so a configuration without them stays valid.

#### Scenario: Existing configuration

- **WHEN** the service loads a limit configuration written before these settings existed
- **THEN** it accepts the configuration and applies the default menu limits

#### Scenario: Lower the menu limit

- **WHEN** an operator lowers the daily menu limit
- **THEN** the service applies it within the documented refresh interval without a deploy
