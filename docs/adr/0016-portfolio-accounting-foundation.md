# 0016. Confirmed opening statements and source-linked portfolio accounting

- **Status**: Proposed; product scope confirmed, schema awaits review
- **Date**: 2026-10-31
- **Implementation**: executable reference specification, read-only opening preview and
  persistent inactive drafts with locked cash-operation staging; no live cash posting or confirmation

## Context

Positions represent purchase parcels, not complete brokerage accounts. Existing snapshots
combine invested capital and gains without a cash ledger. Income, capital flows and historical
adjustments are not fully represented. These values cannot be silently rebranded as complete
portfolio value or cash-flow-adjusted return.

We will preserve existing parcels, trading tools and tax-report revisions. The first supported
accounting scope is long-only shares/ETFs and existing crypto purchases/disposals. Margin,
shorts, crypto transfers and staking income require later policies.

See the [delivery plan](../portfolio-foundation-plan.md) and
[executable reference cases](../../src/lib/portfolio-accounting-contract.test.ts).

## Decisions

### Opening boundary and account readiness

Each account begins in `LEGACY`. Users confirm an end-of-day opening statement for calendar
date D in `Australia/Sydney`. Accounting begins immediately after that day's boundary.
Date-only operations on D are included in opening inventory/cash and do not post again.
Timestamped operations use the Sydney calendar date for this cutover decision, preserving
their original timestamps for execution ordering.

The opening statement lists existing parcel IDs and remaining quantities as of D and actual
cash by currency. It does not create BUYs or derive cash from historical trade gains.
Market value at D establishes period performance; original parcel costs establish trade P&L
and CGT. Unknown opening prices/FX prevent returns, not access to holdings.

`CONFIRMED` requires reconciled opening inventory, recorded cash and no unsupported operations
in the enabled scope. `RECONCILIATION_REQUIRED` preserves access but prevents new spending
until affected balances are resolved. An account with unsupported margin/short history or
incomplete crypto activity cannot be presented as fully accounted.

Pre-boundary edits/imports affecting opening inventory invalidate confirmation. Post-boundary
corrections invalidate valuations from their effective date. A new confirmed statement is a
revision, not replacement of history; pre-existing performance segments remain identifiable.

### Cash postings and transaction identity

Cash currency belongs to the payment/receipt, not the reporting currency or a UI exchange tab.
Support multiple currency balances within the existing TradingAccount; do not require users
to create a new exchange or account for every currency.

Use existing BUY/SELL Transactions as trade truth. Accounting postings are derived, immutable
records linked to the source operation. They are not an independently editable trade ledger.

| Operation            | Cash effect                               | External performance flow                      |
| -------------------- | ----------------------------------------- | ---------------------------------------------- |
| Opening statement    | Establish currency balances               | Starting capital, not gain                     |
| BUY                  | Minus gross consideration and cash fees   | None                                           |
| SELL                 | Plus gross proceeds minus cash fees       | None                                           |
| Deposit              | Plus cash                                 | Positive contribution                          |
| Withdrawal           | Minus cash                                | Negative contribution                          |
| Income               | Plus gross receipt minus withholding      | None                                           |
| Transfer             | Linked debit/credit principal; debit fee  | Principal classified by selected account scope |
| FX conversion        | Explicit debit/credit currency legs; fees | None inside the same account                   |
| Reversal/replacement | Exact inverse plus corrected operation    | Recompute using original effective dates       |

One execution allocated across multiple parcels posts cash exactly once. Existing imported
SELL allocations retain their transaction links; their shared execution identity groups the
cash effect. Fee-currency differences must be explicit legs, not assumed local-currency fees.
Same-asset crypto fees affecting units require inventory handling and must be rejected or
flagged until the supported adapter can account for them.

Commands require an account-scoped idempotency key and normalized payload hash. Same key,
same payload returns the original result; same key, different payload returns a conflict.
All linked trades, postings and source links commit or roll back together.

Corrections retain source revisions and reversal/replacement links. Metadata-only edits need
not repost cash. Financial edits and deletions in confirmed accounts use correction commands,
never direct posted-row mutation. Historical economic effects are replaced on their original
effective dates; correction time remains separately recorded.

### Funding, ordering and ownership

Do not create implicit deposits or convert currencies automatically. A BUY requires recorded
cash in its payment currency including fees. Net-negative SELL receipts also require funding.

Replay the effective-dated timeline when accepting backdated changes; a non-negative current
balance is insufficient. Date-only operations use a persisted stable sequence within a day.
Do not reorder historical operations by amount/type to manufacture funding. Missing funding
or insufficient intraday ordering evidence produces a reconciliation issue.

Serialize writers by locking the affected account rows inside a database transaction; lock
multiple accounts in stable ID order. Revalidate dated balances after the lock. Database unique
source/idempotency constraints complement locks. Tests must demonstrate concurrent spending
cannot overdraw balances. Test-only arithmetic does not establish those guarantees.

Ownership/authentication checks cover every account, parcel, source and transfer endpoint.
Only supported active accounts accept new spending; closed accounts retain balances and
history, and cannot close with undisposed holdings or unexplained residual cash. Existing
deletion guards, demo exclusions and soft-delete/purge rules continue to apply.

### Decimal precision and reporting

Commands accept validated decimal strings, not binary floating-point money. Proposed storage:
`Decimal(38,12)` for cash, quantities, prices and rates, bounded before writing; intermediate
arithmetic uses at least 40 significant digits. Fiat display rounds half-up to currency minor
units; storage does not prematurely round tiny crypto consideration to cents. Cash postings
represent actual broker receipts/payments when available. Derived rounding residuals are
explicit, never silent balancing deposits.

Existing Float quantities are preserved during expand-only rollout. Converting their known
values does not restore precision lost in source history. Precision discrepancies are reviewed
before confirmation. Existing tax output rounding is unchanged.

Valuations retain price/FX sources, source dates, reporting currency, completeness and
methodology version. No missing data defaults to zero or last-known data without disclosure.
Use unadjusted prices with explicit split/unit adjustments, or a separately verified consistent
alternative; never combine adjusted prices with duplicated corporate actions.

### Exact metric contracts

- **Account value V(t)**: sum of cash and remaining units times dated market prices, each
  converted at dated reporting FX. Realised gains are not added again to cash.
- **Net external contribution F**: deposits minus withdrawals plus transfer principal across
  the selected scope boundary, translated at flow-date FX. Transfers whose endpoints are both
  selected cancel; transfer/conversion fees are costs, not external withdrawals.
- **Period investment gain**: `V(end) - V(start) - F`. Requires complete records/valuations
  throughout the interval, not just endpoints.
- **Trade realised P&L**: net proceeds minus original parcel cost of disposed units and
  prorated acquisition fees. It differs from gain since an opening confirmation date.
- **Income**: show gross, withheld and actual net receipts separately. Non-cash franking
  credits remain tax information and never increase cash/account value. Distribution tax
  classifications and cost-base adjustments require supported, documented treatment.
- **TWR**: for every external-flow boundary, value immediately before and after the flow;
  multiply `V(end-before-flow) / V(start-after-flow)` for each interval, then subtract one.
  A zero ending value can mean -100%; zero/negative starting value makes the interval
  unavailable. Daily flow-timing approximations must be named as such, not called exact TWR.
- **XIRR**: investor-perspective dated flows: opening value negative, contributions negative,
  withdrawals positive, terminal value positive. Solve
  `sum(C_i / (1+r)^((date_i-date_0)/365)) = 0`, ACT/365, `r > -1`.
  No sign change, ambiguous solutions, unsupported dates or non-convergence produce an
  explicit unavailable reason. Reference case: 1,000 to 1,100 over exactly 365 days = 10%.
  A production solver and multi-root policy belong to increment 5.
- **Annualisation/risk**: keep cumulative and annualised figures separate. Do not annualise
  incomplete or non-positive wealth intervals. Volatility/Sharpe require a specified sampling
  calendar and risk-free-rate assumption and cash-flow-adjusted returns, not raw account value.

Output amounts are decimal strings; return ratios use fractions (`0.21` = 21%). Future metric
responses use a discriminated available/unavailable shape with methodology and period:
available includes value, currency where relevant and provenance; unavailable includes an
explicit reason and affected source/period. Final route schemas are deferred to increment 2.

## Concrete schema proposal for review (not a migration)

Names below describe proposed records; implementation can consolidate fields where appropriate.

| Record                           | Proposed responsibilities and constraints                                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| TradingAccount additions         | Accounting state, confirmed opening revision pointer; existing ownership/status retained                                                         |
| AccountOpeningStatement          | Account, end-of-day date, timezone, version, confirmation time, supersedes link, source/provenance; unique account/version                       |
| OpeningParcelBalance             | Statement, existing Position FK, quantity at boundary; unique statement/position; no new BUY                                                     |
| OpeningCashBalance               | Statement, ISO currency, amount; unique statement/currency                                                                                       |
| AccountingOperation              | Account-scoped command key/hash, kind, effective time/date/sequence, recorded time, origin/import identity, correction links; unique account/key |
| OperationTradeLink               | Operation to existing Transaction; source grouping supports multiple parcel allocations and no duplicate execution cash                          |
| CashPosting                      | Operation, account, currency, signed amount, role, leg sequence; unique operation/leg; reversals linked to original postings                     |
| IncomeReceipt (increment 3)      | Account/asset, entitlement/payment dates, gross/withheld/net currency amounts, tax components and supporting provenance                          |
| PortfolioValuation (increment 4) | Account/date/currency/revision, opening revision, methodology, cash/holdings totals, completeness and source metadata                            |

Opening confirmations and operations use account locks and revision checks. Currency balance
projections are derived from opening cash plus effective postings; any materialized cache is
rebuildable, never the only source of truth. Cross-account transfer legs share a command identity
and atomic commit. Final foreign-key/deletion actions must integrate with user purge and account
report guards; immutable accounting is not an exemption from data-erasure requirements.

Do not extend the existing parcel Transaction enum with deposits/withdrawals: those do not
belong to a Position. Existing DIVIDEND/SPLIT enum names alone are not supported workflows.

## Read-only reconciliation preview and rollout

Increment 2 begins with a no-write preview containing:

- Account/opening boundary, source revision/fingerprint and proposed confirmation state.
- Each parcel's original BUY, disposals through D, expected remaining quantity and discrepancies
  versus recorded inventory. Post-D operations must be replayed, not subtracted twice.
- User-supplied cash by currency, proposed linked postings after D and dated funding shortfalls.
- Duplicate import/manual identities, unsupported operations, precision differences and affected
  price/FX gaps. Do not infer a missing operation's economic meaning.
- Blocking issues, warnings, earliest trustworthy metric date and proposed record counts.

Confirmation rechecks the preview fingerprint under lock and refuses stale previews. Dry-run
has no financial writes, confirmation or automatic reconciliation; no current user balances
are invented from the synthetic reference examples.

Deploy additive schema first, backfill only unambiguous links, then enable per account after
confirmation. Rehearse migrations/restore on a non-production database. Production migrations
run only through the existing deployment pipeline.

Legacy views stay labelled and accessible. Disabling new accounting pauses writes for confirmed
accounts rather than falling back to divergent legacy writes. Preserve postings, opening
revisions and old CGT PDFs. New backend routes/shape changes require Swagger, frontend manual
type updates, contract pull and regenerated context in both repositories.

## Verification and limitations

The reference tests exercise arithmetic and expected classifications for cash, fees, partial
sales, income, DRP, transfers, FX, splits, gain and TWR plus an XIRR equation reference.
They are an oracle for later engine tests, not proof of implemented accounting features.

The first increment-2 slice adds authenticated `POST /api/accounts/{id}/opening-preview`
and a dashboard dialog. Reads use a repeatable-read snapshot with ownership filtering.
The preview reconstructs opening inventory and replays trade-only cash in parcel currencies.
It flags inventory mismatches, missing currency balances, dated funding gaps, unsupported
records and unresolved imports. Cash values are projections, not verified balances.

Same-day funding uses a conservative debit-first estimate and raises an ordering blocker;
it does not invent or persist a sequence. Imported allocation currencies may differ from
actual execution currency, so imported parcels raise an explicit reconciliation blocker.
The response always says `PREVIEW_ONLY`, warns about missing cash/income/FX history, and
provides no confirmation token or trustworthy performance starting date. Prices, valuation,
duplicate manual/import identity reconciliation and confirmation are later slices.

`POST /api/accounts/{id}/opening-statements` saves a reviewed preview as an immutable `DRAFT`.
It stores exact `Decimal(38,12)` opening cash and parcel quantities plus the original preview
snapshot, input hash and source fingerprint. Negative or over-precision opening inventory
cannot be saved. Reconciliation blockers can be retained in a draft without implying approval.
No BUY, deposit, snapshot valuation or cash posting is created.

Fresh saves compare the fingerprint inside a serializable transaction; stale inputs/sources
return 409. Unique account/fingerprint and account/version constraints, with bounded retries
of database concurrency conflicts, prevent duplicate saves and competing revision numbers.
A retry with the same normalized inputs and saved fingerprint returns that historical draft,
even on a later day; it is not a statement that the old preview is still current.

`GET /api/accounts/{id}/opening-statements` lists 20 newest-first revision summaries using an
exclusive version cursor. The UI loads a draft as inputs and requires another live preview
before a new save; differences in source/inputs/day show a warning. State stays `DRAFT` and
no accounting activation endpoint exists. Closed accounts retain read access. Account and
user deletion cascade drafts and their children; parcel IDs are retained as snapshot references
without a foreign key so legacy edits/deletes cannot erase draft inventory history.

This slice deliberately stores cash/inventory as inactive statement children, not a partial
cash ledger. Production migrations use the deployment pipeline; the additive migration was
rehearsed locally and database-backed tests use a disposable localhost user/account fixture.
Run `RUN_ACCOUNTING_DB_TESTS=1 yarn test --run src/lib/opening-statements.integration.test.ts`
to verify persistence, decimal precision, retry deduplication, concurrent revisions and cascade
cleanup. The test refuses non-local database URLs.

The next slice implements a production pure cash-command/replay core in `src/lib/cash-ledger.ts`.
It derives BUY/SELL consideration and explicitly currency-denominated cash fees, and separate
DEPOSIT/WITHDRAWAL external-capital legs. Each BUY/manual disposal has one parcel transaction;
an imported SELL execution can link multiple allocations but posts its gross/fees only once.
Cash totals must be actual execution totals supplied by a verified adapter, not inferred from
parcel reporting currency or rounded legacy quantities. Unsupported income, FX, asset-unit fees
and unknown financial fields are rejected.

Commands normalize decimal formatting, fee and allocation ordering, and retain account, source,
effective date and stable positive intraday sequence. Their hash includes `cash-ledger-v1`.
The retry helper distinguishes identical normalized payloads from conflicting account/key/content;
it does not replace database constraints or authorize any account/source/transaction link.

Replay requires explicit opening currency balances (including zero) and only post-boundary
operations. It checks duplicate keys, execution references, parcel links and intraday slots,
then replays date/sequence order without debit/deposit sorting. Each execution's cash legs
are atomic for funding purposes; a SELL can fund its same-currency fees, but net-negative
receipts and foreign-currency fees require existing cash. Ending cash, dated negative balances,
minimum cash and external contribution are decimal-string outputs.
`requireFundedCashLedger` refuses any timeline deficit even if a later deposit restores cash.
Cash overflow is a blocking error, never rounding. Shared arithmetic has 50-digit intermediate
precision and `Decimal(38,12)` storage bounds; global Decimal settings are unchanged.
Replay is bounded at 50,000 operations, 50,000 transaction links and 100,000 posting legs,
rejecting excess input rather than returning partial balances.

The next persistence slice adds `DraftCashOperation`, `DraftCashPosting` and
`DraftOperationTradeLink` beneath each opening statement. All state remains `DRAFT`.
Idempotency keys, source identities, effective-date sequences and transaction links are unique
within an opening revision, not globally across alternative draft scenarios. Composite foreign
keys prevent a trade link crossing draft boundaries. Account/user deletion cascades the entire
history; transaction references are snapshots, deliberately not live foreign keys.

`saveDraftCashOperation` is an internal staging service, not an HTTP endpoint or financial
write path. It ownership-filters active real accounts (and excludes soft-deleted users), locks
the account with parameterized `SELECT ... FOR UPDATE`, then rereads the opening statement and
current draft history at `READ COMMITTED`. Commands, cash legs and trade references commit
together. History is replayed under that lock; competing withdrawals cannot overdraw one draft.
Stored normalized hashes, metadata, posting legs and source links are cross-checked before reuse
or append; corruption is surfaced rather than returning a plausible cash balance.

New appends recheck the opening source fingerprint using its original preview date, so midnight
alone does not invalidate draft source identity. Existing legacy source changes require a fresh
opening revision. Identical retries return the original inactive operation and replay its retained
draft history without implying that source records are current. Manual BUY/SELL staging requires
owned, long, manual transaction links matching the stored date, exchange currency, gross and fees.
Legacy records do not verify foreign fee currency or imported execution totals, so both are
rejected at this persistence boundary pending verified adapters.

Run `RUN_ACCOUNTING_DB_TESTS=1 yarn test --run src/lib/draft-cash-ledger.integration.test.ts`
for isolated localhost tests of locks, competing withdrawals, tiny decimals, idempotency,
backdated funding, nested-write rollback, source invalidation and user/account cascade erasure.
The related opening-save retry handler also recognizes verified PostgreSQL adapter `40001`
serialization failures at COMMIT as well as Prisma `P2034`; retries remain bounded.

The next manual-writer slice extracts transactional full/partial close, close-event correction
and parcel deletion to `src/lib/position-mutations.ts`. These routes and inactive cash staging
share `lockOwnedTradingAccount`. Disposal mutations discover the owned parcel, lock its account,
then lock and recheck the parcel's account identity; a concurrent account move returns 409.
Remaining units are reread after locking, and SELL creation/correction plus parcel recomputation
commit in one transaction. Responses and history-provider calls occur after transaction commit.
Legacy arithmetic, dates, fee allocation, parcel identifiers and response shapes are retained.
There are still no live cash legs or implicit deposits created by a close.

Database tests demonstrate competing partial/full closes cannot dispose the same remaining
units twice, forced recompute failures roll back sales and corrections, and deletion leaves no
orphan transaction. Deleted parcel IDs remain in inactive opening snapshots; a financial source
change prevents new cash staging on that old opening revision rather than overwriting its history.
Run `RUN_ACCOUNTING_DB_TESTS=1 yarn test --run src/lib/position-mutations.integration.test.ts`
against localhost to reproduce these cases using disposable fixture records.

The acquisition slice wraps account resolution and nested parcel/BUY creation in one account-locked
transaction. Asset/catalogue lookup stays outside that transaction; a failed parcel write cannot
leave a newly resolved account or partial BUY, though an independently created shared asset may
remain. Acquisition edits reread the parcel's BUY and sold units after locking and commit BUY,
parcel fields and disposal recomputation together. Financial edits require exactly one BUY;
missing or multiple acquisitions return 409 rather than altering only the parcel.
Reducing bought units below sold units returns 400. Changed cost and acquisition fees recompute
realised P&L, remaining inventory and OPEN/PARTIAL/CLOSED status; legacy Float quantities and
monetary rounding are retained until a separate decimal migration.

Moves lock both owned accounts in lexical ID order before the parcel, recheck its account
identity after locking and verify the current demo/real boundary. Asset/catalogue resolution and
metadata preparation remain outside the financial transaction. Account moves are legacy parcel
relocations, not ledger transfers. Tests cover reverse-direction moves, edit/sale races and
forced acquisition recompute failure with complete rollback.

The import slice now shares that account lock for commit, upload/reattachment, review resolution
and discard writes. Market-data preparation and shared asset lookup stay outside locks.
Before writing trades, commit reloads batch/events and eligible holdings at READ COMMITTED and
compares a deterministic source snapshot with its prepared plan. Changed holdings, allocations,
event statuses or batch metadata return 409 and require a refreshed review; the committer never
silently applies a newly selected allocation. Events and parcels have stable ID tie-breakers for
snapshot ordering. This protects the server-prepared plan during the request, not an earlier
browser preview; a user-approved preview token is not implemented.

The locked commit rechecks ownership and active/non-demo eligibility, then writes nested
parcel/BUY records, allocated SELLs, recomputed parcel results and event links in one transaction.
A failed/missing recomputation aborts everything. An already-applied retry creates no additional
trades. Concurrent stale requests get 409 rather than masquerading as a successful retry.
Review/discard remain possible on owned closed accounts; reviewing discarded or processed
events fails. Review updates merge against current locked resolutions, preventing lost fields.
Deferred reward reattachment only resets still-DEFERRED events from the same account;
a concurrent processing/reattachment change aborts the upload instead of resetting applied history.
Frontend commit failures refresh import queries for explicit review and are never automatically
retried; existing error messages remain visible. No import response payload shape changes.

Run `RUN_ACCOUNTING_DB_TESTS=1 yarn test --run src/lib/imports/service.integration.test.ts`
for disposable localhost cases covering competing same/different batches, manual sale/edit/move/
delete races, review/discard changes, full rollback and merged review resolutions.
These tests stub market-data providers and asset lookup, never post fabricated live-user trades.

This proves participating trade-writer atomicity and draft-staging funding safety only.
Trading-account lifecycle now uses account-locked READ COMMITTED transactions for close,
explicit reopen, rename and delete. Closing checks current OPEN/PARTIAL inventory even on
an already-closed legacy account. Real-account deletion rereads position and tax-report retention
guards under lock; demo deletion preserves its existing full cascade policy. Inactive statements,
draft operations and import batches cascade with account deletion, never becoming live cash.

The user-selected archival policy requires reopening before adding open holdings. Manual BUY
creation rereads account status after locking; acquisition edits/moves that leave open holdings
in a closed account fail with 409 and roll back BUY/parcel/recomputation changes. Historical
cost/metadata corrections and movements of fully closed parcels remain permitted. Missing explicit
account IDs now return 404 instead of falling back to Main; absent IDs still use name/Main.
Creation with an existing closed account name remains an explicit reopen flow and uses the lock.

Tax-report revision creation locks the selected account IDs in lexical order and rechecks
ownership/non-demo eligibility before persisting opaque account references. This coordinates with
real-account deletion's retention check despite the absence of an account FK. Concurrent account
deletion returns 404; eligibility or current-revision changes return 409 rather than superseding
a stale revision. Existing unchanged-report retrieval remains read-only; financial computation
and PDF preparation remain outside locks, so this is not proof of report-source freshness.

The scheduled user purge now makes its delete conditional on current deletedAt/purgeAfter,
rather than deleting solely from an earlier scan. A restored or already-purged user is skipped
and not reported as erased. The unit tests exercise this race without running a production purge.
Run `RUN_ACCOUNTING_DB_TESTS=1 yarn test --run src/controllers/trading-account-lifecycle.integration.test.ts`
for disposable localhost close/purchase, destination-move, deletion/disposal, archival rollback
and account-deletion/report-generation cases.

The user-lifecycle slice introduces a shared active-user row barrier before account locks.
Participating trade/import/lifecycle writes hold `FOR SHARE` on the user; soft deletion,
restoration and profile/password updates take that row exclusively. User deletion waits for
earlier participating writes to finish, rechecks its verified password, then commits deletion
state and session/reset-token revocation together. Writers waiting behind deletion return 401
after their locked recheck, even if HTTP authentication passed earlier. Shared barriers allow
independent accounts to write concurrently; the account/parcel lock order remains unchanged.
Acquisition account resolution takes the barrier before creating account/parcel foreign keys,
avoiding a child-first lock order against user purge.

Restoration rechecks the authenticated password and exact deletion timestamp under an exclusive
user lock. Clearing deletion and creating the replacement session commit together; failed token
persistence leaves the user deleted. Login session persistence and refresh rotation share the
active-user barrier, so they cannot recreate sessions after deletion revokes them. Refresh replaces
exactly one still-owned/unexpired token atomically; competing refreshes cannot both succeed,
and a failed replacement rolls back revocation. Existing login/deletion/restore response shapes
remain unchanged. Purge's conditional user delete takes the exclusive user row before cascading
children and rechecks the predicate after a competing restore.

New trading-account creation and acquisition destination resolution also take the user barrier.
Opening draft saves take it inside their existing SERIALIZABLE transaction. Legacy daily snapshot
writes now read holdings and upsert in an account-locked transaction behind the user barrier;
the old arithmetic and date semantics are deliberately retained, not promoted to total-return
valuations. Live-price metadata edits already use the locked acquisition writer.

Run `RUN_ACCOUNTING_DB_TESTS=1 yarn test --run src/lib/user-lifecycle.integration.test.ts`
for disposable localhost cases covering delayed disposal/deletion, late purchases, concurrent
independent accounts, restoration/session rollback, competing refreshes and fixture-only purge.
No production purge or real-user fixture writes are performed.

Password-reset issuance and completion take the exclusive user barrier. Token replacement
and completion are transactional; completion checks active state and consumes exactly one
owned token whose expiry is strictly in the future. Password replacement and revocation of
all reset/refresh tokens commit together. Competing resets succeed at most once and reset
cannot restore a deleted user. Credential hashing and reset email delivery stay outside locks.
Missing/deleted users retain the generic forgot-password response; stale completion returns 400.

Manual and import history backfills now save under user/account/parcel locks using conditional
updates matching their original account, asset, entry price, open date, status and close date.
They also compare the prior value of each metric being written, protecting newer live peaks
and manual changes while allowing independent drawdown/run-up backfills to both save.
Explicit recalculation uses the same writer and returns 409 when those inputs changed.
Stop-hit persistence similarly matches holding status/type and the original stop price,
set timestamp and hit state. A stale scan cannot overwrite an edited stop or record a late hit
after closing/deletion. Provider work stays outside transactions; best-effort backfills log
failures without changing trade/import responses. Frontend conflict handling refreshes position
queries and does not auto-retry these mutations.

Shared asset/exchange metadata, FX caches, unrelated watchlist/screener mutations and signup's
initial session creation are not covered by this financial-writer barrier. Quote freshness and
reproducible tax-report source snapshots remain separate work. This is not an all-writer guarantee.

The cash-correction slice reuses each immutable `DraftCashOperation.id` as the durable
execution identity within its opening revision, rather than creating another editable trade
ledger. An operation's original command/postings, source and parcel links are never updated by
correction. `DraftCashRevision` appends a numbered chain with the expected prior revision ID,
idempotency key, normalized request hash and required audit reason. Its child postings retain
separate exact `REVERSAL` and `REPLACEMENT` legs, including external-capital classification.
Composite foreign keys keep each revision and predecessor inside the same operation/statement;
user/account erasure cascades the draft audit tree.

The approved correction policy restates historical economic activity, not fictitious cash
movement on the recording date. Replay applies only the latest economic command per operation;
reversal-only removes it. A replacement explicitly supplies its corrected effective date and
stable intraday sequence (normally unchanged); recording time is separate. It cannot cross the
opening boundary, collide with another effective slot or move funding after a dependent spend.
Original plus correction records remain available for audit, but are not summed again as extra
economic operations or external contributions. A reversal is terminal. Source/transaction
identities remain reserved even after reversal; a new key cannot post that execution twice.

Internal capital correction takes the account/user lock, checks the expected head, validates
all stored commands/audit postings and replays the entire dated cash history before appending.
Identical retries return the recorded revision, including after later corrections, without
claiming source freshness. Changed key content or competing head edits return 409; historical
funding deficits return 422 even if today's ending balance would be positive. The total audit
is bounded to 50,000 operations plus revisions, 50,000 trade links and 100,000 posting legs.
Ordinary staging and original retries now replay corrected history as well.

Persistence currently permits only inactive deposit/withdrawal corrections. The pure correction
contract can reverse/replace BUY/SELL consideration and fees exactly once across parcel links,
but persisted trade corrections are explicitly rejected until parcel and cash changes share
one transaction. Replacement retains account, operation kind, source and transaction identities;
cross-account moves/reallocation need a dedicated coordinated command. No cash correction
endpoint, activation, live balance or user-facing funding workflow is enabled in this slice.

No legacy writer spends draft cash or maintains its
postings. There is no activation or deposit UI, and drafts must never be counted as spendable cash
or portfolio value. Next connect atomic trade/posting corrections and
verified execution-currency import adapters before confirmation. Existing preview
ordering stays deliberately unverified; it cannot be promoted into stable ledger order automatically.

Live trade/posting atomicity, live command idempotency, concurrent live funding, persisted opening confirmations,
cutover invalidation, production XIRR, corporate-action tax treatment and scheduling
remain unimplemented. Each needs targeted tests in its delivery increment.

## Consequences

Accurate performance begins at a known boundary rather than a fabricated inception history.
Users must supply real funding and resolve gaps. Existing tools remain usable while new
accounting is enabled gradually. Integration breadth and complex tax treatment follow only
after the supported ledger reconciles.
