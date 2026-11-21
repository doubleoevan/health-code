# Health Code MCP

Inspect a public GitHub repository from Claude Code or Codex using your own Runta account. The server offers tools to start an inspection, follow its progress, retrieve a tested patch by digest and record what happened when you applied it.

```sh
npx @health-code/mcp setup
```

Follow the printed client instructions. To start the stdio server directly, run `npx @health-code/mcp`. Each release runs the executable from the matching version of the `health-code` package.

See the [account setup guide](https://github.com/doubleoevan/health-code#mcp-setup) for credentials, sandbox behavior and local storage.

MIT licensed.
