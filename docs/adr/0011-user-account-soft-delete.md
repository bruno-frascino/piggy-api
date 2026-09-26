# 0011. User account deletion is a soft delete with a 30-day grace period

- **Status**: Accepted
- **Date**: 2026-09-26

## Context

The app had no way for a user to delete their account. Only `GET /api/users/me` and
`PATCH /api/users/me` existed. That is not a gap we can leave open:

- **Australian Privacy Act, APP 11.2** requires destroying or de-identifying personal
  information that is no longer needed. Truffles is an Australian, ATO-focused app.
- **Apple App Store guideline 5.1.1(v)** has required in-app account deletion since June
  2022 for any app that offers account creation, and Google Play requires it both in-app
  and via a web URL. piggy-fe is a PWA today, so this blocks any future store distribution.
- **GDPR Art. 17** applies the moment a single EU user registers.

Two schema facts constrained the design: `positions.userId` and
`portfolio_snapshots.userId` were `ON DELETE RESTRICT`, so `prisma.user.delete()` would
have thrown a foreign-key violation for any user with real data; and `tax_reports.userId`
cascades, so deleting a user destroys the only copy of records the ATO expects retained.

## Decision

Deletion is self-service, password-confirmed, and reversible for 30 days.

- `DELETE /api/users/me` requires `currentPassword`, sets `User.deletedAt` and
  `User.purgeAfter = deletedAt + 30 days`, and deletes every `RefreshToken` and
  `PasswordResetToken` for that user in one transaction.
- `positions.userId` and `portfolio_snapshots.userId` become `ON DELETE CASCADE`, so the
  eventual purge is a single `user.delete()`.
- `authenticateToken` rejects tokens belonging to a soft-deleted user, so existing access
  tokens stop working immediately rather than at expiry.
- `POST /api/auth/login` returns `403` with `code: accountPendingDeletion` and the purge
  date — but only _after_ the password verifies, so the response cannot be used to probe
  which email addresses have accounts.
- `POST /api/auth/restore` cancels a pending deletion and signs the user in. It requires
  the password, so a deletion cannot be undone by someone who merely knows the email.
- `yarn db:purge-deleted-users` (`src/scripts/purge-deleted-users.ts`) hard-deletes users
  past `purgeAfter`. It lives under `src/` so the production build includes it.

Why a grace period rather than an immediate hard delete: it makes account takeover
non-catastrophic (a stolen session cannot irreversibly destroy years of trading history),
and it makes a rage-quit recoverable. A 30-day operational window is standard practice and
comfortably satisfies GDPR's "without undue delay".

Why _not_ a separate "deactivate / take a break" state: that exists for social products
where a user's absence is visible to others. In a private portfolio tracker, not logging in
is already functionally identical, so a second reversible state would add a state machine
with no user benefit.

Why _not_ auto-deleting dormant accounts: legitimate dormancy is normal for buy-and-hold
investors, who will still want their 2023 cost bases at tax time. Silently destroying tax
records because someone did not log in for 18 months is indefensible and unrecoverable.
Retention work should target regenerable data (expired tokens, stale price history), not
user accounts.

## Consequences

- **The purge job must be scheduled in production or nothing is ever actually erased**,
  which defeats the entire purpose. See the scheduled-jobs section of `docs/deployment.md`.
- Every query that resolves a user for authentication has to consider `deletedAt`. The
  guard lives in `authenticateToken` and in the login/forgot-password handlers; a new
  unauthenticated route that resolves a user by email must add it too.
- Registering with the email of a soft-deleted account still returns `409`, matching the
  existing behaviour for live accounts.
- Deletion destroys generated tax reports, so the confirmation dialog warns about the
  five-year ATO retention expectation. A data-export flow is the natural follow-up and is
  deliberately not part of this decision.
- The frontend must tear down tokens, the React Query cache and service-worker caches on
  deletion exactly as it does on sign-out; both paths now share `src/lib/session.ts`.
