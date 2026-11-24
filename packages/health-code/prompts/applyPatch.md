---
title: Apply a tested patch
version: 3
model tier: downstream
description: Apply the inspected mailbox and repeat its checks.
updated: 2026-11-23
---

For an upgrade patch, create a branch at {{base}}. For a feature patch, keep your current branch if the required upgrade patch is already applied. Otherwise create a branch at the inspected commit and apply the required upgrade patch first. Verify each mailbox digest before applying it with git am. If the branch moved, adapt minimally and disclose the exact changes. Run typecheck and tests without editing tests. Fork first if needed, then open a pull request using the patch commit messages.
