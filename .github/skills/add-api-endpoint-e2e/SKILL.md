---
name: add-api-endpoint-e2e
description: Add a new REST API endpoint end-to-end across piggy-api and piggy-fe — backend route, Swagger docs, frontend API module, React Query hook, mock-mode support, and tests on both sides. Use when the user asks to add/expose a new backend endpoint that the frontend will consume.
---

# Add a new API endpoint end-to-end

This repo is `piggy-api` (backend). A matching skill lives in `../piggy-fe/.github/skills/add-api-endpoint-e2e/SKILL.md`
for the frontend half. Do both halves in the same change — don't ship a backend-only or
frontend-only endpoint (see `AGENTS.md` hard rules).

## Backend steps (this repo)

1. **Route**: add `router.METHOD(path, [validators], handleValidationErrors, asyncHandler(async (req, res) => {...}))`
   in the relevant `src/controllers/*.ts` file (or a new file wired into
   `src/controllers/index.ts` if it's a new resource). Use `express-validator`
   (`body()`/`query()`/`param()`) for input validation.
2. **Auth**: if the endpoint needs a logged-in user, add `authenticateToken` — either at the
   router level (`router.use(authenticateToken)`) or per-route.
3. **Swagger**: add a `@swagger` JSDoc block directly above the `router.METHOD(...)` call —
   `tags`, `summary`, `security` (if protected), request body/query/path schema, and
   `responses`. See `.github/instructions/controllers.instructions.md` for the exact
   conventions and error-shape contract.
4. **Business logic**: keep controllers thin — put non-trivial logic in `src/lib/*` (e.g.
   `position-service.ts`) so it's unit-testable without an HTTP layer. Controllers must not
   import other controllers.
5. **Prisma**: if this needs a schema change, follow
   `.github/instructions/prisma.instructions.md` (new migration via
   `yarn db:migrate:dev --name <desc>`, never edit `20260517140750_init`).
6. **Tests**: add/extend the sibling `*.test.ts` for the controller (mocked Prisma client)
   and for any new `lib/` function, per `.github/instructions/testing.instructions.md`.
7. **Context** (once Phase 2 tooling lands): run `yarn context:build` so
   `context/openapi.json` and `context/api-surface.md` pick up the new route.
8. Verify: `yarn lint && yarn test --run && yarn build`.

## Then hand off to piggy-fe

Once the backend route is committed (and, once Phase 3 tooling exists, its
`context/openapi.json` regenerated), switch to `piggy-fe` and follow its
`add-api-endpoint-e2e` skill: `yarn contract:pull` (if contract tooling exists) → add an
`src/lib/api/*.ts` method → wire a `src/hooks/api.ts` React Query hook → add a
`src/lib/mock-api.ts` mock branch → update `src/lib/types.ts` → tests.

Cross-repo ordering rule: **piggy-api lands first**, always — see `AGENTS.md`.
