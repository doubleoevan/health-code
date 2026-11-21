# Inspection prompts

Each filename uses its public model role so the builder can load the matching task directly. These four Markdown templates belong to the inspection library and ship in its tarball. The host and guest roles share the single-pass builder in `../src/buildPrompt.ts`. Keep output shapes in sync with their validators, bump the template version for behavior changes and exercise the untrusted-data fence tests.
