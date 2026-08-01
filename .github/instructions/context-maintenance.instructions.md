---
applyTo: '**'
---

# Context maintenance

- After changing anything under `src/`, `prisma/schema.prisma`, or route definitions, run
  `yarn context:build` and commit the resulting `context/` diff in the same change set.
- Never hand-edit files under `context/` — they are regenerated wholesale by
  `scripts/context/*.ts` and any manual edit will be silently overwritten (and will make
  `yarn context:check` report false drift in the meantime).
- If you add, remove, or change a route: update its `@swagger` JSDoc block too (see
  `.github/instructions/controllers.instructions.md`), then run `yarn context:build` so
  `context/api-surface.md` and `context/openapi.json` pick up the change.
- If you add, remove, or change a Prisma model/field: update
  `piggy-fe/src/lib/types.ts` by hand in the same change set (manual mirror, see
  `piggy-fe/docs/adr/0007-manual-types-mirror.md`), then run `yarn context:build` here so
  `context/data-model.md` picks it up.
- `yarn context:check` verifies freshness without writing anything — run it if you're not
  sure whether `context/` is stale. It's what the pre-push hook and CI's context-drift job
  run; a stale `context/` blocks `git push` (escape hatch: `CONTEXT_SKIP=1 git push`, not
  recommended).
- A non-zero exit from `yarn context:build` can also mean a real architecture-rule
  violation was found (see `context/module-graph.md`), not just staleness — read the
  console output to tell which case applies before assuming it's just a rebuild.
- Review generated context diffs whenever TypeScript, ts-morph, dependency-cruiser, knip,
  Prisma, Swagger, or related parser/generator dependencies change; version upgrades can
  legitimately reshape deterministic output.
