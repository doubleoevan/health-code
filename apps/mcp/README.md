# Health Code MCP

[npm](https://www.npmjs.com/package/@health-code/mcp) · [GitHub](https://github.com/doubleoevan/health-code) · [Demo](https://runhealthcode.dev)

Inspect a public GitHub repository from Claude Code or Codex using your own Runta account. The server offers tools to start an inspection, follow its progress, retrieve a tested patch by digest and record what happened when you applied it.

```sh
npx @health-code/mcp setup
```

Follow the printed client instructions. Claude and other clients with MCP Apps support show an app view. Choose an upgrade, follow its inspection and read the verdict and patch on one page. Select **Apply** to ask your coding agent to apply a patch. Other clients receive the same results as text.

To start the stdio server directly, run `npx @health-code/mcp`. Each release runs the executable from the matching version of the `health-code` package.

## Setup

You need Node 22.18 or later on the 22.x line. Node 24.11 or later also works.

| Required | Value |
| --- | --- |
| `RUNTA_TOKEN` | Token from your [Runta account](https://dashboard.runta.com). It needs access to runtimes and secrets and the model-provider list. |
| `MODEL_API_KEY` | Model provider key. Only setup needs it. Setup stores it in Runta. |
| `HEALTH_CODE_MODEL_HOST` | Model provider address such as `https://api.anthropic.com`. Include the full API path when it isn't `/v1`, such as `https://api.z.ai/api/paas/v4` or `https://proxy.example.com/anthropic/v1`. Leave out `/chat/completions` or `/messages`. |
| `HEALTH_CODE_MODEL` | Model ID such as `claude-opus-5-5`. |

1. Set these variables and run `npx health-code mcp setup` from your home directory.
2. Paste the printed entry inside `mcpServers` in `.mcp.json` for Claude Code. For Codex paste it at the top level of `~/.codex/config.toml`.
3. Remove `MODEL_API_KEY` and restart your client with `RUNTA_TOKEN` set. The entry includes your model settings.
4. Ask your agent to **list upgrades for this repository**. Choose one and ask it to **try that upgrade and apply its verified patch**.

| Optional | Use |
| --- | --- |
| `HEALTH_CODE_SUMMARY_MODEL` | Model that summarizes release notes. Defaults to `HEALTH_CODE_MODEL`. |
| `HEALTH_CODE_MATCH_MODEL` | Model that matches new features to your code. Defaults to `HEALTH_CODE_MODEL`. |
| `HEALTH_CODE_REPAIR_MODEL` | Model that repairs checks an upgrade breaks. Defaults to `HEALTH_CODE_MODEL`. |
| `HEALTH_CODE_ADOPTION_MODEL` | Model that applies a new feature to your code. Defaults to `HEALTH_CODE_MODEL`. |
| `HEALTH_CODE_MODEL_PROTOCOL` | `anthropic` or `openai-compatible`. Defaults to `anthropic` for `https://api.anthropic.com` and `openai-compatible` for other hosts. Set `anthropic` for a proxy that uses the Anthropic API. |
| `HEALTH_CODE_INPUT_USD_PER_MILLION` | Highest price per million input tokens. Defaults to `10`. |
| `HEALTH_CODE_OUTPUT_USD_PER_MILLION` | Highest price per million output tokens. Defaults to `50`. |
| `GITHUB_TOKEN` | Release notes and the public repository check. Add it to the client entry. |

The prices apply to every model you set and drive the spend limits. Set them when your model costs more than the defaults or to use more of each limit with a cheaper model. Run setup again after changing the host or protocol.

## Tools

Name a public repository as `owner/repository` or a URL. When you name none, your agent passes the GitHub origin of your current checkout. A failed call returns the cause and the next step.

Call `list_upgrades({ repositoryUrl })` to see eligible versions and their documented features. Choose one and call `get_upgrade({ upgradeMenuId, dependency, to })` to get its verified patch or the check results explaining why none was produced. Starting discovery or testing a selected upgrade sends ordered events to clients that display MCP progress. A saved upgrade menu reuses the discovered versions and fetches release notes for the visible page. A saved patch opens from local storage. Use the inspection ID with `read_inspection` to replay the log. To browse another page or sort the same upgrade menu, pass its `upgradeMenuId` to `list_upgrades` with `offset`, `order` (workspaces by default, minor or alphabetical), `search` or `readyOnly`.

`read_inspection` returns a `patches` list with the dependency, target version when recorded, role, SHA-256 and required Patch SHA-256 (`prerequisiteSha256`). Choose one artifact and pass its `sha256` and the same `inspectionId` to `get_tested_patch`. Verify the downloaded mailbox and apply any required upgrade patch before its feature patch.

Call `read_upgrade_results` for each upgrade’s verdict, checks and patch references. Call `stop_inspection` to stop an active inspection.

Each upgrade menu target includes its first five documented features. Pass `nextOffset` as `offset` to `get_upgrade_features` for the next page.

## Example agent session

Ask your agent to **list upgrades for this repository, try the upgrade I choose and apply its verified patch**.

1. Call `list_upgrades` with the public GitHub `repositoryUrl`. Review the versions and documented features. To browse more, pass the returned `upgradeMenuId` and pass `nextOffset` as `offset`.
2. Call `get_upgrade` with `upgradeMenuId`, `dependency` and `to` from the upgrade menu. It returns the verified upgrade patch or the check results explaining why none was produced.
3. Compare the local remote and HEAD with the inspected repository and commit. To fetch additional patch pages, pass the inspection ID, digest and offset to `get_tested_patch`. New discovery and testing stream step and sandbox events as MCP progress notifications. A saved upgrade menu skips sandbox discovery and fetches release notes for the visible page. Saved patches open from local storage. Replay the log with `read_inspection`.
4. Concatenate each Patch’s text pages verbatim. Verify the SHA-256 digest, follow the library prompt and apply the required series first on a new branch. Run the typecheck and tests without editing tests. Open the authorized pull request.
5. Call `report_patch_result` with the ID, digest, `application` (clean or adapted), `tests` (passed, failed or not_run) and optional `pullRequest`. Supply `adaptation` for an adapted Patch.

Completed Inspection Reports live under `~/.health-code/inspections/<inspection-id>/inspection-report.json`. Restart either client and read by the same ID without credentials. Developer-reported results are separate from the library Verdict. Closing the local server interrupts active Inspections. Public links belong to hosted Inspections.

## CI

Run `npx @health-code/mcp setup` once to register your model key with your Runta account. In CI, set `RUNTA_TOKEN` and the model settings from setup, then run:

```sh
npx health-code check https://github.com/owner/repository --dependency zod --to 4.0.0
```

Omit the target to test the first eligible upgrade. The command writes `inspection-report.json` and any `.patch` files to `health-code-report/`. Use `--output` to change the folder and `--revision` to pin a commit. It exits nonzero when the inspection fails or stops early. An upgrade without a patch still exits zero, so read its verdict in the report.

Tests receive placeholder environment values. Supply a non-secret value with `--env NAME=value`, repeated as needed. The sandbox and its saved output can expose these values.

Your pipeline can apply a patch with `git am` and open a pull request with its own token.

## Unpublished checkout

To use an unpublished checkout, build the library with `bun run --cwd packages/health-code build`, then run `bun run --cwd apps/mcp build`. Use `node packages/health-code/dist/mcp/cli.js mcp setup` in your secret environment. In the printed client entry, use `node` as the command and pass the absolute path to that file followed by `mcp` as the arguments.

MIT licensed.
