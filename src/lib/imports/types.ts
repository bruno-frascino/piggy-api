export type ImportSourceName = 'KRAKEN' | 'BINANCE' | 'COINBASE'

export type ImportEventKind =
  | 'BUY'
  | 'SELL'
  | 'STAKING_REWARD'
  | 'DEPOSIT'
  | 'WITHDRAWAL'
  | 'UNSUPPORTED'

export type QuoteCurrency = 'AUD' | 'USD'

/** One exchange-agnostic event. All amounts are decimal strings. */
export interface NormalizedEvent {
  source: ImportSourceName
  externalId: string
  kind: ImportEventKind
  occurredAt: Date
  baseAsset: string
  quoteCurrency?: QuoteCurrency
  /**
   * BUY: coins actually received (net of base-asset fees).
   * SELL: coins that left the wallet (gross, including base-asset fees).
   * STAKING_REWARD: net coins received.
   */
  quantity: string
  /** VWAP in the quote currency. */
  price?: string
  /** BUY: price × quantity. SELL: gross proceeds. Both in the quote currency. */
  grossValue?: string
  /** BUY: total fees in the quote currency. SELL: fees in the quote currency. */
  fee: string
  feeCurrency?: string
  raw: Record<string, string>
  warning?: string
}

export interface ParseResult {
  events: NormalizedEvent[]
  warnings: string[]
  /** Last reported balance per base asset, summed across wallets. */
  ledgerBalances: Record<string, string>
}

export type CloseReasonName = 'STOP_LOSS' | 'TARGET' | 'MANUAL' | 'OTHER'

export interface EventResolution {
  /** Do not import this event. */
  skip?: boolean
  /** Explicit sell allocation; replaces the FIFO suggestion. */
  allocations?: Array<{ positionRef: string; quantity: string }>
  closeReason?: CloseReasonName | null
  /** Staking: AUD value override when none could be determined. */
  fmvAud?: string
}

export interface PlannerEvent extends NormalizedEvent {
  id: string
  resolution?: EventResolution | null
}

export interface ExistingParcel {
  id: string
  baseAsset: string
  exchangeCode: string
  currency: string
  openDate: Date
  createdAt: Date
  remainingQty: string
  entryPrice: string
}

export type IssueType =
  | 'INSUFFICIENT_HOLDINGS'
  | 'DUST_SHORTFALL'
  | 'INVALID_ALLOCATION'
  | 'MISSING_FMV'
  | 'MISSING_FX'

export interface PlanIssue {
  type: IssueType
  blocking: boolean
  eventId: string
  externalId: string
  message: string
}

export interface PlannedParcel {
  /** Stable reference: `event:<externalId>` / `staking:<key>` for new parcels. */
  ref: string
  origin: 'IMPORT_TRADE' | 'STAKING_REWARD'
  externalRef: string
  symbol: string
  baseAsset: string
  quoteCurrency: QuoteCurrency
  exchangeCode: string
  acquiredAt: Date
  openDate: Date
  quantity: string
  entryPrice: string
  totalBuyValue: string
  buyFees: string
  orderType: string | null
  notes: string
  tags: string[]
  eventIds: string[]
}

export interface PlannedAllocation {
  positionRef: string
  quantity: string
  /** In the parcel's currency. */
  price: string
  totalValue: string
  fees: string
  notes: string | null
}

export interface PlannedSell {
  eventId: string
  externalId: string
  occurredAt: Date
  sellDate: Date
  baseAsset: string
  quoteCurrency: QuoteCurrency
  quantity: string
  orderType: string | null
  closeReason: CloseReasonName | null
  allocations: PlannedAllocation[]
  userOverridden: boolean
  dustIgnored: string | null
  resolved: boolean
  /** Parcels this sale could draw on, with the quantity left at the time of the sale. */
  eligible: Array<{
    positionRef: string
    remaining: string
    acquiredAt: Date
    currency: string
  }>
}

export interface StakingMonth {
  key: string
  baseAsset: string
  month: string
  eventIds: string[]
  quantity: string
  fmvAud: string
  /** AUD value per reward event (empty until the month is valued). */
  fmvByEvent: Record<string, string>
  status: 'APPLY' | 'DUST' | 'DEFERRED' | 'BLOCKED'
}

export interface ReconciliationRow {
  asset: string
  expected: string
  simulated: string
  difference: string
}

export interface Reconciliation {
  reconciled: boolean
  rows: ReconciliationRow[]
}

export type PlanStep =
  | { type: 'PARCEL'; ref: string; at: Date }
  | { type: 'SELL'; eventId: string; at: Date }

export interface ImportPlan {
  newPositions: PlannedParcel[]
  sells: PlannedSell[]
  staking: StakingMonth[]
  unsupported: Array<{ eventId: string; externalId: string; reason: string }>
  skipped: Array<{ eventId: string; externalId: string; reason: string }>
  issues: PlanIssue[]
  reconciliation: Reconciliation | null
  /** Application order (chronological per asset). */
  steps: PlanStep[]
  summary: {
    buys: number
    sells: number
    stakingMonthsApplied: number
    stakingMonthsDust: number
    stakingMonthsDeferred: number
    dustTotalAud: string
    unsupported: number
    skipped: number
    blockingIssues: number
  }
}
