# Design

A compiler error is identified by its file and message without its line. A repeated message counts separately, so a second copy is new. Any output line without a file leaves the whole check opaque. Builds with `-b` use the same comparison. An older compiler skips projects that depend on a failing one, so their errors stay hidden before and after the upgrade. An opaque Baseline typecheck keeps the previous partial comparison.

Node's test runner takes no reporter after its file arguments. The guest sets `NODE_OPTIONS` with a custom reporter that writes the Jest JSON shape the existing readers accept. Only scripts ending in a plain `node --test` or `tsx --test` command qualify. Scripts that set a reporter, preload a module or use other shell syntax keep exit status results.
