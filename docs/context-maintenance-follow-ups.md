# Context maintenance follow-ups

Tracked on 2026-08-01. These items are intentionally deferred; update this document when
each item is verified or resolved.

## Hosted enforcement

- Push a documentation-only test change or use `workflow_dispatch` and confirm the `CI` workflow
  passes on GitHub-hosted Ubuntu. Local lint, test, build, and context checks pass, but the hosted
  workflow has not been verified yet.
- Check the GitHub Actions result after every direct push. The hosted workflow runs after `main` is
  updated, so failures require a follow-up fix or revert; local Husky hooks remain the preventive
  consistency check and can be bypassed.
- Confirm the repository's GitHub Actions retention and dependency-cache settings are
  acceptable.

## Generator maintenance

- Review generated context diffs whenever parser/tool versions change. `ts-morph`,
  dependency-cruiser, knip, Prisma, and Swagger upgrades can legitimately reshape output.
- OpenAPI completeness still depends on route JSDoc remaining synchronized with handlers.
  The generator detects documented surface drift, but cannot prove every runtime response
  matches its schema.
