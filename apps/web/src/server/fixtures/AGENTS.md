# Inspection fixtures

`recorded/inspection-report-v2.json` captures the version 2 public library with a fake Sandbox Provider, recorded model replies, release metadata and Patch mailboxes for the example repository. The library produced the timeline, role usage, Verdict and digests. Replay preserves the event intervals. `recorded/inspection.json` is the earlier version 1 capture used to check stored report compatibility. `createTestSite.ts` supplies the credential-free HTTP test app. Run `bun test apps/web` after changing either recording.
