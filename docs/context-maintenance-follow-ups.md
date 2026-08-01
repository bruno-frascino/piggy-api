# Context maintenance follow-ups

Tracked on 2026-08-01. These items are intentionally deferred; update this document when
each item is verified or resolved.

## Generator maintenance

- Review generated context diffs whenever parser/tool versions change. `ts-morph`,
  dependency-cruiser, knip, Prisma, and Swagger upgrades can legitimately reshape output.
- OpenAPI completeness still depends on route JSDoc remaining synchronized with handlers.
  The generator detects documented surface drift, but cannot prove every runtime response
  matches its schema.
