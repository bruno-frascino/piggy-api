# piggy-api — Agent Entry Point

Truffles is a personal stock portfolio tracker (equities, ETFs, crypto across multiple
exchanges). This repo is the REST API backend. The sibling repo `../piggy-fe` is the
Next.js frontend — see its `AGENTS.md` for that side.

## What this system does

- Users track `TradingAccount`s, each holding `Position`s (one BUY transaction at
  creation = one CGT parcel, never appended to) on `Asset`s tied to an `Exchange`.
- SELL `Transaction`s partially or fully close a `Position`.
- Generates ATO Capital Gains Tax reports (PDF) scoped by an explicit multi-select of
  accounts, with RBA-first FX conversion and loss/discount rules per the ATO method.
- Symbol search via Yahoo Finance (no API key).

## Run / test / build

```bash
yarn dev              # tsx watch, port 4000
yarn build             # tsc -p tsconfig.build.json
yarn test              # vitest (watch)
yarn test --run        # vitest, single pass
yarn test:coverage     # vitest --coverage --run (thresholds: 70/70/70/50)
yarn lint              # eslint . --ext .ts,.tsx
yarn db:migrate:dev --name <desc>   # NEVER edit 20260517140750_init directly
```

Package manager is **yarn only** (yarn@1.22.22 pinned) — do not introduce npm/pnpm
lockfiles. Node version per `.nvmrc`.

## Hard rules (violating these breaks conventions enforced elsewhere in this repo)

1. Every route handler is wrapped in `asyncHandler()` (`src/middleware/validation.ts`).
2. Every protected route uses `authenticateToken` (`src/middleware/auth.ts`).
3. Controllers must not import other controllers; `lib/` must not import controllers;
   only `lib/prisma.ts` imports `@prisma/client`.
4. Any route surface change (new/changed/removed route, body/query/response shape)
   needs a matching `@swagger` JSDoc block above the `router.METHOD(...)` call —
   Swagger UI at `/api/docs` must stay in sync with code.
5. Schema changes: `prisma/schema.prisma` + `yarn db:migrate:dev --name <desc>`, new
   timestamped migration, never edit the existing `20260517140750_init`.
6. Every feature/bugfix/behavior change ships with unit tests in the same change set
   (controllers: mocked Prisma client). Target ≥80% line coverage for new code.
7. No `any` — use `unknown` + type guards at system boundaries.
8. Every `Position` = exactly one BUY transaction = one CGT parcel. There is no
   "add units to an existing position" flow and no FIFO lot reconstruction anywhere.
9. Tax reports are scoped by an explicit account multi-select (never "all accounts");
   see `docs/adr/0002-tax-report-accounts-key-scoping.md`.
10. After changing `src/`, `prisma/schema.prisma`, or routes: see
    `.github/instructions/context-maintenance.instructions.md` for the context-rebuild
    step (once Phase 2 tooling lands — see status note below).

## Where to look

- **Route → controller map, data model, module graph, symbol index**: `context/`
  (generated — see `context/README.md`. **Status: not yet generated in this repo as of
  2026-07-28** — Phase 2 tooling is planned but not built. Until then, use
  `src/controllers/index.ts` and `prisma/schema.prisma` directly.)
- **Domain terms** (parcel, disposal, accountsKey, financial year, close event): `docs/glossary.md`
- **Why decisions were made**: `docs/adr/`
- **ATO CGT methodology write-up**: `docs/ato-capital-gains-methodology.md`
- **Production deployment topology (VPS + Vercel, CI/CD pipeline)**: `docs/deployment.md`
- **Scoped conventions**: `.github/instructions/*.instructions.md` (auto-attached by
  file path via `applyTo` globs — prisma changes, controller changes, tests, tax logic)

## Key directories

```
src/
  controllers/   # Route handlers (auth, users, stocks, positions, portfolio, accounts, tax-reports)
  lib/           # prisma.ts, jwt.ts, exchange-sync.ts, swagger.ts, fx-rates.ts,
                 # cgt-engine.ts, pdf-report.ts, position-service.ts, historical-drawdown.ts
  middleware/    # validation.ts (asyncHandler, errorHandler), auth.ts (authenticateToken)
prisma/
  schema.prisma  # source of truth for all data models
  migrations/    # timestamped migration history
```

Default port: `4000`.

## Frontend/backend coordination

When a change spans both repos, land `piggy-api` first (regenerate/commit its
`context/openapi.json` once Phase 2 lands), then run `yarn contract:pull` in
`piggy-fe`. See `piggy-fe/AGENTS.md` for the other side of this rule.
