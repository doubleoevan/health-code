# Sandbox guest tools

`project.ts` is the entry for dependency discovery, Baseline and Upgrade commands. `inventory.ts` reads lockfiles, workspace manifests, and environment variable names. `readTestReport.ts` translates JUnit and JSON test results into comparable identities.

`observe.ts` interprets the protected network and filesystem evidence after an Install Check. `trackFileLinks.ts` follows recorded in-project symlink targets for metadata changes. Unknown targets and ambiguous changes to writable mappings leave filesystem coverage incomplete. The library build bundles both guest entries for Node. Verify them using the recorded projects and the shared live provider contract.
