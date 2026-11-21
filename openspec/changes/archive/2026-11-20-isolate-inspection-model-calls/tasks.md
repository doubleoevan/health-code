# Implementation tasks

## 1. Public role configuration

- [ ] 1.1 After agents-and-patches merges, reconcile the role names, accepted requirements and option types against its public package. Add packed type fixtures for legacy calls, host handles, valid isolated routes and rejected mixed inputs.
- [ ] 1.2 Add the optional discriminator to the public package and document its default, caller-owned routes and failure behavior in the library guide and README. Verify both default and isolated examples compile.

## 2. Isolated model dispatch

- [ ] 2.1 Dispatch the two selected roles through an isolated provider runtime. Use the fake provider to assert endpoint and header scope, absence of repository commands and absence of raw credentials in guest traffic or evidence.
- [ ] 2.2 Reserve runtime and model costs before use. Exercise missing bindings, egress mismatch, exhausted budgets, timeouts, lost responses and caller cancellation. Check usage, teardown and zero fallback requests to the host model.
- [ ] 2.3 Extend the separately gated provider contract to verify stub attachment, authenticated requests to a controlled destination, revocation and cleanup. Keep routine verification offline.

## 3. MCP migration

- [ ] 3.1 Pin the public library with the new option and enable it in the MCP server. Run a recorded four-role Inspection with a fake provider and the host model key unset. Confirm missing stored secrets give setup guidance.
- [ ] 3.2 Remove model-key forwarding from generated configs for both clients. Document migration and rollback in the README and MCP guide. Test setup and key rotation still write the same named secret and never print the value.
- [ ] 3.3 Smoke-test the packed Node consumer, read a pre-upgrade Report Card, run strict OpenSpec validation and repository preflight.
