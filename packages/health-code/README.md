<div align="center">

<img src="https://raw.githubusercontent.com/doubleoevan/health-code/main/.github/icon-light.svg" alt="Health Code" width="96" height="96">

# Health Code

### Try dependency upgrades before you merge them

[![npm](https://img.shields.io/npm/v/health-code?style=flat-square&color=16853c)](https://www.npmjs.com/package/health-code)
[![License](https://img.shields.io/npm/l/health-code?style=flat-square)](https://github.com/doubleoevan/health-code/blob/main/LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/doubleoevan/health-code?style=flat-square)](https://github.com/doubleoevan/health-code/stargazers)

[Demo](https://runhealthcode.dev) · [GitHub](https://github.com/doubleoevan/health-code) · [Guide](https://github.com/doubleoevan/health-code/blob/main/packages/health-code/GUIDE.md) · [CI](https://github.com/doubleoevan/health-code/blob/main/apps/cli/README.md)

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

You need [Node.js](https://nodejs.org/) 22.18+ or 24.11+. Listing upgrades needs no account. Testing one needs a [Runta](https://dashboard.runta.com) account.

## Features

- **Upgrade menu:** lists eligible versions from GitHub and the npm registry in your process, with no sandbox.
- **Your checks:** runs your install, typecheck and tests before and after each upgrade.
- **Your package manager:** the sandbox installs the version your repository declares, so the patch's lockfile matches your frozen install.
- **Repairs:** a coding agent patches confirmed breakage and the health inspector retests the patch in a fresh checkout.
- **New features:** finds release features that match your code.
- **Sandbox:** the network is locked and your model key stays outside.
- **Package managers:** npm, pnpm, Bun and Yarn.
- **Models:** bring your own through an Anthropic or OpenAI-compatible API with tool calling.

## Choose one upgrade

```ts
import { getUpgrade, listUpgrades } from "health-code"

const repositoryUrl = "https://github.com/ai/nanoid"

// list upgrades from GitHub and the npm registry
const menu = await listUpgrades({ repositoryUrl, githubToken: process.env.GITHUB_TOKEN })
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

`listUpgrades` offers the newest minor and the newest major version of each direct dependency. To test another version, such as the patch release another tool chose, call `resolveUpgrade({ repositoryUrl, dependency, to })` and pass its `upgrade` to `getUpgrade`.

**Upgrading from 0.2.** `listUpgrades` no longer returns `releaseFeatures` on each target, and it ignores `sandboxProvider`. Read features for the choices you show with `readUpgradeMenuFeatures(menu.dependencies.slice(0, 4), { githubToken })`.

## Use it in CI

```sh
npx health-code check https://github.com/owner/repository --pull-request
```

The command tries the first eligible upgrade, writes the Inspection Report and opens or updates a pull request with the tested patch. Pipelines can run the same command as a standalone executable with no Node and no npm install. The [CI guide](https://github.com/doubleoevan/health-code/blob/main/apps/cli/README.md#install) shows how to install and verify it, the settings it needs and a GitHub Actions job.

[MIT License](https://github.com/doubleoevan/health-code/blob/main/LICENSE)
