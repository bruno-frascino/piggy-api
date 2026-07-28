# Project Context & Architecture

> This file is a thin pointer, not the source of truth. Full context lives in:
>
> - **[`AGENTS.md`](../AGENTS.md)** (this repo, `piggy-api`) — system overview, run/test/build
>   commands, hard rules, and an index into `docs/adr/`, `docs/glossary.md`, and `context/`.
> - **`../piggy-fe/AGENTS.md`** — the frontend side of the same system.
> - **`.github/instructions/*.instructions.md`** — scoped conventions auto-attached by file
>   path (`applyTo` globs): Prisma changes, controller changes, tests, tax-calculation code.
>
> Read `AGENTS.md` first. This file is kept only so tools that specifically look for
> `.github/copilot-instructions.md` still find an entry point.

Truffles is a personal stock portfolio tracker supporting equities, ETFs, and crypto across multiple exchanges.
The workspace contains two projects:

- **`piggy-api/`** — REST API backend (Node.js / Express / PostgreSQL)
- **`piggy-fe/`** — Web frontend (Next.js / React / PrimeReact)

---

Full stack tables, integration rules (portfolio UX, tax reports, HTTP/API client contract,
data contracts, auth, error handling, API docs) and coding standards have moved to:

- `AGENTS.md` (this repo) — backend rules, run/test/build, hard rules
- `.github/instructions/controllers.instructions.md` — Swagger sync, error shape, auth
- `.github/instructions/tax.instructions.md` — CGT/tax-report business rules
- `.github/instructions/prisma.instructions.md` — schema/migration rules
- `.github/instructions/testing.instructions.md` — test conventions
- `../piggy-fe/AGENTS.md` and `../piggy-fe/.github/instructions/*` — frontend side
  (stack table, HTTP client, data contracts, auth, portfolio UX, PWA/offline rules)
