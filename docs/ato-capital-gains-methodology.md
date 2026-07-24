# ATO Capital Gains Tax Report — Methodology & Assumptions

This document explains exactly how the "Tax Reports" feature computes capital
gains/losses, so future maintainers (and the app's owner, at tax time) know
precisely what assumptions were made.

> **This is not tax advice.** The report and this document describe a
> simplified implementation of general ATO capital gains tax (CGT) rules for
> individuals. Always verify figures with a registered tax agent before
> lodging a tax return.

## Scope

- Covers stocks, ETFs, and crypto positions tracked in Truffles (all treated
  as CGT assets under the same engine — the ATO treats crypto disposals as
  CGT events for personal investors in the same general way as shares).
- Assumes the taxpayer is an **individual** (not a company/trust), since this
  is a personal portfolio tracker. The 50% CGT discount only applies to
  individuals (and trusts, with complexity not modelled here) — not
  companies.

## Why no FIFO parcel matching is needed

A `Position` (see `prisma/schema.prisma`) is created with exactly one BUY
`Transaction` at creation time (`POST /api/positions`) and is **never**
appended to — there is no "add units to an existing position" feature. This
means every `Position` already represents a single, discrete CGT acquisition
parcel: `openDate` is the acquisition date, `entryPrice` the cost per unit,
`buyFees` the incidental acquisition costs.

Every SELL `Transaction` recorded against a position (via
`POST /api/positions/:id/close`, which supports partial closes) is therefore
an unambiguous, already-specifically-identified disposal of units from that
one parcel — there is no pooled/ambiguous FIFO matching problem to solve
across multiple acquisition lots of the same asset within a position.

If, in the future, positions are changed to support averaging in additional
BUY transactions, this assumption breaks and a real FIFO (or specific
identification) parcel-matching step would need to be added to
`src/lib/cgt-engine.ts`.

## Per-disposal calculation

For each SELL transaction within the target financial year:

- `quantity` = the transaction's quantity.
- `proceeds` = `totalValue − fees` (sell value net of selling costs).
- `originalBuyQty` = `position.totalBuyValue / position.entryPrice` (the
  position's original acquired quantity).
- `proratedBuyFee` = `position.buyFees × (quantity / originalBuyQty)`.
- `costBase` = `position.entryPrice × quantity + proratedBuyFee`.
- Foreign-currency amounts are converted to AUD using the historical FX rate
  on the **acquisition date** (for cost base) and the **disposal date** (for
  proceeds) respectively — see "FX conversion" below.
- `capitalGain = proceedsAud − costBaseAud`.
- `holdingDays = disposeDate − acquireDate` (simple day count). Discount
  eligibility is `holdingDays > 365` — a simplification of the ATO's "more
  than 12 months" rule that doesn't account for leap years or exact calendar
  months. This is flagged in the generated PDF's methodology footnote.

## Aggregation & the 50% CGT discount

1. All positive-gain disposals are split into **discount-eligible** (held
   > 12 months) and **non-discount** (held ≤ 12 months) buckets.
2. All negative-gain (loss) disposals for the year are summed as
   `totalCapitalLossAud`.
3. Any carried-forward loss from a prior year's report for the **same
   account selection** (see "Account scoping" below) is added as an opening
   loss balance.
4. Available losses (current year + carried-forward) are applied **first to
   non-discount gains**, then to **discount-eligible gains** — this is the
   ATO-preferred ordering, because it maximises the eventual 50% discount
   benefit (applying losses to already-discounted gains first would waste
   loss value).
5. The 50% discount is applied to whatever discount-eligible gain remains
   after step 4.
6. `netCapitalGainAud` = remaining non-discount gain + discounted remaining
   discount-eligible gain. If losses exceed all gains, this is `0` and the
   excess becomes `carriedForwardLossClosingAud`, carried into the next
   year's report for the same account selection.

## Account scoping ("declarations")

Reports are **not** automatically scoped to "all accounts". Each time a
report is generated, the user explicitly selects which Trading Accounts to
include (`accountIds`) — this supports tracking genuinely separate tax
declarations under one login (e.g. the user's own brokerage accounts vs a
spouse's accounts also tracked in the same app).

- `TaxReport.accountsKey` = the sorted, comma-joined selected account IDs —
  this is the actual "declaration identity".
- Uniqueness/upsert key: `(userId, financialYearStartYear, accountsKey)` —
  regenerating a report with the _same_ account selection for the same FY
  recalculates and replaces it in place; a _different_ account combination
  creates an entirely separate report with its own independent
  carry-forward-loss chain.

## FX conversion

Foreign-currency (non-AUD) disposals are converted using, in priority order:

1. **RBA's official daily exchange rates** — `src/lib/fx-rates.ts` downloads
   and parses `https://www.rba.gov.au/statistics/tables/csv/f11.1-data.csv`
   ("Exchange Rates – Daily – 2023 to Current"). RBA publishes rates as
   "AUD 1 = X foreign currency"; we invert this to get AUD-per-unit. If the
   exact date has no published rate (weekends, NSW public holidays, or a
   currency published less frequently), the nearest earlier published date
   (up to 10 days back) is used.
2. **Yahoo Finance historical FX** (`yahoo-finance2`, already a project
   dependency) — used only when RBA doesn't cover the requested date (e.g.
   dates before 2023) or currency.

Resolved rates are cached in `FxRateCache` (`{currency, date}` unique) both
to avoid repeated downloads within a single report generation and so that
regenerating an old report later reproduces the same figures. Each
disposal's line item records which source (`RBA` or `YAHOO_FALLBACK`) was
used, and the source is disclosed in the PDF.

**Known limitation:** older RBA archives (pre-2023) are only published as
XLS multi-year blocks, not CSV, and are not parsed by this implementation
(to avoid an XLS-parsing dependency for low-value legacy coverage) — disposals
or acquisitions dated before 2023 fall back to Yahoo Finance instead.

## PDF generation & storage

- PDFs are rendered server-side with `pdfkit` (pure JavaScript, no
  Chromium/Puppeteer) — deliberately chosen given the production VPS has
  limited RAM (1–2GB) and cannot comfortably run a headless browser.
- The PDF bytes are stored directly in the `TaxReport.pdfData` column
  (Postgres `Bytes`) rather than on disk or in object storage — simplest
  option for personal-scale data volumes, and means a report can always be
  re-downloaded exactly as originally generated.
- Email delivery is **not implemented** (deferred by design choice) —
  reports are download-only via `GET /api/tax-reports/:id/download`. Adding
  a "resend by email" endpoint later is straightforward since the PDF bytes
  are already persisted.
