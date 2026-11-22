# Health Code MCP

Inspect a public GitHub repository from Claude Code or Codex using your own Runta account. The server offers tools to start an inspection, follow its progress, retrieve a tested patch by digest and record what happened when you applied it.

```sh
npx @health-code/mcp setup
```

Follow the printed client instructions. To start the stdio server directly, run `npx @health-code/mcp`. Each release runs the executable from the matching version of the `health-code` package.

See the [account setup guide](https://github.com/doubleoevan/health-code#mcp-setup) for credentials, sandbox behavior and local storage.

MIT licensed.

Call `list_upgrades({ repositoryUrl })` to see eligible versions and their documented features. Choose one and call `get_upgrade({ upgradeMenuId, dependency, to })` to get its verified patch or the check results explaining why none was produced. Starting discovery or testing a selected upgrade sends ordered events to clients that display MCP progress. A saved upgrade menu reuses the discovered versions and fetches release notes for the visible page. A saved patch opens from local storage. Use the inspection ID with `read_inspection` to replay the log. To browse another page or sort the same upgrade menu, pass its `upgradeMenuId` to `list_upgrades` with `offset`, `order` (minor, alphabetical or workspaces), `search` or `readyOnly`.

`read_inspection` returns a `patches` list with the dependency, target version when recorded, role, SHA-256 and prerequisite SHA-256. Choose one artifact and pass its `sha256` and the same `inspectionId` to `get_tested_patch`. Verify the downloaded mailbox and apply any required upgrade patch before its feature patch.

Each upgrade menu target includes its first five documented features. Pass `nextOffset` as `offset` to `get_upgrade_features` for the next page.
