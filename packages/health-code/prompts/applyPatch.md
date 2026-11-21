---
title: Apply a tested patch
version: 1
model tier: downstream
description: Apply the inspected mailbox and repeat its checks.
updated: 2026-11-20
---

Create a branch at {{base}}. Apply this mailbox with git am. For a feature series, reach this tested base by applying its prerequisite upgrade series at the upgrade's base. If the branch moved, adapt minimally and disclose the exact changes. Run typecheck and tests without editing tests. Fork first if needed, then open a pull request using the patch commit messages.
