---
applyTo: '**/*.test.ts'
---

# Test conventions (piggy-api)

- Runner: Vitest (`yarn test --run` for a single pass, `yarn test:coverage` for coverage).
  Coverage thresholds: 70% statements / 70% branches / 70% functions / 50% lines
  (`vitest.config.ts`). `src/controllers/positions.ts` is now INCLUDED in coverage
  (no longer excluded as of the Phase 0 refactor into `lib/position-service.ts`) —
  don't re-add it to the exclusion list.
- Controller tests mock the Prisma client (`vi.mock('../lib/prisma.js', ...)`) rather than
  hitting a real database. See `src/controllers/accounts.test.ts` / `positions.test.ts` for
  the established pattern (mock factory + `beforeEach` reset).
- `lib/` unit tests (e.g. `cgt-engine.test.ts`, `fx-rates.test.ts`, `position-service.test.ts`)
  test pure functions directly with plain inputs/outputs — no Prisma mocking needed unless the
  function itself touches Prisma.
- Before refactoring any module with no existing test coverage, write characterization tests
  first (capture current behavior), verify green against the unrefactored code, THEN refactor,
  THEN re-run to prove zero behavior change.
- Every new feature, bug fix, or behavior change ships with tests in the same change set.
  Consider the task incomplete until the new/changed behavior has passing tests.
- Don't use `any` in test mocks where a real type or `unknown` + type guard will do — existing
  `any` warnings in test files are legacy and tolerated, but don't add new ones.
