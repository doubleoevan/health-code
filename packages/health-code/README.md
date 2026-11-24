<div align="center">

<img src="https://raw.githubusercontent.com/doubleoevan/health-code/main/.github/icon-light.svg" alt="Health Code" width="96" height="96">

# Health Code

### Try dependency upgrades before you merge them

[![npm](https://img.shields.io/npm/v/health-code?style=flat-square&color=16853c)](https://www.npmjs.com/package/health-code)
[![License](https://img.shields.io/npm/l/health-code?style=flat-square)](https://github.com/doubleoevan/health-code/blob/main/LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/doubleoevan/health-code?style=flat-square)](https://github.com/doubleoevan/health-code/stargazers)

[Demo](https://runhealthcode.dev) · [GitHub](https://github.com/doubleoevan/health-code) · [Guide](https://github.com/doubleoevan/health-code/blob/main/packages/health-code/GUIDE.md) · [MCP](https://github.com/doubleoevan/health-code/blob/main/apps/mcp/README.md)

</div>

The health inspector runs your checks in a [Runta](https://runta.com/) sandbox before and after an upgrade. It attempts to repair what breaks and retests the patch. You get a report with a tested patch when it works.

```ts
import { inspectRepository } from "health-code"

// reads RUNTA_TOKEN
const report = await inspectRepository({
  repositoryUrl: "https://github.com/ai/nanoid",
  limits: { maxUpgrades: 1 },
})
console.log(report.upgrades)
```

This checks one upgrade without a model. [Add models](https://github.com/doubleoevan/health-code/blob/main/packages/health-code/GUIDE.md#inspections-with-models) to repair what breaks.

## Quick start

```sh
npm install health-code
```

You need [Node.js](https://nodejs.org/) 22.18+ or 24.11+ and a [Runta](https://dashboard.runta.com) account.

## Features

- **Your checks:** runs your install, typecheck and tests before and after each upgrade.
- **Repairs:** a coding agent patches confirmed breakage and the health inspector retests the patch in a fresh checkout.
- **New features:** finds release features that match your code.
- **Sandbox:** the network is locked and your model key stays outside.
- **Package managers:** npm, pnpm, Bun and Yarn.
- **Models:** Anthropic and OpenAI-compatible hosts.

## Choose one upgrade

```ts
import { getUpgrade, listUpgrades } from "health-code"

const repositoryUrl = "https://github.com/ai/nanoid"
const menu = await listUpgrades({ repositoryUrl })
const upgrade = menu.dependencies[0]?.targets[0]
if (!upgrade) {
  throw new Error(menu.issue ?? "No upgrades found")
}

// the guide shows how to set models
const report = await getUpgrade({
  repositoryUrl,
  models,
  revision: menu.repository.commit,
  upgrade,
})
console.log(report.upgrades[0].verdict, report.upgrades[0].patches)
```

## Use it in Claude Code or Codex

```sh
npx health-code mcp setup
```

The [MCP guide](https://github.com/doubleoevan/health-code/blob/main/apps/mcp/README.md#setup) lists the settings it needs. Then ask `Use health-code to list upgrades`.

[MIT License](https://github.com/doubleoevan/health-code/blob/main/LICENSE)
