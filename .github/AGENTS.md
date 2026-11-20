# GitHub automation

`workflows/` contains CI and CodeQL. CI runs the offline preflight and the separate dependency advisory check. `actions/setup-bun/` installs the pinned Bun version and frozen workspace dependencies. `dependabot.yml` schedules dependency updates for Bun and GitHub Actions.

Update this guide and README Development when a workflow changes the commands contributors use.
