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

</div>

<!-- DEMO SITE VIDEO: replace this line with the video -->

<!-- MCP VIDEO: replace this line with the video -->

## What it does

Pick an upgrade. The health inspector tries it on your code, attempts to repair what breaks and retests the patch. You get a report with a tested patch when it works.

Your model key stays outside the sandbox.

<a id="mcp-setup"></a>

## Quick start

**On the web:** paste a public JavaScript or TypeScript repository at [runhealthcode.dev](https://runhealthcode.dev).

**In Claude Code or Codex:** needs [Node.js](https://nodejs.org/) 22.18+ or 24.11+, a [Runta](https://dashboard.runta.com) account and a model key.

```sh
export RUNTA_TOKEN=...
export MODEL_API_KEY=...   # setup only
export HEALTH_CODE_MODEL_HOST=https://api.anthropic.com
export HEALTH_CODE_MODEL=claude-opus-5-5

npx health-code mcp setup
```

Paste the printed entry into your client and restart it. Then ask:

```text
Use health-code to list upgrades
```

See the [MCP guide](apps/mcp/README.md#setup) for settings.

## Packages

```text
packages/health-code   Inspection library on npm
apps/web               Demo site
apps/mcp               MCP server and CI command
```

Guides: [library](packages/health-code/GUIDE.md) · [MCP](apps/mcp/README.md) · [development](DEVELOPMENT.md)

## Architecture

```mermaid
flowchart LR
  Browser --> Web["Web · Hono · React · SQLite"]
  Agent["Claude Code or Codex"] --> MCP["MCP · stdio"]
  Web --> Library["health-code"]
  MCP --> Library
  Library --> Runta["Runta sandbox"]
```

[MIT License](LICENSE)
