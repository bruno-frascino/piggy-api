# 0016. Confirmed opening statements and source-linked portfolio accounting

- **Status**: Proposed overall architecture; implemented slices include gated manual/supported
  Kraken posting, audited manual/imported execution corrections, terminal manual trade voids,
  live funding revisions, capability-aware ordinary BUY/SELL routing and explicit reviewed
  per-account confirmation. Statement-supported manual equity/ETF income receipts now have
  audited replacement and terminal reversal; AMIT, holdings transfers, imported voids, financial
  moves/deletion and unsupported currencies remain blocked. Paired same-currency cash-transfer
  posting/history and fixed-identity paired corrections/terminal reversals are implemented;
  manual same-account FX posting/history and audited fixed-identity corrections/terminal
  reversals are implemented. The delivery plan owns remaining-step
  status.
- **Date**: 2026-10-31
- **Last reviewed**: 2026-11-17
- **Implementation**: executable reference specification, read-only opening preview, persistent
  inactive drafts, a gated atomic trade/cash writer, audited manual/imported BUY/SELL
  corrections, manual voids with retained audit access, capability-aware ordinary trade-entry
  routing, user-triggered per-account confirmation, and statement-based manual income posting
  with immutable correction/reversal revisions. Confirmation atomically marks the latest eligible
  opening statement confirmed and creates its active ledger; no account is provisioned or
  activated implicitly or by the implementation process.

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
The plan's [step status register](../portfolio-foundation-plan.md#step-status-register)
is the canonical implementation handoff: update status, prerequisites, remaining work and
verification evidence with each milestone. Read it before resuming to avoid repeating
delivered work or skipping unfinished gates. This ADR records policy, not a separate task queue.

## Decisions

These sections describe the target accounting contract unless an implementation section
explicitly states otherwise. `LEGACY`, `CONFIRMED` and `RECONCILIATION_REQUIRED` below are
product readiness concepts, not a claim that all are persisted account states or exposed
in a provisioning API. Existing draft funding remains inactive; live deposit/withdrawal
posting, audited funding corrections/reversals, live review and ordinary trade-entry routing
and controlled confirmation are implemented. See delivery steps 2A-2F in the
[plan](../portfolio-foundation-plan.md#remaining-increment-2-steps-implement-in-this-order)
and current income scope 3A in its status register.
Implementation notes record successive milestones; older statements about unavailable
capital corrections/reversals and trade-entry routing are historical. The final
delivery-boundary section and current plan take precedence when determining what is now
implemented.

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

The first transfer slice is same-currency cash only between two owned active real ledgers.
It uses existing immutable cash operations: a shared normalized request/hash and command key
link `TRANSFER_OUT` and `TRANSFER_IN`, with both endpoint IDs retained. Posting is atomic under
sorted account locks; each endpoint has its own stable intraday sequence on the same effective
date, after both opening boundaries. Both currencies must have explicit opening balances.
Only the sender pays the explicit fee, in that currency. Transfer principal alone affects
account-level external capital and cancels across a scope containing both endpoints; the fee
is a cost. Replay verifies the counterpart's ownership, request, economics and stored postings
without requiring that a subsequently archived counterpart be reopened to read retained history.
There is no transfer of positions, automatic FX or account activation. Direct edits/deletion
and one-sided revisions are blocked. Paired corrections preserve both account IDs, currency
and source reference; principal, sender-paid fee, shared effective date and both sequences may
change. Both reviewed audit heads and fresh active ledgers are required under sorted account
locks. Immutable paired revision chains retain original/replacement postings and reserve all
historical date/sequence slots. Both effective-dated timelines must remain funded. Reversal is
terminal and removes the original economic effect including its fee, not a new return transfer.
Identical retained requests can be retried after later activity; altered payloads or stale heads
fail closed. Sender-side online review manages both histories; do not simulate corrections with
unrelated deposits/withdrawals. Settlement across different dates/in-transit
balances and recipient/third-currency fees remain unsupported.

Do not create implicit deposits or convert currencies automatically. A BUY requires recorded
cash in its payment currency including fees. Net-negative SELL receipts also require funding.

Explicit same-account FX records an already executed broker conversion, not a live exchange.
One immutable cash operation links positive source and gross received amounts before explicit
fees on a shared date/sequence. Fees may be aggregated in either exchanged currency; third-currency
fees and cross-date settlement remain unsupported. Both opening currency balances must be
explicit, and full effective-dated replay including fees must stay funded. Source-currency fees
debit in addition to exchanged principal; received-currency fees reduce the gross credit.
Principal uses `FX_PRINCIPAL`, not external capital, and fees remain costs. Actual exchanged
amounts and statement reference are authoritative; no market rate, spread, parcel transaction,
reporting-currency valuation or account activation is inferred. Account/user locking and retained
canonical command identity protect atomic posting and exact retries. Cash-only source fingerprints
remain unchanged. Dedicated FX revisions keep the account, currency pair/direction and source
reference fixed while allowing exchanged amounts, fees, date and sequence to change. The
current revision/audit/fingerprint and reason must match under the account/user lock. Immutable
inverse/replacement legs restate the effective timeline, reserve every original/replacement
slot and require funded replay in both currencies. Reversal is terminal and removes the
effective conversion including fees; it is not a new reverse exchange. Identical retained
requests can be retried after later activity or reversal. Generic funding or one-sided revisions
cannot alter FX postings. Currency/source mistakes require reversal and a new conversion.
Archived audit reads remain supported, but new revisions require a fresh active ledger.

Statement-supported dividend reinvestment is one atomic command linking an equity/ETF income
receipt and a new BUY parcel in the same account and currency. It reuses the ordinary income
and acquisition writers inside one locked transaction, never appends units or adopts an
already recorded receipt/BUY. Exact net income must equal acquisition consideration plus
explicit fees and residual cash paid into the account. Existing cent-precision consideration
storage must represent the exact product without rounding. Issuer-held carry-forward, prior
plan credits, external top-ups, cross-currency acquisitions and complex AMIT components remain
unsupported; users explicitly confirm the statement and residual disposition.
Eligible historical long holdings on the entitlement date are required, including parcels
disposed of after that date; current quantities are not an entitlement estimate. Statement
gross/withholding/franked/unfranked/franking figures remain authoritative. Payment and
acquisition retain their own dates/sequences; acquisition cannot precede payment, and
same-day acquisition follows the income sequence. Full dated replay includes both operations,
so intervening spending cannot leave a later allotment unfunded.
Both immutable operation envelopes retain the complete normalized request, counterpart IDs and
new parcel ID, bound by one account-scoped payload hash. Replay validates both links, original
request/transaction snapshots, consecutive audit numbers, source fingerprints and postings;
removing a link cannot turn either half into an ordinary editable operation. Exact retries
return the retained IDs even after subsequent sales. Independent income revisions and BUY
corrections/voids are blocked; the dedicated paired audited workflow replaces both effects
with both revision heads, account audit/fingerprint and a reason. Account, asset, currency
and statement reference remain fixed. Corrections can change tax figures, dates/sequences,
units, price, fees and account-cash residual. Corrected entitlement is checked against
historical holdings excluding the new parcel. Effective sales must be voided before correction
or terminal reversal. Reversal removes income and acquisition without creating a disposal.
Immutable paired inverse/replacement postings, source snapshots, funded dated replay and
reserved historical slots are validated atomically; exact retries remain valid after later
changes. Ordinary sales of the new parcel remain supported. No new schema, external capital, valuation or activation
is introduced. Archived history remains readable without enabling new posting.

Replay the effective-dated timeline when accepting backdated changes; a non-negative current
balance is insufficient. Date-only operations use a persisted stable sequence within a day.
Do not reorder historical operations by amount/type to manufacture funding. Missing funding
or insufficient intraday ordering evidence produces a reconciliation issue.

Serialize writers by locking the affected account rows inside a database transaction; lock
multiple accounts in stable ID order. Revalidate dated balances after the lock. Database unique
source/idempotency constraints complement locks. Tests must demonstrate concurrent spending
cannot overdraw balances. Test-only arithmetic does not establish those guarantees.

Ownership/authentication checks cover every account, parcel, source and transfer endpoint.
Only supported active accounts accept new spending. Closure requires no effective open or
partial holdings, but residual cash and statement variance do not prevent closure: the account
and its cash/history remain retained and read-only. Reopening is explicit and required before
new financial writes; it does not reset cash, opening evidence or audit history. Archival status
does not change the accounting source fingerprint, and close/reopen preserves the account
timestamp used by that fingerprint. Source drift blocks writes without silently advancing the
accepted fingerprint; supported audited correction/void workflows cover eligible manual
changes, while unsupported drift requires reviewed reconciliation before a future recovery
workflow can resolve it. Metadata-only account renames do not alter the accounting source
timestamp. Existing deletion guards, demo exclusions and soft-delete/purge rules continue to
apply; archived audit access remains available.

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

### Stock splits and consolidations (partial, not released)

The user approved a statement-supported initial slice for stock splits and consolidations.
Apply the exact stated ratio to the units held in each affected parcel immediately before the
action. The original acquisition date and remaining aggregate cost base, including acquisition
fees, are preserved; earlier disposals retain their previously allocated cost. Later disposals
allocate the remaining cost over the adjusted units. The action itself is neither a cash flow
nor a disposal. Reject cases requiring rounding, cash-in-lieu or unsupported allocation rather
than guessing. Block posting when affected parcels have effective later sales; eligible sales
must be voided and re-entered after posting. Ambiguous same-day ordering must fail closed.

The internal locked writer applies statement-supported actions atomically, but public
posting/history endpoints and UI are not available. An internal terminal reversal is implemented;
there is no in-place revision or replacement workflow. Additive action/effect storage,
split-aware CGT and position recomputation are implemented. Both readers share linked action
identity, request hash and parcel quantity
validation and reject missing effects; existing report revisions remain unchanged. Position
recomputation updates remaining units, realized P&L and status without rewriting acquisition
fields. Opening/current source inventory now uses the same validated split replay without
changing trade cash. Fully disposed pre-action parcels and post-action acquisitions do not
require an effect. Source fingerprints include retained action/effect evidence, including
statement provenance; missing or inconsistent effects fail instead of returning partial inventory.
No-split accounts retain their existing fingerprint format. Split source hashing preserves the
original evidence representation and excludes audit-number/head metadata, avoiding self-reference
and preserving previously recorded hashes.
Proposed-sale review now replays the complete retained timeline without mutating acquisition or
split snapshots. It reserves units for later sales and rejects proposed sales that would alter
retained split quantities or introduce ambiguous split-day ordering. Reinvestment entry and
paired correction share dated split-aware entitlement inventory; correction excludes its own
reinvestment parcel. The bounded history loader and source-fingerprint representation are shared
with opening review. These integrations remain behind the write fence, not a posting authorization.
Retained audited split actions now validate in the shared account sequence with cash operations and
revisions, advancing the accepted fingerprint and audit count without cash commands, postings or
reserved cash sequence slots. The action must be post-opening, with a positive consecutive audit
number and valid connected previous/next fingerprints; its source fingerprint equals the previous
head. Gaps, collisions, broken links and a mismatched final ledger head fail closed. Nullable audit
metadata preserves staged records but never silently adopts them; SQL requires either all-null or
complete valid metadata. Cash audit lists/totals remain cash-only, while the account audit number
includes audited split events. Source freshness is still independently checked against retained
inventory/evidence. A valid chain can report `CURRENT` without certifying cash completeness.
An internal writer now performs statement-confirmed split application under the owned account lock.
It requires an active real account, a current accepted source fingerprint, no unsupported account
activity or unrelated blocking preview issues, and a complete exact parcel review with no effective
later disposals. It atomically stores the action and parcel effects, updates only remaining parcel
quantities, and advances the accepted source/audit head; it does not create cash activity or alter
the original BUY. Exact retries and repeated splits are supported. This service is not exposed by a
route. The coordinated manual BUY/SELL writer now permits active real accounts with valid, current
split history, using the same inventory replay and account audit/cash chain. New acquisitions on
or before an active split date are rejected to avoid ambiguous same-day order and mutation of
retained parcel effects. Validated split history also permits audited cash-only operations,
paired cash transfers and statement-income receipts/corrections. Imports, reinvestment, legacy
financial mutations, moves and deletion remain fenced pending the historical release gates.
An internal terminal reversal preserves the original action and parcel effects and appends a
separate reversal record to the same account audit/source chain. It retroactively excludes the
reversed action from effective inventory, restores each affected stored quantity to its captured
pre-action amount, and changes no acquisition or cash record. It requires the current audit head
and rejects a later active split or a same-day or later sale of an affected parcel. Later
statement-backed asset-income receipts and their cash postings remain unchanged by the reversal;
receipt corrections or reversals use their separate audited flow. Exact retries are idempotent.
After reversal, a corrected action may
reuse the source reference and effective date with a new idempotency key; original idempotency keys
remain reserved. Reversal and corrected posting both run under the account lock and advance the
accepted source fingerprint atomically. The financial-write fence remains for imports,
reinvestment, legacy mutations, moves and deletion until their split-dependent protections and the
broader historical release gates are complete. No route or UI exposes either split operation.
Read-only realized-trade statistics now load effective parcel trades and retained split evidence,
then allocate original acquisition cost using the validated exact sale cost fraction. Summary,
realized time series, distributions and closed-trade results use this path; no-split calculations
retain their previous formula. Missing or inconsistent split evidence fails closed rather than
falling back to nominal unsplit units.
The existing positions read route also returns an optional `splitAdjustedInventory` projection
for affected parcels: remaining quantity, remaining cost basis, remaining acquisition fees and
average unit cost as decimal strings. The frontend uses this projection for split-adjusted held
units and open-cost/return calculations while preserving original `buyPrice` and acquisition
fees as historical facts; raw split actions/effects are not exposed in the response. No-split
holdings keep their prior calculation.
Until the remaining dependent writers support splits, retained history places a
temporary account-wide 409 fence on legacy financial mutations, moves at either endpoint,
new financial import steps, draft source-verified writes and live-ledger writes. Notes remain
editable, and completed legacy import retries without financial steps remain possible.
Opening review explicitly reports `SPLIT_REPLAY_UNSUPPORTED`; opening confirmation is blocked,
trade capability is `BLOCKED`, and readable live cash history is marked `INCOMPLETE`.
The internal terminal reversal is the only supported split correction; in-place edits and
replacement revisions remain unsupported, and the financial-write fence still blocks posting.
Saved tax-report revisions remain append-only when split-adjusted CGT changes: regeneration
creates a new revision without changing the prior PDF or line items, covered by a controller
regression test. Production support must still complete broader historical protections and review
the release gates before exposing corporate-action posting/history; see step 3H in the delivery plan.
Separate cost-base adjustments and complex corporate actions remain outside this slice.

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

The user-selected archival policy permits residual cash/history to remain read-only after closing,
and requires explicit reopening before new financial writes. Close/reopen and metadata-only
renames preserve the account source timestamp; archival status is normalized out of the opening
source fingerprint. This keeps lifecycle changes from creating false source drift. Manual BUY
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

The initial cash-correction slice permits inactive deposit/withdrawal corrections. The pure correction
contract can reverse/replace BUY/SELL consideration and fees exactly once across parcel links,
but corrections to real trades are explicitly rejected until parcel and cash changes share
one transaction. Replacement retains account, operation kind, source and transaction identities;
cross-account moves/reallocation need a dedicated coordinated command. No cash correction
endpoint, activation, live balance or user-facing funding workflow is enabled in this slice.

The isolated manual-trade increment adds `DraftManualTrade`, a one-to-one inactive snapshot
child of a cash operation. The approved behavior is explicitly _not_ to mutate real holdings
while accounting remains inactive. The internal `saveDraftManualTrade` writer validates a
normalized decimal BUY/SELL request and its retry hash, rechecks the opening source under
user/account locks, and commits proposed trade, cash operation, exact legs and snapshot links
in one nested transactional write. It creates no live `Position`/`Transaction` and changes
neither opening statements nor tax reports. User/account erasure cascades the proposal tree.

Every proposed BUY has its own immutable draft execution ID used as its parcel key.
Proposed partial/full SELLs explicitly select an earlier BUY in the same opening draft.
Decimal inventory replay refuses overselling, sales preceding acquisition and mismatched
currencies without Float tolerance, implicit allocation or an extra BUY in a parcel.
Cash replay still requires explicit opening currency balances, dated funding and stable
intraday order; a later deposit cannot fund an earlier proposal. Ordinary cash staging and
capital corrections replay proposal cash too, so they cannot independently reuse spent money.
Original operation date/sequence slots remain reserved by the durable-history schema even
after reversal or correction; new operations attempting reuse return an explicit conflict.

Identical retries retain the proposed trade/parcel IDs and return current draft projections
without claiming fresh live-source reconciliation. Different request content conflicts.
BUY asset currency/active status is checked at staging; asset IDs/symbols are stored snapshots.
Only cash generated by the dedicated writer may use its reserved `draft-trade:` source
namespace. Cash history validates each proposal against its original normalized request,
command, linked ID and posting identity, and rechecks the proposed parcel graph.

This increment supports new proposed BUY parcels and their SELLs, plus isolated opening-inventory
sale proposals as described below. Live application and Float-to-decimal
cutover remain explicit next steps. No app code can import these proposals as live holdings;
there is no HTTP/UI surface or activation. The frontend mirrors the additive persistence model
for contract consistency only. Fixture-only database tests demonstrate trade/cash rollback,
competing buys/sells, retry identity, funding-correction interaction and unchanged live tables.

Isolated trade corrections now reuse `DraftCashRevision.request` to retain both the normalized
cash replacement and an explicit `proposedTrade` replacement (or paired nulls for reversal).
The revision hash covers units, price, fees, dates and order as well as reason/expected head,
so cash-equivalent but economically different proposals cannot reuse the same retry identity.
Legacy capital revision hashes are unchanged because the additional field is absent there.
The parser verifies exact trade-to-cash agreement; historical audit replay applies the latest
proposed trade and cash together while validating every original and intervening revision.

The dedicated internal trade-correction writer shares the existing account/user transaction,
head checks, audit limits and append-only posting creation. It rejects asset/currency/parcel
rebinding and replays both dated inventory and cash before writing: reducing/reversing a BUY
cannot invalidate dependent SELLs, and changing/reversing a SELL cannot remove cash consumed
later. A SELL reversal restores units; a BUY can be reversed after its SELLs are reversed.
Original IDs, requests and postings are preserved, and reversal remains terminal. Identical
old retries return current projections without duplicating effects or claiming source freshness.
The standalone cash-correction entry point cannot modify proposed trades or attach trade content
to a capital operation. Real-trade corrections remain disabled; existing holdings are untouched.
No schema migration, HTTP/UI surface or activation is introduced by this correction increment.

### Isolated opening-parcel sales

Draft inventory replay now starts from the persisted `OpeningParcelBalance` quantities.
No BUY operation or acquisition cash is generated for these units. The end-of-day boundary
still excludes on/before-boundary sales through cash-command validation, and the dated replay
deducts only explicit proposed SELLs. Live post-boundary trades are not implicitly replayed:
this is an isolated scenario starting from the reviewed boundary, not today's live holdings.
New proposed BUYs remain separate parcels; nothing appends to an opening parcel.

An opening parcel is addressed as `opening:<OpeningParcelBalance.id>`, scoped to its statement.
Live position IDs and keys from another opening revision are rejected. The reader validates all
child balances against the retained preview inventory with bounded, exact decimal quantities.
New mutations also compare this inventory with the freshly verified source preview under the
account lock. An opening sale checks the owned LONG source position and captures its asset/symbol
identity in the existing immutable `DraftManualTrade` row; no schema migration is necessary.
The old opening balance did not record asset IDs, so opening projections retain a null `assetId`
and expose the snapshot `positionId`/symbol instead of inventing an identity. Historical retries
do not fetch live positions; all opening sale snapshots must agree on their parcel's identity.

Corrections and terminal reversals restate this combined unit/cash timeline just like new
proposed parcel trades. Competing disposals cannot consume the same units; increasing an earlier
sale cannot invalidate later sales, and reducing/reversing proceeds cannot invalidate later
spending. Reversal restores only draft units and cash, never live holdings. Recorded live-trade
cash operations and opening-sale proposals cannot coexist in the same statement (including
reserved reversed originals), avoiding a second cash posting for a legacy disposal. Capital
operations and isolated proposed purchases remain supported. A Kraken-first import reconciliation
path can stage persisted execution cash in an inactive draft; it does not establish external
verification or enable live cash posting.

### Read-only opening reconciliation

`reconcileDraftOpening` uses the same active-user/owned-account locks and rereads the opening
after acquiring them. It makes no financial writes. It reconstructs validated effective draft
trade/cash history, returns dated funding gaps rather than inventing funding, and reads the
current live opening preview in that transaction. A second preview at the saved observation
date (only when different) separates source changes from normal calendar advancement.

The report exposes saved/fresh opening quantities, proposed remaining units and both expected
and recorded live remaining units. Exact boundary and scenario differences are distinct:
scenario divergence is not necessarily a live inventory error. Missing references remain null;
new proposed parcels remain separate from live position IDs. Current preview issues preserve
existing Float reconciliation tolerances and unsupported import/short/income warnings.

Observed post-boundary live transaction identities are classified as linked, unlinked or
linked to a reversed operation. This describes coverage only, not economic verification of
a subsequently changed live trade. Missing, pre-boundary or future-dated linked sources become
explicit review entries. Active opening-sale proposals on the same live parcel are potential
overlaps, never automatically identified as duplicates or matched to an execution. Existing
audit/preview limits remain enforced; overlap output is limited to 100000 references.

Funding sufficiency does not prove external cash correctness. Cash is always `UNVERIFIED`;
user-attested statement evidence is not bank/broker verification. `accountingActive` and
`activationReady` remain false, with explicit reasons for unverified cash, inactive live
accounting, source/inventory drift, funding gaps, unlinked sources, potential overlaps and
current preview blocking issues.

The cash-evidence extension stores immutable snapshots containing a statement date, every
tracked currency balance, source/reference and explicit user attestation. A read-only preview
compares exact replay at the evidence date before persistence. A mismatch requires a reason and
bounded note for each currency; those decisions are audit records only, do not change balances,
and do not resolve a variance. Current reconciliation replays each saved snapshot against
effective dated operations while retaining the original attestation and decision history.

The review UI exposes the cash, source, inventory and trade-link comparison. It allows
explicitly sourced, separately dated manual deposits/withdrawals through the account-locked
inactive writer, which retains stable ordering, exact arithmetic and funding validation.
It also exposes capital-only correction/reversal commands using the same immutable revision
engine. Replacements accept only effective date, sequence and amount; currency, source and kind
are derived from the original command. The URL account is checked before and after locking.
Expected revision IDs prevent lost updates, unchanged retry keys/content reuse the recorded
correction, and full dated replay rejects downstream deficits. An audit reason is required;
terminal reversal never frees a source identity for reuse. The report includes current revision,
capital amount and correction/reversal reasons. Saved statement evidence is retained and its
variance is recomputed, not silently rewritten. No capital correction can alter a trade/import.
These operations are not balancing adjustments and never affect live cash or holdings. Exact
agreement with attested evidence does not enable confirmation or activation.

### Applied Kraken execution cash staging (inactive only)

The reconciliation report lists applied Kraken BUY/SELL events and their persisted
`brokerRef` transaction/parcel links. Staging accepts only the applied event identity and an
explicit positive intraday sequence; execution currency, gross consideration and fee amount are
read from the stored event, never supplied by the caller. The writer verifies event ownership,
account, status, date, supported currencies, gross/fee amounts and the complete transaction and
parcel identity before replaying or persisting one source-linked operation. A multi-parcel SELL
therefore has one cash effect, not one effect per allocation.

An event already represented in that statement, or a transaction identity already linked to any
draft operation, an event on/before the opening boundary, unsupported amount/currency treatment,
missing or inconsistent links, stale opening data and an opening-sale proposal conflict are never
stageable. The writer enforces the transaction-link check under the account lock, including
reversed operations, so changing a source reference cannot stage the same live trade twice.
Stable ordering is supplied explicitly; timestamps are shown for review but do not determine
sequence. Imported execution operations cannot use manual cash corrections. A dedicated
source-aware sequence correction accepts only idempotency key, expected revision, audit reason
and corrected sequence. It retains date, consideration, fees, currencies and complete source links
from the immutable original; the original is revalidated against the applied Kraken event under
the account lock. Every stored imported revision is also checked against this sequence-only
contract before replay. Changed source records fail closed rather than silently restating money.
Original commands and exact reversal/replacement audit legs remain intact. Full cash replay
rejects intraday funding deficits and occupied effective slots. Identical retries reuse the saved
revision and return current projections, including after another correction; original staging
retries likewise cannot duplicate the effect. The UI shows only sequence and audit inputs,
refreshes conflicts without retrying mutations and disables stale/offline editors.
For imported executions, cash-only reversals and financial corrections beyond the supported
sequence-only adjustment remain unsupported until source trades and cash can change atomically.

No legacy writer spends draft cash or maintains its postings. Draft operations must never be
counted as spendable cash or portfolio value. The Kraken path reconciles persisted import records
only; it does not verify them with the broker or enable live posting. Kraken remains the only
supported adapter while accounting is completed. Binance/Coinbase and other demand-driven
integrations are deferred, not cutover prerequisites; a CSV upload needs no activation switch,
while future read-only API connections must be explicitly enabled by each user. Subsequent
implementation added gated atomic live trade/posting and audited manual BUY/SELL corrections.
Imported financial adjustments, execution reversals, and coordinated move/deletion workflows
remain cutover blockers. Existing preview ordering stays deliberately unverified; it cannot be
promoted into stable ledger order automatically.

At this earlier milestone, persisted user-facing opening confirmation and account activation
were not yet implemented; step 2F below subsequently delivered the controlled per-account flow.
Production XIRR, corporate-action tax treatment and scheduling remain unimplemented. The live
trade writer is gated behind confirmed-ledger state and has integration
coverage for atomic BUY/SELL posting, retries, source drift, funding and concurrent spending.
Kraken imports for ledger-backed accounts require one complete batch containing only supported
BUY/SELL executions. The writer derives Sydney-date sequence from execution timestamps, rejects
identical timestamps and any existing cash or trade activity on an affected Sydney date. Before
posting, source-head validation excludes only the locked pending batch being committed; unrelated
source drift still conflicts. It then posts each source event's cash exactly once (including a
SELL allocated across multiple parcels) and advances the accepted fingerprint to the resulting
preview in the same transaction as the import. Unsupported event types and partial live-ledger
batch commits remain blocked. Legacy financial writers remain blocked until their coordinated
correction paths exist.

### Recorded manual execution staging

The inactive reconciliation review also lists persisted manual long BUY/SELL transactions.
Staging accepts a transaction identity and explicit sequence only. The server constructs the
command from persisted date, exchange currency, gross consideration and fees, then checks the
source again under the existing account lock before storing any postings. Imported parcels and
transactions with a broker reference are excluded: in particular, an imported SELL allocation
against a manual opening parcel must not be posted as a separate manual execution.

The durable identity is `manual-transaction:<transactionId>` within the opening statement.
Existing duplicate-link checks reserve transaction identities even after reversal. Identical
retries return the existing operation; changing sequence is not an implicit correction. Source,
boundary, funding, account-state and opening-sale-scenario guards remain authoritative. The UI
requires explicit ordering, masks money in privacy mode, disables offline mutations and refreshes
conflicts without retrying. This adds neither live trade edits nor independent cash corrections
for executions. Financial source/cash corrections still require a coordinated atomic workflow.

### Financial source preservation before coordinated correction

Financial correction is manual-first. Imported execution values are preserved; a future
source-aware adjustment workflow, not an ordinary editor override, must explain any financial
discrepancy. Legacy acquisition and close-event editors therefore reject actual financial
changes to imported acquisitions or broker-linked SELL transactions, including imported SELLs
allocated against manual parcels. Imported parcels and parcels containing broker-linked
allocations cannot be moved, re-instrumented or individually deleted through the legacy editor.
Account/user lifecycle deletion remains a separate explicit data-erasure operation.

Any durable draft cash link also prevents legacy financial acquisition/SELL changes and parcel
instrument/account changes or deletion. The checks run after account/parcel locking, serializing
with cash staging and import writers; reversing cash never releases the source identity.
Rejected mixed metadata/financial requests perform no trade update. Metadata and unchanged
financial inputs remain accepted, and frontend editors omit unchanged financial fields to avoid
converting displayed date-only values, rounded fees or remaining units into acquisition edits.
Conflict responses explain the restriction instead of silently abandoning the change.

These guards remain protective prerequisites. The dedicated manual acquisition and sale workflows below
are the currently exposed coordinated financial execution corrections. The guards do not enable
live accounting or imported financial overrides.

### Atomic manual sale corrections with audited opening continuation

A dedicated account/statement/operation-scoped command corrects an existing effective manual long
SELL and its linked draft cash together. It accepts exact decimal price/fees, effective date,
explicit sequence, audit reason, expected cash head, expected source fingerprint and idempotency
key. Quantity, parcel, source, currency and instrument are retained. The source must have no
broker reference; imported SELL allocations cannot enter this workflow. The parcel must have one
BUY and reconciled remaining inventory. Corrections stay after the opening boundary, on/after
acquisition and within the reviewed observation date. This is not a reversal or reallocation.

The command uses the existing account/user and parcel locking order, verifies the prior source,
replays the entire dated cash timeline, updates the live SELL, recomputes parcel totals and appends
one immutable cash revision with exact reversal/replacement postings in a single transaction.
It preserves same-Sydney-date execution timestamps; a changed date is represented at 01:00 UTC
on the requested calendar date, without claiming verified intraday execution timing. Price and
fees respect their database precision (12 and 8 fractional digits). Gross consideration is
quantity times price, explicitly rounded half-up to the existing transaction column's 2 decimal
places, and must fit its 10 integer digits. Sequence-only changes do not rewrite the live sale.

Opening statements remain immutable. The chosen policy is **audited continuation**, stored in
the existing revision's hashed request as `executionAudit`, not a mutable replacement of
`sourceFingerprint` or `previewSnapshot`. The audit includes the reviewed correction input,
exact before/after sale snapshots, statement-wide ordinal, previous accepted fingerprint and new
fingerprint after recomputation. Replay checks snapshot/cash agreement, identity/quantity
retention, exact audit postings and the globally ordered source chain rooted at the original
fingerprint. Current corrected transactions must still match their latest snapshots. Source
verification for subsequent appends uses the chain's accepted fingerprint. Other statements do
not inherit that continuation and therefore become stale. Corrupt audit chains and source drift
fail closed. Legacy histories without source audits retain their original semantics.

Retries reuse the persisted input and revision identity before expected-head checks, returning
current cash projection without rewriting the sale, even after later corrections. Original
manual staging retries also reuse their operation after an audited correction. Existing source
and transaction identities stay reserved. Funding deficits, order collisions, stale revisions,
source drift, precision overflow and post-update audit failures cannot leave partial live/cash
changes. Attested statement evidence is never restated; its variances are recomputed against the
corrected timeline. The UI explicitly warns about changing LIVE trade results and stale tax
reports, retains failed-request retry identity, disables offline/stale editors, masks amounts
and refreshes live holdings/history/statistics/tax usage and all draft reconciliations.

Execution reversal, account/instrument moves, deletion, imported
financial adjustments and atomic new live trade posting remain separate work. This enables
neither live spendable cash nor accounting activation.

### Coordinated manual acquisition and quantity corrections

The same atomic writer now supports an effective linked manual long BUY. Its dedicated endpoint
adds exact decimal `quantity` to the sale correction's reviewed input. The account, instrument,
parcel, currency, transaction and source identity stay fixed. A parcel still has exactly one BUY;
this is correction of that acquisition, never an additional purchase. All sale quantities and
allocations remain unchanged. The new bought quantity must cover their sum, and the acquisition
date must not follow any sale's Sydney calendar date. Same-day sales must have effective draft cash
ordered after the acquisition; sale corrections enforce that relationship too. Missing or earlier
sale ordering requires staging/resequencing before the purchase can move onto that day.
Imported acquisitions and any parcel with a broker-linked sale allocation are ineligible.

The acquisition must stay after the immutable opening boundary and within the original observation
date. Pre-opening acquisitions need a separate opening-inventory revision workflow and cannot
enter this path. Same-date edits preserve the full timestamp; changed dates use the existing
01:00 UTC representation. Quantity must be positive, have at most 12 fractional digits, be at most
9007199254740991, and retain its decimal value through the existing Float storage round trip.
This rejects silent quantity normalization without changing the existing live storage schema or
portfolio calculation arithmetic. Gross consideration is rounded half-up to 2 decimal places,
and capital allocation (gross plus fees) must fit its existing storage precision.

The transaction, parcel acquisition fields (date, entry price, gross, fees, capital allocation),
recomputed remaining quantity/status/realized results, and immutable cash revision are committed
together. Acquisition-based cached drawdown/run-up and unrealized PnL are cleared rather than
retaining results based on the old purchase. Quantity corrections can close or reopen a parcel,
but never create/delete/reassign sales. Source drift, insufficient quantity, invalid dates/order,
funding deficits, stale heads and downstream audit failures roll back every write.

Purchase source audits carry `kind: BUY` and the reviewed quantity. Historical sale audits remain
untagged with their existing hash representation and fixed-quantity rule. Replay validates the
audit kind against cash and current persisted transaction type, and checks exact before/after
snapshots within the same statement-wide continuation chain across both kinds. Original openings
and evidence remain immutable, unrelated drafts become stale, and retries (including original
staging retries and retries after a later sale correction) never rewrite the source.
The shared review editor masks quantity and money, requires explicit acknowledgement of LIVE
cost-basis/realized-gain/tax-report impacts, and uses the same offline, stale-review and retry
protections. This does not activate ordinary accounts or expose accounting-backed balances;
the separately gated live trade writer below requires manually provisioned confirmed-ledger
state. Imported financial overrides, execution reversals, deletion and moves remain unavailable.

### Gated atomic live manual trade posting

The additive `AccountCashLedger`, `AccountCashOperation` and `AccountCashPosting` records provide
an append-only live cash audit separate from statement-scoped drafts. No existing account is
provisioned, and `TradingAccount.status` is not treated as accounting confirmation. A live trade
is accepted only when the owned account is active and real, an `ACTIVE` cash ledger exists, and
its linked opening statement is `CONFIRMED` with matching opening fingerprint.

`POST /api/accounts/{id}/trades` accepts exact decimal-string BUY/SELL commands, a positive
effective-date sequence and an account-scoped idempotency key. Under account (and, for SELL,
parcel) locks, the writer validates draft cash history and audited source continuation, verifies
all existing post-opening trades are cash-linked, checks persisted live snapshots/postings and
replays the complete dated cash timeline. It creates/recomputes the parcel transaction, appends
the cash legs and source-fingerprint transition, and advances the accepted fingerprint in one
database transaction. Funding deficits, source drift, occupied order slots, invalid parcel
inventory, changed idempotency payloads and write failures cannot leave partial state. Same-key,
same-payload retries return the existing operation.

The legacy position-create/close paths, financial edits/moves/deletions and account deletion
cannot bypass the ledger: they are rejected for ledger-backed accounts until coordinated cash
corrections exist. Kraken imports are supported only as complete BUY/SELL batches with
timestamp-derived sequencing and same-day ambiguity blocks; import records and cash postings
commit atomically. Closing an account retains its ledger and history. Legacy accounts without a
ledger retain their previous behavior. Ordinary BUY and partial/full SELL forms now resolve
the server-owned capability and route through this writer only for `LIVE_LEDGER`; legacy/demo
accounts retain their existing supported flows.

### Capability-aware ordinary trade-entry routing

`GET /api/accounts/:id/trade-capability` resolves the server-owned write mode for an
effective date: `LIVE_LEDGER`, `LEGACY`, `DEMO`, `ARCHIVED` or `BLOCKED`. It checks account
ownership, confirmed active-ledger state, source freshness and unsupported history, and
returns the opening boundary and next available same-day sequence. It is read-only and never
provisions or activates an account.

The ordinary BUY and partial/full SELL forms use the coordinated writer only for
`LIVE_LEDGER`; legacy/demo accounts retain their existing supported flows. Live forms preserve
acquisition/close metadata, require a date after the opening boundary and submit exact decimal
strings with a stable retry identity. Unknown or blocked capability, stale source history,
archived accounts and offline live submissions fail closed rather than falling through to a
legacy mutation or offline queue. A cached capability permits offline queueing only when it
explicitly identifies `LEGACY` or `DEMO` for non-demo API-backed accounts; existing local
demo practice behavior is unchanged. This routing does not enable account activation.

### Audited corrections for live manual sales

Live cash-linked manual SELL corrections append an `AccountCashOperationRevision` and exact
reversal/replacement postings; the original operation and its posting rows remain immutable.
Only the sale's effective date, stable sequence, price and fees can change. Quantity, parcel,
currency and source identity stay fixed, and reversal is not supported. Imported executions
remain ineligible because their source records require a separate source-aware adjustment policy.

The correction locks the owned account and parcel, checks the expected revision and current
account source fingerprint, validates the acquisition boundary and reserved sequence slots, then
replays the complete cash timeline before committing the transaction, recomputed parcel results,
revision audit and accepted fingerprint together. Replays validate the ordered operation/revision
chain, snapshots and postings against current source data. The closed-trade history exposes
correction metadata only for eligible active-account manual sales; its editor requires an audit
reason and does not queue writes offline. This remains a gated writer: it provisions no ledger,
activates no account and does not enable imported financial corrections or execution reversal.

### Audited corrections for live manual acquisitions

Live cash-linked manual BUYs use the same append-only operation revision and fingerprint chain
as SELL corrections, with acquisition audits explicitly tagged `kind: BUY`. The endpoint
`POST /api/accounts/{id}/trades/{transactionId}/acquisition-corrections` accepts exact total bought
quantity, price, fees, effective date and sequence with an expected revision/source head,
idempotency key and audit reason. Existing untagged SELL audit hashes remain unchanged.

Under owned account/parcel locks, the writer preserves every existing sale and requires the
corrected acquisition to cover their quantities, precede their dates and precede any same-day
effective sale cash. Imported purchases and parcels containing broker-linked allocations remain
ineligible. The full dated cash replay must remain funded. The single BUY, parcel cost basis,
remaining quantity/status, realized results, immutable reversal/replacement cash legs and source
fingerprint advance commit together or roll back together. A quantity correction may close or
reopen the parcel without changing a disposal; acquisition-based derived caches are cleared.
Existing Float quantity storage retains the same exact round-trip and precision limits as the
draft acquisition workflow.

The UI exposes corrections in holdings and closed-trade history, including fully sold parcels,
using full exact acquisition metadata rather than prorated fees/remaining holdings. It requires
explicit acknowledgement of live cash/cost-basis/tax-report impacts, preserves retry identity,
and blocks offline or stale review submissions. Legacy financial editors cannot bypass the
ledger. This slice did not include activation, demo provisioning, moves/deletion or reversals.
Restricted imported corrections and terminal manual voids are described in the later sections.

### Audited corrections for live imported executions

Eligible applied Kraken BUY/SELL executions in active real ledger-backed accounts use
`POST /api/accounts/{id}/imported-executions/{eventId}/corrections`. The immutable operation
revision stores the source event identity, audit reason, expected revision/source head,
before/after linked transaction snapshots and exact reversal/replacement cash postings. It
allows only effective date, stable sequence, exact price and fees to change. Transaction
quantity, parcel allocation, currency and source identity are fixed, and the original
`ImportedEvent` remains unchanged.

The writer locks the account and all affected parcels, revalidates the applied event and exact
transaction links, enforces the opening/observation boundary and same-day BUY/SELL ordering,
and replays the full effective-dated cash ledger before writing. Funding failure, changed
allocation links, short parcels, multiple currencies and fee-currency conversion are rejected.
Transaction and parcel projections, revision postings, audit chain and accepted source
fingerprint commit atomically. History provides controls for imported BUYs (including closed
parcels) and SELLs; holdings provide controls for imported BUYs. The UI requires an audit reason
and acknowledgement and rejects offline/stale writes. This does not activate accounts or enable
execution reversals, arbitrary import adjustments, moves or deletion.

### Live deposits and withdrawals

`POST /api/accounts/{id}/cash-operations` records a manual deposit or withdrawal only for an
already confirmed active real ledger. The command requires an exact positive amount, supported
currency, effective Sydney date, stable sequence, explicit source reference and account-scoped
idempotency key. Under the account lock, the writer validates stored audit/posting consistency,
checks source freshness, reserves the date/sequence slot and replays the full dated timeline.
Any withdrawal or backdated flow that leaves a later balance negative is rejected atomically.
The response includes the resulting cash replay; it does not create a transaction, position or
opening statement and does not change the accepted holdings-source fingerprint.

`AccountCashOperation.transactionId` is nullable for these cash-only records; the command and
cash postings remain the immutable source of truth. No synthetic BUY/SELL is created. The
frontend form preserves retry identity for unchanged requests and never queues offline writes.

### Live funding corrections and reversals

`GET /api/accounts/{id}/cash-operations` presents each original cash-only funding operation,
its current effective command, and retained correction/reversal posting legs. The endpoint
replays the complete live cash history and fails visibly if the source or audit chain is
invalid.

`POST /api/accounts/{id}/cash-operations/{operationId}/corrections` appends an immutable
revision. A replacement can change only effective date, stable sequence and exact amount;
kind, source reference, account and currency come from the original operation. A reversal is
terminal. Original and superseded replacement slots remain reserved. Every command validates
the current operation revision, account-wide audit number and accepted source fingerprint
under the account lock, then replays the full dated timeline before persistence. A correction
that would make any later balance negative is rejected atomically. Same-command retries return
the prior revision, including after later revisions; changed retries conflict.

Capital revisions participate in the account-wide audit-number chain, but do not modify the
accepted holdings-source fingerprint: their `previousFingerprint` and `nextFingerprint` are
equal. The revision audit records exact before/after commands and reversal/replacement postings,
without rewriting the original operation or any evidence attestations. The frontend provides
an online-only review and correction panel and requires an explicit acknowledgement for
terminal reversal. This is not a full live balance/evidence reconciliation surface (2D), and
does not introduce account activation or provisioning.

### Live balances, activity and evidence review

`GET /api/accounts/{id}/cash-operations` also serves as the read-only live cash review for
ledger-backed real accounts. It reports exact replayed balances by currency, effective-dated
cash activity, the Sydney end-of-day opening boundary, source freshness, funding gaps,
unsupported/unlinked events, and retained operation/revision summaries. A stale active source
or unsupported event marks the replay incomplete; the last validated ledger replay is not
presented as a complete current balance. Invalid audit chains or postings fail visibly rather
than returning partial/success-shaped balances.

The read surface also works after account closure. Archived accounts are explicitly marked
read-only and their current source freshness is reported as not revalidated; their retained
replay remains available for history, not as a current broker balance. Saved cash evidence is
compared to the effective dated replay at its attested date, with original decisions retained.
Exact agreement remains user-attested evidence, not broker verification or proof of complete
performance. The frontend can display cached last-successful read data offline with a stale
indicator; it does not queue or retry writes.

### Manual cash income receipts (increment 3A first slice)

`POST /api/accounts/{id}/income-receipts` accepts only statement-entered equity/ETF
distributions for an asset already present in the account's non-voided holdings history.
Entitlement date, payment/effective date, stable sequence, settlement currency, gross,
withholding, franked and unfranked amounts, non-cash AUD franking credit, and source reference
are retained in an income receipt linked to one immutable cash operation. Franked plus
unfranked amounts must equal gross; withholding cannot exceed gross. The effective cash posting
is exactly gross less withholding, and income does not count as external capital. A franking
credit never increases spendable cash.

The endpoint requires an active confirmed ledger, a payment date after its opening boundary,
current source history, a free date/sequence slot and a funded replay. Same-payload retries are
idempotent. The frontend loads both open and closed historical equity/ETF positions for asset
selection and shows receipt attributes in the retained cash audit. This first slice does not
derive entitlement from parcel quantities and is not a broker verification or tax calculation.

`POST /api/accounts/{id}/income-receipts/{operationId}/corrections` appends immutable replacement
or terminal reversal revisions, with before/after income commands and reversal/replacement cash
postings. A replacement can correct dates, sequence, gross, withholding and tax attributes, but
preserves asset, currency and source reference; reverse and record a new receipt to change those
identity fields. The complete dated cash replay must remain funded, date/sequence slots remain
reserved, stale audit heads conflict, and same-key retries return the original revision even
after a later revision. Reversed receipts cannot be revised again. Receipts and revisions are
never directly edited or deleted. AMIT components, automated estimates, crypto staking and
transfers remain excluded.

### Terminal audited manual trade voids

`POST /api/accounts/{id}/trades/{transactionId}/voids` appends a terminal manual
BUY/SELL operation revision with reversal-only cash postings, reason, expected source/
revision identity, original execution snapshot and exact void timestamp. Original trades
and operations are retained. Nullable `Transaction.voidedAt` and `Position.voidedAt`
markers represent economic inactivity, not disposal or physical deletion; replay validates
them against the immutable terminal audit. An unsold voided BUY remains an archival parcel
with zero quantity, not a genuinely CLOSED sale. A SELL void restores its remaining units.

Only reconciled manual long parcels without imported allocations or non-trade adjustments
are supported. BUY voids require no effective sales. All participating writes lock the owned
account and parcel; the complete dated cash replay must remain funded. Markers, derived
inventory, revision postings and fingerprint advancement commit together. Terminal trades
cannot be changed, sold, deleted or voided again; identical prior requests remain retryable,
including after intervening revisions. Original/previously corrected sequence slots stay reserved.

Effective holdings, disposals, CGT/statistics, import inventory and opening previews exclude
voided records. Tax PDFs retain their original content; source timestamps invalidate affected
report usage. `GET /api/accounts/{id}/trades/voids` exposes paginated retained audits; the
account-filtered history UI keeps these separate from effective disposal history. Confirmation
requires a reason and acknowledgement, and is never queued offline. Imported voids, moves,
deletion and real/demo account provisioning remain unsupported.
Read-only audit access remains available after account closure. It validates retained source
snapshots, markers and revision/posting chains but does not claim that a current cash/source
reconciliation is fresh.

## Consequences

Accurate performance begins at a known boundary rather than a fabricated inception history.
Users must supply real funding and resolve gaps. Existing tools remain usable while new
accounting is enabled gradually. Integration breadth and complex tax treatment follow only
after the supported ledger reconciles.

### Current delivery boundary and next work

The live trade and deposit/withdrawal writers, audited live funding revisions and audited
manual/imported BUY/SELL correction paths require the matching confirmed statement and active
ledger. Imported correction is limited to fixed quantities and parcel allocations in one
currency; it does not activate accounts, and ordinary legacy accounts continue using legacy
trade behavior. Manual voids are supported; imported reversals and financial moves/deletion
remain explicitly blocked. Live cash review, capability-aware ordinary trade-entry routing and
the explicit confirmation flow are implemented.

Confirmation is per-account and online-only. Under the owned account lock and a serializable
transaction it requires the latest draft for an active real account, no selected-draft activity,
no post-boundary trades, a current accepted source fingerprint at the saved observation date,
no blocking inventory issues, funded cash replay and the latest funded user-attested statement
evidence exactly matching replay. Other draft activity is listed and retained as excluded; the
user explicitly acknowledges the opening balances, attested evidence, exclusion and unavailable
returns without sourced valuations. The actor, timestamp, idempotency identity, evidence identity,
acknowledgements and excluded-draft summary are retained with the confirmed statement/ledger.
Same-key retries return the original result, and serialization conflicts are retried safely.
Unit and disposable-localhost tests cover activity/source blockers, idempotency, competing
confirmation, account closure and user-deletion races. Only this explicit confirmation action
can enable one eligible real account; no real account has been activated during development.

Transfers, sourced valuations, production XIRR, corporate-action tax treatment and scheduled
valuation remain subsequent work;
accounting-backed performance must not be presented before its data and methodology are
available. See the [delivery plan](../portfolio-foundation-plan.md) for sequence and acceptance
gates.
