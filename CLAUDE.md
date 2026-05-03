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
`r = realizedPnl / (sumOpen × entryPrice)` — fraction of notional deployed at entry. Used for per-trade Sharpe (fallback) AND asset-level Sharpe so the two cards never disagree. Helper: `RiskMetrics.tradeReturn(p)` (returns `null` when notional is undefined).

### Per-market P&L
`total = realized of CLOSED in that market + unrealized of OPEN in that market`. Used by the Overview chart tooltip AND the Performance-by-Asset table. Helper: `RiskMetrics.marketPnL(positions)`.

### Headline Max Drawdown
**Always** trade-system $ DD: peak-to-trough on cumulative `realizedPnl` over closed trades, in chronological order. Same series feeds the Drawdown Periods table so the two views can never disagree. Helper: `RiskMetrics.tradeSystemDrawdown(positions)`.

The Drawdown Periods table enumerates every peak→trough→recovery event on this same cumulative-P&L curve via `RiskMetrics.tradeSystemDrawdownEvents(positions)`.

### Drawdown of arbitrary equity series
Use `RiskMetrics.validDrawdownFromEquity(equityArray)` for any other drawdown calc (monthly MDD column, Calmar denominator on TWR wealth). Returns `null` when peak ≤ 0 OR trough < 0 — these are synthetic-equity artifacts that arise when the inception-time principal proxy goes under zero (e.g. a wipe followed by a redeposit). Filtered drawdowns must render as `—`.

### Sample-adequacy gate
A statistical metric (Sharpe, Sortino, Calmar, VaR, CVaR, monthly Sharpe) renders `—` unless the time-weighted-return sample passes ALL three constants (defined in `risk-metrics.js`):
- `MIN_RETS = 30` (at least 30 valid TWR returns)
- `MIN_YEARS = 1/12` (at least one month of valid coverage)
- `MIN_COVERAGE = 0.5` (at least half the historical-pnl rows produced a valid return — protects against post-wipeout sample bias)

Helper: `RiskMetrics.assessAdequacy(returns, timestamps, histLength)` → `{ adequate, reason, ppy, years, coverage, n }`. The same gate fires for Sharpe/Sortino/Calmar AND VaR/CVaR — the dashboard never shows VaR for a sample window that's too short to support Sharpe.

When the time-series gate fails, Sharpe/Sortino/Calmar fall back to `computeTradeBasedMetrics(positions)` which derives an annualized per-trade Sharpe from the realized-P&L log. VaR/CVaR have no fallback — they render `—` with the gate reason.

### Cross-margin liquidation price
dYdX is cross-margin. Per-position liq price assumes OTHER open positions hold their current uPnL contribution — exact for single-position accounts; isolation approximation otherwise.
- LONG:  `P_liq = oracle − equity / (size × (1 − MMF))`
- SHORT: `P_liq = (equity + oracle × |size|) / (|size| × (1 + MMF))`

Helper: `RiskMetrics.crossMarginLiqPrice(position, subaccount, marketsMap)` returns `null` when MMF / size / equity unavailable.

The Liquidation Risk Analysis table's LEVERAGE column shows `notional / subaccount.equity` (account-level utilization attributed to each position by notional share). Per-position equity does not exist on the dYdX API.

### Sign convention
**Losses always render as negative dollars.** Helper: `formatCurrency(value)` with negative input. Avg Loss / Trough cum P&L / Worst columns must pass `-Math.abs(loss)` so the displayed sign matches the visual loss styling.

## Future Improvements
- Add more detailed error messages
- Implement data caching for performance
- Add export functionality for reports
- Support for multiple subaccounts
