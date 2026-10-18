# Plan — Crypto exchange positions (Kraken now; Binance & Coinbase deferred)

Status: **ready for implementation** · Author: planning session 2026-10-18 (rev. 2: Kraken
format verified against the user's real export; Binance/Coinbase deferred) · Repos:
`piggy-api`, `piggy-fe`

> **Scope of this revision:** implement **Kraken only**. Binance and Coinbase are **deferred**
> until the user supplies sample exports (see Phase 3). Keep the adapter registry pluggable so
> they can be added later without touching the pipeline.

## 0. Delivery 1 scope (agreed with the user — implement this first)

**Goal of Delivery 1:** ingest Kraken `trades.csv` + `ledgers.csv` and turn them into normal
Truffles data — closed positions + SELL history for round trips, open/partial positions for
anything still held — after a review step; plus a working manual "Add Position" for crypto.

| Included in Delivery 1                                                                                                                                                                                                        | Deferred to Delivery 2+                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Phase 0** foundations: precision widening, `externalRef` + new unique, `PositionOrigin` (`MANUAL`, `IMPORT_TRADE`, `STAKING_REWARD`), venues/exchange rows, `GET /api/exchanges`, CGT `originalBuyQty` fix, ADR 0013 + 0014 | `TRANSFER_OUT` / `TRANSFERRED` / `TRANSFER_IN` origin / `transferredFromPositionId` and the status audit (Phase 0 items 5 & 7) — ship with transfers                                                      |
| **Phase 1** manual crypto add (search → crypto exchange picker, `assetType`, precision, crypto quotes)                                                                                                                        | §4.5 transfers: crypto `deposit`/`withdrawal` ledger rows map to **UNSUPPORTED** with message "Crypto transfers aren't supported yet — add these positions manually"; reconciliation shows the difference |
| **Phase 2** import pipeline + Kraken CSV adapter + review/commit UI, incl. sells allocation, `spend`/`receive` instant buys, staking monthly parcels (§4.6) with the dust rule, reconciliation, golden test                   | **Phase 4** staking income in tax report (Migration C) and cross-batch transfer linking                                                                                                                   |
|                                                                                                                                                                                                                               | **Phase 3** Binance/Coinbase · **Phase 5** API connections + scheduled sync                                                                                                                               |

Delivery 1 acceptance = Phase 0/1/2 "Done when" criteria + the §3a golden table.

Implementer: read `piggy-api/AGENTS.md`, `piggy-fe/AGENTS.md` and the scoped
`.github/instructions/*.instructions.md` in both repos before starting. All hard rules there
still apply (asyncHandler, authenticateToken, Swagger sync, no `any`, tests in the same change
set, `yarn context:build`, land API before FE then `yarn contract:pull`).

---

## 1. Goal

Let users get crypto positions into Truffles from crypto exchanges — **Kraken now**, Binance and
Coinbase later (deferred until sample exports exist):

1. Fix the **manual** "Add Position" flow so crypto can be added by hand (currently broken).
2. **CSV import** (first) of each exchange's export → review screen → commit.
3. **API sync** (later phase) with read-only keys, manual "Sync now" + scheduled job, feeding the
   same review pipeline.

## 2. Decisions taken with the user (do not re-litigate)

| Topic                          | Decision                                                                                                                                                                                                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ingestion                      | CSV upload first; API sync (manual + scheduled) as a later phase                                                                                                                                                                                                     |
| Exchanges                      | **Kraken now.** Binance/Coinbase deferred until sample exports exist (pluggable adapter design kept)                                                                                                                                                                 |
| Position granularity           | **One Position per exchange order** (merge fills of the same order)                                                                                                                                                                                                  |
| SELL handling                  | **Review screen**: FIFO suggestion pre-filled, user can reassign to any eligible parcel (specific identification) before committing                                                                                                                                  |
| Pairs supported                | Crypto/AUD and Crypto/USD. Crypto/crypto, stablecoin-quoted and other fiat → skipped with a warning                                                                                                                                                                  |
| Currency model                 | **Separate Exchange rows per quote currency** (e.g. `KRAKEN`=AUD, `KRAKEN_USD`=USD) — keeps the "1 Exchange = 1 currency" assumption intact everywhere                                                                                                               |
| Target account                 | User picks an existing (ACTIVE) trading account                                                                                                                                                                                                                      |
| Manual crypto add              | Fix it (in scope)                                                                                                                                                                                                                                                    |
| Staking/earn rewards           | Imported; **aggregated per asset per calendar month** into one parcel; staking income shown in the tax report as ordinary income                                                                                                                                     |
| Crypto deposits from elsewhere | Shown in review; user enters original acquisition date(s) + cost base, or links to a withdrawal from another tracked exchange                                                                                                                                        |
| Crypto withdrawals             | New `TRANSFER_OUT` transaction type: reduces/ends a parcel **without** a CGT disposal; if linked to a deposit on another tracked exchange, the parcel moves there keeping its original acquisition date and AUD cost base                                            |
| Tiny ("dust") rewards          | **Skip** a monthly staking aggregate whose AUD value is below a threshold (default **A$1** per asset per month, configurable constant/env `IMPORT_DUST_THRESHOLD_AUD`). Stored as `SKIPPED` events with reason `DUST`, reported in the summary, excluded from income |
| Close reason for stop orders   | Pre-fill `closeReason = STOP_LOSS` for Kraken `stop market` / `stop limit` sells (editable in review); `take-profit*` → `TARGET`; others `null`                                                                                                                      |

## 3. Current state (findings)

- `Exchange` rows `KRAKEN` (AUD), `BINANCE` (USD), `COINBASE` (USD) already seeded in
  `src/lib/exchange-sync.ts`; `AssetType.CRYPTO` exists; `Transaction.brokerRef` exists (unused).
- **Manual crypto add is broken**: `/api/stocks/search` maps Yahoo crypto results to exchange
  `CCC` (not a known exchange → 404 on `POST /positions`), and the FE never sends `assetType`
  (so everything is stored as `EQUITY`). See `AddHoldingsDialog.tsx` `handleSymbolSelect` and
  `HoldingsTable.tsx` create payload (~line 869).
- **Precision**: `Position.entryPrice/exitPrice/stopLossPrice/takeProfitPrice`,
  `Transaction.price`, `PriceHistory.*` are `Decimal(10,4)`; fees `Decimal(8,2)`. Sub-cent coins
  (SHIB, PEPE…) cannot be stored. API validator `entryPrice min 0.0001`.
- `Position @@unique([userId, assetId, openDate, entryPrice, accountId])` — two imported orders
  with same timestamp+price would collide. Nothing in code relies on it except generic P2002→409.
- `cgt-engine.ts` derives original buy qty as `totalBuyValue / entryPrice`; `totalBuyValue` is
  `Decimal(12,2)` → wrong fee proration for tiny parcels (staking).
- `recomputePositionFromTransactions` only knows BUY/SELL.
- Quotes (`/api/stocks/quotes`) and history (`historical-drawdown.ts`) try FMP then Yahoo using the
  stored `Asset.symbol` verbatim. Yahoo understands `BTC-AUD` / `BTC-USD`.
- "1 Exchange = 1 currency" is assumed in dashboard tabs, CGT FX, statistics, history page,
  `mappers.ts` — hence the split-exchange decision.
- `express.json()` default 100 kb body limit (src/index.ts). No CSV/multipart dependency yet.
- `normalizeCode` in `exchange-sync.ts` truncates codes to 10 chars.

## 3a. Kraken export format — verified against the user's real export

Source files (user's machine, **never commit them as-is**):
`~/Documents/Projects/PiggyBank/kraken-spot-trades-2025-10-27-2026-10-18.csv` (28 fills) and
`~/Documents/Projects/PiggyBank/kraken-spot-ledgers-2025-10-27-2026-10-18.csv` (127 rows).

**trades.csv header** (24 columns, all quoted):
`txid, ordertxid, pair, aclass, subclass, time, type, ordertype, price, cost, fee, vol, margin,
misc, ledgers, posttxid, posstatuscode, cprice, ccost, cfee, cvol, cmargin, net, trades`

- `pair` uses the **new slash format** (`SOL/AUD`, `BTC/AUD`) and already-normalised asset codes
  (`BTC`, not `XXBT`). Keep legacy parsing (`XXBTZAUD`) for older exports, but the slash format is
  the primary path.
- `aclass` = `forex`, `subclass` = `crypto` (not a margin indicator). `margin` = `0.00000` for
  spot. `misc` may contain `initiated` on stop orders — informational.
- `type` ∈ `buy|sell`; `ordertype` seen: `limit`, `stop limit`, `stop market`.
- One order fills in **many rows minutes apart** (e.g. order `OHVN2M…` = 9 fills from 13:47 to
  13:51). Group by `ordertxid`.
- `cost` = gross quote amount (price × vol); `fee` = fee **expressed in quote currency**
  regardless of which asset was actually charged.
- `ledgers` = comma-separated ledger txids of the two legs (also reachable via ledger `refid` =
  trade `txid`).
- `time` = UTC `YYYY-MM-DD HH:mm:ss.ffff` (variable fraction digits).

**ledgers.csv header** (16 columns):
`txid, refid, time, type, subtype, aclass, subclass, asset, wallet, amount, fee, balance,
amountusd, feeusd, balanceusd, feecurrency`

Observed `(type, subtype, asset, wallet)` combinations:

|   Count | type    | subtype        | asset           | wallet                      | Meaning / mapping                                                                     |
| ------: | ------- | -------------- | --------------- | --------------------------- | ------------------------------------------------------------------------------------- |
|       1 | deposit | —              | AUD             | spot / main                 | Fiat deposit → **ignore**                                                             |
| 27+24+3 | trade   | tradespot      | AUD / BTC / SOL | spot / main, earn / liquid  | Trade legs → used to get **net amounts & real fee currency** for each trades.csv fill |
|       4 | earn    | autoallocation | SOL             | spot / main ↔ earn / liquid | Internal move between wallets → **ignore**                                            |
|      50 | earn    | reward         | SOL             | spot / main, earn / liquid  | Staking reward → STAKING_REWARD                                                       |
|      18 | earn    | reward         | BABY            | spot / main                 | Babylon token reward (for holding BTC) → STAKING_REWARD                               |

No crypto `deposit`/`withdrawal`, `spend`/`receive`, or `staking` rows exist in this user's data —
those mappings (§4.5, Phase 2 item 2) must be implemented from Kraken's documented format with
**synthetic fixtures using exactly the 16-column header above**, and flagged in tests as
synthetic.

**Critical fee behaviour (drives the quantity rule):**

- **Buys**: Kraken charged the fee **in the base asset**. Example order `OR37C4…` (SOL/AUD):
  trades.csv `vol 12.43781094, cost 3500, fee 8.75` (AUD-equivalent), but the ledger SOL leg is
  `amount +12.43781094, fee 0.03109453 SOL` → **net SOL received = 12.40671641**; AUD leg
  `amount −3500, fee 0`. Using `vol` as the position quantity leaves a phantom 0.0311 SOL open
  forever (the later sell is exactly 12.40671641).
- **Sells**: fee charged **in AUD** (ledger AUD leg `fee 1.112`, SOL leg fee 0) — `vol` is the
  quantity disposed.
- Users can change Kraken's fee-currency preference, so **never hard-code** "buys = base fee":
  derive it per fill from the ledger legs (`feecurrency` / which leg has `fee > 0`).

**Rule — Kraken amounts are ledger-driven** (trades.csv supplies grouping, pair, order type, time):

```
per order (Σ over fills, Decimal arithmetic):
  baseIn/out   = Σ base-leg amount            quoteIn/out = Σ quote-leg amount
  baseFee      = Σ base-leg fee                quoteFee    = Σ quote-leg fee
  vwap         = Σcost / Σvol                  (trades.csv)
BUY:  quantity   = Σ base amount − baseFee                  (coins actually held)
      costBase   = |Σ quote amount| + quoteFee              (AUD actually paid)
      entryPrice = vwap
      buyFees    = costBase − entryPrice × quantity         (= AUD-equivalent fee; ≈ trades.csv fee)
      totalBuyValue = entryPrice × quantity
SELL: quantity   = |Σ base amount| + baseFee                (coins actually leaving)
      proceeds   = Σ quote amount (gross, = Σcost)
      fees       = quoteFee + baseFee × vwap
```

This makes `entryPrice × quantity + buyFees` equal **exactly** the AUD debited, and the
simulated holdings reconcile with Kraken's ledger `balance` column.

- **Both files are required** for a Kraken import (ledgers for net amounts + rewards; trades for
  order grouping). Reject with a clear message if either is missing or the headers don't match.
- **Wallets** (`spot / main`, `earn / liquid`) are irrelevant for positions: the same coins move
  between them (autoallocation) and sells can draw from `earn / liquid`. Treat the account as one
  pool per asset.
- **Rewards**: Kraken deducts a commission → **net qty = amount − fee** (matches `balance`).
  **FMV**: use the ledger's own `amountusd − feeusd` (USD value at receipt) × USD→AUD
  (`getHistoricalFxRateToAud('USD', date)`, RBA-first) — no price lookup needed, and it works for
  tokens Yahoo doesn't list (BABY). Fall back to `getCryptoDailyCloses` only if `amountusd` is
  empty.
- **Dates**: store the exact UTC instant in `Transaction.executionTime`; set `Position.openDate` /
  `Transaction.date` to the **Australia/Sydney calendar date** at 00:00Z (same representation as a
  manual `YYYY-MM-DD` entry). Example: last sell `2026-10-15 18:59:34 UTC` → `2026-10-16`. FY
  allocation and the 12-month discount use these dates.
- `Transaction.orderType` = Kraken `ordertype`; `closeReason` pre-fill per §2.
- **Reconciliation check** (show in the review summary): after planning, simulated holdings per
  asset (+ skipped dust) must equal the last ledger `balance` per asset summed across wallets;
  display "Reconciled ✓" or a per-asset difference table. This catches missing history (e.g. the
  export date range starting after an earlier buy).

**Golden expectations for the user's export** (use as the end-to-end acceptance test on the
anonymised fixture; values in AUD, dates = Sydney):

| Parcel (buy order → sell order)               | Acquired   | Disposed   | Qty         | Cost base  | Proceeds   | Sell fees | Gain/loss | FY     |
| --------------------------------------------- | ---------- | ---------- | ----------- | ---------- | ---------- | --------- | --------- | ------ |
| SOL `OR37C4` → `OKS63B` (stop limit, 2 fills) | 2025-10-31 | 2025-11-01 | 12.40671641 | 3500.00000 | 3507.67343 | 9.18618   | −1.51     | FY2025 |
| BTC `OLEVPD` → `O2QQFO` (5 fills)             | 2026-05-03 | 2026-05-16 | 0.03197303  | 3498.47913 | 3493.69298 | 10.48108  | −15.27    | FY2025 |
| BTC `O4RUIR` → `OHVN2M` (9 fills)             | 2026-05-20 | 2026-06-01 | 0.03189703  | 3483.21977 | 3197.29130 | 9.59187   | −295.52   | FY2025 |
| BTC `OT7TEG` → `ODOZMF` (stop market)         | 2026-06-15 | 2026-08-21 | 0.03376209  | 3187.68979 | 3615.36964 | 28.92295  | +398.76   | FY2026 |
| BTC `O3ZD7J` → `OPXYQ7` (5 fills)             | 2026-10-06 | 2026-10-16 | 0.02908320  | 3577.00000 | 3459.51644 | 10.41423  | −127.90   | FY2026 |

- Every sell exactly closes the preceding buy (FIFO suggestion = the obvious answer; 0 open
  trade parcels afterwards). 5 positions, all `CLOSED`, `origin IMPORT_TRADE`.
- FY2025 net capital loss **−312.30**; FY2026 gains 398.76, losses 127.90 → with FY2025 carried
  forward (same `accountsKey`): net capital gain **0.00**, closing carry-forward loss **41.44**.
  No discount (all held < 12 months).
- Staking: SOL rewards ≈ US$0.0001–0.18/month, BABY ≈ US$0.01–0.04/month → **every monthly
  aggregate is below A$1 → all skipped as DUST**; reconciliation must still pass by counting
  skipped dust (SOL 0.0008646593, BABY 6.58872 = final ledger balances).
- The fiat AUD deposit and 4 autoallocation rows are ignored; 0 unsupported events.
- Ledger AUD amounts have 4 decimals while trades.csv `cost` has 5 (e.g. 3498.4791 vs
  3498.47913) — assert golden values to **±0.01 AUD**.

**Fixture rule**: build `src/lib/imports/__fixtures__/kraken/{trades,ledgers}.csv` from the
real files with **all txid/refid/ordertxid/posttxid values replaced by consistent fake ids**
(keep amounts, times, pairs so the golden table stays valid). **User approved** committing this
anonymised copy with real amounts/times (2026-10-18). Never commit the original files.

## 4. Core design

### 4.1 Venues and exchange rows

New code-level registry `src/lib/crypto/venues.ts`:

```ts
export const CRYPTO_VENUES = {
  KRAKEN: { AUD: 'KRAKEN', USD: 'KRAKEN_USD' },
  BINANCE: { USD: 'BINANCE', AUD: 'BINANCE_AUD' },
  COINBASE: { USD: 'COINBASE', AUD: 'COINBASE_AUD' },
} as const
export type CryptoVenue = keyof typeof CRYPTO_VENUES
export function exchangeCodeFor(
  venue: CryptoVenue,
  quote: string
): string | null
export function venueOfExchangeCode(code: string): CryptoVenue | null
export function sameVenueExchangeCodes(code: string): string[] // e.g. KRAKEN → [KRAKEN, KRAKEN_USD]
```

- Keep existing codes (production data / FE localStorage may reference them). Add
  `KRAKEN_USD`, `BINANCE_AUD`, `COINBASE_AUD` to `CORE_EXCHANGES`; rename display names to
  `Kraken (AUD)`, `Kraken (USD)`, `Binance (USD)`, `Binance (AUD)`, `Coinbase (USD)`,
  `Coinbase (AUD)`; countryName `Global`, countryCode `XX` for all crypto rows.
- Raise `normalizeCode` truncation from 10 → 20 chars (update its test).
- Add `GET /api/exchanges` (auth, optional `?assetClass=crypto|equity`) returning
  `{ code, name, currency, isCrypto }` — `isCrypto` derived from `venueOfExchangeCode`.
  New controller `src/controllers/exchanges.ts`.

### 4.2 Canonical crypto symbols

- `Asset.symbol` for crypto = **`<BASE>-<QUOTE>`** (Yahoo format): `BTC-AUD`, `ETH-USD`.
  `Asset.assetType = CRYPTO`, `Asset.name` = coin name if known else base code.
- `src/lib/crypto/symbols.ts`:
  - `normalizeAssetCode(venue, raw)` — Kraken legacy codes: `XXBT|XBT→BTC`, `XETH→ETH`,
    `XXDG|XDG→DOGE`, `XLTC→LTC`, `XXRP→XRP`, `XXLM→XLM`, `XETC→ETC`, `XZEC→ZEC`, `XXMR→XMR`,
    `ZAUD→AUD`, `ZUSD→USD`, `ZEUR→EUR`, `ZGBP→GBP`, `ZCAD→CAD`, `ZJPY→JPY`; strip staking/earn
    suffixes `.S .M .P .F .B .HOLD`, `ETH2`/`ETH2.S→ETH`. Binance/Coinbase: uppercase passthrough.
  - `parsePair(venue, raw)` → `{ base, quote } | null` — handles `XXBTZAUD`, `XBTAUD`, `ETHAUD`,
    `SOLUSD`, `BTC/AUD`, `XBT/USD`, `BTCAUD` (Binance) by matching a known-quote suffix list
    (longest first: `ZAUD, ZUSD, USDT, USDC, AUD, USD, EUR, GBP, XXBT, XBT, XETH, ETH, BTC…`).
  - `toCanonicalSymbol(base, quote)`.
- **Quote fallback for crypto** (in `/api/stocks/quotes` and `historical-drawdown.ts`): if
  `BASE-AUD` has no Yahoo/FMP result, fetch `BASE-USD` and multiply by the USD→AUD rate
  (reuse `fx-rates.ts`). Put this in `src/lib/crypto/pricing.ts`
  (`getCryptoQuote`, `getCryptoDailyCloses(base, quote, from, to)`), used by quotes route,
  drawdown/run-up, and staking FMV.

### 4.3 Schema changes (one migration per phase; never edit committed migrations)

**Migration A — `crypto_foundation` (Phase 0):**

```prisma
enum PositionOrigin { MANUAL IMPORT_TRADE STAKING_REWARD TRANSFER_IN }
enum PositionStatus { OPEN CLOSED PARTIAL TRANSFERRED }           // + TRANSFERRED
enum TransactionType { BUY SELL DIVIDEND SPLIT BONUS TRANSFER_OUT } // + TRANSFER_OUT

model Position {
  entryPrice      Decimal  @db.Decimal(24, 12)   // was (10,4)
  exitPrice       Decimal? @db.Decimal(24, 12)
  stopLossPrice   Decimal? @db.Decimal(24, 12)
  takeProfitPrice Decimal? @db.Decimal(24, 12)
  buyFees         Decimal  @default(0) @db.Decimal(18, 8)  // was (8,2)
  sellFees        Decimal? @default(0) @db.Decimal(18, 8)
  origin          PositionOrigin @default(MANUAL)
  externalRef     String   @default("")   // e.g. "KRAKEN:order:OABC12-…"; "" for manual
  transferredFromPositionId String?
  transferredFrom Position?  @relation("PositionTransfer", fields: [transferredFromPositionId], references: [id], onDelete: SetNull)
  transferredTo   Position[] @relation("PositionTransfer")
  @@unique([userId, assetId, openDate, entryPrice, accountId, externalRef])  // replaces old unique
}
model Transaction {
  price Decimal @db.Decimal(24, 12)   // was (10,4)
  fees  Decimal @default(0) @db.Decimal(18, 8)
  // brokerRef already exists → store external trade/order/ledger id
}
model PriceHistory { open/high/low/close → Decimal(24, 12) }
```

`externalRef` is non-null with default `""` so manual positions keep the old duplicate
protection (NULLs would be distinct in Postgres). Widening `DECIMAL` is lossless; verify the
generated SQL is `ALTER COLUMN … TYPE DECIMAL(24,12)` only.

**Migration B — `exchange_imports` (Phase 2):**

```prisma
enum ImportSource { KRAKEN BINANCE COINBASE }
enum ImportMethod { CSV API }
enum ImportBatchStatus { PENDING_REVIEW PARTIALLY_APPLIED COMMITTED DISCARDED FAILED }
enum ImportedEventKind { BUY SELL STAKING_REWARD DEPOSIT WITHDRAWAL UNSUPPORTED }
enum ImportedEventStatus { PENDING DEFERRED APPLIED SKIPPED DUPLICATE }

model ImportBatch {
  id          String @id @default(cuid())
  userId      String
  accountId   String
  source      ImportSource
  method      ImportMethod
  status      ImportBatchStatus @default(PENDING_REVIEW)
  connectionId String?            // Phase 5
  fileNames   String[]
  fileHash    String?             // sha256 of concatenated inputs, informational
  warnings    Json   @default("[]")
  createdAt   DateTime @default(now())
  committedAt DateTime?
  user    User           @relation(fields: [userId], references: [id], onDelete: Cascade)
  account TradingAccount @relation(fields: [accountId], references: [id], onDelete: Cascade)
  events  ImportedEvent[]
  @@index([userId, createdAt])
  @@map("import_batches")
}

model ImportedEvent {
  id           String @id @default(cuid())
  batchId      String
  userId       String
  source       ImportSource
  externalId   String              // order id / ledger refid / row hash
  kind         ImportedEventKind
  status       ImportedEventStatus @default(PENDING)
  occurredAt   DateTime
  baseAsset    String              // BTC
  quoteCurrency String?            // AUD / USD (null for staking/deposit/withdrawal)
  exchangeCode String?             // resolved Exchange.code (KRAKEN, KRAKEN_USD…)
  quantity     Decimal @db.Decimal(28, 12)
  price        Decimal? @db.Decimal(24, 12)
  grossValue   Decimal? @db.Decimal(20, 8)   // in quoteCurrency
  fee          Decimal  @default(0) @db.Decimal(18, 8)
  feeCurrency  String?
  fmvAud       Decimal? @db.Decimal(20, 8)   // staking: AUD value at receipt (set at commit)
  resolution   Json?   // user choices: allocations, deposit parcels, transfer link, skip
  appliedPositionIds String[]
  warning      String?
  raw          Json
  createdAt    DateTime @default(now())
  batch ImportBatch @relation(fields: [batchId], references: [id], onDelete: Cascade)
  @@unique([userId, source, externalId])
  @@index([userId, kind, status])
  @@map("imported_events")
}
```

**Migration C — `staking_income_in_tax_reports` (Phase 4):**
`TaxReport.stakingIncomeAud Decimal @default(0) @db.Decimal(15,2)` and
`TaxReport.incomeLineItems Json @default("[]")`.

**Migration D — `exchange_connections` (Phase 5):** see §5 Phase 5.

Every schema change: mirror in `piggy-fe/src/lib/types.ts` by hand (ADR 0007), run
`yarn context:build` in both repos (FE after `yarn contract:pull`).

### 4.4 Import pipeline (backend, `src/lib/imports/`)

```
adapters/kraken-csv.ts      parse(files) → { events: NormalizedEvent[], warnings }
adapters/binance-csv.ts
adapters/coinbase-csv.ts
adapters/index.ts           registry: getCsvAdapter(source)
types.ts                    NormalizedEvent, ImportPlan, Resolution types (+ type guards)
planner.ts                  buildPlan(events, existingParcels, …) → ImportPlan   (pure)
committer.ts                applyEvents(batchId, eventIds, userId) inside prisma.$transaction
staking.ts                  monthly aggregation + deferral rules (pure)
transfers.ts                withdrawal↔deposit matching (pure)
```

Keep adapters/planner/staking/transfers **pure** (no Prisma) so they are trivially unit-tested;
only `committer.ts` and the controller touch the DB (rule: only `lib/prisma.ts` imports
`@prisma/client`; take enum string unions from local constants as `positions.ts` does).

`NormalizedEvent`:

```ts
{ source, externalId, kind, occurredAt: Date, baseAsset, quoteCurrency?: 'AUD'|'USD',
  quantity: string /* decimal string */, price?: string, grossValue?: string,
  fee: string, feeCurrency?: string, raw: Record<string, string>, warning?: string }
```

Use decimal strings + a small decimal helper (or add `decimal.js`, already a transitive Prisma
dep — add it explicitly to `package.json` if used) to avoid float drift when summing fills.

**Order aggregation** (granularity decision): group fills by order id (Kraken `ordertxid`,
Coinbase order/ID where available). Aggregated event: `quantity = Σvol`,
`grossValue = Σcost`, `price = grossValue/quantity` (VWAP), `fee = Σfee`,
`occurredAt = earliest fill time`, `externalId = "<SOURCE>:order:<orderId>"`. Where the export
has no order id (Binance trade-history CSV), group rows with identical `(timestamp to the
second, pair, side)`; `externalId = "BINANCE:trade:" + sha256(normalized row group)`.

**Dedup**: `@@unique([userId, source, externalId])`. On upload, events whose key already exists
are stored in the _response_ as duplicates (count) but not inserted. Re-uploading the same or an
overlapping file is therefore safe. Also set `Transaction.brokerRef = externalId` and
`Position.externalRef = externalId` on commit.

**Planner rules** (per account, per base asset, chronological):

1. **BUY** → new Position on `exchangeCodeFor(venue, quote)`; asset via `findOrCreateAsset`
   (`BASE-QUOTE`, CRYPTO); `entryPrice = VWAP`, `quantity`, `buyFees = fee` (converted to quote
   currency if `feeCurrency ≠ quote`; see fees), `totalBuyValue = grossValue`,
   `capitalAllocated = grossValue + fee`, `origin IMPORT_TRADE`,
   `notes = "Imported from Kraken (order OXXXX)"`, `tags = ['import:kraken']`.
   Auto-resolved — no user input needed.
2. **SELL** → needs an allocation `[{ positionId, quantity }]` summing to the sell quantity
   (tolerance 1e-10). **Eligible parcels**: same account, same base asset, **any exchange row of
   the same venue** (`sameVenueExchangeCodes`, e.g. BTC bought on BTC/AUD can be sold via
   BTC/USD — coins are fungible inside one exchange wallet), status OPEN/PARTIAL (or created
   earlier in the same plan), `openDate ≤ sell time`, available qty after earlier allocations.
   **Suggestion** = FIFO by `openDate`, then `createdAt`. User may edit (specific identification).
   On commit, create one SELL `Transaction` per allocated parcel with prorated fee, `brokerRef`,
   `closeReason: null`, notes `"Imported sale (order X)"`, then `recomputePositionFromTransactions`.
   **Cross-currency sells**: if the parcel's exchange currency ≠ the sell's quote currency,
   convert sell price and fee into the parcel's currency using `getHistoricalFxRateToAud` for both
   currencies on the sell date (`priceParcelCcy = priceQuote * fxQuote→AUD / fxParcel→AUD`) and
   record the original quote price/rate in `notes`. This keeps the CGT engine unchanged
   (proceeds in AUD are identical).
   If eligible quantity < sell quantity → blocking issue
   `INSUFFICIENT_HOLDINGS` ("import earlier history, or resolve the deposit that brought these
   coins in"). User may also mark the sell **skipped**.
3. **STAKING_REWARD** → see §4.6.
4. **WITHDRAWAL** / **DEPOSIT** → see §4.5.
5. **UNSUPPORTED** (crypto↔crypto trades, stablecoin/other-fiat pairs, margin/futures, converts,
   fiat deposits are simply ignored, NFT, unknown ledger types) → listed with reason; never
   silently dropped; status `SKIPPED` at commit.

**Chronology / partial commit**: events are applied strictly in `occurredAt` order per
(account, base asset). The commit endpoint accepts either "everything resolvable" or a list of
event ids; it rejects applying an event while an **earlier** pending SELL/WITHDRAWAL/DEPOSIT of
the same asset in the same account is unresolved (409 with the blocking event id). This is what
lets Phase 5 auto-apply buys while sells wait for review.

**Fees in another currency**: for **Kraken**, fees in the base asset are handled exactly by the
ledger-driven rule in §3a (no price lookup). For future adapters (e.g. Binance BNB fees): convert
to the quote currency using `getCryptoDailyCloses(feeAsset, quote)` on the trade date; if
unavailable, set 0 and add a warning that the user can edit the fee in review. Document the
simplification that the tiny disposal of a third-asset fee is not modelled.

### 4.5 Transfers (withdrawals / deposits)

- **WITHDRAWAL** (crypto leaving the exchange) needs an allocation over eligible parcels (same
  rules as SELL; FIFO suggestion). Commit creates `TRANSFER_OUT` transactions (price = parcel
  entryPrice, totalValue = cost-base amount moved, fees 0, brokerRef). The network fee quantity
  is included in the TRANSFER_OUT (documented simplification: not treated as a disposal).
- **`recomputePositionFromTransactions`**: `remaining = ΣBUY − ΣSELL − ΣTRANSFER_OUT`; realized
  P&L from SELLs only; if remaining ≈ 0 → `CLOSED` when any SELL exists, else `TRANSFERRED`;
  `closeDate` = last SELL/TRANSFER_OUT date. CGT engine already only reads `type: 'SELL'` —
  add a test proving TRANSFER_OUT is never a disposal.
- **DEPOSIT** (crypto arriving) requires a resolution:
  - `link`: choose an applied/pending WITHDRAWAL (any tracked account/venue of the same user,
    same base asset, `withdrawal.occurredAt ≤ deposit.occurredAt ≤ +7 days`,
    `deposit.qty ≤ withdrawal.qty` and within 2% — suggest the best match automatically). Commit
    creates one new Position per source parcel moved (pro-rated to the received quantity),
    `origin TRANSFER_IN`, `openDate` = **source parcel's original openDate**,
    `transferredFromPositionId` = source parcel, on the destination exchange row (the venue's
    AUD row by default). Cost base must be identical in AUD: if currencies differ,
    `entryPriceDest = entryPriceSrc * fxSrc→AUD(openDate) / fxDest→AUD(openDate)`; buyFees
    pro-rated and converted the same way. One BUY transaction each (ADR 0001 preserved).
  - `manual`: user enters 1..n parcels `{ acquisitionDate, quantity, costBase, currency }`
    (sum of quantities = deposit qty). Creates Positions `origin TRANSFER_IN`, opening BUY dated
    at `acquisitionDate`.
  - `skip`.
- If the user later imports the destination exchange, pending deposits there can link to
  already-applied withdrawals (store the withdrawal's per-parcel allocation in its `resolution`
  JSON so the move can be reconstructed).

### 4.6 Staking / earn rewards

- Kraken ledger `type=staking`, or `type=earn` + `subtype=reward` (the latter is what the user's
  real export contains). Net quantity per reward = `amount − fee` (Kraken commission). Future
  adapters: Binance `Staking Rewards`, `Simple Earn … Rewards/Interest`; Coinbase `Staking
Income`, `Rewards Income`, `Inflation Reward`. Allocation/deallocation/internal wallet
  transfers (`transfer`, `earn` + `allocation|deallocation|autoallocation|migration`) are
  **ignored** (internal moves).
- Aggregate per `(account, venue, baseAsset, calendar month in Australia/Sydney)`.
  **Only completed months are applied**; rewards in the current month stay `DEFERRED` and are
  picked up by a later import/sync after month end (because a parcel can never be appended to).
- Per reward FMV (store `fmvAud` on the ImportedEvent): Kraken →
  `(amountusd − feeusd) × USD→AUD rate on the reward date` (§3a); otherwise
  `netQty × daily close of BASE-AUD` (`getCryptoDailyCloses`, USD×FX fallback).
- **Dust rule**: if a completed month's `ΣfmvAud < IMPORT_DUST_THRESHOLD_AUD` (default `1.00`),
  mark all its reward events `SKIPPED` with `warning = 'DUST'`, create **no** position, and
  exclude them from staking income. Summary shows "N reward months skipped as dust (total
  A$x.xx)". With the user's data this skips every SOL and BABY month.
- Dust interacting with later sells: if a SELL/WITHDRAWAL is short of eligible quantity by
  **≤ the cumulative skipped dust quantity** of that asset, raise a non-blocking
  `DUST_SHORTFALL` issue with a one-click resolution "ignore dust portion": allocate what exists
  and pro-rate proceeds/fees to the allocated quantity; the remainder is recorded in the event's
  `resolution` (no CGT line for the dust). Larger shortfalls remain `INSUFFICIENT_HOLDINGS`.
- One Position per non-dust month: exchange row = venue's AUD row, `openDate` = **last** reward
  date in the month (conservative for the 12-month discount — document), `quantity = ΣnetQty`,
  `entryPrice = ΣfmvAud/ΣnetQty`, `totalBuyValue = ΣfmvAud`, `buyFees 0`,
  `origin STAKING_REWARD`, `externalRef = "<SOURCE>:staking:<ASSET>:<YYYY-MM>"`, tag `staking`.
- If no FMV can be determined for a reward → blocking issue; user can enter the AUD value
  manually in review.

### 4.7 CGT engine & tax report changes

- `cgt-engine.ts`: compute `originalBuyQty` from the position's BUY transaction quantity (fallback
  to the current formula only if no BUY tx exists). Required for tiny parcels; add a regression
  test showing existing equity results are unchanged.
- Transferred-in parcels: acquisition date = `position.openDate` (already the original date) —
  add a test that the 50% discount uses the original date across a transfer.
- **Staking income (Phase 4)**: in `computeCapitalGainsReport`, also sum `ImportedEvent`
  (`kind STAKING_REWARD`, `status APPLIED`, `occurredAt` in FY, the batch's `accountId` in the
  selected non-demo accounts) → `incomeLineItems` grouped by asset (qty, AUD value) and
  `stakingIncomeAud`. Include both in `contentHash`. PDF (`pdf-report.ts`): new section
  "Other income — staking & earn rewards (ordinary income, not capital gains)" with its own note
  and the existing disclaimer. Expose in API responses + Swagger. FE reports page shows it.
- Update `docs/ato-capital-gains-methodology.md` (crypto parcels, transfers not CGT events,
  staking as ordinary income + new parcel at FMV, monthly aggregation simplification, fee
  simplifications, cross-currency sell conversion).

### 4.8 API surface (all `authenticateToken`, `asyncHandler`, `@swagger` blocks)

| Method | Path                               | Purpose                                                                                                                                                                                                                                                                                                                                       |
| ------ | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/exchanges`                   | List exchanges (`?assetClass=crypto\|equity`)                                                                                                                                                                                                                                                                                                 |
| POST   | `/api/imports`                     | Body `{ source, accountId, files: [{ kind: 'trades'\|'ledgers'\|'statement'\|'transactions', fileName, content }] }` → parse, dedupe, store batch + events, return batch summary + plan. Route-level `express.json({ limit: '10mb' })`, rate-limited (e.g. 10/hour/user via `express-rate-limit`). Account must belong to user and be ACTIVE. |
| GET    | `/api/imports`                     | List batches (paginated) with counts by kind/status                                                                                                                                                                                                                                                                                           |
| GET    | `/api/imports/:id`                 | Batch + full plan (new positions, sells w/ suggested allocations + eligible parcels, withdrawals, deposits + link suggestions, staking months incl. deferred, unsupported, issues)                                                                                                                                                            |
| PATCH  | `/api/imports/:id/events/:eventId` | Save resolution for one event (allocation / deposit parcels / link / fee or FMV override / skip). Validate sums & eligibility; return updated plan slice                                                                                                                                                                                      |
| POST   | `/api/imports/:id/commit`          | Body `{ eventIds?: string[] }` — apply all resolvable (default) or given events in one `prisma.$transaction` (raise timeout), chronological. Returns created/updated position ids; fires drawdown/run-up backfill **after** the transaction, throttled (sequential, small delay)                                                              |
| DELETE | `/api/imports/:id`                 | Discard a batch: deletes its non-APPLIED events (so files can be re-imported); batch → DISCARDED. Applied events untouched                                                                                                                                                                                                                    |

Validation errors → existing `{ error, message, details }` shape; blocking issues → 409 with the
issue list. Also loosen numeric validators in `positions.ts` (create/patch/close/close-event
patch): `entryPrice`/`exitPrice`/`stopLossPrice`/`takeProfitPrice` `min: 0.000000000001`.

## 5. Phases / work packages

Each phase is independently shippable, lands API first then FE, ships tests, runs
`yarn lint`, `yarn test --run`, `yarn build`, `yarn context:build` (both repos) and
`yarn contract:pull` in FE when the API surface changed.

### Phase 0 — Foundations (API + FE types)

1. Migration A (§4.3). Update `prisma` seed/wipe scripts if they reference the old unique.
2. `src/lib/crypto/venues.ts`, `symbols.ts`, `pricing.ts` + tests.
3. `exchange-sync.ts`: new rows, names, 20-char codes; tests.
4. `GET /api/exchanges` controller + tests + Swagger; mount in `src/controllers/index.ts`.
5. `recomputePositionFromTransactions` TRANSFER_OUT/TRANSFERRED support + tests.
6. `cgt-engine.ts` originalBuyQty from BUY tx + tests.
7. Audit every place that switches on `PositionStatus`/`TransactionType` (grep `'CLOSED'`,
   `'PARTIAL'`, `'SELL'`, `status:` in `src/controllers/*`, `statistics-engine.ts`,
   `portfolio-calc.ts`) and make sure TRANSFERRED/TRANSFER_OUT are excluded from P&L, win-rate,
   close-events, holdings and snapshots (positions listing `status` filter: allow `TRANSFERRED`).
8. ADRs (see §6), glossary entries.
9. FE: mirror enums/fields in `src/lib/types.ts` (`PositionOrigin`, `TRANSFERRED`,
   `TRANSFER_OUT`, `externalRef`, `origin`); make sure History/Statistics ignore TRANSFERRED.

**Done when**: migration applies cleanly on a copy of dev DB, all existing tests pass, a position
with `entryPrice 0.00001234` round-trips through `POST/GET /api/positions`.

### Phase 1 — Manual crypto add (API + FE)

API:

- `/api/stocks/search`: detect crypto (Yahoo `quoteType === 'CRYPTOCURRENCY'` or
  `exchDisp in ['CCC','CCY']`; FMP exchange `CRYPTO`/symbols like `BTCUSD`). Return
  `assetType: 'EQUITY'|'ETF'|'CRYPTO'` on every result (map Yahoo `ETF`, `EQUITY`), crypto
  symbol canonicalised to `BASE-QUOTE`, plus `quoteCurrency`, and `exchange: null` for crypto
  (venue must be chosen by the user). Only AUD/USD quotes kept; when user searches "BTC" make sure
  both `BTC-AUD` and `BTC-USD` are offered (synthesize the missing one if the provider returns
  only USD). Update Swagger + tests.
- `/api/stocks/quotes`: use `pricing.getCryptoQuote` for `*-AUD`/`*-USD` symbols that FMP/Yahoo
  miss (USD×FX fallback). Tests.
- `historical-drawdown.ts`: use `getCryptoDailyCloses` for crypto symbols. Tests.

FE (`piggy-fe`):

- `src/lib/api/exchanges.ts` + `useExchanges(assetClass)` hook in `src/hooks/api.ts`.
- `AddHoldingsDialog.tsx`: when the chosen result is CRYPTO, show a **"Crypto exchange"**
  dropdown listing crypto exchange rows whose `currency` = result `quoteCurrency`
  (pre-select the dashboard's current exchange if it qualifies); store `assetType` in the form.
  Price/units/fees inputs: `maxFractionDigits` 12 for price, 10 for units when crypto.
- `HoldingsTable.tsx` create/edit payloads: send `assetType` (create) — keep existing exchange
  inference for equities.
- Price formatting: `src/lib/format.ts` — `formatPrice(value, currency)` with adaptive decimals
  (≥1 → 2, <1 → up to 8 significant decimals); use it for price columns in `HoldingsTable`,
  `ClosePositionDialog`, History. Units: show up to 8 decimals; replace `toFixed(6)` in the
  close handler with 10.
- `ClosePositionDialog`: allow fractional units/price with crypto precision.
- Tests: dialog crypto path (picker shown, payload has assetType + exchange), formatting helper.

**Done when**: a user can search "BTC", pick `BTC-AUD`, choose Kraken (AUD), save, see a live
price and the position under the KRAKEN tab; `SHIB-AUD` with entry 0.00002 works end-to-end.

### Phase 2 — Import pipeline + Kraken CSV (API + FE)

API:

1. Migration B; `src/lib/imports/*` (§4.4–4.6 minus staking income); controller
   `src/controllers/imports.ts`; mount `/api/imports`; Swagger for every route.
2. **Kraken CSV adapter** (`adapters/kraken-csv.ts`) — implement exactly the verified format and
   the ledger-driven amount rule in **§3a**. Header-driven (match by column name, ignore unknown
   extra columns), both files required:
   - `trades.csv`: required columns `txid, ordertxid, pair, time, type, ordertype, price, cost,
fee, vol, margin, ledgers`. Group fills by `ordertxid`; join each fill to its two ledger
     legs via `ledgers` (fallback: ledger `refid = txid`). `margin ≠ 0` → UNSUPPORTED (margin).
     Pairs whose quote isn't AUD/USD, or whose base is fiat/stablecoin → UNSUPPORTED.
   - `ledgers.csv`: required columns `txid, refid, time, type, subtype, asset, amount, fee,
balance`; optional `wallet, amountusd, feeusd, feecurrency, aclass, subclass,
balanceusd`. Mapping:
     - `trade`/`tradespot` → consumed via the trades join (never a standalone event). A ledger
       trade leg with no matching trades.csv fill → warning "trades.csv does not cover this
       period" + reconciliation difference.
     - `earn`+`reward`, `staking` → STAKING_REWARD (net qty, USD FMV — §3a/§4.6).
     - `earn`+`autoallocation|allocation|deallocation|migration`, `transfer` → ignored.
     - `deposit`/`withdrawal` of fiat → ignored; of crypto → DEPOSIT / WITHDRAWAL (synthetic
       fixtures — not present in the user's data).
     - `spend` + `receive` sharing a `refid` (Kraken "Buy Crypto" instant buy/sell) → BUY or
       SELL with `externalId = KRAKEN:instant:<refid>` (synthetic fixture).
     - `margin`, `rollover`, `settled`, `adjustment`, `sale`, anything unknown → UNSUPPORTED
       with the raw type in the message.
   - Times: UTC `YYYY-MM-DD HH:mm:ss[.f…]`; dates per §3a (Sydney calendar date).
   - Add dependency `csv-parse` (sync API) for parsing; `yarn add csv-parse`. Use `decimal.js`
     (add explicitly) for all amount maths.
   - Reconciliation (§3a) computed by the planner and returned in the plan summary.
3. Committer + chronology checks + 409 blocking rules; drawdown/run-up backfill after commit
   (skip backfill for positions that are already CLOSED within the same import to avoid needless
   Yahoo calls — or run it throttled; user's data creates 5 closed positions).
4. Tests: fixture-driven adapter tests on the **anonymised real fixture** (§3a fixture rule) plus
   small synthetic fixtures for deposit/withdrawal/spend-receive/margin/unknown types; planner
   tests (golden table §3a, FIFO suggestion, user override, cross-currency sell conversion,
   insufficient holdings, dust skip + `DUST_SHORTFALL`, deferred current month, chronology
   blocking, duplicate re-upload, reconciliation pass/fail when the first buy is removed from the
   fixture), committer tests with mocked Prisma, controller tests (auth, ownership,
   demo/closed account rules, body limit, missing file kind, wrong headers, validation).

FE:

1. `src/lib/api/imports.ts`, hooks `useImports`, `useImport(id)`, `useCreateImport`,
   `useResolveImportEvent`, `useCommitImport`, `useDiscardImport`; on commit invalidate
   positions, portfolio, portfolio history, close-events, statistics, tax position-usage keys
   (check `context/data-flow.md` for the key catalog).
2. Entry point: **"Import from exchange"** button next to "Add Position" in `HoldingsTable.tsx`
   header (account locked to the selected account, like `lockAccount` for Add). Opens
   `ImportUploadDialog` (source selector shows **Kraken only** for now — Binance/Coinbase
   rendered as "coming soon" or omitted; Kraken "how to export" instructions: _History → Export
   → Trades_ **and** _Ledgers_, same date range, CSV; two file pickers labelled "Trades CSV" and
   "Ledgers CSV"; read files as text client-side, upload). Disabled when offline
   (imports are online-only; do not queue).
3. Review page `src/app/imports/[id]/page.tsx` (+ `src/app/imports/page.tsx` history list):
   sections Summary (counts, reconciliation ✓/differences, dust skipped total) · New positions ·
   Sells (allocation editor: eligible parcels table with quantity inputs, FIFO pre-filled,
   "Reset to FIFO", live remaining-to-allocate counter, close-reason select pre-filled per §2) ·
   Withdrawals (same editor) · Deposits (link suggestion / manual parcels form / skip) ·
   Staking (applied months, dust-skipped months, deferred current month) · Unsupported &
   warnings · Duplicates count. Sticky footer: "Commit N events" disabled while blocking issues
   remain; "Discard".
4. Tests: upload dialog (both files required), allocation editor validation, deposit
   manual-parcel form sums, commit button gating, reconciliation banner, hooks with mocked axios.

**Done when**: uploading the user's Kraken trades + ledgers export (or the anonymised fixture)
into an account produces exactly the 5 closed positions in the §3a golden table, skips all
rewards as dust, shows "Reconciled ✓"; re-uploading the same files creates nothing new; the
FY2025/FY2026 CGT reports match the golden totals.

### Phase 3 — Binance + Coinbase CSV adapters — **DEFERRED (blocked on sample exports)**

Do **not** implement until the user provides real (anonymised) exports and, for Binance,
confirms global vs Binance Australia. The notes below are background only; the formats must be
re-verified against the samples the same way §3a was for Kraken.

- **Binance**: support (a) Spot **Trade History** export (`Date(UTC), Pair, Side, Price,
Executed, Amount, Fee` — amounts carry the asset suffix e.g. `0.01BTC`, `650AUD`, fee may be in
  BNB) and (b) **Transaction History / account statement** (`User_ID, UTC_Time, Account,
Operation, Coin, Change, Remark`) for deposits, withdrawals and rewards. Binance global quotes
  are mostly USDT → those pairs are UNSUPPORTED with a clear message; AUD (Binance Australia) and
  USD pairs supported. No order id → grouping rule from §4.4.
- **Coinbase**: **Transaction history** CSV (preamble lines before the header; columns like
  `ID, Timestamp, Transaction Type, Asset, Quantity Transacted, Price Currency, Price at
Transaction, Subtotal, Total (inclusive of fees and/or spread), Fees and/or Spread, Notes`).
  Types: `Buy`, `Advanced Trade Buy` → BUY; `Sell`, `Advanced Trade Sell` → SELL; `Send` →
  WITHDRAWAL; `Receive` → DEPOSIT; `Staking Income`, `Rewards Income`, `Inflation Reward` →
  STAKING_REWARD; `Convert` → UNSUPPORTED (crypto↔crypto); `Learning Reward` → UNSUPPORTED with
  "ordinary income, add manually" warning; fiat `Deposit`/`Withdrawal` ignored. `Price Currency`
  determines AUD/USD row. Detect header row by scanning for `Timestamp` + `Transaction Type`.
- Both: fixtures from real anonymised exports, same test matrix as Kraken. Export formats drift —
  keep parsers header-name-based and fail with a clear "unrecognised export format, expected
  columns …" error rather than guessing.
- FE: add the two sources + export instructions to the upload dialog.

### Phase 4 — Staking income in tax report + transfer linking polish

- Migration C; engine/PDF/API/FE changes from §4.7; tests for FY boundaries, account scoping,
  demo exclusion, contentHash change, PDF section present.
- Cross-batch deposit↔withdrawal linking UX (deposit in one batch/account linking to a
  withdrawal applied from another Kraken batch or account; becomes cross-exchange once Phase 3
  lands) + tests.

### Phase 5 — API connections + scheduled sync

Schema (Migration D):

```prisma
enum ExchangeConnectionStatus { ACTIVE ERROR DISABLED }
model ExchangeConnection {
  id           String @id @default(cuid())
  userId       String
  accountId    String
  source       ImportSource
  label        String
  apiKeyEnc    String      // AES-256-GCM, base64(iv|tag|ciphertext)
  apiSecretEnc String
  keyLast4     String
  status       ExchangeConnectionStatus @default(ACTIVE)
  cursor       Json @default("{}")      // per-endpoint last seen ids/timestamps
  lastSyncedAt DateTime?
  syncingSince DateTime?                // simple lock; stale after 30 min
  lastError    String?
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  @@unique([userId, source, accountId])
  @@map("exchange_connections")
}
```

- `src/lib/secret-box.ts`: AES-256-GCM with `EXCHANGE_CREDENTIALS_KEY` (32-byte base64 env var;
  app refuses to create connections if unset). Add to `.env.example` and `docs/deployment.md`.
  Secrets never returned by any endpoint, never logged (sanitize upstream error messages).
- Clients (`src/lib/imports/api/`):
  - **Kraken** (first): `POST /0/private/TradesHistory` and `/0/private/Ledgers`, headers
    `API-Key`, `API-Sign = base64(HMAC-SHA512(uriPath + SHA256(nonce + postData), base64decode(secret)))`,
    monotonically increasing nonce (ms timestamp ×1000 + counter), pagination via `ofs`
    (50/page) and `start` cursor; respect the call-rate counter (back off on `EAPI:Rate limit
exceeded`). Output → same `NormalizedEvent`s as the CSV adapter (share the mapping code).
  - **Binance** (**deferred with Phase 3**): HMAC-SHA256 signed; `GET /sapi/v1/account/apiRestrictions` at creation → reject
    keys with trading or withdrawal enabled; trades via `/api/v3/myTrades` (per symbol — derive
    symbol list from balances + deposit history), deposits `/sapi/v1/capital/deposit/hisrec`,
    withdrawals `/sapi/v1/capital/withdraw/history`, rewards via Simple Earn/asset dividend
    endpoints. Verify current endpoints against official docs at implementation time.
  - **Coinbase** (**deferred with Phase 3**) Advanced Trade (CDP keys, ES256 JWT): fills `/api/v3/brokerage/orders/historical/fills`,
    plus v2 transactions for send/receive/staking; `GET /api/v3/brokerage/key_permissions` →
    reject `can_trade`/`can_transfer` keys. Verify against official docs at implementation time.
- Sync semantics: each sync appends events to a rolling PENDING batch per connection
  (`method API`). **BUYs and completed staking months are auto-applied**; SELL/WITHDRAWAL/DEPOSIT
  stay PENDING for review (chronology rule from §4.4 protects ordering). FE shows a
  "N items need review" badge on the account/dashboard and in the imports list.
- Endpoints: `GET/POST /api/exchange-connections`, `PATCH /:id` (label/disable),
  `DELETE /:id`, `POST /:id/sync` (rate limited, respects lock).
- Scheduler: `scripts/sync-exchange-connections.ts` + `yarn sync:exchanges`; cron example in
  `docs/deployment.md` (e.g. every 6 h), mirroring the purge job. Skips users with `deletedAt`
  set; on account soft-delete, connections are set DISABLED immediately.
- FE: "Exchange connections" section in `src/app/account/page.tsx` (add key/secret with clear
  "create a **query-only** key" instructions per exchange, status, last sync, Sync now, remove).
- Tests: signing functions against known vectors, pagination/cursor, rate-limit backoff, lock,
  encryption round-trip + tamper detection, permission rejection, controller tests.

## 6. Documentation & ADRs

- `docs/adr/0013-exchange-imports-sell-allocation.md` — imports keep "one BUY per Position";
  sells/withdrawals are allocated to parcels at import time by **user-confirmed specific
  identification with a FIFO suggestion**; the CGT engine still does no lot matching. Amend the
  "No FIFO" wording in ADR 0001, `tax.instructions.md` and `prisma.instructions.md` to point here.
- `docs/adr/0014-crypto-venues-split-by-quote-currency.md`.
- `docs/adr/0015-crypto-transfers-and-staking-parcels.md` (TRANSFER_OUT, TRANSFERRED, cost-base
  carry-over, monthly staking parcels + deferral, staking income reporting).
- `docs/adr/0016-exchange-api-credentials.md` (Phase 5).
- `docs/glossary.md`: Venue, Import batch, Imported event, Allocation, Transfer, Staking parcel.
- `docs/ato-capital-gains-methodology.md` updates (§4.7).
- `AGENTS.md` (both repos): mention imports + hard rule "imports never append to a Position".

## 7. Inputs from the user

- ✅ **Kraken** spot trades + ledgers export received (2025-10-27 → 2026-10-18) and analysed in
  §3a. User confirmed this is their **full Kraken history** (started 2025-10-27), so
  reconciliation is expected to pass with no prior holdings.
- ⏸ **Binance / Coinbase**: user currently has no history there → Phase 3 and their Phase 5 API
  clients stay deferred until samples (and, for Binance, global vs Australia) are provided.
- ✅ User approved committing the anonymised fixture with real amounts/times (ids replaced).

## 8. Known simplifications (document in methodology + UI)

- Kraken fees charged in the base asset are folded into cost base/quantity exactly (§3a); fees in
  a third asset (future Binance BNB) are converted and the tiny fee-asset disposal is not modelled.
- Network fees on withdrawals reduce quantity without a CGT event.
- Staking parcels aggregated monthly with acquisition date = last reward of the month.
- Staking months worth < A$1 (configurable) are skipped as dust: no parcel, not counted as income,
  later disposals of that dust produce no CGT line.
- Crypto↔crypto trades, stablecoin-quoted trades, margin/futures, NFTs, airdrops/forks and
  "learning rewards" are not imported (warned).
- Not tax advice — existing disclaimer applies to everything above.
