# Inspection prompts

The package ships seven Markdown templates. Four filenames match the model roles. `verifyCredential.md` defines the one-token credential probe and `applyPatch.md` supplies instructions for the downstream coding agent. `investigateInspection.md` guides diagnosis when checks stop early.

Use `../src/readPrompt.ts` for template validation and `../src/models/buildPrompt.ts` for bounded evidence and per-call delimiters. Bump the integer frontmatter version when a template’s behavior changes. Keep the role’s output contract aligned with its validator. Run the prompt tests and the packed consumer check after editing a template.
