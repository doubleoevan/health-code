# tested-patches Specification

## Purpose
Give maintainers a reproducible series of reviewed commits that reproduces the tested upgrade and any accepted adoption.

## Requirements

### Requirement: Protect the Baseline test inventory

Before retaining a Patch the engine SHALL reconcile Baseline and final test inventories. Every previously passing case must still exist and pass. Preserve named prior failures and test file errors. A missing inventory, deleted test or newly skipped case SHALL prevent publication.

#### Scenario: Runner filters hide tests

- **WHEN** editing the test command, test source, snapshots or discovery configuration makes an existing test disappear, skip or cease asserting behavior
- **THEN** the final check rejects the Patch even if the test command exits zero.

#### Scenario: Test setup lives outside a test directory

- **WHEN** a proposed source edit targets a configured setup module or a helper used only by tests
- **THEN** the engine rejects the edit using the inspected repository’s test configuration and imports. Unresolved setup leaves the source edit unverified. A Vite or Vitest configuration may compute settings that cannot name setup modules, such as plugins. Its local imports stay protected and its path aliases must be readable without running them.

### Requirement: Review edits to existing tests

The engine SHALL allow added cases and reject weakened assertions. A changed existing assertion requires evidence of changed library behavior, the agent’s rationale, a separate flagged commit and a reviewable Verdict.

#### Scenario: A documented behavior change needs a new assertion

- **WHEN** an existing case retains its identity, independently supported old/new behavior explains its changed expectation and all required checks pass
- **THEN** the Patch flags that change for review and the upgrade receives Fixed with test changes.

#### Scenario: A repair moves a mocked module path

- **WHEN** a repair changes only the mocked path in an existing test and both paths belong to the upgraded package
- **THEN** the engine keeps the rest of the test unchanged, flags the commit for review and reports Fixed with test changes once all required checks pass.

#### Scenario: Additional coverage in an existing file

- **WHEN** a fix adds a new case alongside unchanged existing cases
- **THEN** the case is recorded as added, and this edit alone does not trigger the existing-test-change Verdict.

#### Scenario: Added coverage uses a new test file

- **WHEN** an agent adds named cases beside a discovered test using the same runner filename convention
- **THEN** the protected workspace creates the file exclusively and final verification requires each new case to be discovered and pass.

### Requirement: Independently verify the final tree

The engine SHALL reconstruct the proposed tree from the tested base and recheck changed paths, dependency commits, lifecycle scripts, install actions, applicable typechecking and test evidence. During final install and tests it SHALL compare all observed destination hosts with the corresponding Baseline phase. Any new host, incomplete comparison, unexpected install finding, new lifecycle script, unflagged new dependency or file outside the frozen allowed set SHALL reject the Patch.

#### Scenario: Registry is allowed but new to this phase

- **WHEN** tests on the candidate contact an otherwise allowed registry that Baseline tests never contacted
- **THEN** the final check rejects the Patch and records the phase and destination.

#### Scenario: Independent replay detects an unauthorized edit

- **WHEN** a patch edits outside the usage map, manifests, lockfile, recognized test files and files identified by failing checks, introduces a lifecycle hook or hides a new dependency in a fix commit
- **THEN** the engine records the rejection and withholds that patch series.

#### Scenario: A confirmed install failure needs a repair

- **WHEN** an Install Check fails twice with complete, comparable installation observations
- **THEN** the supervisor restores the inspected tree, writes the intended version to each declaring manifest, and tries to resolve the lockfile without lifecycle scripts before starting the repair. An unresolved lockfile permits diagnosis and prevents Patch publication until a committed dependency change resolves the lockfile with the target version in every declaring workspace. An incomplete observation prevents the attempt. Manifest edits change only the affected values and keep the file’s formatting. Project reads during patch verification use the verification deadline.

#### Scenario: Declared dependencies must move with the target

- **WHEN** a repair requests newer versions of dependencies the repository already declares
- **THEN** the supervisor updates every declaring workspace, installs the whole set under the Baseline observation rules and records one flagged commit. The report lists each earlier version. An older version, a change to the target or a new lifecycle script rejects the set.

#### Scenario: An installed package gains another lifecycle hook instance

- **WHEN** a candidate adds a second installed copy of a package with an existing hook, or the installed layout cannot be inventoried
- **THEN** the engine withholds the Patch. Each hook is compared by installed location and occurrence as well as package, script and content. Installed packages are compared by the scripts that package managers run for registry packages (`preinstall`, `install` and `postinstall`). The root package and workspaces also include preparation scripts.

#### Scenario: Verification exceeds its deadline

- **WHEN** the final check reaches its deadline before the complete series has been verified and replayed
- **THEN** the report withholds the Patch, including if a provider operation finishes later.

### Requirement: Export tested commits in order

The engine SHALL commit inside the sandbox and export each accepted series with git format-patch. The upgrade series SHALL order the bump and lockfile, each flagged dependency, individual fixes, then flagged existing-test changes. A feature series SHALL apply to the accepted upgrade tip. Each export SHALL identify its base, tested tip, reviewed commits, digest and prerequisite series and reproduce the tested tree when applied.

#### Scenario: An upgrade and adoption are both accepted

- **WHEN** an upgrade needs one new dependency and a code fix and later gains an accepted adoption
- **THEN** the first mailbox replays in the declared order at the inspected repository commit and the feature mailbox replays on top to the tested feature tree.

### Requirement: Return instructions for the consumer's coding agent

Every retained Patch SHALL include application instructions to create a branch, apply the ordered series with git am, adapt minimally on a moved repository and disclose exactly what changed, then run typecheck and tests without editing tests. Instructions SHALL direct the consumer to open a pull request using the supplied commit messages and to fork first when the repository belongs to someone else. Delivery details belong to the consumer.

#### Scenario: Repository advanced since inspection

- **WHEN** a consumer retrieves a patch tested on an older commit
- **THEN** its instructions identify the tested base and any prerequisites and require explicit disclosure and verification of any adaptation.
