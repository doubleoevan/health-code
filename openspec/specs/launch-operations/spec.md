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

The admin page SHALL show daily share rate, viewer-to-runner rate, denominators, starts, cache hits, cap hits and spend. It SHALL use only first-party records, discard raw IPs and cookie values, deduplicate qualifying visits, and authenticate every admin HTML and data route with HTTP Basic over HTTPS using the password supplied by Doppler as `HEALTH_CODE_ADMIN_PASSWORD`. An unset or empty password SHALL disable access.

#### Scenario: A teammate reads and then runs

- **WHEN** the creator and a link preview open the report, then another browser reads it twice and starts its own new Inspection within seven days
- **THEN** the report counts as shared once and the eligible viewer converts once

#### Scenario: Unauthenticated admin request

- **WHEN** a request arrives through the public hostname or provider origin without valid Basic credentials
- **THEN** the service returns a 401 Basic challenge on HTTPS and discloses no admin HTML or metrics

### Requirement: Verify the hosted journey with public repositories

An explicit end-to-end command SHALL exercise the four approved public TypeScript repositories against the configured deployment, keep evidence of report rendering and runtime cleanup, and distinguish live verdicts from deterministic regression coverage.

#### Scenario: Collect acceptance evidence

- **WHEN** the maintainer runs the authorized suite
- **THEN** it reports repository commits, report URLs, prompt versions, verdicts and checked runtime deletion, flags timeouts or residual runtimes as failures, and shows how Untested and Can't fix render with their reasons
