---
applyTo: 'prisma/**'
---

# Prisma / schema conventions

- `prisma/schema.prisma` is the source of truth for all data models. Frontend
  `piggy-fe/src/lib/types.ts` is a manually mirrored copy — update it in the same change
  set when a field changes (see ADR 0007: manual mirror is intentional, not generated).
- Schema changes always go through:
  ```bash
  yarn db:migrate:dev --name <short-description>
  ```
  This applies to the local dev DB (`DATABASE_URL` in `.env`, `DB_AUTO_MIGRATE=true` locally)
  and generates a new timestamped migration folder under `prisma/migrations/`.
- **Never edit the existing `20260517140750_init` migration** or any other already-committed
  migration file. Always create a new one, even for a one-line column tweak.
- Production is live. Migrations are applied to production only by the CI/CD deploy pipeline
  running `prisma migrate deploy` on the VPS (`DB_AUTO_MIGRATE=false` in prod `.env`). Never
  attempt to run migrations against production directly from a local/agent session.
- Optional-column changes on existing tables (e.g. `String` → `String?`) should be plain
  `ALTER COLUMN ... DROP NOT NULL` migrations — verify there's no data-loss before writing one.
- After a schema change, regenerate context (`yarn context:build`, once Phase 2 tooling lands)
  so `context/data-model.md`'s Mermaid ERD and model list stay current.
- Every `Position` = exactly one BUY transaction at creation, never appended to. Don't add a
  schema shape that implies multiple BUYs feeding one Position (that would need FIFO lot
  tracking, which this codebase deliberately does not implement — see
  `docs/adr/0001-one-buy-per-position.md`).
