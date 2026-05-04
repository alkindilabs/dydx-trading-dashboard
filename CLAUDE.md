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
  - Total P&L for that market (realized of CLOSED + unrealized of OPEN — same definition as Performance-by-Asset table)
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

### Per-market P&L
`total = realized of CLOSED in that market + unrealized of OPEN in that market`. Used by the Overview chart tooltip AND the Performance-by-Asset table. Helper: `RiskMetrics.marketPnL(positions)`.

### Headline Max Drawdown
$ DD on cumulative `totalPnl` from `/historical-pnl` (realized + unrealized P&L over time, excluding net transfers). Peak-to-trough in chronological order. This series captures unrealized peaks the closed-trade ledger cannot see (e.g. a +$364K open profit that later got given back). Helper: `RiskMetrics.histPnlDrawdown(historicalPnl)`.

Falls back to trade-system $ DD on cumulative `realizedPnl` (`RiskMetrics.tradeSystemDrawdown(positions)`) when historical-pnl is unavailable OR when it produced no positive drawdown (an empty/monotonic series). The Recovery Factor and Drawdown Periods table follow the same fallback rule so all drawdown-derived cards stay aligned.

The Drawdown Periods table enumerates every peak→trough→recovery event on the same `totalPnl` curve via `RiskMetrics.histPnlDrawdownEvents(historicalPnl)` (with the same trade-system fallback). The Monthly Performance Breakdown's MAX DD column applies `histPnlDrawdown` to that month's slice, so it shares the headline's definition.

The Recovery Factor card uses the matching numerator: latest `totalPnl` ÷ headline DD when on the historical-pnl path; `cls.totalRealized` ÷ trade-system DD when on the fallback path. The numerator/denominator never come from different P&L series.

### Drawdown of arbitrary equity series
Use `RiskMetrics.validDrawdownFromEquity(equityArray)` for the Calmar denominator on TWR wealth. No longer feeds the headline. Returns `null` when peak ≤ 0 OR trough < 0 — these are synthetic-equity artifacts that arise when the inception-time principal proxy goes under zero (e.g. a wipe followed by a redeposit). Filtered drawdowns must render as `—`.

### Sample-adequacy gate
A statistical metric (Sharpe, Sortino, Calmar, VaR, CVaR, monthly Sharpe) renders `—` unless the time-weighted-return sample passes ALL three constants (defined in `risk-metrics.js`):
- `MIN_RETS = 30` (at least 30 valid TWR returns)
- `MIN_YEARS = 1/12` (at least one month of valid coverage)
- `MIN_COVERAGE = 0.5` (at least half the historical-pnl rows produced a valid return — protects against post-wipeout sample bias)

Helper: `RiskMetrics.assessAdequacy(returns, timestamps, histLength)` → `{ adequate, reason, ppy, years, coverage, n }`. The same gate fires for Sharpe/Sortino/Calmar AND VaR/CVaR — the dashboard never shows VaR for a sample window that's too short to support Sharpe.

When the time-series gate fails, Sharpe/Sortino/Calmar fall back to `computeTradeBasedMetrics(positions)` which derives an annualized per-trade Sharpe from the realized-P&L log. VaR/CVaR have no fallback — they render `—` with the gate reason.

### Cross-margin liquidation price
dYdX is cross-margin. Per-position liq price assumes OTHER open positions hold their current uPnL contribution — exact for single-position accounts; isolation approximation otherwise. Derivation: at liquidation, account equity equals maintenance margin requirement computed off liquidation-price notional (`MMR = |size| × P_liq × MMF`).
- LONG:  `P_liq = (size × oracle − equity) / (size × (1 − MMF))`
- SHORT: `P_liq = (equity + oracle × |size|) / (|size| × (1 + MMF))`

Helper: `RiskMetrics.crossMarginLiqPrice(position, subaccount, marketsMap)` returns `null` when MMF / size / equity unavailable.

The Liquidation Risk Analysis table's LEVERAGE column shows `notional / subaccount.equity` where `notional = |size| × oracle` (mark-based, matches dYdX's official UI). Falls back to entry price when oracle is unavailable. Per-position equity does not exist on the dYdX API.

Two display-side helpers wrap the formula so the Risk-tab Leverage card and the per-row LEVERAGE column never diverge: `RiskMetrics.leverageUtilization(positions, subaccount, marketsMap)` returns the account-level ratio; `RiskMetrics.liquidationRow(position, subaccount, marketsMap)` returns `{ size, entry, oracle, notional, lev, liq, distancePct }`. Position objects from `/perpetualPositions` do **not** carry `oraclePrice` — the oracle price lives on `marketsMap[market].oraclePrice`. Both helpers and `crossMarginLiqPrice` follow the same fallback chain `position.oraclePrice || marketsMap[market].oraclePrice || position.entryPrice`. All three are unit-tested in `test/risk-metrics.test.js`.

## Tests

`node --test test/` runs the regression suite for `risk-metrics.js`. The suite pins formulas that have shipped bugs in the past: cross-margin liq price (LONG and SHORT), leverage notional source, oracle field path, indexer-zeroed `realizedPnl` repair, drawdown family, sample-adequacy gate, classifier. CI runs the same command on every push and PR via `.github/workflows/test.yml`.

When semantics of any helper change, update `risk-metrics.js`, the calling sites, this section, AND the test in the same commit.

### Sign convention
**Losses always render as negative dollars.** Helper: `formatCurrency(value)` with negative input. Avg Loss / Trough cum P&L / Worst columns must pass `-Math.abs(loss)` so the displayed sign matches the visual loss styling.

## Future Improvements
- Add more detailed error messages
- Implement data caching for performance
- Add export functionality for reports
- Support for multiple subaccounts
