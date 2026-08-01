# Context maintenance follow-ups

Tracked on 2026-08-01. These items are intentionally deferred; update this document when
each item is verified or resolved.

## Hosted enforcement

- Open a pull request and confirm the PR-only `CI` workflow passes on GitHub-hosted Ubuntu.
  Local lint, test, build, and context checks pass, but the hosted workflow has not run yet.
- After the first successful run, consider making the `CI / Lint, test, build,
context:check` check required in branch protection. Local Husky hooks can be bypassed and
  are not an authoritative control.
- Confirm the repository's GitHub Actions retention and dependency-cache settings are
  acceptable before expanding CI beyond pull requests.

## Generator maintenance

- Review generated context diffs whenever parser/tool versions change. `ts-morph`,
  dependency-cruiser, knip, Prisma, and Swagger upgrades can legitimately reshape output.
- OpenAPI completeness still depends on route JSDoc remaining synchronized with handlers.
  The generator detects documented surface drift, but cannot prove every runtime response
  matches its schema.
