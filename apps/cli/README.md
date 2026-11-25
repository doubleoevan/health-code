# Health Code in CI

[npm](https://www.npmjs.com/package/health-code) · [GitHub](https://github.com/doubleoevan/health-code) · [Demo](https://runhealthcode.dev)

Try a dependency upgrade on a public GitHub repository from a CI job. The upgraded code runs in a Runta sandbox on your own Runta account. Your pipeline receives an Inspection Report and a tested patch.

## Setup

You need Node 22.18 or later on the 22.x line. Node 24.11 or later also works.

| Required | Value |
| --- | --- |
| `RUNTA_TOKEN` | Token from your [Runta account](https://dashboard.runta.com). It needs access to runtimes and secrets and the model-provider list. |
| `MODEL_API_KEY` | Model provider key. Only setup needs it. Setup stores it in Runta. |
| `HEALTH_CODE_MODEL_HOST` | Model provider address such as `https://api.anthropic.com`. Include the full API path when it isn't `/v1`, such as `https://api.z.ai/api/paas/v4` or `https://proxy.example.com/anthropic/v1`. Leave out `/chat/completions` or `/messages`. |
| `HEALTH_CODE_MODEL` | Model ID such as `claude-opus-5-5`. |


1. Set these variables on your own machine and run `npx health-code setup` once. Setup stores the model key in Runta and verifies it.
2. Remove `MODEL_API_KEY`. Add `RUNTA_TOKEN` to your CI secrets and set the model host and model ID in the job.

| Optional | Use |
| --- | --- |
| `HEALTH_CODE_SUMMARY_MODEL` | Model that summarizes release notes. Defaults to `HEALTH_CODE_MODEL`. |
| `HEALTH_CODE_MATCH_MODEL` | Model that matches new features to your code. Defaults to `HEALTH_CODE_MODEL`. |
| `HEALTH_CODE_REPAIR_MODEL` | Model that repairs checks an upgrade breaks. Defaults to `HEALTH_CODE_MODEL`. |
| `HEALTH_CODE_ADOPTION_MODEL` | Model that applies a new feature to your code. Defaults to `HEALTH_CODE_MODEL`. |
| `HEALTH_CODE_MODEL_PROTOCOL` | `anthropic` or `openai-compatible`. Defaults to `anthropic` for `https://api.anthropic.com` and `openai-compatible` for other hosts. Set `anthropic` for a proxy that uses the Anthropic API. |
| `HEALTH_CODE_INPUT_USD_PER_MILLION` | Highest price per million input tokens. Defaults to `10`. |
| `HEALTH_CODE_OUTPUT_USD_PER_MILLION` | Highest price per million output tokens. Defaults to `50`. |
| `GITHUB_TOKEN` | Release notes and the public repository check. |

The prices apply to every model you set and drive the spend limits. Set them when your model costs more than the defaults or to use more of each limit with a cheaper model. Run setup again after changing the host or protocol.


## Run in CI

```sh
npx health-code check https://github.com/owner/repository --dependency zod --to 4.0.0
```

Omit the target to test the first eligible upgrade. The command writes `inspection-report.json` and any `.patch` files to `health-code-report/`. Use `--output` to change the folder and `--revision` to pin a commit. It exits nonzero when the inspection fails or stops early. An upgrade without a patch still exits zero, so read its verdict in the report.

Tests receive placeholder environment values. Supply a non-secret value with `--env NAME=value`, repeated as needed. The sandbox and its saved output can expose these values.

Your pipeline can apply a patch with `git am` and open a pull request with its own token.

This GitHub Actions job tries the first eligible upgrade every Monday and keeps the report and patches:

```yaml
name: Try dependency upgrades
on:
  schedule:
    - cron: "0 6 * * 1"
  workflow_dispatch:
jobs:
  health-code:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v6
        with:
          node-version: 24
      - run: npx health-code check https://github.com/${{ github.repository }}
        env:
          RUNTA_TOKEN: ${{ secrets.RUNTA_TOKEN }}
          HEALTH_CODE_MODEL_HOST: https://api.anthropic.com
          HEALTH_CODE_MODEL: claude-opus-5-5
      - uses: actions/upload-artifact@v4
        with:
          name: health-code-report
          path: health-code-report
```

## Unpublished checkout

Build the library with `bun run --cwd packages/health-code build`, then run `bun run --cwd apps/cli build`. Use `node packages/health-code/dist/cli/cli.js` in place of `npx health-code`.

MIT licensed.
