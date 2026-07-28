---
applyTo: 'src/controllers/**'
---

# Controller conventions

- Wrap every route handler in `asyncHandler()` (`src/middleware/validation.ts`) so thrown
  errors reach the central error handler instead of crashing the process.
- Every protected route uses the `authenticateToken` middleware (`src/middleware/auth.ts`).
  Its JSDoc must include `security: [{ bearerAuth: [] }]`.
- Controllers must not import other controllers. Only `src/lib/prisma.ts` imports
  `@prisma/client` — controllers get the Prisma client from `../lib/prisma.js`.
- Validate input with `express-validator` (`body()`/`query()`/`param()`) followed by
  `handleValidationErrors` from `src/middleware/validation.ts`.

## Swagger sync (required for any route surface change)

Any new, changed, or removed route needs a matching `@swagger` JSDoc block directly above
the `router.METHOD(...)` call — Swagger UI at `/api/docs` is generated live from these
comments (swagger-jsdoc), there is no static `openapi.json` to forget to regenerate today,
but Phase 2 tooling will add `context/openapi.json` emitted from the same spec object.

- New route → add a `@swagger` block with `tags`, `summary`, `security` (if protected),
  request body/params/query schema, and `responses`.
- Deleted route → remove its JSDoc block.
- Changed request/response shape → update the relevant block in the same commit.
- New tag or security scheme → update `src/lib/swagger.ts`.

## Error response shape

```json
{ "error": "Unauthorized", "message": "Invalid or expired token" }
```

Validation errors:

```json
{ "error": "Validation Error", "details": [...] }
```

Use these exact top-level keys (`error`, `message` or `details`) so the frontend's shared
error-handling code (`piggy-fe/src/lib/api/http.ts`) can pattern-match on them. If the Yahoo
Finance symbol search request fails or times out (5s), return `503` with
`{ "error": "Upstream Unavailable", "message": "Symbol search temporarily unavailable" }`.

## Tests

Every controller change ships with tests in the sibling `*.test.ts` file in the same PR,
mocking the Prisma client (see `src/controllers/accounts.test.ts` for the pattern). Target
≥80% line coverage for new code; overall coverage floor is 70/70/70/50
(statements/branches/functions/lines).
