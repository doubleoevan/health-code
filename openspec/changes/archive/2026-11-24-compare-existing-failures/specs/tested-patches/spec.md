## MODIFIED Requirements

### Requirement: Independently verify the final tree

The engine SHALL reconstruct the proposed tree from the tested base and recheck changed paths, dependency commits, lifecycle scripts, install actions, applicable typechecking and test evidence. Final typechecking SHALL accept only errors identified in the Baseline. During final install and tests it SHALL compare all observed destination hosts with the corresponding Baseline phase. Any new host, incomplete comparison, unexpected install finding, new lifecycle script, unflagged new dependency or file outside the frozen allowed set SHALL reject the Patch.

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
- **THEN** the supervisor updates every declaring workspace, installs the whole set under the Baseline observation rules and records one flagged commit. The report lists each earlier version. Listing the target at its upgraded version has no effect. An older version, a change to the target or a new lifecycle script rejects the set.

#### Scenario: An installed package gains another lifecycle hook instance

- **WHEN** a candidate adds a second installed copy of a package with an existing hook, or the installed layout cannot be inventoried
- **THEN** the engine withholds the Patch. Each hook is compared by installed location and occurrence as well as package, script and content. Installed packages are compared by the scripts that package managers run for registry packages (`preinstall`, `install` and `postinstall`). The root package and workspaces also include preparation scripts.

#### Scenario: Verification exceeds its deadline

- **WHEN** the final check reaches its deadline before the complete series has been verified and replayed
- **THEN** the report withholds the Patch, including if a provider operation finishes later.
