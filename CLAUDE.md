# dYdX Trading Dashboard - Development Notes

## Chart Explanations

### Trading Activity by Market (formerly Market Exposure)
The Trading Activity chart (doughnut chart on Overview tab) shows:
- Distribution of your trades across different markets (ETH-USD, BTC-USD, etc.)
- Each slice size = number of trades in that market (CLOSED count)
- Labels show market name and trade count
- Legend shows percentage of total trading activity
- Hover tooltip displays:
  - Number of trades and percentage
  - Profit for that market labeled "Profit (incl. funding − fees)" = realized of CLOSED + unrealized of OPEN + netFunding − fees across every fill in the market (same definition as Performance-by-Asset PROFIT column AND the Total Profit headline)
  - Number of open positions
- Shows top 5 most traded markets
- Helps identify trading focus and diversification

## Dashboard Components

### Data Sources
- All price data: dYdX v4 API (`/v4/candles/perpetualMarkets/ETH-USD`)
- Account data: dYdX v4 API (`/v4/addresses/{address}/subaccountNumber/0`)
- Position data: dYdX v4 API (`/v4/perpetualPositions`)

### Key Variables
- `currentPortfolioData`: Stores all portfolio data from API (never pre-initialized)
- `currentAddress`: Currently loaded dYdX address
- `currentETHPrice`: Latest ETH price from dYdX

### Important Rules
1. Never show demo/fake data
2. Always require real dYdX address
3. Display "—" when no data available (or "Data not available" caption when the metric itself is unimplemented)
4. Auto-load from URL if address parameter present
5. **No metric is better than a wrong metric.** If a number can't be computed correctly from available data, render `—` and label "Data not available". Do not invent placeholder formulas.

### Last-address cache (`portfolio-cache.js`)

`loadDashboard()` runs a stale-while-revalidate cycle: on page load it tries to paint a cached snapshot before any network call, then always issues the foreground fetches and overwrites both `allData` and the cache slot when every endpoint succeeds. Reloads of the same address feel instant; the user still gets fresh data within the normal fetch window.

- **Storage key**: `dydxCache:v1`. Single slot, address-keyed. Loading a different address overwrites the slot.
- **Schema**: `{ v: 1, address, fetchedAt, data }` where `data` is the raw response map (`subaccount`, `openPositions`, `orders`, `markets`, `closedPositions`, `fills`, `fundingPayments`, `historicalPnl`). Derived fields like `allData.positions` are NOT persisted — `processData()` rebuilds them on hydrate. When the response shape of any cached field changes, bump `SCHEMA_VERSION` in `portfolio-cache.js` so old payloads are rejected as stale.
- **Compression**: `LZString.compressToUTF16` (~3:1 on JSON-shaped data). Loaded from CDN alongside Chart.js; if the CDN fails, `PortfolioCache` no-ops cleanly and the dashboard behaves exactly as it did before the cache existed.
- **Eviction order** on `QuotaExceededError` (largest payloads first): `fills` → `fundingPayments` → `historicalPnl` trimmed to last 5000 rows → `closedPositions`. Each step is retried once before the next is applied; if the slot still won't fit, the cache write is skipped silently.
- **Persistence rule**: snapshot is written only when **all** endpoints succeed in a refresh, so a partial fetch can never replace a complete cache with a degraded one. `lastAddress` is still written on every successful load as the address-only fallback.
- **Forget**: clears both `lastAddress` and `dydxCache:v1`.

`PortfolioCache.read(address)` returns the cached `data` map (or `null` on miss / schema mismatch / address mismatch / corruption). `PortfolioCache.write(address, snapshot)` accepts a raw response map and handles compression + eviction. `PortfolioCache.clear()` drops the slot. The pure helpers `pack`, `unpack`, and `evictOnce` are exported on `_internal` for unit testing without LZString or localStorage.

## Metric Definitions (single source of truth)

All trade-classification, return, drawdown, and adequacy logic lives in `risk-metrics.js` on `window.RiskMetrics`. **Do not recompute these inline in `index.html` — call the helper.** When semantics change, update the helper AND this section in the same commit.

### Trade classification
A position with `status === 'CLOSED'` is bucketed by `realizedPnl`:
- `> 0` → **win**
- `< 0` → **loss**
- `== 0` → **scratch**

`decisiveCount = winCount + lossCount` (excludes scratches). Use `decisiveCount` as the denominator for win-rate-style ratios so the same value never reads two ways across cards.

Helper: `RiskMetrics.classifyClosed(positions)` returns `{ wins, losses, scratches, all, grossWin, grossLoss, totalRealized, winCount, lossCount, scratchCount, decisiveCount, closedCount }`.

### Per-trade return
`r = realizedPnl / (maxSize × entryPrice)` — fraction of max-instantaneous notional ever held during the position lifecycle. `maxSize` (when the indexer exposes it) is the honest "peak capital at risk" for scaled-in/out positions; `sumOpen` overstates exposure because it sums every entry. Falls back to `sumOpen` and then `size` when `maxSize` is absent so legacy responses still produce a number, with the caveat that scaled positions then read smaller-than-actual returns. Used for per-trade Sharpe (fallback) AND asset-level Sharpe so the two cards never disagree. Helper: `RiskMetrics.tradeReturn(p)` (returns `null` when notional is undefined).

### Total Profit (headline)
`totalPnL = FIFO realized over /fills + Σ unrealizedPnl over OPEN positions + Σ netFunding over every position − Σ fees over every fill`. Realized is computed **bottom-up from /fills via FIFO inventory walk** (`computeRealizedFromFills`), NOT from `/perpetualPositions.realizedPnl`. The indexer field has observed accounting gaps — it undercounts lifetime realized on heavy-scaling accounts by tens of percent (verified against equity-truth via `/historical-pnl totalPnl`). FIFO over the raw fill records reconciles to the equity-based curve within float-rounding. The Total Profit hero card surfaces the split as a three-cell ledger:

- **TRADING** = `computeRealizedFromFills(fills).total + Σ unrealizedPnl of OPEN positions`
- **FUNDING** = `netFundingTotal(positions)` — positive contribution when received, negative when paid
- **FEES** = `−feesTotal(fills)` — displayed as a *signed contribution to profit*. dYdX `fill.fee` is positive when the user paid (taker / most maker fills) and negative for maker rebates, so the cell renders the paid amount as a negative dollar value (red) and rebates as positive (green)

Headline math: `TRADING + FUNDING + FEES_contribution`. Helpers:
- `RiskMetrics.computeRealizedFromFills(fills)` — `{ total, byMarket }` from FIFO inventory walk; handles position flips atomically (closes current lots, opens fresh opposite-side inventory at the flip-fill price for residual size)
- `RiskMetrics.netFundingTotal(positions)` — funding component
- `RiskMetrics.feesTotal(fills)` — sum of `fill.fee` (positive = paid)
- `RiskMetrics.marketFees(fills)` — `{ [market]: feesPaid }` map for the per-asset table

A reconciliation guard fires (`console.error`) when `|headline − /historical-pnl latestTotalPnl| > max($1, |latestTotalPnl|×1%)`. The guard never trips on accounts with complete `/fills` to inception; if it fires, the structured payload (trading / funding / fees / equityBased / gap / row counts / activeChildSubaccounts) tells the operator which stream to inspect.

A second per-fetch guard surfaces **isolated-margin blind spots**. dYdX v4 supports up to 128k subaccounts per address; isolated-margin positions live in children (≥128 per convention). The dashboard analyses sub=0 only, so a child sub with non-zero equity, open positions, or asset balances is invisible to every per-stream calculation. On every load, `/addresses/{address}` enumerates every subaccount; `RiskMetrics.activeChildSubaccounts(subs)` returns the children with state. When non-empty, `console.warn` fires with the affected sub numbers so the operator knows the headline is partial. The error path's `childHint` references the same list so a `_reconciliation FAILED_` payload mentions isolated margin as a likely contributor.

Classification (`classifyClosed`) still keys off the indexer's `realizedPnl` for Win Rate / Profit Factor / Avg Win / Avg Loss / Risk:Reward / Expectancy. Those metrics are trade-quality summaries where per-position attribution matters more than absolute precision — they're not lifetime-profit estimates.

### Per-market Profit
`total = realized (FIFO from /fills) + unrealized of OPEN in that market + netFunding across every position in that market − fees on fills in that market`. Used by the Overview chart tooltip AND the Performance-by-Asset table. Helper: `RiskMetrics.marketPnL(positions, feesMap?, realizedByMarket?)` (returns `{ realizedClosed, unrealizedOpen, netFunding, fees, total, closedCount, openCount }`).

- `feesMap` is optional `{ [market]: feesPaid }` (positive = paid). Omitting keeps prior behavior.
- `realizedByMarket` is optional `{ [market]: realized }` from `computeRealizedFromFills(...).byMarket`. When provided, it OVERRIDES the sum of per-position `realizedPnl` field as the source for `slot.realizedClosed`. Omitting falls back to the indexer-based sum (legacy behavior; lossy on scaled accounts).

### Monthly Performance Breakdown — PNL column
`PNL = lastOfMonth.totalPnl − lastOfPriorMonth.totalPnl` from `/historical-pnl`. Same series as headline drawdown and MAX DD on the row, so the column is dimensionally consistent with every other monthly column. Helper: `RiskMetrics.histPnlMonthly(historicalPnl)` returns `{ [monthKey]: { delta, hasData } }`. Months with no `/historical-pnl` rows render `—` (no-metric > wrong-metric). The earliest observed month gets `delta = firstRow.totalPnl − 0`, which slightly overstates that first month when `/historical-pnl` was paginated-capped; the existing `historyCapped` banner already discloses that case. Win Rate / Avg Win / Avg Loss / Profit Factor in the same row stay on `realizedPnl` because they are trade-quality metrics.

### Headline Max Drawdown
$ DD on cumulative `totalPnl` from `/historical-pnl` (realized + unrealized profit over time, excluding net transfers). Peak-to-trough in chronological order. This series captures unrealized peaks the closed-trade ledger cannot see (e.g. a +$364K open profit that later got given back). Helper: `RiskMetrics.histPnlDrawdown(historicalPnl)`.

Falls back to trade-system $ DD on cumulative `realizedPnl` (`RiskMetrics.tradeSystemDrawdown(positions)`) when historical-pnl is unavailable OR when it produced no positive drawdown (an empty/monotonic series). The Recovery Factor and Drawdown Periods table follow the same fallback rule so all drawdown-derived cards stay aligned.

The Drawdown Periods table enumerates every peak→trough→recovery event on the same `totalPnl` curve via `RiskMetrics.histPnlDrawdownEvents(historicalPnl)` (with the same trade-system fallback). The Monthly Performance Breakdown's MAX DD column applies `histPnlDrawdown` to that month's slice, so it shares the headline's definition.

The Recovery Factor card uses the matching numerator: latest `totalPnl` ÷ headline DD when on the historical-pnl path; `cls.totalRealized` ÷ trade-system DD when on the fallback path. The numerator/denominator never come from different profit series.

### Current Drawdown
`$ DD = max(0, peak − latest)` on the same `totalPnl` series as Headline Max Drawdown — the two cards always share their P&L stream so they cannot disagree about which side of the ledger is being measured. `0` means the account is at-or-above its prior peak; positive value means the account has given back that many dollars since the peak. Helper: `RiskMetrics.histPnlCurrentDrawdown(historicalPnl)` returns `{ dollarDrawdown, pctOfPeakProfit, peakAt, peakValue, currentAt, currentValue, n, hasData }`.

Falls back to `RiskMetrics.tradeSystemCurrentDrawdown(closedPositions)` (cumulative `realizedPnl`) using the same `drawdownSource` decision as Max Drawdown — if the hist path was skipped for the max card, it's skipped for the current card too. `hasData: false` on an empty series → render `—` with "No equity series available".

Visual states on the card:
- `hasData = false` → `—`, detail "No equity series available" (or "No closed trades")
- `dollarDrawdown ≤ 0` → `$0`, green (profit class), detail "At peak (YYYY-MM-DD)"
- `dollarDrawdown > 0` → `−$X`, red (loss class), detail "Nd below peak (since YYYY-MM-DD) · Y.Y% of peak"

The "days below peak" duration is derived inline from `peakAt`/`currentAt` timestamps (rounded to whole days). `pctOfPeakProfit` is suppressed when peak ≤ 0 (no positive peak profit to denominate against).

### Drawdown of arbitrary equity series
Use `RiskMetrics.validDrawdownFromEquity(equityArray)` for the Calmar denominator on TWR wealth. No longer feeds the headline. Returns `null` when peak ≤ 0 OR trough < 0 — these are synthetic-equity artifacts that arise when the inception-time principal proxy goes under zero (e.g. a wipe followed by a redeposit). Filtered drawdowns must render as `—`.

### Sample-adequacy gate
A statistical metric (Sharpe, Sortino, Calmar, VaR, CVaR, monthly Sharpe) renders `—` unless the time-weighted-return sample passes ALL three constants (defined in `risk-metrics.js`):
- `MIN_RETS = 30` (at least 30 valid TWR returns)
- `MIN_YEARS = 1/12` (at least one month of valid coverage)
- `MIN_COVERAGE = 0.5` (at least half the historical-pnl rows produced a valid return — protects against post-wipeout sample bias)

Helper: `RiskMetrics.assessAdequacy(returns, timestamps, histLength)` → `{ adequate, reason, ppy, years, coverage, n }`. The same gate fires for Sharpe/Sortino/Calmar AND VaR/CVaR — the dashboard never shows VaR for a sample window that's too short to support Sharpe.

When the time-series gate fails, Sharpe/Sortino/Calmar fall back to `computeTradeBasedMetrics(positions)` which derives an annualized per-trade Sharpe from the realized-profit log. VaR/CVaR have no fallback — they render `—` with the gate reason.

### Cross-margin liquidation price
dYdX is cross-margin. Per-position liq price assumes OTHER open positions hold their current unrealized profit contribution — exact for single-position accounts; isolation approximation otherwise. Derivation: at liquidation, account equity equals maintenance margin requirement computed off liquidation-price notional (`MMR = |size| × P_liq × MMF`).
- LONG:  `P_liq = (size × oracle − equity) / (size × (1 − MMF))`
- SHORT: `P_liq = (equity + oracle × |size|) / (|size| × (1 + MMF))`

Helper: `RiskMetrics.crossMarginLiqPrice(position, subaccount, marketsMap)` returns `null` when MMF / size / equity unavailable.

The Liquidation Risk Analysis table's LEVERAGE column shows `notional / subaccount.equity` where `notional = |size| × oracle` (mark-based, matches dYdX's official UI). Falls back to entry price when oracle is unavailable. Per-position equity does not exist on the dYdX API.

Two display-side helpers wrap the formula so the Risk-tab Leverage card and the per-row LEVERAGE column never diverge: `RiskMetrics.leverageUtilization(positions, subaccount, marketsMap)` returns the account-level ratio; `RiskMetrics.liquidationRow(position, subaccount, marketsMap)` returns `{ size, entry, oracle, notional, lev, liq, distancePct }`. Position objects from `/perpetualPositions` do **not** carry `oraclePrice` — the oracle price lives on `marketsMap[market].oraclePrice`. Both helpers and `crossMarginLiqPrice` follow the same fallback chain `position.oraclePrice || marketsMap[market].oraclePrice || position.entryPrice`. All three are unit-tested in `test/risk-metrics.test.js`.

## Tax report (Portugal)

All tax-year report logic lives in `tax-report.js` on `window.TaxReport`. **Do not recompute these inline in `index.html` or in panels — call the helper.** ECB daily FX rates live in `fx-rates.js` on `window.FxRates`. The Tax panel (`src/panels/tax.js`) is wiring + DOM only. When semantics change, update the helper AND this section in the same commit.

### Year boundary
A closed position belongs to tax year `Y` iff `new Date(position.closedAt).getUTCFullYear() === Y`. UTC is mandatory: Portuguese local time (WET/WEST) would misclassify late-Dec UTC trades.

Helper: `TaxReport.closedAtYearUTC(position)` returns `null` for invalid timestamps.

### Fee attribution
Per-fill fees on `/v4/fills` are attributed to a closed position when ALL hold: `fill.market === position.market`, `upper(fill.side) === upper(position.side)`, and `Date.parse(fill.createdAt) ∈ [position.createdAt, position.closedAt]`. When ANOTHER closed position in the same `(market, side)` overlaps the same window, the row carries `_feeAttributionWarning=true` and fees are NOT split pro-rata — pro-rata would fabricate. The ambiguity stays visible.

Helper: `TaxReport.aggregateFeesForPosition(position, fills, closedPositions)` returns `{ totalFee, fillCount, warning }`.

### Net realized P&L (per row)
`netUSD = realizedPnl + netFunding − (derivedFlag ? fees : 0)`. The `derivedFlag` is `position._derivedRealizedPnl` (set by `RiskMetrics.normalizeRealizedPnl` when the indexer reports `realizedPnl=0` and the helper backfills via `(exit − entry) × maxSize × sideMult`). Derived values are provably gross of fees — subtract. Indexer-supplied values have UNVERIFIED fee semantics; we do NOT subtract to avoid double-count and mark the row `_feeDoubleCountRisk=true` so the user sees the uncertainty. **Spot-check verdict pending**: after sampling 3+ live positions with `_derivedRealizedPnl=false` against `(exit − entry) × size` and `Σ fee_in_window`, lock the policy here and either always-subtract or never-subtract for indexer rows, then remove the flag.

Helper: `TaxReport.netRealizedPnl(realizedPnlUSD, netFundingUSD, feesUSD, derivedFlag)`.

### Currency conversion
USD → EUR via ECB daily reference rate on `closedDateUTC`. Source: `https://api.frankfurter.app/{date}?from=USD&to=EUR` (ECB-sourced, CORS-friendly, no auth). Weekend/holiday close dates inherit the nearest preceding business-day rate; the rate is stored in localStorage under the REQUESTED date so close-date lookups always hit. Cache key `fxRates:v1:USD-EUR`, indefinite TTL (historical reference rates do not change), independent of `dydxCache:v1` so `Forget` does not clear multi-year FX work.

When a rate is unavailable for a row's close date, EUR cells render `—` and the row is excluded from EUR totals — never fall back to year-end rate. Single rule, no surprises. The totals card flips `eurPartial=true` so the user sees the partial coverage.

Helper: `FxRates.getRates(dates: string[]) -> Promise<{rates, missing}>`. The `dates` array is built from the report's unique `closedDateUTC` values.

### Classification (Categoria E vs G)
The Portuguese fiscal category affects ONLY the totals card label preset and whether the Holding (days) column renders. Row data is identical. The 365-day holding exemption that applies to spot crypto under Categoria G is NOT automatically applied to perp gains: accountants decide on a case-by-case basis.

- `Categoria E (derivativos)`: 28% flat. No holding column.
- `Categoria G (cripto-ativos)`: 28% flat. Holding-days column shown for reference.

Helper: `TaxReport.summarize(rows, classificationId)` — `classificationId ∈ {'E','G'}` swaps labels only.

### Outputs
- On-screen broadsheet table + 8 totals cards.
- CSV download (RFC 4180 escapes for `,` `"` `\r` `\n`, CRLF line endings, includes meta header line with category + year).
- JSON download (`{ meta: { classification, year, generatedAt, schemaVersion }, totals, rows }`).

Helpers: `TaxReport.toCsv(rows, classificationId, year)`, `TaxReport.toJson(rows, totals, classificationId, year)`.

### Tests
`test/tax-report.test.js` pins year boundary in UTC, fee attribution + overlap flag, derived vs indexer-supplied net formulas, EUR conversion with missing-rate handling, summarize bucketing, RFC 4180 CSV escaping. Network logic in `fx-rates.js` is verified manually (no test mocks).

## Tests

`npm test` (equivalent: `node --test test/*.test.js`) runs the regression suites for `risk-metrics.js`, `portfolio-cache.js`, and `tax-report.js`. The suites pin formulas that have shipped bugs in the past: cross-margin liq price (LONG and SHORT), leverage notional source, oracle field path, indexer-zeroed `realizedPnl` repair, drawdown family, sample-adequacy gate, classifier, tax year boundary (UTC), fee attribution + overlap flag, RFC 4180 CSV escaping. CI runs the same command on every push and PR via `.github/workflows/test.yml`.

When semantics of any helper change, update `risk-metrics.js`, the calling sites, this section, AND the test in the same commit.

### Sign convention
**Losses always render as negative dollars.** Helper: `formatCurrency(value)` with negative input. Avg Loss / Trough cum Profit / Worst columns must pass `-Math.abs(loss)` so the displayed sign matches the visual loss styling.

### Status badge (FRESH / FETCHING / FRESH · PARTIAL / OFFLINE)
The masthead badge is a **snapshot freshness indicator**, NOT a streaming signal. There is no websocket. States are toggled by `FetchProgress` in `index.html`:
- **FRESH** — last fetch returned every endpoint successfully
- **FETCHING** — a fetch is in flight (gold pulse, faster cadence)
- **FRESH · PARTIAL** — fetch completed but some endpoints failed; the dashboard renders with degraded data
- **OFFLINE** — every endpoint failed

The pulsing dot is purely decorative; data is static between fetches. The badge owns a fixed `min-width: 160px` (sized for "FRESH · PARTIAL") so swapping text never reflows the masthead — verified by the breadcrumb-height / right-rail-width invariant introduced in commit `abb0f0c`.

## Future Improvements
- Add more detailed error messages
- Implement data caching for performance
- Support for multiple subaccounts
- Lock the fee-double-count policy in `tax-report.js` after spot-checking indexer `realizedPnl` semantics against fills (remove `_feeDoubleCountRisk` flag once resolved)
