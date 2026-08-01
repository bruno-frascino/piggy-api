# context/ — generated, do not hand-edit

Everything in this folder is produced by `scripts/context/*.ts` via:

```bash
yarn context:build   # regenerates every artifact + manifest.json
yarn context:check   # verifies context/ is up to date (no writes; used by CI/pre-push)
```

Run `yarn context:build` after changing anything under `src/`, `prisma/schema.prisma`, or
route definitions, then commit the diff. Never hand-edit files in this folder — they will
be overwritten and any manual changes will make `yarn context:check` report false drift.

## Artifacts

| File | Generator | Contents |
| ---- | --------- | -------- |
| `openapi.json` | `emit-openapi.ts` | Static OpenAPI 3.0 spec (from the live swagger-jsdoc definition) |
| `api-surface.md` | `api-surface.ts` | Route table: method, path, auth, validators, file#line |
| `data-model.md` | `data-model.ts` | Prisma models/fields/relations + Mermaid ERD + migration list |
| `module-graph.json`/`.md` | `module-graph.ts` | Full dependency graph (dependency-cruiser) + architecture rule violations |
| `symbol-index.json` | `symbol-index.ts` | Every exported symbol under `src/`: kind, signature, JSDoc, file/line range |
| `unused.json` | `unused.ts` | knip report of unused files/exports/dependencies (informational) |
| `manifest.json` | `lib/manifest.ts` | sha256 per artifact + generator version, used by `context:check` |

Architecture rules enforced by `module-graph.ts` (fails the build if violated — see
`AGENTS.md` hard rules): controllers must not import other controllers; `lib/` and
`middleware/` must not import controllers; only `src/lib/prisma.ts` imports
`@prisma/client`; no circular dependencies.

Deferred operational concerns and verification work are tracked in
`docs/context-maintenance-follow-ups.md`.
