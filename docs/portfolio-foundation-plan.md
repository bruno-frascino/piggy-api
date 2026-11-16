# Portfolio accounting foundation

Status: increment 1 specification delivered; increment 2 implementation is complete.
Opening previews, inactive drafts, cash replay/reconciliation, gated manual and supported
Kraken trade posting, cash-only live deposits/withdrawals, audited execution corrections,
terminal manual trade voids, live funding corrections/reversals, and capability-aware ordinary
BUY/SELL routing are implemented.
**Reviewed per-account confirmation (2F) is implemented.** Only an explicit user confirmation
can enable one eligible real account; saving/reviewing a draft and ordinary capability lookup
never activate accounts. No real account has been activated during development. Imported voids,
financial moves and deletion remain explicitly blocked, not required to become unrestricted
before launch.
**Increment 3 remains in progress; 3A, manual statement-supported cash income, is complete.**
Equity/ETF cash distributions support audited replacements and terminal reversals. Complex AMIT,
automated estimates and crypto staking remain unsupported. **3B, same-currency paired cash-transfer
posting/history, and 3C, paired transfer corrections/reversals, are complete.** Direct edits,
one-sided transfer revisions and holdings transfers remain blocked. **3D, explicit same-account
FX posting/history, and audited fixed-identity FX revisions (3E), are implemented and verified.**
**3F, statement-supported dividend-reinvestment posting/history, is complete.** One atomic
command records income once and creates a new parcel, with account-paid residual cash only.
**3G, paired audited reinvestment corrections/reversal, is complete.** Independent financial
edits remain blocked, and effective parcel sales must be voided before paired changes.
**3H, stock splits/consolidations, is not enabled.** The user approved the initial scope;
parcel projection, command preparation, review, additive persistence, split-aware CGT
reading and position recomputation are implemented. Opening and current source inventory now
replay retained splits, and fingerprints include their action/effect evidence. Proposed-sale
review and dated reinvestment entitlement now share this validated inventory, behind the existing
account-wide write guards. Audited fingerprint continuation and the remaining dependent workflows
are still required. Posting and corporate-action history/UI remain unavailable.
Legacy accounts retain their existing behavior.
Date: 16 November 2026.
Scope: piggy-api and sibling piggy-fe.

## Start here when resuming

This document owns delivery order and acceptance gates; [ADR 0016](./adr/0016-portfolio-accounting-foundation.md)
owns accounting policy. The [glossary](./glossary.md) defines domain terms.
Backend [generated context](../context/README.md) and [API surface](../context/api-surface.md)
describe implemented code, not planned capabilities. The [frontend README](../../piggy-fe/README.md)
describes available UI entry points.

| Milestone                              | Current state            | Resume guidance                                                                                |
| -------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------- |
| 1. Accounting contract/reference cases | Delivered specification  | Reference cases are not proof of production income, transfers, valuations or returns           |
| 2. Opening/cash-backed trades          | Implemented              | Steps 2A-2F are delivered; real-account activation remains an explicit per-account user action |
| 3. Income/transfers/adjustments        | In progress (3A-3G done) | Next: implement approved stock-split/consolidation posting and history (3H)                    |
| 4. Sourced valuations                  | Planned                  | Replace synthetic value series only with explicit provenance and completeness                  |
| 5. TWR/XIRR/risk                       | Planned                  | Depends on verified flows and valuations; existing trading statistics are not these returns    |
| 6. Broader ingestion/tax readiness     | Planned                  | Demand-driven adapters and reviewed tax cases, not a prerequisite to support every broker      |
| 7. Decision tools                      | Planned                  | Follow verified accounting/performance, not ahead of it                                        |

### Increment 2 delivery checklist

- [x] Read-only Sydney end-of-day opening preview and immutable inactive drafts.
- [x] Exact draft cash replay, deposits/withdrawals and immutable capital corrections/reversals.
- [x] Draft evidence/variance review, proposed trades and recorded manual/Kraken cash staging.
- [x] Account/user/parcel locking, source identity, dated funding and retry guards.
- [x] Gated live manual BUY/SELL and supported Kraken execution posting.
- [x] Audited live manual BUY/SELL and restricted imported execution corrections.
- [x] Terminal manual SELL voids and unsold BUY voids, effective-reader filtering and retained audit UI.
- [x] 2A. Publish and verify the supported cutover operation/lifecycle matrix.
- [x] 2B. Deliver live deposits/withdrawals.
- [x] 2C. Deliver audited live funding corrections/reversals.
- [x] 2D. Deliver live balance/activity/evidence review.
- [x] 2E. Route ordinary trade entry for ledger-backed accounts.
- [x] 2F. Deliver reviewed per-account confirmation and prove the release gate.

Checked items describe implementation, not production activation or broker verification.
Earlier narrative progress notes below are historical; this checklist and the remaining-step
section are the current handoff.

### Step status register

Last updated: 15 November 2026. Steps 2A-2F and 3A-3G are implemented and verified; no
real account has been activated. The user selected same-currency cash transfers as slice 3B.
Posting/history and paired transfer revisions (3C) are implemented and verified;
explicit same-account FX posting/history is implemented and verified. Audited FX revisions
are implemented and verified. Statement-supported dividend-reinvestment posting/history is
implemented and verified, as are paired audited reinvestment revisions. The user approved
statement-supported stock splits/consolidations as 3H, blocking existing later sales and
deferring audited corrections/reversal; posting and history are not yet implemented. Preserve
per-account confirmation as an explicit cutover gate.

| Step                                          | Status  | Prerequisites                                           | Remaining work / evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------- | ------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manual trade voids                            | Done    | Gated live writer and execution revisions               | Implemented with backend/frontend tests, localhost replay/rollback/concurrency tests, effective CGT/preview checks and retained audit access; see the delivered section below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 2A. Supported lifecycle policy                | Done    | Delivered mutation guards and current capability matrix | User-selected residual-cash archival policy documented; source drift is fail-closed; close/reopen preserves source fingerprint; lifecycle unit and localhost replay/write tests pass                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 2B. Live funding                              | Done    | 2A                                                      | Cash-only schema/migration, dated replay, Swagger endpoint, frontend hook/form and atomic retry/rollback coverage delivered. Backend/frontend focused tests, builds, lint, context and contract checks pass. No account is activated                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 2C. Funding revisions                         | Done    | 2B                                                      | Immutable live correction/reversal revisions, cash-only postings, full-timeline funding validation, global audit ordering, retained history UI and retry/stale-head/rollback tests pass; source fingerprint remains unchanged because no trade source changes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 2D. Cash review                               | Done    | 2B, 2C                                                  | Read-only `GET /api/accounts/:id/cash-operations` now returns exact replayed balances, paginated dated activity/audits, source freshness, explicit unsupported events and recomputed statement-evidence variances. Active stale history is marked incomplete; archived views explicitly say freshness is not revalidated. Dashboard review works offline from cached data, visibly marked stale. Manual/imported replay, sale void, evidence variance, archive, source drift and tampered posting tests pass; no activation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 2E. Trade-entry routing                       | Done    | 2B, 2D                                                  | Authenticated effective-date capability distinguishes live, legacy, demo, archived and blocked accounts; ordinary BUY/SELL routes through the coordinated writer only for live ledgers. Unknown, blocked, archived and offline live writes fail closed; legacy/demo flows remain supported. Backend 49 focused tests and 79 localhost integration tests, frontend 137 focused tests, builds, lint, both context checks and frontend contract check pass. No account is activated                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 2F. Controlled activation                     | Done    | 2A-2E                                                   | User selected block-unresolved cutover policy. The authenticated online confirmation route and explicit four-acknowledgement UI confirm only the latest clean draft for one active real account. Server checks source fingerprint at the saved observation date, blocking preview issues, no post-boundary trades, funded replay, latest exactly matching attested evidence, and no selected-draft activity under the account lock. Other draft activity remains retained and is listed/audited as excluded. Same-key retries are idempotent; competing confirmations and races with close/user deletion are covered by localhost tests. Backend full suite 1,193 passed / 187 skipped, 82 localhost integration tests, build, lint and context check pass; frontend full suite 595 passed, lint, contract and context checks pass. Frontend production build remains blocked by a pre-existing duplicate `busy` JSX prop in `src/components/HoldingsTable.tsx`; no real account is activated                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 3A. Manual cash income                        | Done    | 2F                                                      | Additive statement-based equity/ETF receipts post net cash only and retain tax attributes. Immutable replacement and terminal reversal preserve the audit chain, reserve date/sequence slots, require funded replay, and keep asset/currency/source identity fixed; reverse and re-record to change identity. Backend 1,205 tests passed / 189 skipped, 84 disposable-localhost integration tests passed, build/lint/context checks passed; frontend 606 tests passed, lint/contract/context checks passed. Frontend production build remains blocked by the pre-existing duplicate `busy` JSX prop in `src/components/HoldingsTable.tsx`. No real account is activated                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 3B. Paired cash-transfer posting/history      | Done    | 2F, 2B, 2D                                              | Same-currency, same-date principal between two owned active real ledgers; exact sender-only fee, deterministic dual-account locking, shared immutable command identity and atomic postings. Full replay verifies counterpart ownership/content/postings; direct edits and one-sided revisions are blocked. Backend full suite 1,219 passed / 192 skipped; all 87 disposable-localhost ledger tests pass, including transfer conservation, backdated funding, rollback, stale sources, endpoints, slots, archival reads, missing/tampered counterparts, competing writes and retries. Frontend full suite 617 passed. Both builds/lints, frontend type-check, both context checks and contract check pass; contract drift is zero. Existing frontend duplicate busy prop/type-check blockers were resolved, with pending-sale submission coverage. No new schema or real-account activation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 3C. Paired transfer revisions                 | Done    | 3B                                                      | Fixed accounts/currency/source; editable principal, sender fee, shared date and both sequences. Both current review heads, immutable paired audits, terminal reversal, exact retries and funded replay are implemented end-to-end. Backend full suite 1,221 passed / 194 skipped; all 89 disposable-localhost ledger tests pass, including revisions, terminal state, funding rollback, stale heads, reserved slots, competing corrections and tampered paired audits. Frontend full suite 629 passed, including sender action, exact retry, offline/privacy/pending/terminal guards and error/refreshed-head form reset. Both builds/lints, frontend type-check, contract check and both context checks pass; contract drift is zero. No new schema or real-account activation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 3D. Explicit same-account FX posting/history  | Done    | 3C                                                      | Manual posting/history with one shared date/sequence, exact positive exchanged amounts before fees, explicit fees in either exchanged currency and retained statement reference. Existing cash-operation storage; no new schema. Explicit currency openings, atomic postings, unchanged cash-only source fingerprint, exact canonical retries and funded dated replay are enforced. Backend full suite 1,236 passed / 198 skipped; all 93 disposable-localhost ledger tests pass, including concurrent retries, competing FX spending, backdated/source/received-fee funding rollback, occupied slots, opening boundaries, missing currency balances, archived retained reads and tampered signed postings. Frontend full suite 642 passed, including exact amounts/fees/retry identity, dashboard legacy gating, privacy/offline/pending/stale capability guards and masked history. Both builds/lints, frontend type-check, contract check and both context checks pass; contract drift is zero. No automatic exchange, market-rate inference, holdings change, activation or FX revisions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 3E. Audited FX revisions                      | Done    | 3D                                                      | Fixed account/currency pair/direction/source; editable exchanged amounts, fees, date and sequence. Current revision/audit/fingerprint and reason protect immutable inverse/replacement legs, reserved historical slots and funded replay in both currencies. Reversal is terminal; identity changes require reversal plus a new record. Backend full suite 1,240 passed / 200 skipped; all 95 disposable-localhost ledger tests pass, including exact FX correction/reversal legs, old retries after later activity/terminal reversal, funding rollback in either currency, no-op/opening guards, concurrent/stale heads, reserved slots, archived audits and tampered revision postings. Frontend full suite 656 passed, including exact fees/amounts/retry keys, reason/acknowledgement, privacy/offline/pending/error/terminal guards, conflict refresh, keyed form reset, encoded review API and account-scoped invalidation. Both builds/lints, frontend type-check, contract check and both context checks pass; contract drift is zero. No new schema or real-account activation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 3F. Statement-supported dividend reinvestment | Done    | 3A, 3E                                                  | User-approved posting/history first, account-paid residual only. Atomic new equity/ETF income and a separate BUY parcel share statement identity, retained counterpart IDs and full dated replay. Net income exactly funds consideration, fees and residual; no issuer-held credits, extra funding, relinking existing receipts or independent income/acquisition revisions/voids. Historical entitlement and statement tax figures are retained; current quantities do not determine income. Backend full suite 1,244 passed / 204 skipped; all 99 disposable-localhost ledger tests pass, including concurrent exact retries, separate new parcel/tax attributes, ordinary subsequent sales, one-sided revision guards, occupied-slot rollback, later-allotment funding, historical entitlement after disposal, duplicate statement rejection and removed-link tampering. Frontend full suite 669 passed, including exact fractional tax/residual amounts, identical ambiguous-error retry keys, acknowledgement, privacy/offline/pending/stale/error/legacy guards, dashboard entry, masked linked history, encoded API transport and cash/holdings/review invalidation. Both builds/lints, frontend type-check, contract check and both context checks pass; contract drift is zero. No new schema or real-account activation                                                                                                                                                                                                                                                           |
| 3G. Paired audited reinvestment revisions     | Done    | 3F                                                      | Fixed account/asset/currency/source identity; editable statement/tax figures, acquisition units/price/fees, dates/sequences and account-cash residual. Corrections and terminal paired reversals require both current revision heads, account audit/fingerprint, reason, no effective parcel SELLs, reserved historical slots and full funded replay. Exact inverse/replacement postings and source/parcel updates commit atomically; both original and revision retries remain idempotent. Backend full suite 1,254 passed / 207 skipped before the final additional integration case; all 103 localhost ledger tests pass, including competing revisions, reserved slots, archived history, concurrent retries, tax-only changes, terminal reversal, effective-sale/void guard, stale heads, identity/no-op guards, unfunded rollback and tampered postings. Frontend full suite 683 passed, including paired-head submission, exact retry, terminal acknowledgement, sale/offline/privacy/pending/error guards, conflict refresh/reset, encoded API and mock parity. Both builds/lints, frontend type-check, contract check and both context checks pass; contract drift zero. No schema change or activation                                                                                                                                                                                                                                                                                                                                                                            |
| 3H. Stock splits/consolidations               | Partial | 3G; approved methodology                                | User approved statement-supported splits and consolidations, with no silent fractional rounding/cash-in-lieu, blocking affected existing later sales, and audited corrections/reversal deferred. Parcel projection and statement-command review cover exact quantities, cost fractions and later-sale restrictions. CGT, recomputation, opening/source inventory, proposed-sale review and dated reinvestment entitlement share retained split validation; original acquisitions and trade cash remain unchanged. Source fingerprints include retained evidence, detecting provenance changes with unchanged quantities. Reinvestment entry/correction use the dated reader; correction excludes its own acquisition parcel. Sale review preserves later sale capacity and rejects changed retained effects or ambiguous same-day ordering. Both migrations were applied locally; deferred position references permit user/account cascade deletion. These consumers remain behind the account-wide financial write guards: opening review reports SPLIT_REPLAY_UNSUPPORTED, capability is BLOCKED and live cash review is incomplete. Backend regression: 1,317 passed / 210 skipped; targeted localhost CGT/ledger/opening suites: 107 passed. Source-service/shared-reader line coverage: 97.36%; build/lint pass. Posting/history, locked source-freshness enforcement and audited fingerprint continuation, remaining financial workflows, holdings cost presentation, statistics integration, frontend and end-to-end regression remain unimplemented; do not enable or claim support |

Status meanings: **Pending** = not started; **In progress** = actively being implemented;
**Partial** = some deliverables exist but exit criteria remain; **Blocked** = an explicit
decision or prerequisite prevents progress; **Done** = all scoped deliverables and exit
criteria verified. Checked checklist items denote Done; any corresponding register entry
must agree. Unchecked items can be Pending, In progress, Partial or Blocked.
Implementation completion is separate from commit, deployment and account activation.
The historical frontend build blockers recorded for 2F/3A above are resolved in 3B: the
misplaced sale `busy` flag now belongs on the close dialog, and unsupported test-only `exact`
options were removed without changing matching behavior. Current frontend production build and
type-check both pass. Worktrees remain uncommitted; contract metadata names the current backend
HEAD until the tested backend milestone is committed and the frontend contract is pulled again.

Before starting a step, read this register and its acceptance criteria, then check the
relevant code/tests and repository state. Reuse delivered work; do not restart it from
historical notes. If evidence contradicts a status, correct the register and explain the gap.
Set In progress when implementation starts. Before each handoff, update status, remaining
work, blockers, relevant file/test evidence and next action in this document. Record actual
validation outcomes, including failures or checks not run; do not mark Done based only on
code being written. Keep unfinished steps visible rather than silently skipping them.

When a step is split or reordered, update its prerequisites and checklist together and
document why. Each feature change must update this register and related system documentation
in the same change set. Keep this as the single status source; the ADR links here rather
than maintaining a competing task list.

### Current capability matrix (not the final launch policy)

| Operation                                             | Legacy / inactive draft                                                                                                 | Active real ledger                                                                                                                            | Archived real ledger                                                                                          |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Opening preview, saved draft, evidence/reconciliation | Available; draft cash is not spendable                                                                                  | Explicit 2F confirmation enables one eligible account only                                                                                    | Retained history does not permit new spending                                                                 |
| Manual BUY/SELL entry                                 | Existing eligible legacy flow; proposed draft trades are scenarios only                                                 | Coordinated backend writer and capability-aware ordinary UI routing delivered (2E)                                                            | New live writes rejected                                                                                      |
| Manual execution correction                           | Eligible recorded trade + draft cash corrections are coordinated; cash-linked financial edits cannot use legacy writers | Dedicated audited BUY/SELL corrections                                                                                                        | New live corrections rejected                                                                                 |
| Imported Kraken execution correction                  | Source-linked draft cash supports sequence-only edits, not financial import overrides                                   | Date/sequence/price/fees only; fixed quantity, allocations and currency                                                                       | New live corrections rejected                                                                                 |
| Manual trade void                                     | No dedicated live void without confirmed ledger                                                                         | SELL or unsold BUY only; terminal retained audit                                                                                              | No new void; retained audit read supported                                                                    |
| Deposit/withdrawal and capital revision               | Inactive draft funding/revisions available                                                                              | Live deposit/withdrawal posting (2B) and audited live revisions (2C) delivered                                                                | Retain residual cash/history; live read/reconciliation delivered (2D); explicit reopening required for writes |
| Imported void, financial move or protected deletion   | Imported/cash-linked records guarded                                                                                    | Explicitly blocked                                                                                                                            | Ledger deletion blocked; preserve history                                                                     |
| Same-currency cash transfer                           | No paired draft transfer or implicit activation                                                                         | Paired posting/history (3B), fixed-identity audited replacement and terminal reversal (3C); sender fee only                                   | Retained audit only; both endpoints must be active for posting or revision                                    |
| Explicit same-account FX                              | No draft conversion or implicit activation                                                                              | Linked postings/history (3D) and audited fixed-identity corrections/terminal reversal (3E); fees in either exchanged currency                 | Retained audit only; new postings/revisions rejected                                                          |
| Statement-supported dividend reinvestment             | No draft reinvestment or implicit activation                                                                            | Atomic income plus new equity/ETF BUY parcel (3F), account-paid residual; paired audited corrections/reversal (3G) require no effective sales | Retained audit only; new postings/revisions rejected                                                          |
| User-facing confirmation/provisioning                 | Explicit per-account 2F confirmation is implemented; saving a draft is not confirmation                                 | No automatic enablement                                                                                                                       | No automatic legacy fallback                                                                                  |

Draft cash inactivity does not mean all draft workflows are read-only: dedicated recorded
manual execution corrections can update the actual transaction/parcel and its linked draft
cash atomically. Proposed draft trades, by contrast, never create real holdings.
Demo accounts keep legacy practice behavior and are not eligible for real-ledger operations.

## Goal

Make portfolio value and investment performance explainable from recorded holdings,
cash, income, fees and currency movements. Preserve the existing purchase parcels,
trading tools and CGT reports rather than replace the application.

This is a staged accounting upgrade, not a promise of complete tax compliance,
broker synchronisation or institutional accounting.

## Confirmed product decisions

- Start with long-only shares/ETFs and existing crypto buys/sells. Broader crypto
  accounting comes later.
- Establish trustworthy balances from a user-confirmed opening statement on a chosen
  date. Do not fabricate historical deposits or claim complete historical returns.
- Maintain separate currency cash balances within each trading account.
- Purchases in confirmed accounts require sufficient recorded cash in the payment
  currency, including fees. Prompt for explicit funding; never auto-create deposits.
- Legacy accounts and their positions remain accessible before confirmation.

## Preserve these invariants

- Each Position remains one acquisition parcel with exactly one BUY transaction.
  Reinvestment creates a new parcel; it never adds a BUY to an existing Position.
- Existing acquisition dates, quantities, costs and disposal links remain intact.
  An opening holdings statement references existing parcels; it does not buy them again.
- Existing CGT PDFs and revisions remain unchanged. Cash migration does not rewrite
  historical tax results or merge account-selection loss chains.
- Demo accounts remain excluded from real-account aggregates and tax reporting.
- Dashboard navigation remains account-first and position-first. Add a consolidated
  accounting overview without removing exchange-scoped holdings.
- Legacy performance and accounting-backed performance are separately labelled.
  Never splice their series or silently reinterpret an old metric.
- Corrections cannot silently rewrite posted cash history. Retain the original,
  reversal and replacement links and rebuild affected projections.
- Missing prices, FX, records or unsupported events produce explicit completeness
  warnings and unavailable metrics, not zero-valued substitutes.

## Target accounting rules

1. Account value = market value of holdings + actual cash balances, converted into
   the user's reporting currency at the valuation date.
2. Do not add realised gains separately to account value: sale proceeds are already
   included in cash. Show realised P&L separately as attribution.
3. BUY consumes gross consideration plus cash fees; SELL adds proceeds minus cash
   fees. Multi-parcel allocations of one execution must not duplicate its cash impact.
4. Deposits and withdrawals are external capital flows, not profit.
5. A transfer is external to either individual account but internal to a selected
   portfolio containing both endpoints. Transfer fees remain costs.
6. Currency conversion is two linked currency legs with recorded amounts and fees;
   a purchase does not implicitly convert another currency's balance.
7. Income records actual receipts and their tax components. Non-cash franking credits
   are not spendable cash and must not inflate account value.
8. Valuation uses dated, sourced prices and FX. Trading/execution currency remains
   distinct from reporting currency and AUD tax conversion.
9. Accounting quantities, money and intermediate calculations use decimal arithmetic.
   Round at documented posting/display boundaries, not after every intermediate step.
   Converting legacy Float quantities cannot recover precision already lost.
10. Opening holdings and cash establish the performance starting value, not a profit.
    Original cost remains available for inception trade P&L and CGT.

## Delivery sequence

Each increment must include its own API, frontend, tests, documentation and migration
work where applicable. Do not wait until the final phase to make the work usable.

### 1. Specify and test the accounting contract

Deliver:

- An ADR defining posting rules, currency balances, corrections, funding validation,
  ownership checks and the confirmed-cutover boundary.
- Exact definitions for account value, capital flows, investment gain, trade P&L,
  time-weighted return (TWR) and money-weighted return (XIRR).
- A deterministic reference fixture covering opening balances, purchases, partial
  sells, fees, income, external funding, transfers and FX.
- A migration/reconciliation dry-run specification with no writes to financial data.

Design direction, subject to the ADR:

- Account accounting state and confirmed start date.
- Opening statement referencing parcel quantities plus currency cash balances.
- Durable cash postings linked uniquely to their source operations and corrections.
- Income records linked to account/asset, with entitlement and tax breakdowns.
- Versioned valuations carrying source dates, methodology and completeness status.

Reuse existing Transaction and parcel services. Add accounting-specific records only
where the existing parcel-only model cannot represent them. Do not introduce a second
independently editable copy of the trade ledger or a generic bookkeeping framework.

Exit gate: every reference-fixture operation has explicit expected balances and
performance classification; accounting policy is approved before schema design.

### 2. Ship opening balances and cash-backed trades

Prerequisite: increment 1.

Deliver:

- Additive schema migrations and decimal-safe accounting helpers.
- Account setup showing existing holdings and asking the user to confirm a start date,
  holdings and actual opening cash by currency.
- Deposits, withdrawals, balances and activity history.
- Atomic trade and cash posting for manual buys, partial/full sells and supported
  Kraken imports. Wire create, edit, delete, close-event edits and retry paths.
- Funding checks against the dated cash timeline, not only today's balance.
- Idempotency and concurrent-spend protection; failure rolls back both trade and cash.
- Reversal/replacement corrections with previews of downstream effects.
- Clear distinction between unconfirmed legacy and confirmed accounting accounts.

Boundary:

- Only operations after the confirmed opening boundary generate new cash postings.
- Choose and document whether an opening statement is start-of-day or end-of-day;
  same-day trades must be included exactly once.
- Pre-boundary edits that affect opening inventory require reconciliation/reconfirmation.
- Backdated imports cannot recreate cash for already-included opening positions.
- Unsupported short/margin workflows remain available only in legacy tracking until
  a separate policy exists; never silently apply long-only accounting to them.
- Closed accounts retain cash/history; closure cannot silently discard balances.
- Negative cash is not permission to auto-fund. A confirmed account with an unresolved
  funding discrepancy must be flagged and further spending prevented until reconciled.

Exit gate: supported trades reconcile holdings and cash, with no invented funding,
duplicate postings or regressions to existing trade history and tax report downloads.

### 3. Ship income, transfers and adjustment support

Prerequisite: increment 2.

Deliver in small slices. The first slice (3A) is manual, statement-supported equity/ETF
cash distributions only: gross, withholding, franked/unfranked split, non-cash AUD franking
credit, entitlement/payment dates, currency and source reference are retained. The cash ledger
posts only `gross - withholding`; income is not an external contribution. Users enter source
figures rather than deriving entitlement from current quantities. The first implementation supports audited replacement and terminal reversal without changing
asset, currency or source reference; reverse and record a new receipt to correct those identity
fields. Do not directly edit or delete a posted income event. AMIT components, automated estimates
and crypto staking remain unsupported.

Remaining slices:

1. **3B (delivered):** manual same-currency cash transfers between two owned active,
   confirmed real ledgers on one shared effective date, with independently attested intraday
   sequences and an explicit sender-paid fee in the principal currency. Existing cash-operation
   records retain the shared normalized request/hash and opposite endpoint identities; no
   second editable transfer ledger or schema migration is needed. Both account rows are locked
   in sorted ID order, both dated timelines must remain funded, and both legs commit or roll
   back together. No missing currency opening is inferred. Principal counts as external capital
   at either individual account and cancels when both accounts are selected; fees remain costs.
   The cash review exposes both endpoint IDs and fees, and validates the paired source/postings.
   The UI requires online capability checks and acknowledgement of the paired audited workflow.
   Same-key retries reuse both operation IDs; collisions, stale sources, demo/legacy/archived/
   unowned endpoints and occupied date/sequence slots fail closed. No holdings move or FX occurs.
2. **3C (delivered):** paired transfer corrections/reversals preserve accounts, currency
   and source reference while allowing principal, sender-paid fee, shared effective date and
   both account sequences to change. Both current audit heads and fresh active source ledgers
   are required. Sorted account locks, immutable paired revision chains and full-timeline funding
   ensure atomic replacement or terminal reversal; reversal removes the original economic
   effect including fees, rather than recording a new return transfer. All original/replacement
   slots stay reserved. Exact retained retries remain valid after subsequent activity.
   Sender-side cash review exposes the online-only paired form, reason, acknowledgement and
   explicit refresh of both heads; privacy, stale/error review and pending writes block submission.
   Direct edits/deletions and one-sided funding revisions remain rejected. Cross-date
   settlement/in-transit cash, recipient-side or third-currency fees, external untracked
   endpoints and holdings transfers need separate policy.
3. **3D (delivered):** manual same-account FX records one atomic cash operation with
   positive source and received amounts before separately charged fees, a shared effective
   date/sequence and statement reference. Both exchanged currencies require explicit opening
   balances. Fees may be aggregated in either exchanged currency, not a third currency.
   Full dated replay must stay funded, including source principal/fees and received-currency
   fees. Both principal legs use `FX_PRINCIPAL`, never external capital; no parcel transactions
   or reporting-FX valuations are created. Exact amounts are authoritative; market rates and
   spreads are not inferred. This records a broker conversion; it never executes one or
   silently funds a purchase. Immutable history and source fingerprints are retained, with
   exact retries and fail-closed source/posting validation. Dashboard entry is online-only,
   capability-gated and privacy/pending protected; live cash review shows both amounts and fees.
   Third-currency fees and cross-date settlement remain unsupported.
   **3E (delivered):** dedicated audited corrections retain the account, ordered currency
   pair and source reference while allowing exchanged amounts, fees, date and sequence to change.
   Current revision/audit/fingerprint and reason are required under the account/user lock.
   Exact inverse/replacement legs restate the dated currency timeline atomically; all original
   and replacement slots remain reserved. Reversal is terminal and removes the effective
   conversion including fees, not a new reverse exchange. Both currencies must remain funded.
   Original records and full audits remain retained; identical old requests can be retried after
   later activity or terminal reversal. Live cash review opens a fresh operation-specific review
   regardless of history pagination. The form blocks offline/privacy/pending/stale/error review;
   conflicts require explicit refresh, and refreshed heads reset reason/acknowledgement/fields.
   To change currency direction or source, reverse and record a new conversion. Generic funding
   revisions, direct edits/deletions and implicit deposits cannot alter FX history.
4. **3F (delivered):** one statement-supported equity/ETF command atomically records income
   once and acquires a new parcel in the same account/currency. Existing income and BUY writers
   are reused inside one account/user-locked transaction; there is no append-units flow or
   relinking of an existing receipt/BUY. Exact net income equals consideration plus explicit
   acquisition fees plus residual cash paid into the account. Issuer-held carry-forward, prior
   plan credits, external top-ups, cross-currency purchases and complex AMIT components remain
   unsupported. Consideration must fit existing cent-precision storage without rounding.
   Statement tax figures and entitlement/payment/acquisition dates are retained with explicit
   acknowledgement. Historical eligible long holdings are required on the entitlement date,
   even when sold before payment; current quantities never determine the dividend.
   Acquisition cannot precede payment, and same-day income must have the earlier sequence.
   Full dated replay prevents intervening spending from leaving a later allotment unfunded.
   Both immutable envelopes share the complete normalized request/hash and retain counterpart
   operation IDs and the new parcel ID. Replay verifies links, snapshots, postings and consecutive
   fingerprint audits; removing a link cannot bypass mutation guards. Identical retries return
   the original IDs after later ordinary sales. Online entry is capability-, privacy-, pending-
   and stale/error-gated for both dates; live cash review retains linked provenance and masks
   quantities/residuals in privacy mode. Original income/BUY corrections and BUY voids reject
   independent changes. Archived retained history remains readable without enabling writes.
   **3G (delivered):** fixed identity paired corrections and terminal reversal require both
   reviewed revision heads, global audit/fingerprint, a reason and no effective parcel sales.
   Void effective sales first. Statement tax figures, income/acquisition dates/sequences,
   units, price, fees and account-cash residual can change together; corrected historical
   entitlement excludes the reinvestment parcel. Immutable paired revision audits retain
   inverse/replacement postings, prior heads, historical slots and source fingerprints; full
   dated cash replay must remain funded. Reversal removes both effective effects without
   recording a disposal. Exact old retries remain valid after later activity or reversal.
   The online review blocks privacy, pending, stale/error state and effective sales; conflicts
   require explicit review refresh and refreshed heads reset reason/acknowledgement. Independent
   income or BUY revisions/voids remain blocked.
5. **3H (partial, not enabled):** statement-supported stock splits/consolidations preserve
   each affected parcel's original acquisition date and remaining aggregate cost base,
   including acquisition fees. The action changes units, not cash or a disposal. Apply the
   statement ratio to each parcel's units immediately before the action; cost already allocated
   to an earlier disposal remains with that disposal. Subsequent disposals use the adjusted
   per-unit cost. Retain the source and effective date and apply the action atomically to the
   affected holdings. Exact representability is required; reject cases needing rounding or
   cash-in-lieu rather than inventing allocations. Block posting if an affected parcel has an
   effective later sale; void eligible sales first and re-enter them after the action is safely
   supported. Reject ambiguous same-day ordering unless proven by the supported timeline.
   Posting/history come first; audited corrections and terminal reversal are a separate slice.
   Do not expose posting until inventory, cash-ledger replay and source fingerprints, trade
   and import mutation guards, holdings, realized results, statistics, historical income
   entitlement, CGT report calculations and previously generated report behavior are covered.
   Test multiple parcels, earlier and later disposals, repeated actions, exactness, unchanged
   cash/acquisition dates, retries/concurrency, ownership, stale sources and unsupported cases.
   Standalone cost-base adjustments, mergers, demergers, complex AMIT and bonus issues are
   not included.
   The standalone `projectParcelInventory` kernel replays dated splits and parcel sales,
   retaining exact rational fractions of the original acquisition cost and rejecting
   over-disposals, ambiguous same-day split ordering, inexact split quantities and quantities
   incompatible with existing Float storage. The CGT reader now uses this projection for
   recorded split effects, validates linked source data and before/after quantities, and rejects
   missing parcel effects. The additive action/effect schema is applied locally, but no
   application command can create or review stored actions yet.
   CGT and position recomputation now share stored-action validation and exact parcel replay.
   Recomputation preserves acquisition fields and uses adjusted remaining units and cost for
   OPEN/PARTIAL/CLOSED status, realized P&L and return percentage; voided sales are excluded.
   Missing or inconsistent effects reject recomputation before updating the position.
   Until the dependent writers can replay and audit split history, a conservative account-wide
   fence rejects legacy acquisitions, sales, financial edits, moves (either account), parcel
   deletion and new financial import steps with 409 under the account lock. The shared draft
   source check and live-ledger write reader apply the same fence before writes. Metadata-only
   notes and completed legacy import retries without financial steps remain possible; this is
   protection, not support for split-aware financial corrections. Opening preview reports the
   explicit `SPLIT_REPLAY_UNSUPPORTED` blocking issue, preventing opening confirmation even when
   transaction-only quantities happen to match. Trade capability returns `BLOCKED`; retained live
   cash history stays readable but is marked `INCOMPLETE`, not certified split-aware.
   The opening/source reader now projects exact inventory at the cutover boundary and current
   observation date using the same stored-action validation. Earlier and later sales and repeated
   splits/consolidations leave recorded cash unchanged; parcels fully sold before an action or
   acquired afterward do not need an effect for that action. Missing or inconsistent effects fail
   without a partial preview. Canonical source snapshots include retained action/effect evidence,
   so changing split provenance changes the fingerprint even when quantities are unchanged.
   Accounts without splits retain their previous fingerprint format and calculation path.
   Interactive preview also caps retained history at 500 actions and 50000 effects and rejects
   oversized snapshots rather than truncating them.
   The shared bounded history loader is now also used for dated account/asset entitlement.
   Reinvestment entry and paired correction use exact split-adjusted holdings at the entitlement
   date, not current quantities; correction excludes its own reinvestment parcel, and voided
   trades/parcels are excluded by the source queries. The sale writer includes retained effects
   in proposed-sale review and validates the complete timeline, reserving units for later sales
   and rejecting backdated changes to immutable split snapshots and ambiguous split-day sales.
   Its no-split arithmetic remains unchanged. These integrations remain behind the account-wide
   split-history write fence; they are not permission to post or mutate split accounts.
   Backend regression: 1,317 passed / 210 skipped; targeted localhost CGT/ledger/opening suites:
   107 passed. Source-service/shared-reader line coverage: 97.36%; build and lint pass.
   Next, implement audited fingerprint continuation and remaining mutation/revision workflows
   before replacing the write fences. Holdings cost presentation and statistics also remain;
   posting and corporate-action history/frontend remain unavailable.
   The standalone account command prepares a statement-confirmed, account-bound payload and
   reviews eligible parcels against a supplied effective snapshot, rejecting inconsistent
   quantities, unsupported assets, ambiguous dates and existing same-day/later sales or actions.
   It neither fetches nor locks the snapshot and is not an API or a posting authorization;
   the eventual writer must enforce ownership, source completeness and freshness under lock.

Income is an account/asset event with any necessary parcel allocation, not one full
dividend duplicated on each parcel. Distinguish distribution tax components from cash
received. Manual entry comes before automated estimates or provider imports.

Tax-impacting corporate actions need their own approved methodology and regression
tests before activation. Mergers, demergers, complex AMIT cases and bonus issues are
not assumed covered by a generic adjustment field. Unsupported cases are surfaced
and mark affected periods incomplete.

Exit gate: supported income and adjustments reconcile to cash and inventory without
duplicate return, changed original acquisition dates or implicit taxable transfers.

### 4. Replace synthetic equity with sourced valuations

Prerequisites: increments 2 and 3 for the supported accounting scope.

Deliver:

- Consolidated account/selected-accounts value in the user's reporting currency,
  with local-currency holdings and cash breakdowns.
- Historical inventory reconstructed from effective-dated operations rather than
  today's remaining quantities.
- Historical valuation using prices compatible with the corporate-action ledger;
  never double-apply splits or dividends from adjusted price series.
- Scheduled daily valuation independent of page visits, with safe retries, bounded
  backfill, logs and deployment scheduling instructions.
- Explicit price/FX as-of dates, market calendar/time-zone policy and stale-data status.
- Versioned replacement valuations after backdated corrections; old methodology is
  retained and never silently merged into the new chart.

Start with AUD reporting using the existing RBA-first FX mechanism where appropriate;
support other reporting currencies through a verified conversion policy, not relabelling
AUD amounts. Preserve cached rates and sources used by existing tax reports.

Exit gate: full sales leave proceeds in cash; external deposits change account value
without creating gain; no realised-P&L double counting or undisclosed missing valuations.

### 5. Ship proper investment returns and rebuild risk metrics

Prerequisite: increment 4.

Deliver:

- Investment gain over a supported interval:
  ending value - starting value - net external contributions.
- TWR using valuations at external-flow boundaries, or an explicitly named approximation
  where the required observations are unavailable. Do not label an approximation TWR.
- XIRR with dated external flows, opening and terminal values, and explicit unavailable
  results for insufficient data, non-convergence or ambiguous solutions.
- Income, costs and currency attribution with a documented reconciliation to total gain.
- Separate investment-return analytics from existing per-trade win/loss/expectancy tools.
- Volatility, drawdown and Sharpe rebuilt from cash-flow-adjusted returns with documented
  frequency, annualisation, risk-free assumptions and sample-quality gates.
- UI labels distinguishing period returns, inception trade returns and annualised returns.

Do not show professional-looking risk figures merely because a sample count is high.
Missing flow-boundary prices, incomplete income or unsupported events must affect
availability. Mixed shares/crypto portfolios need an explicit calendar policy.

Exit gate: contributions/withdrawals do not improve or damage return artificially;
reinvestment does not create duplicate income; known reference TWR/XIRR results pass.

### 6. Expand ingestion and Australian tax readiness

Prerequisites: accounting rules and reconciliation established in increments 1-5.

Deliver:

- Broker CSV adapters chosen for actual product needs, with preview and reconciliation.
  Automatic connections are a separate integration project.
- Crypto transfers with cost-base carry-over and staking income; crypto-to-crypto
  disposals and DeFi remain explicit follow-on scope.
- Exact CGT discount calendar rules, tax-component reporting and entity policy.
- Accountant-reviewed reference cases before stronger tax-accuracy claims.
- Machine-readable exports of holdings, cash, income, operations and valuation metadata.

Preserve the existing report revision model and account-selection scoping. If tax entity
identity changes loss-chain semantics, approve a separate migration design first.

Exit gate: each new adapter/event type demonstrates no duplication, reconciled balances
and correctly classified tax effects before it is advertised as supported.

### 7. Add decision tools on the verified foundation

Prerequisite: increment 5; income forecasting also depends on increment 3.

- Benchmarks using comparable currency, period and total-return methodology.
- Target allocation/rebalancing, income calendars and ETF overlap.
- Controlled accountant sharing and broader operational hardening as separate projects.

Do not prioritise these ahead of accounting completeness.

## Minimum acceptance examples

Amounts below are synthetic test data, not existing user balances.

| Scenario                                                                           | Required outcome                                                                  |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Open with AUD 10,000 cash; buy 10 units at AUD 100 plus AUD 10 fee                 | Cash 8,990; units 10; at an unchanged price account value 9,990                   |
| Sell 4 of those units at AUD 120, fee AUD 5                                        | Cash 9,465; units 6; at price 120 account value 10,185; realised trade P&L 71     |
| Then sell the remaining 6 at AUD 120, fee AUD 5                                    | Cash/account value 10,180; units 0; no separate realised gain added to value      |
| Deposit AUD 5,000 with no market movement                                          | Value rises 5,000; investment gain and TWR remain unchanged                       |
| Receive AUD 100 gross income with AUD 15 withholding                               | Cash increases 85; gross income 100 and withholding 15 shown separately           |
| Record a non-cash franking credit                                                  | No cash increase; tax metadata retained                                           |
| Transfer AUD 1,000 between two selected accounts, without fees                     | Combined value/return unchanged; source and destination balances change           |
| Apply a 2-for-1 split                                                              | Units double; total parcel cost unchanged; no gain caused by the split            |
| Two concurrent purchases exceed available cash together                            | At most the adequately funded operation posts; no negative cash or partial writes |
| Retry an import or trade request                                                   | Same result; no second acquisition or cash posting                                |
| Missing required historical FX or price                                            | Incomplete status and affected metric unavailable, not zero                       |
| Edit a trade included in the opening statement                                     | Explicit reconciliation requirement; no silent opening-balance rewrite            |
| XIRR: opening outflow 1,000 on 01/01/2025; terminal value 1,100 on 01/01/2026      | 10% within a defined numerical tolerance                                          |
| TWR: value 1,000 grows to 1,100; deposit 900; value then grows from 2,000 to 2,200 | 21% cumulative TWR, not a return driven by the deposit                            |

## Migration and release safety

- Use expand/backfill/enable stages; never overwrite committed migrations.
- Do not run production migrations from an agent/local session. Use the existing
  deployment pipeline, verified backup and restore procedure, and a rehearsal first.
- Backfill provenance from existing operations only where unambiguous. Do not invent
  missing income, transfers, cash, source precision or opening statements.
- Reconcile per-account inventory and balances before enabling confirmed accounting.
- Keep legacy endpoints/metrics available during transition with explicit semantics.
- Changing pre-cutover records or effective dates can invalidate confirmation and
  downstream valuations; show the impact and require resolution.
- Posted-record retention must be coordinated with account closure/deletion and the
  existing user soft-delete/purge flow. Auditability does not mean retaining data forever.
- Enable per account, not globally. Rollback disables the new view/write mode without
  deleting postings or silently creating a divergent legacy history.

## Engineering verification for every increment

- Focused unit tests for arithmetic, dates, FX, rounding and accounting classifications.
- Controller/service tests for ownership, atomicity, correction and idempotency.
- Database-backed tests for migrations, unique source links and concurrent spending.
- Frontend tests for funding prompts, opening confirmation, corrections, missing data
  and query invalidation. Confirm mobile, light/dark and offline read-only behaviour.
- Regression fixtures for manual and imported parcels, partial closes and CGT outputs.
- Build/type-check, existing lint and targeted suites; aim for at least 80% line coverage
  of new accounting logic.
- Swagger updates for every changed route/shape.
- Regenerate backend context, then pull the frontend contract, update the manual type
  mirror, regenerate frontend context and review contract drift.

## Implementation progress

The following records delivered implementation slices; the opening preview and inactive-draft
work below is already implemented, not the current next task. Some earlier progress notes describe
work that was outstanding at that point; the current remaining work is listed at the end of this
section. Statements such as "future corrections" describe that earlier slice, not current
availability. Dedicated live correction and void workflows supersede those older limitations;
legacy direct financial writers remain blocked.

Use the dashboard's "Opening-balance preview" for a selected real account to review a
chosen end-of-day date and explicit currency balances. Preview is read-only and cannot confirm
an account or generate deposits. It shows parcel reconciliation and trade-only projected
cash, with blockers for incomplete records, ordering and unsupported imported currencies.

After reviewing, "Save inactive draft" explicitly persists a new statement revision with
its cash and inventory snapshots. Saved drafts can be reopened as inputs, but must be
previewed against current records again. Saving creates no spendable balance and does not
alter trades. Retrying the same reviewed content returns the existing draft.

The cash engine prepares exact trade/fee and deposit/withdrawal legs and checks the entire
dated cash timeline using explicitly supplied intraday order. It distinguishes external capital
from profit and refuses historical funding gaps, duplicate execution cash, missing currency
balances and precision overflow. Draft operations remain inactive. A separate live writer now
requires an active ledger plus its matching confirmed Sydney opening statement, verifies the
source-fingerprint chain and trade snapshots, then commits the trade, cash postings and ledger
head atomically. No endpoint confirms or activates accounts.

Inactive drafts now retain cash operation identities, exact postings and snapshot trade links.
Internal staging serializes writes by locking the account and rejects stale source records,
duplicate execution cash and historical funding gaps. Database tests cover competing withdrawals,
idempotent retries, atomic child-write rollback and erasure cascades. Manual cash-flow staging is
available in the review UI, but these are isolated draft histories, not live account cash.

Manual full/partial close, close-event correction and parcel deletion now share the owned-account
lock with draft staging. Sale creation/correction and parcel recomputation commit together, and
remaining units are reread under a parcel lock before selling. Real database tests verify competing
closes cannot sell the same units twice and recomputation failures roll back the sale/correction.
These routes still use legacy trade arithmetic; they do not create live cash postings.

Buy creation now resolves the account and commits the parcel with its nested BUY in one locked
transaction. Acquisition edits reread sold units under lock, reject bought units below disposed
units, and recompute status and realised gains after cost/fee/quantity changes. Account moves lock
both accounts in stable ID order and recheck ownership and the demo boundary. Database tests
cover acquisition rollback, edit/sale races and opposite-direction moves without deadlocks.
These operations still preserve legacy trade arithmetic and do not post live cash.

Import commits now take the same account lock and compare current events/eligible holdings with
the server-prepared plan before writing. A concurrent sale, acquisition edit, account move,
deletion, review edit or discard produces a 409 rather than stale/implicit reallocation.
Imported BUYs, allocated SELLs, parcel recomputation and source links commit or roll back together.
Review merges, discard and deferred reward reattachment also participate in the account lock.
Database tests cover import/manual-writer races, duplicate commits, rollback and lost-update
prevention; the frontend refreshes failed imports for review without automatically retrying commits.
This does not bind commits to a browser preview token or introduce live cash.

Trading-account close/reopen/rename/delete now participate in account locks. Closing checks
current open/partial parcels in the transaction; deleting real accounts checks current parcels
and tax-report references before erasure. Demo deletion still cascades its entire disposable tree.
Explicit reopening is required before adding open holdings to an archived account. Acquisition
edits/moves that would create open holdings there roll back; fully closed history can still be
corrected. A missing explicit account ID returns 404 rather than silently rerouting to Main.
Tax-report revision creation also locks selected accounts before retaining their opaque references,
and rejects deleted accounts or changed current revisions. Purge rechecks deletion eligibility
at the actual delete, protecting users restored after its initial scan.

Participating writes now take a shared active-user barrier before account locks. Deletion waits
for earlier trades, then marks the user deleted and revokes sessions in one transaction; later
writes fail their locked recheck. Restoration and session persistence are atomic, login/refresh
cannot recreate sessions after revocation, and concurrent refreshes rotate a token at most once.
Profile updates recheck user/password state under the exclusive barrier. New account creation,
destination resolution, opening draft saves and legacy daily snapshot writes also participate.
Independent accounts retain concurrency. Fixture-only DB tests cover disposal/deletion ordering,
late buys, restore/refresh rollback and restore-versus-purge behavior.

Password-reset issuance and completion now use the exclusive user barrier. Reissuance replaces
tokens atomically; completion consumes exactly one still-owned/unexpired token and commits the
password change plus all reset/refresh-token revocation together. Deleted/purged users cannot
reset, and concurrent completions succeed at most once. Reset email delivery remains outside
locks; a deletion/reissue can invalidate an already dispatched link.

Manual/import history backfills, explicit historical recalculation and stop-hit persistence
now take user/account/parcel locks and condition writes on their original calculation inputs.
Acquisition edits, moves, closes, stop edits and deletion cannot be overwritten by stale
provider results. Background skips/failures are logged, and explicit requests return 409 for
changed inputs. The frontend refreshes conflicted position queries without retrying mutations.
Provider fetches remain outside locks. This does not establish quote freshness or a new
valuation methodology; shared asset/exchange/FX-cache writes and unrelated watchlist/screener
mutations are outside the financial barrier, and signup's initial session creation is unchanged.

Cash operations now retain a stable immutable identity while corrections append linked
reversal/replacement revisions, reasons and retry hashes. Capital corrections restate the
effective-dated economic timeline and recheck all subsequent funding; recording time is kept
separate. An explicit corrected date/order may be supplied, but no boundary crossings, ordering
collisions or earlier cash deficits are permitted. Original/revision/posting history remains
intact; a pure reversal is terminal, and execution identities cannot be reused afterward.
Staging and old retries now use corrected balances. Fixture-only database tests cover competing
corrections/withdrawals, retry deduplication, rollback, immutable audit and cascade erasure.
The existing draft identities are extended, not duplicated into an independently editable
trade ledger. These records remain inactive and opening-revision-scoped; live identity
selection/cutover still needs implementation.

The pure reversal/replacement contract also handles trade cash and fees, but corrections to
real trades remain disabled until source trades and postings can change atomically.
There is no correction/deposit UI or endpoint in this slice. Replacement cannot rebind the
account, source, operation kind or transaction allocations.

The isolated trade slice now atomically records a proposed BUY, its cash legs and a durable
draft execution ID. Each new proposed BUY creates a separate parcel. Partial/full proposed
SELLs select that parcel explicitly; dated decimal inventory replay refuses earlier sales,
overselling and currency mismatches. Dated cash replay includes fees and external funding,
so simultaneous buys cannot overspend, simultaneous sells cannot reuse units, and capital
corrections cannot remove money already consumed by a proposal. Identical retries reuse the
same trade/parcel IDs; changed request content conflicts. Failures roll back the proposed
trade, cash operation, links and posting children together.

These are intentionally isolated proposals, not a second live trade ledger. Existing
`Position`/`Transaction`, opening revisions, current portfolio views and tax reports stay
untouched. Proposed sales can now select new draft BUY parcels or confirmed opening parcels.
Draft execution IDs in
cash links are snapshot references, not live transaction IDs. Ownership/source rechecks,
active-real-account requirements, precision/replay limits and user/account locks remain in force.
Original date/sequence slots remain reserved even after reversal/correction; new operations
cannot reuse them. The proposed-trade writer is internal only, with no HTTP/UI or activation.

Proposed-trade corrections now append a combined immutable trade/cash revision and exact
reversal/replacement cash legs. Their retry hashes include quantity and price independently,
even when a different quantity/price pair has the same consideration. Corrections/reversals
rebuild both the dated parcel graph and cash timeline before committing: a BUY cannot be reduced
below disposed units or reversed while active sells remain, and SELL proceeds cannot be removed
if later spending depends on them. Reversing a SELL restores its units; an unused BUY can then
be reversed. Reversals remain terminal; original identities and audit rows are retained.
Replacement cannot change the account, asset, selected parcel, operation kind or currency.
Earlier revisions and original requests can be retried without duplicate effects and return
current draft projections. Standalone cash corrections cannot mutate a proposed trade.
The implementation reuses the existing revision JSON and postings; no additional migration
or live holding changes are required. This remains an internal inactive workflow with no UI.

Opening-parcel proposals seed exact units directly from the immutable reviewed balance;
they never synthesize an acquisition or repost boundary cash. Keys are `opening:<opening-row-id>`,
not live position IDs, so a different statement/revision cannot silently reuse them.
The seed includes zero-unit parcels (which cannot be sold) and keeps each parcel separate.
It is the boundary quantity, not today's live remaining quantity: existing post-boundary trades
are not automatically added to an isolated scenario. Only explicit staged proposals affect it.
New opening sales verify the owned long source parcel and unchanged preview fingerprint;
stored rows must match the reviewed JSON and newly verified source inventory. Retries use
stored identities and projections, even after source changes; new writes then require a fresh
opening revision. Opening parcel projections expose their `positionId`/symbol and a null
`assetId`, since the old opening schema did not snapshot asset IDs. Each new SELL independently
records its verified asset identity without requiring live lookups for historical retries.

The same atomic correction/reversal path now handles opening sales, including exact unit
restoration, downstream purchase/withdrawal funding checks and competing allocations.
Recorded live-trade cash cannot coexist with opening-sale proposals in one draft, preventing
double-counting a legacy disposal; this guard retains reserved original identities after reversal.
Fixture tests preserve existing live BUY/SELL rows and opening balances through proposals,
corrections, rollback and concurrent unit allocation. No schema or HTTP/UI changes are required.

An internal read-only `reconcileDraftOpening` report now brings the existing checks together
under the owned account/user barrier. It validates draft audit history, replays effective
cash without requiring a positive funding result, and compares opening units with fresh live
boundary/current units. `openingDifference` compares saved versus freshly reconstructed
boundary units; `scenarioDifference` compares proposed versus expected live remaining units.
Neither difference silently adjusts holdings. New draft parcels are listed separately, and
missing/new live references are explicit nulls rather than invented zero balances.

The report distinguishes changed source data from the passing of time by rechecking the
saved observation date. It includes current preview blocking issues and lists observed
post-boundary transactions as `LINKED`, `UNLINKED` or `REVERSED`. Linkage is identity coverage,
not verification of the current execution's economic contents; source changes still require
review. Missing or re-dated linked executions are retained as excluded-source review items.
Active opening-sale proposals on a live parcel are identified as potential overlaps with
recorded post-boundary transactions, never automatically equated with or allocated to them.
Reports reject oversized reads or more than 100000 overlap references instead of returning
partial reconciliation.

Cash evidence is a strict, user-attested statement snapshot with date, currency balances,
source and reference. Preview compares every tracked currency against exact dated replay
without writes. Persisted evidence and per-currency reason/note decisions are immutable;
decisions describe a reviewed variance but never adjust cash or clear it. Reconciliation
recalculates each snapshot against currently effective dated operations and retains the
original attestation and decision history.

The review UI exposes cash funding gaps, source drift, parcel differences, trade linkage,
possible overlaps and statement-date variances. It permits only separately dated, explicitly
sourced manual deposits/withdrawals through the locked inactive writer; exact replay and
funding checks still apply. This is not a balancing-adjustment control and does not change
live cash or holdings. Cash remains `UNVERIFIED`, and the report always returns
`accountingActive: false` and `activationReady: false`, even when replay exactly matches
user-attested evidence.

The same review now lists already-applied Kraken BUY/SELL executions and can stage an execution
using only its persisted import amounts and transaction links. The user must supply an explicit
stable sequence; the endpoint does not accept cash amounts or infer intraday ordering. Duplicate
event identities and transaction identities already linked to another draft operation,
opening-boundary executions, unsupported currencies, missing/mismatched transaction links and
incompatible opening-sale proposals are rejected or shown as ineligible. Transaction identity
remains reserved after reversal, preventing the same live trade from being staged again under a
different source reference.
Imported execution cash now permits audited sequence-only corrections through a dedicated
source-aware endpoint and review control. The account-locked writer revalidates the original
applied Kraken event and complete transaction links; date, consideration, fees, currency and
source identities remain unchanged. Revision replay checks the same invariant, retains exact
reversal/replacement audit legs and rejects occupied slots or a sequence that creates an intraday
funding deficit. Expected revision checks and retry hashes prevent competing edits or duplicate
effects. Original staging retries return the corrected projection. Cash-only reversals and
financial/source edits remain unavailable: those require coordinated trade and cash correction.
This remains inactive draft cash, not broker verification or live posting.

The review now exposes the existing immutable capital-correction engine for manual deposits and
withdrawals. Users can replace a date, stable sequence or amount, or explicitly reverse a mistaken
entry, with an audit reason and review acknowledgement. Currency, kind and source identity are
retained from the original entry. Corrections require the expected revision, preserve retry
identity, reject downstream funding deficits and expose audit reasons in the report. Reversal is
terminal. Corrections do not change attested statement evidence; its current variance is recomputed.
This does not expose trade/import corrections or enable live accounting.

Kraken remains the only supported import integration. Additional exchanges are optional,
demand-driven follow-ups after the accounting foundation, not a prerequisite for cutover. CSV
imports need no separate activation switch; future read-only API connections will require explicit
per-user connection and disconnection controls. Binance and Coinbase enum entries do not imply
implemented adapters.

At this point in delivery, atomic live trade/posting integration and the remaining supported
financial paths were still outstanding. The gated live writer and manual BUY/SELL correction
workflows described below have since landed; the remaining coordinated financial paths and
activation gate are listed at the end of this section.

Recorded manual long BUY/SELL transactions can now be staged from the same review, using only
their transaction identity and an explicitly entered intraday sequence. Money, fees, currency and
date are sourced from the persisted trade and checked again under the account lock. Broker-linked
allocations use the import workflow instead; imported parcels and short positions are excluded.
The report explains unavailable entries, including already-reserved transaction identities.
Concurrent identical submissions have one cash effect; funding/source failures roll back without
changing trades. This closes the missing manual execution-linking workflow. The later implementation notes below
describe the subsequent live posting and manual correction work; those capabilities remain gated
until an account is explicitly provisioned through a reviewed cutover.

Financial correction policy is manual-first: imported execution values remain source records;
future import corrections need separate audited, source-aware adjustments rather than overrides.
As a prerequisite, legacy editors now reject financial edits, instrument/account changes and
deletion of trades already linked to draft cash, including reversed operations. Imported
acquisitions and broker-linked SELL allocations cannot be financially rewritten, moved or deleted
through those editors. Guards run under the same account/parcel locks as staging. Notes and
non-financial metadata remain editable; frontend editors submit only changed financial fields,
so a notes save cannot overwrite an imported timestamp, rounded fee or partial parcel quantity.
Those guards remain in place; the dedicated coordinated manual acquisition and sale workflows
below are the only financial execution corrections currently exposed. Live accounting remains disabled.

Opening-reconciliation manual SELL corrections update the draft sale, recomputed parcel results
and linked draft cash atomically. The review requires exact price/fee strings, effective date, stable sequence,
audit reason, explicit acknowledgement, expected operation head and expected source fingerprint.
Quantity, instrument, parcel, currency and source identity cannot change. Date corrections must
stay after opening, on/after acquisition and within the original observation date. Same-day
corrections preserve the original timestamp. Gross cash uses the existing transaction precision:
quantity times price rounded half-up to 2 decimal places; price supports 12 fractional digits and
fees 8. Unrepresentable values fail before the live write.

The approved opening policy is **audited continuation**. Each immutable cash revision includes
before/after sale snapshots and a numbered before/after source fingerprint link. All reads and
appends validate the chain from the original opening fingerprint and verify its current source
snapshots; the opening statement itself is never rewritten. Other drafts become stale. Statement
evidence stays unchanged and variances are recomputed. Dated funding failures, source/head drift,
occupied slots and audit failures roll back every live and draft change. Retries reuse their
saved audit revision without rewriting the trade, including after later corrections.

Manual acquisition corrections now share that atomic writer and audited continuation. They can
change the purchase date, exact quantity, price and fees while retaining every existing sale.
The corrected quantity must cover all sales; the date must precede their dates, stay after opening
and within the reviewed observation date. Same-day sales require effective draft cash explicitly
ordered after the purchase. Broker-linked sale allocations and imported acquisitions are excluded.
The single-BUY parcel's cost basis, total bought value, fees, capital allocation, remaining quantity,
status and realized results are updated together; stale acquisition-based drawdown/run-up and
unrealized PnL caches are cleared. A quantity correction can close or reopen the parcel without
changing any sale allocation. The UI explicitly warns about cost-basis/tax impacts and protects
offline/stale edits, exact amount strings and retry identity.

Existing live quantities use Float storage. This workflow rejects quantities above the safe integer
limit, with more than 12 fractional digits or whose decimal value changes through a Float round trip;
it does not migrate or replace existing live portfolio calculation arithmetic. New purchase audits
are tagged `kind: BUY`; historical untagged sale audits retain their original canonical hashes.
Both execution kinds share one globally ordered source continuation chain.

The gated live writer now handles manual BUY/SELL commands and complete supported Kraken BUY/SELL
import batches, with exact cash postings, source snapshots, account-scoped manual idempotency and
funding validation. Imported execution sequence is derived from timestamps within each Sydney
date; identical timestamps and any existing cash/trade activity on an affected Sydney date are
blocked. Pre-commit source validation excludes only the locked pending batch being committed;
unrelated source drift remains a conflict. Legacy position creation/close, financial edits,
moves, deletion and account deletion remain blocked for ledger-backed accounts until coordinated
correction workflows exist. Kraken imports to legacy accounts retain their existing behavior.
There is deliberately no account activation or opening-confirmation workflow, and the existing
trade-entry UI still uses the legacy path for legacy accounts.

### Audited corrections for live manual sales

The history editor can append a cash correction for eligible live manual SELLs through
`POST /api/accounts/{id}/trades/{transactionId}/corrections`. The immutable revision records the
reason, expected revision/source head, before/after execution snapshots and exact reversal and
replacement cash legs. Only sale date, stable sequence, price and fees are editable; quantity,
parcel, currency and source identity stay fixed. Imported and broker-linked sales, reversals and
sequence-slot reuse remain unavailable.

The account and parcel are locked while the current source, correction head, opening/observation
date bounds and reserved sequence slots are revalidated. The corrected cash timeline must remain
funded. The transaction, recomputed parcel values, revision postings and accepted source
fingerprint commit atomically. History exposes correction controls only for eligible active
real-account sales, requires an audit reason and disables offline writes. This does not activate
accounts or change behavior for legacy accounts.

### Audited corrections for live manual acquisitions

Eligible manual BUYs now use
`POST /api/accounts/{id}/trades/{transactionId}/acquisition-corrections`. The same live revision
and cash replay machinery supports date, sequence, exact total bought quantity, price and fees.
Instrument, account, currency and purchase identity are fixed. All existing sales are preserved:
the purchase must cover their quantities and precede their dates and same-day cash sequence.
Imported purchases and parcels with broker-linked sales remain excluded.

The purchase, parcel cost basis, remaining quantity, status, realized results, reversal/replacement
cash legs and accepted source fingerprint commit atomically. Quantity corrections can close or
reopen a parcel; acquisition-based drawdown/run-up and unrealized caches are cleared. Original
operations/postings remain unchanged and retries reuse the original audit revision even after
later BUY/SELL corrections. The editor uses exact full purchase values, not prorated remaining
holdings, requires an audit reason and explicit financial/tax-impact acknowledgement, and blocks
offline and stale writes. Controls are available from holdings and closed-trade history so fully
sold parcels remain correctable. No account is activated.

### Audited corrections for live imported executions

Ledger-backed imported Kraken BUY/SELL executions can be corrected through
`POST /api/accounts/{id}/imported-executions/{eventId}/corrections`. The immutable
revision records the original event identity, audit reason, expected revision/source
head, transaction snapshots and exact reversal/replacement cash legs. Date, stable
sequence, price and fees may change; quantity, parcel allocations, currency and source
identity remain fixed. The original `ImportedEvent` is never rewritten.

The correction locks the owned account and affected parcels, revalidates the applied
source event and all linked transactions, checks opening/observation date bounds and
same-day BUY/SELL order, then replays the full cash timeline. Insufficient funding,
changed allocations, unsupported short parcels, multiple currencies, and fees in a
different currency are rejected. Transaction/parcel projections, revision postings,
audit chain and accepted source fingerprint commit atomically. Holdings expose imported
BUY controls, and history exposes imported BUY and SELL controls, including closed
parcels. Inputs require an audit reason; offline and stale submissions are rejected.

### Delivered: terminal audited manual trade voids

Active real ledger-backed accounts can void manual SELLs and unsold manual BUYs via
`POST /api/accounts/{id}/trades/{transactionId}/voids`. A SELL void restores inventory;
a BUY void requires no effective sales and removes its parcel from effective holdings.
Voided acquisitions are not treated as disposals or genuinely closed positions.
Transactions retain their original economic fields; nullable `voidedAt` markers are
validated against an immutable terminal operation revision. Original operations,
postings and corrected snapshots remain intact, with reversal-only revision postings.
Original and corrected date/sequence slots remain reserved.

The owned account/parcel locks serialize voids with participating trade writers.
Revision/source checks and full dated cash replay reject stale requests, inconsistent
audits and downstream funding deficits. Trade markers, parcel recomputation, reversal
postings and the accepted fingerprint commit atomically. Imported allocations and
non-trade parcel adjustments are deliberately unsupported, as are subsequent corrections
or new voids against a terminal trade. Identical prior retries remain safe.

Holdings, close events, current CGT/statistics, import inventory and opening previews
exclude voided economic effects. Previously generated tax PDFs remain immutable and
their source-usage timestamps mark affected reports stale. UI actions require an audit
reason and financial acknowledgement, block offline/privacy/stale submissions, and retain
retry identity. The account-filtered history view exposes paginated retained void audits
via `GET /api/accounts/{id}/trades/voids`, independently of current disposals.

No real or demo account is activated by this milestone.

### Remaining increment 2 steps (implement in this order)

These are planned slices, not currently exposed endpoints. Each step should be a separate
coherent, tested milestone; no step implicitly activates existing accounts.

#### 2A. Supported operation and lifecycle policy

Document the launch matrix for legacy, inactive-draft, active real-ledger and archived
accounts. Keep imported voids, cross-account financial moves, deletion and unsupported
currencies/shorts blocked. Source drift blocks new writes without automatically accepting
changed holdings or history; supported audited corrections/voids are the recovery path for
covered manual changes, while unsupported drift requires reviewed reconciliation before a
future confirmation/recovery workflow. Closure is allowed after effective holdings are closed,
even with residual cash or statement variance. The closed account retains cash/history read-only;
explicit reopening is required before new financial writes and does not reset accounting state.

Exit: no legacy writer can bypass a supported ledger mutation; each unsupported action has
an explicit error and documented recovery path. Demo ledgers remain ineligible for real-ledger
operations; no demo ledger is provisioned.

#### 2B. Live deposits and withdrawals

Reuse exact cash commands, account locks and dated replay for explicit real-ledger funding.
Require owned active ledger state, stable date/sequence, exact amount/currency, source/
reference and retry identity. Deposits/withdrawals are external capital, never P&L or
automatic balancing adjustments. Agree the public request/response and stale-review contract
before adding Swagger/API/hooks. Do not treat inactive draft funding as live funding.

Exit: deposits fund later trades; withdrawals cannot unfund any point in the timeline.
Same retries have one effect; changed retries conflict. Concurrent spends, foreign accounts,
source drift and injected final-write failures leave no partial operation/postings/head.
Provide UI entry and failure feedback without offline queues.

Delivered and verified 8 November 2026: `POST /api/accounts/:id/cash-operations` stores
cash-only audited operations with no synthetic transaction, and the frontend provides an
online-only deposit/withdrawal form. Backend unit/controller tests passed (63 tests), the
localhost cash-ledger integration suite passed (71 tests), and the frontend feature tests
passed (68 tests). Backend/frontend builds and lint passed; backend context, frontend context,
and vendored OpenAPI contract checks are current. The dashboard can show the form before an
account is ledger-enabled; the server remains authoritative and rejects ineligible accounts.
Capability-aware entry is still part of the later routing/readiness work; no accounts were
activated.

#### 2C. Live funding corrections and reversals

Reuse immutable capital revision rules: preserve source/kind/currency, expected revision,
audit reason and original postings; replacement changes only supported date/sequence/amount.
Reversal is terminal. Reserve historical slots, replay the complete dated timeline and
recompute evidence variances without rewriting attestations. Capital revisions take a slot
in the account-wide audit-number chain and bind to the expected audit head and source
fingerprint. Their previous/next source fingerprints are identical: cash-only changes must not
pretend they changed trade or holdings sources.

Exit: corrected/reversed funding that would unfund a purchase is rejected atomically;
old retries remain safe after later revisions. The UI shows current effective capital
separately from original and reversal/replacement audit legs.

Delivered and verified 8 November 2026: `GET /api/accounts/:id/cash-operations` exposes the
current effective funding alongside original records and retained revision postings.
`POST /api/accounts/:id/cash-operations/:operationId/corrections` appends amount/date/sequence
replacements or a terminal reversal. Every correction requires the current operation revision,
account audit number and accepted source fingerprint; stale requests fail closed. Original and
prior replacement date/sequence slots remain reserved, and each replacement or reversal is
accepted only if exact dated replay remains funded. Revisions use the shared audit order while
leaving the accepted trade-source fingerprint unchanged. The frontend displays original versus
effective values, signed reversal/replacement legs and reason; mutations are online-only and
reversal requires explicit acknowledgement. Backend focused unit/controller tests passed
(196 tests), localhost ledger integration tests passed (74 tests), and focused frontend tests
passed (51 tests). Backend/frontend builds and lint passed; generated context and vendored
contract checks pass in both repositories. No accounts were activated.

#### 2D. Live balances, activity and reconciliation

Delivered and verified 8 November 2026: `GET /api/accounts/:id/cash-operations` now returns
the exact replayed balances, paginated effective-dated activity, retained original/current
operation summaries and revision postings/reasons, opening boundary, reviewed as-of date,
source freshness, unsupported/unlinked events, and up to 20 retained user-attested evidence
comparisons. Evidence variance is recomputed against the full effective ledger timeline at its
attested date; decisions and original statements are not rewritten. Unsupported source
operations are explicit, and active stale source history makes the result incomplete. A closed
account remains readable but is clearly marked `NOT_REVALIDATED` and read-only.

The dashboard review shows cached last-successful data offline with a stale warning and never
queues writes. It explicitly distinguishes user attestation from broker verification. Manual and
imported trade replay, sale void, evidence variance, archive, source drift, unlinked trades and
tampered postings are covered by localhost integration cases. Targeted backend unit/controller
tests passed (172), localhost accounting integration tests passed (78), frontend feature/API
tests passed (31), backend/frontend builds and lint passed, and both context builds/checks plus
the vendored contract check passed. The first integration run caught a fixture mutation that did
not alter the source fingerprint; the fixture was corrected to mutate the transaction amount
that feeds the fingerprint, and the complete 78-test suite then passed. No activation occurred.

Exit met for the scoped read surface: balances match one replay of trades, imports, corrections
and voids, without adding gains separately; tampered audits fail visibly. The larger accounting
system remains incomplete by design—attested evidence is not broker verification or proof of
complete performance.

#### 2E. Ordinary manual trade-entry routing — Done

`GET /api/accounts/:id/trade-capability` returns the backend-owned effective-date capability
(`LIVE_LEDGER`, `LEGACY`, `DEMO`, `ARCHIVED` or `BLOCKED`), the opening boundary and the next
available same-day sequence. It validates account ownership, active confirmed-ledger state,
source freshness and unsupported history without activating or provisioning the account.
Ordinary BUY and partial/full SELL forms route through the coordinated writer only for
`LIVE_LEDGER`; legacy/demo flows remain unchanged. Live entry preserves acquisition and close
metadata, enforces the post-opening boundary, and reports funding failures explicitly.
Unknown/unavailable capability, blocked/archived state, and offline live writes fail closed;
live writes are never queued. Existing legacy/demo offline behavior is unchanged; for
non-demo API-backed accounts, offline queueing requires cached capability to explicitly
identify `LEGACY` or `DEMO`.

Exit verified: the empty-account BUY and full SELL integration case preserves metadata and
advances the dated sequence; backend focused tests (49), the localhost accounting integration
suite (79), frontend focused tests (137), both builds, both linters, both context checks and
the frontend contract check pass. No account is activated.

#### 2F. Reviewed confirmation, controlled enablement and release proof

**Cutover policy:** saved draft operations, proposals and revisions are never carried into the
live ledger automatically. A selected opening statement containing any such operation cannot
be confirmed. Existing activity on other inactive statement revisions remains immutable and
inactive; confirmation requires the user to explicitly acknowledge that those drafts are
excluded, not posted or promoted into real holdings. The confirmed statement's immutable
confirmation audit records that choice. No draft is deleted or modified.

Confirmation is per-account and requires an explicit user action. The service revalidates the
selected saved statement under the owned account lock and inside the same transaction that
creates its active ledger. Source fingerprints must still match at the reviewed observation
date; current opening inventory must have no blocking preview issues; dated cash must replay
without a funding gap; the latest user-attested cash evidence must be funded and exactly match
replay; and no post-boundary trades may remain. Users must select an opening boundary after
their existing trade history, because saved activity on the selected draft blocks confirmation.
Unsupported import, income, short, currency or audit states block confirmation rather than being
inferred or discarded. Evidence remains user-attested, not broker-verified. Unknown opening
valuations do not block cash/trade accounting, but confirmation explicitly acknowledges that
performance returns remain unavailable until sourced valuations exist.

Under the owned account lock, revalidate the reviewed Sydney end-of-day opening inventory,
cash, statement version and accepted source; record the actor, acknowledgements, cash evidence
identity and excluded draft activity; then atomically confirm the statement and create its
active ledger. Activity on other inactive drafts is shown with statement/version/count and stays
retained but excluded; it is never promoted or posted. Retries with the original idempotency key
and payload return the same confirmation; conflicting keys/payloads cannot create another
ledger. Unit and disposable-localhost tests cover stale source, selected-draft activity,
idempotency, competing confirmation, account close and user-deletion races. The only activation
path is this explicit authenticated action; saving/reviewing a draft, capability lookup and
ordinary trade entry do not activate accounts.

Exit: one eligible account can be enabled deliberately, never in bulk; rejected/stale/failed
confirmation has no partial effects. Unknown valuations keep returns unavailable even if
cash/trade tracking can be enabled. The feature is implemented and tested on disposable
localhost fixtures only; no real account has been activated.

### Handoff and commit discipline

For each step, update this checklist, the relevant ADR/README/glossary, Swagger and tests in
the same change set. Record unresolved decisions rather than marking a partially wired step
delivered. Keep architectural rationale in the ADR and operational delivery status here.

Validate targeted tests first; database tests must use disposable localhost fixtures:

```bash
yarn test --run
yarn build
yarn lint
RUN_ACCOUNTING_DB_TESTS=1 yarn vitest run src/lib/draft-cash-ledger.integration.test.ts
yarn context:build
yarn context:check
```

Commit the tested backend milestone, including migrations and generated context, first.
Then in `piggy-fe` run `yarn contract:pull` against that committed backend, update manual types,
run tests/build/lint, run `yarn context:build`, `yarn contract:check` and `yarn context:check`,
and commit the corresponding frontend milestone. Do not wait for all foundation increments
to finish. Deploy additive backend migrations through the existing pipeline before dependent
frontend code; this is not permission to provision real ledgers manually.

After these gates, deliver income/transfers/adjustments, sourced valuations, cash-flow-adjusted
returns and risk metrics, then broader ingestion and tax readiness as described in increments
3–6. Ledger-backed demo accounts remain a separate proving-ground decision, not a shortcut to
real-account activation.

The 8 November 2026 2D context build, frontend contract pull, and both repositories' context and
contract freshness checks passed. The frontend contract metadata still names backend HEAD
`6d2566b28103` because the backend milestone is uncommitted; after committing backend 2D, pull the
contract again and regenerate frontend context so the recorded source commit matches that backend
commit. Worktrees remain uncommitted; do not activate accounts.

Ledger-backed demo accounts are a subsequent controlled proving ground, not enabled by this
increment. They should share the accounting engine and audit/funding rules with real accounts,
but start from explicit virtual cash rather than broker-statement evidence. Existing demos must
not be silently migrated or reinterpreted, and must remain excluded from real aggregates and tax.

## Existing implementation references

- [Parcel model and transactions](../prisma/schema.prisma)
- [Parcel service](../src/lib/position-service.ts)
- [Current synthetic equity calculation](../src/lib/portfolio-calc.ts)
- [Current statistics methodology](../src/lib/statistics-engine.ts)
- [Historical AUD FX](../src/lib/fx-rates.ts)
- [Kraken import pipeline](../src/lib/imports/service.ts)
- [Parcel invariant](./adr/0001-one-buy-per-position.md)
- [Report revisions](./adr/0010-append-only-tax-report-revisions.md)
- [Crypto exchange currency boundaries](./adr/0014-crypto-venues-split-by-quote-currency.md)
- [Deferred crypto transfers and staking income](./adr/0015-crypto-staking-parcels.md)
- [Frontend dashboard](../../piggy-fe/src/components/DashboardView.tsx)
- [Frontend snapshot workflow](../../piggy-fe/src/hooks/useExchangeDiscovery.ts)
