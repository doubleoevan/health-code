<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="apps/web/public/assets/favicon.svg">
  <img src=".github/icon-light.svg" alt="Health Code" width="96" height="96">
</picture>

# Health Code

### Try dependency upgrades before you merge them

The health inspector runs your checks in a Runta sandbox and tries to repair what breaks.

[![npm](https://img.shields.io/npm/v/health-code?style=flat-square&color=16853c)](https://www.npmjs.com/package/health-code)
[![GitHub stars](https://img.shields.io/github/stars/doubleoevan/health-code?style=flat-square&color=16853c)](https://github.com/doubleoevan/health-code/stargazers)
[![GitHub issues](https://img.shields.io/github/issues/doubleoevan/health-code?style=flat-square)](https://github.com/doubleoevan/health-code/issues)
[![Last commit](https://img.shields.io/github/last-commit/doubleoevan/health-code?style=flat-square)](https://github.com/doubleoevan/health-code/commits)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Powered by Runta](https://img.shields.io/badge/powered_by-Runta-16853c?style=flat-square)](https://runta.com/)

[Try the demo](https://runhealthcode.dev) · [Quick start](#quick-start) · [Packages](#packages) · [Architecture](#architecture)

<a href="https://runhealthcode.dev"><img src=".github/health-code-demo.gif" width="960" alt="Health Code demo: choose an upgrade, watch it run in a Runta sandbox and get a tested patch"></a>

</div>

## What it does

Pick an upgrade. The health inspector tries it on your code. It attempts to repair what breaks and retests the patch. You get a report with a tested patch when it works.

The upgraded code runs in a Runta sandbox with the network locked to package registries. Your model key and your CI secrets stay outside it.

## Quick start

**On the web:** paste a public JavaScript or TypeScript repository at [runhealthcode.dev](https://runhealthcode.dev).

<a id="ci-setup"></a>

**In CI:** needs [Node.js](https://nodejs.org/) 22.18+ or 24.11+, a [Runta](https://dashboard.runta.com) account and a model key. Store the model key in Runta once from your own machine:

```sh
export RUNTA_TOKEN=...
export MODEL_API_KEY=...   # setup only
export HEALTH_CODE_MODEL_HOST=https://api.anthropic.com
export HEALTH_CODE_MODEL=claude-opus-5-5

npx health-code setup
```

Then add a job that tries an upgrade and keeps the report and patch:

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

See the [CI guide](apps/cli/README.md) for settings and options.

## Packages

| Package | Use |
| --- | --- |
| [`health-code`](https://www.npmjs.com/package/health-code) | Inspection library and CI command |
| [`apps/web`](apps/web) | Demo site |

Guides: [library](packages/health-code/GUIDE.md) · [CI](apps/cli/README.md) · [development](DEVELOPMENT.md)

## Architecture

```mermaid
flowchart LR
  Browser --> Web["Web · Hono · React · SQLite"]
  CI["CI job"] --> Command["health-code check"]
  Web --> Library["health-code"]
  Command --> Library
  Library --> Runta["Runta sandbox"]
```

[MIT License](LICENSE)
