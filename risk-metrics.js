/**
 * Risk metrics utilities. Depends on window.AppConstants (PERCENT).
 * Exposes global `RiskMetrics` with helpers to compute Sharpe and Sortino.
 * All returns are fractional per-period returns (e.g., 0.01 = 1%).
 */

(function () {
  'use strict';

  const { PERCENT } = window.AppConstants;

  function isNumber(n) {
    return typeof n === 'number' && !isNaN(n) && isFinite(n);
  }

  function computeReturnsFromEquitySeries(equitySeries) {
    if (!Array.isArray(equitySeries)) return [];
    const returns = [];
    for (let i = 1; i < equitySeries.length; i++) {
      const prev = parseFloat(equitySeries[i - 1] || 0);
      const curr = parseFloat(equitySeries[i] || 0);
      if (prev > 0 && isNumber(curr) && isNumber(prev)) {
        returns.push((curr / prev) - 1);
      }
    }
    return returns;
  }

  // Transfer-aware time-weighted returns from dYdX historical-pnl rows.
  // r_t = (totalPnl_t − totalPnl_{t-1}) / equity_{t-1}.
  // Using the totalPnl delta isolates trading P&L (excludes deposits/withdrawals);
  // dividing by equity_{t-1} scales to capital actually deployed at the start of the period.
  function computeTimeWeightedReturnsFromHist(historicalPnl) {
    if (!Array.isArray(historicalPnl) || historicalPnl.length < 2) return [];
    const series = historicalPnl.slice().sort((a, b) => (
      (a.createdAt || '').localeCompare(b.createdAt || '')
    ));
    const out = [];
    for (let i = 1; i < series.length; i++) {
      const prevEq = parseFloat(series[i - 1].equity || 0);
      const prevPnl = parseFloat(series[i - 1].totalPnl || 0);
      const currPnl = parseFloat(series[i].totalPnl || 0);
      const pnlDelta = currPnl - prevPnl;
      if (prevEq > 0 && isFinite(pnlDelta)) out.push(pnlDelta / prevEq);
    }
    return out;
  }

  function mean(values) {
    if (!values.length) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  function stdDev(values) {
    if (values.length <= 1) return 0;
    const m = mean(values);
    const variance = values.reduce((acc, v) => acc + Math.pow(v - m, 2), 0) / (values.length - 1);
    return Math.sqrt(variance);
  }

  /**
   * Compute Sharpe ratio from per-period returns.
   * @param {number[]} returns fractional returns per period
   * @param {number} mar minimum acceptable return per period (default 0)
   * @returns {number|null} null when undefined (no data or zero variance)
   */
  function computeSharpe(returns, mar = 0) {
    if (!Array.isArray(returns) || returns.length === 0) return null;
    const excess = returns.map(r => r - mar);
    const mu = mean(excess);
    const sd = stdDev(excess);
    return sd > 0 ? (mu / sd) : null;
  }

  /**
   * Compute Sortino ratio from per-period returns. Frank-Sortino downside
   * deviation: sum of squared negative excess returns divided by N (the
   * target semi-deviation; NOT the non-standard divide-by-count-of-negatives).
   * @param {number[]} returns fractional returns per period
   * @param {number} mar minimum acceptable return per period (default 0)
   * @returns {number|null} null when undefined; Infinity only if no downside variance
   */
  function computeSortino(returns, mar = 0) {
    if (!Array.isArray(returns) || returns.length === 0) return null;
    const excess = returns.map(r => r - mar);
    const mu = mean(excess);
    const downs = excess.map(x => Math.min(0, x));
    const downVar = downs.reduce((a, d) => a + d * d, 0) / returns.length;
    const dd = Math.sqrt(downVar);
    if (dd === 0) return mu > 0 ? Infinity : null;
    return mu / dd;
  }

  /**
   * Compute risk metrics from historicalPnl objects as returned by /v4/historical-pnl.
   * Uses transfer-aware time-weighted returns (pnlDelta / equity_{t-1}) so deposits/withdrawals
   * do not appear as fictitious returns.
   * @param {Array} historicalPnl array of { equity, totalPnl, createdAt, ... }
   * @param {{mar?: number}} options
   */
  function computeFromHistoricalPnl(historicalPnl, options = {}) {
    const mar = options.mar ?? 0;
    const returns = computeTimeWeightedReturnsFromHist(historicalPnl);
    const sharpe = computeSharpe(returns, mar);
    const sortino = computeSortino(returns, mar);
    return { returns, sharpe, sortino };
  }

  function median(values) {
    if (!values.length) return 0;
    const arr = values.slice().sort((a,b)=>a-b);
    const mid = Math.floor(arr.length/2);
    return arr.length % 2 ? arr[mid] : (arr[mid-1]+arr[mid])/2;
  }

  function detectPeriodsPerYearFromTimestamps(timestamps) {
    if (!Array.isArray(timestamps) || timestamps.length < 2) return 0;
    const secs = timestamps
      .map(t => (new Date(t)).getTime())
      .filter(n => !isNaN(n))
      .sort((a,b)=>a-b);
    if (secs.length < 2) return 0;
    const diffs = [];
    for (let i=1;i<secs.length;i++) diffs.push((secs[i]-secs[i-1])/1000);
    const m = median(diffs) || 3600; // default 1h if cannot detect
    const year = 365.25*24*3600;
    return Math.max(1, year / m);
  }

  function computeAnnualizedFromReturns(returns, timestamps, options = {}) {
    const mar = options.mar ?? 0;
    const perPeriodSharpe = computeSharpe(returns, mar);
    const perPeriodSortino = computeSortino(returns, mar);
    const ppy = detectPeriodsPerYearFromTimestamps(timestamps);
    const factor = ppy > 0 ? Math.sqrt(ppy) : 1;
    const annualize = (v) => (v === null || !isFinite(v)) ? v : v * factor;
    return {
      sharpe: perPeriodSharpe,
      sortino: perPeriodSortino,
      sharpeAnnualized: annualize(perPeriodSharpe),
      sortinoAnnualized: annualize(perPeriodSortino),
      ppy
    };
  }

  function computeAnnualizedFromHistoricalPnl(historicalPnl, options = {}) {
    const mar = options.mar ?? 0;
    const series = Array.isArray(historicalPnl) ? historicalPnl.slice().sort((a, b) => (
      (a.createdAt || '').localeCompare(b.createdAt || '')
    )) : [];
    const timestamps = series.map(p => p.createdAt).filter(Boolean);
    const returns = computeTimeWeightedReturnsFromHist(series);
    const { sharpe, sortino, sharpeAnnualized, sortinoAnnualized, ppy } = computeAnnualizedFromReturns(returns, timestamps, { mar });
    return { returns, sharpe, sortino, sharpeAnnualized, sortinoAnnualized, ppy };
  }

  // ---------------------------------------------------------------------------
  // Shared classifiers / helpers used across the dashboard. Single source of
  // truth — every UI surface that reports trade counts, win rate, P&L, or
  // drawdown calls these instead of recomputing inline.
  // ---------------------------------------------------------------------------

  // True when attributeFillsToPositions tied the position to its fills
  // (`complete === true`). A position without attribution fields is not
  // complete. The one completeness rule every panel and the tax report use.
  function hasCompleteAttribution(p) {
    return !!p && p.complete === true;
  }

  // A position's fill-attributed profit (attributeFillsToPositions), or
  // null when that attribution is incomplete or absent.
  function completeProfit(p) {
    if (!hasCompleteAttribution(p)) return null;
    const profit = parseFloat(p.profit);
    return isNumber(profit) ? profit : null;
  }

  // Classify closed positions into wins / losses / scratches by the sign
  // of their fill-attributed `profit` (net of fees, excluding funding).
  // Scratches (profit == 0) are excluded from win-rate-style ratios.
  // Derived fields (winRate, profitFactor, avgWin, avgLoss, expectancy,
  // payoff, breakevenWinRate) are computed once here so consumers cannot
  // adopt different definitions in different panels. Each is null when
  // its denominator is zero — surface as '—' per the
  // no-metric-better-than-wrong-metric rule.
  //
  // All-or-nothing: a closed position without complete fill attribution
  // lands in `incomplete`, and while any exists every derived ratio is
  // null and `incompleteReason` says why. `unavailableReason` (e.g.
  // 'Closed positions failed to load') does the same for a list that is
  // itself unknown, so an endpoint failure never reads as "no trades".
  function classifyClosed(positions, unavailableReason = '') {
    const closed = (positions || []).filter(p => p && p.status === 'CLOSED');
    const wins = [], losses = [], scratches = [], incomplete = [];
    let grossWin = 0, grossLoss = 0;
    closed.forEach(p => {
      const r = completeProfit(p);
      if (r === null) { incomplete.push(p); return; }
      if (r > 0)      { wins.push(p);     grossWin  += r;          }
      else if (r < 0) { losses.push(p);   grossLoss += Math.abs(r); }
      else            { scratches.push(p); }
    });
    const winCount = wins.length;
    const lossCount = losses.length;
    const decisiveCount = winCount + lossCount;
    const totalProfit = grossWin - grossLoss;
    const incompleteCount = incomplete.length;
    const incompleteReason = unavailableReason || (incompleteCount === 0 ? ''
      : `${incompleteCount} position${incompleteCount === 1 ? '' : 's'} missing fill data`);
    const ratio = (denominator, value) => (!incompleteReason && denominator > 0 ? value() : null);
    const avgWin = ratio(winCount, () => grossWin / winCount);
    const avgLoss = ratio(lossCount, () => grossLoss / lossCount);
    const payoff = avgWin !== null && avgLoss !== null ? ratio(avgLoss, () => avgWin / avgLoss) : null;
    return {
      wins, losses, scratches, incomplete, all: closed,
      grossWin, grossLoss,
      totalProfit,
      winCount,
      lossCount,
      scratchCount: scratches.length,
      decisiveCount,
      closedCount: closed.length,
      incompleteCount,
      incompleteReason,
      winRate:      ratio(decisiveCount, () => (winCount / decisiveCount) * PERCENT),
      profitFactor: ratio(grossLoss,     () => grossWin / grossLoss),
      avgWin,
      avgLoss,
      expectancy:   ratio(decisiveCount, () => totalProfit / decisiveCount),
      payoff,
      // Win rate (percent) at which expectancy is zero for this payoff.
      breakevenWinRate: payoff === null ? null : PERCENT / (1 + payoff)
    };
  }

  // Bucket closed positions by closedAt month, then run classifyClosed per
  // bucket. Returns { [monthKey]: Classification } where monthKey matches
  // the "Month long, year numeric" format the Monthly Performance Breakdown
  // table uses. Months with zero closed positions are omitted — caller
  // merges them in from histPnlMonthly when funding-only months matter.
  // `unavailableReason` (normally the account-wide classifier's
  // incompleteReason) is applied to every month, so one incomplete
  // position blanks the ratios of every month together.
  function classifyByMonth(positions, unavailableReason = '') {
    const byMonth = {};
    (positions || []).forEach(p => {
      if (!p || p.status !== 'CLOSED') return;
      const d = new Date(p.closedAt || p.createdAt);
      if (isNaN(d)) return;
      const key = d.toLocaleString('en-US', { month: 'long', year: 'numeric' });
      if (!byMonth[key]) byMonth[key] = [];
      byMonth[key].push(p);
    });
    const out = {};
    Object.keys(byMonth).forEach(k => { out[k] = classifyClosed(byMonth[k], unavailableReason); });
    return out;
  }

  // Peak notional: peakSize × entryVwap from attributeFillsToPositions,
  // the largest position value held during the lifecycle (NOT the
  // cumulative entered size, which overstates capital deployed on scaled
  // positions). Null when the attribution is incomplete or either factor
  // is not positive. The denominator of tradeReturn and the size measure
  // of the Position Size Distribution and the Behavior double-down detector.
  function peakNotional(p) {
    if (!hasCompleteAttribution(p)) return null;
    const size = parseFloat(p.peakSize);
    const entry = parseFloat(p.entryVwap);
    return size > 0 && entry > 0 ? size * entry : null;
  }

  // Per-trade fractional return: profit / peakNotional, both from the fill
  // attribution. Used by per-trade Sharpe (fallback), asset-level Sharpe,
  // the win/loss distribution and the Positions board PROFIT % column.
  // Returns null when the attribution is incomplete or the notional is
  // undefined.
  function tradeReturn(p) {
    const profit = completeProfit(p);
    const notional = peakNotional(p);
    if (profit === null || notional === null) return null;
    const r = profit / notional;
    return isNumber(r) ? r : null;
  }

  // Drawdown of an arbitrary equity series with synthetic-equity-artifact
  // rejection: returns null when peak is non-positive OR trough is negative
  // (the inception-time principal proxy went under zero, which isn't a real
  // drawdown). Use this everywhere that consumes adjusted-equity series.
  function validDrawdownFromEquity(equityArray) {
    if (!Array.isArray(equityArray) || equityArray.length === 0) return null;
    let peak = -Infinity, peakIdx = -1;
    let maxDD = 0, peakAtMaxDD = 0, troughVal = 0, troughIdx = -1;
    for (let i = 0; i < equityArray.length; i++) {
      const v = parseFloat(equityArray[i]);
      if (!isNumber(v)) continue;
      if (v > peak) { peak = v; peakIdx = i; }
      if (peak > 0) {
        const dd = (v - peak) / peak;
        if (dd < maxDD) {
          maxDD = dd;
          peakAtMaxDD = peak;
          troughVal = v;
          troughIdx = i;
        }
      }
    }
    if (peakAtMaxDD <= 0 || troughVal < 0) return null;
    return {
      pct: Math.abs(maxDD) * PERCENT,
      abs: Math.max(0, peakAtMaxDD - troughVal),
      peakIdx, troughIdx
    };
  }

  // Sample-adequacy gate. Single source of constants used everywhere a
  // statistical metric is computed from time-weighted returns.
  var ADEQUACY_MIN_RETS = 30;
  var ADEQUACY_MIN_YEARS = 1 / 12;
  var ADEQUACY_MIN_COVERAGE = 0.5;

  function assessAdequacy(returns, timestamps, histLength) {
    const n = Array.isArray(returns) ? returns.length : 0;
    const ppy = detectPeriodsPerYearFromTimestamps(timestamps || []);
    const years = ppy > 0 ? n / ppy : 0;
    const coverage = histLength > 0 ? n / histLength : 0;
    let reason = '';
    let adequate = true;
    if (n < ADEQUACY_MIN_RETS) {
      adequate = false;
      reason = `Need ≥${ADEQUACY_MIN_RETS} returns (have ${n})`;
    } else if (years < ADEQUACY_MIN_YEARS) {
      adequate = false;
      reason = `Need ≥1 month of valid data (have ${(years * 12).toFixed(1)} months)`;
    } else if (coverage < ADEQUACY_MIN_COVERAGE) {
      adequate = false;
      reason = `Coverage ${(coverage * PERCENT).toFixed(0)}% — most periods filtered (likely post-wipeout sample bias)`;
    }
    return { adequate, reason, ppy, years, coverage, n };
  }

  // Sort closed positions chronologically and build the cumulative
  // fill-attributed profit series. Shared by tradeSystemDrawdown (worst
  // single event), tradeSystemDrawdownEvents (every peak→recovery cycle)
  // and tradeSystemCurrentDrawdown so they can never operate on different
  // inputs. All-or-nothing like classifyClosed: while any closed position
  // lacks complete fill attribution the series is empty, so every wrapper
  // reports no drawdown and callers show the classifier's incompleteReason.
  function buildCumulativeProfitSeries(closedPositions) {
    const closed = (closedPositions || [])
      .filter(p => p && p.status === 'CLOSED' && p.closedAt)
      .slice()
      .sort((a, b) => (
        new Date(a.closedAt).getTime() - new Date(b.closedAt).getTime()
      ));
    if (closed.some(p => completeProfit(p) === null)) return { closed: [], cums: [] };
    let cum = 0;
    const cums = closed.map(p => {
      cum += completeProfit(p);
      return { t: p.closedAt, c: cum };
    });
    return { closed, cums };
  }

  // Build a clean cumulative trading-P&L series from /historical-pnl rows.
  // dYdX's `totalPnl` field is realized + unrealized P&L excluding net
  // transfers — the canonical "what did this account make from trading"
  // measurement at each timestamp. This series captures unrealized peaks
  // (e.g. a +$364K open profit that later got given back) which the
  // closed-trade ledger cannot see.
  function buildCumulativeTotalPnlSeries(historicalPnl) {
    const arr = (historicalPnl || [])
      .filter(r => r && r.createdAt && r.totalPnl !== undefined && r.totalPnl !== null)
      .slice()
      .sort((a, b) => (
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      ));
    return arr.map(r => ({
      t: r.createdAt,
      c: parseFloat(r.totalPnl || 0)
    }));
  }

  // Single peak-to-trough/peak-to-recovery scanner over a {t, c}[] series.
  // Single source of truth for both the totalPnl-based and trade-profit-based
  // drawdown views — the wrappers below only differ in which series they
  // build. Returns the worst-event summary AND the full event list so a
  // caller never has to re-scan.
  function scanDrawdownEvents(cums) {
    const empty = {
      worst: { dollarDrawdown: 0, pctOfPeakProfit: 0, n: cums.length,
               peakAt: null, troughAt: null,
               peakValue: 0, troughValue: 0,
               peakIdx: -1, troughIdx: -1 },
      events: []
    };
    if (cums.length === 0) return empty;

    // Worst-event scan.
    let peak = cums[0].c, peakIdx = 0;
    let ddAbs = 0, ddPeakIdx = 0, ddTroughIdx = 0, ddPeak = peak;
    cums.forEach((pt, i) => {
      if (pt.c > peak) { peak = pt.c; peakIdx = i; }
      const dd = peak - pt.c;
      if (dd > ddAbs) {
        ddAbs = dd;
        ddPeak = peak;
        ddPeakIdx = peakIdx;
        ddTroughIdx = i;
      }
    });

    // Per-event peak → trough → recovery scan.
    const events = [];
    if (cums.length >= 2) {
      let pIdx = 0;
      for (let i = 1; i < cums.length; i++) {
        if (cums[i].c > cums[pIdx].c) { pIdx = i; continue; }
        let tIdx = i;
        while (i + 1 < cums.length && cums[i + 1].c < cums[pIdx].c) {
          if (cums[i + 1].c < cums[tIdx].c) tIdx = i + 1;
          i += 1;
        }
        const recIdx = (i + 1 < cums.length && cums[i + 1].c >= cums[pIdx].c) ? i + 1 : null;
        const peakV = cums[pIdx].c;
        const troughV = cums[tIdx].c;
        const depthAbs = Math.max(0, peakV - troughV);
        if (depthAbs > 0) {
          events.push({
            peakAt: cums[pIdx].t,
            troughAt: cums[tIdx].t,
            recoveryAt: recIdx !== null ? cums[recIdx].t : null,
            peakCum: peakV,
            troughCum: troughV,
            depthAbs
          });
        }
        pIdx = recIdx !== null ? recIdx : tIdx;
      }
    }

    return {
      worst: {
        dollarDrawdown: ddAbs,
        pctOfPeakProfit: ddPeak > 0 ? (ddAbs / ddPeak) * PERCENT : 0,
        n: cums.length,
        peakAt: cums[ddPeakIdx].t,
        troughAt: cums[ddTroughIdx].t,
        peakValue: cums[ddPeakIdx].c,
        troughValue: cums[ddTroughIdx].c,
        peakIdx: ddPeakIdx,
        troughIdx: ddTroughIdx
      },
      events
    };
  }

  // Worst peak-to-trough drawdown on the totalPnl series. Replaces the
  // trade-system-only definition for accounts that built large unrealized
  // gains and then gave them back (the trade ledger only sees the final
  // realized P&L, missing the peak entirely).
  function histPnlDrawdown(historicalPnl) {
    return scanDrawdownEvents(buildCumulativeTotalPnlSeries(historicalPnl)).worst;
  }

  // Find every peak-to-recovery drawdown event on the totalPnl series.
  // Recovery = totalPnl returns to the prior peak (or higher).
  function histPnlDrawdownEvents(historicalPnl) {
    return scanDrawdownEvents(buildCumulativeTotalPnlSeries(historicalPnl)).events;
  }

  // Trade-system drawdown: peak-to-trough on cumulative profit over
  // closed trades, in chronological order. Used as the fallback when
  // historical-pnl is unavailable. Cumulative profit never has
  // synthetic-equity artifacts, so no negative-trough filter is needed.
  function tradeSystemDrawdown(closedPositions) {
    const { closed, cums } = buildCumulativeProfitSeries(closedPositions);
    const out = scanDrawdownEvents(cums).worst;
    out.n = closed.length;
    out.closed = closed;
    return out;
  }

  // Find every peak-to-recovery drawdown event on the cumulative profit
  // curve. Used as the fallback for the Drawdown Periods table when
  // historical-pnl is unavailable.
  function tradeSystemDrawdownEvents(closedPositions) {
    const { cums } = buildCumulativeProfitSeries(closedPositions);
    return scanDrawdownEvents(cums).events;
  }

  // Where is the account RIGHT NOW relative to its all-time equity peak?
  // dollarDrawdown = max(0, peak − latest). 0 when at-or-above prior peak.
  // pctOfPeakProfit = % of peak profit currently given back.
  // peakAt/currentAt timestamps let callers surface "days below peak" without
  // re-scanning the series. peak is computed across the WHOLE series (not just
  // up to the latest point) so revisiting an old peak after a deeper one was
  // hit shows dollarDrawdown=0, matching the "currently above prior peak"
  // intent. Returns hasData=false on empty input so callers can render "—"
  // without recomputing emptiness.
  function currentDrawdownFromSeries(cums) {
    if (!cums || cums.length === 0) {
      return {
        dollarDrawdown: 0,
        pctOfPeakProfit: 0,
        peakAt: null,
        peakValue: 0,
        currentAt: null,
        currentValue: 0,
        n: 0,
        hasData: false
      };
    }
    let peak = cums[0].c;
    let peakIdx = 0;
    for (let i = 1; i < cums.length; i++) {
      if (cums[i].c > peak) {
        peak = cums[i].c;
        peakIdx = i;
      }
    }
    const lastIdx = cums.length - 1;
    const current = cums[lastIdx].c;
    const dollarDrawdown = Math.max(0, peak - current);
    return {
      dollarDrawdown,
      pctOfPeakProfit: peak > 0 ? (dollarDrawdown / peak) * PERCENT : 0,
      peakAt: cums[peakIdx].t,
      peakValue: peak,
      currentAt: cums[lastIdx].t,
      currentValue: current,
      n: cums.length,
      hasData: true
    };
  }

  // Current (active) drawdown on the totalPnl series. Mirror of
  // histPnlDrawdown but answering "where am I now?" instead of "what was the
  // worst?". Same input + sorting + sign convention as histPnlDrawdown so the
  // two cards can never disagree about which P&L stream is being measured.
  function histPnlCurrentDrawdown(historicalPnl) {
    return currentDrawdownFromSeries(buildCumulativeTotalPnlSeries(historicalPnl));
  }

  // Fallback path: current drawdown on cumulative profit. Used when
  // historical-pnl is unavailable, mirroring tradeSystemDrawdown's role.
  function tradeSystemCurrentDrawdown(closedPositions) {
    const { closed, cums } = buildCumulativeProfitSeries(closedPositions);
    const out = currentDrawdownFromSeries(cums);
    out.closed = closed;
    return out;
  }

  // Per-market P&L. Single definition: realized + unrealized of OPEN +
  // netFunding − fees, all bucketed per market. dYdX v4 keeps each of
  // these components on separate fields/streams; without folding all of
  // them in, the "Total Profit" family disagrees with the equity-based
  // /historical-pnl totalPnl curve (which is equity − transfers and
  // therefore implicitly captures funding AND fees).
  //
  // Realized source: when `realizedByMarket` is provided (the FIFO-from-
  // fills map produced by computeRealizedFromFills), it OVERRIDES the
  // sum of /perpetualPositions.realizedPnl. FIFO is authoritative because
  // the indexer's per-position realizedPnl field has observed accounting
  // gaps on heavy-scaling accounts. Omitting the override preserves the
  // legacy behavior for callers without /fills data.
  //
  // Unrealized source: `unrealizedByMarket` (computeUnrealizedFromFills'
  // byMarket, FIFO lots at the oracle) likewise OVERRIDES the sum of
  // /perpetualPositions.unrealizedPnl, so realized and unrealized share one
  // cost basis. A null entry (open lots without an oracle price) adds 0;
  // the caller blanks totals whose unrealized is unknown.
  //
  // `feesMap` is optional: `{ [market]: feesPaid }` where positive = USD
  // paid (taker / most maker), negative = maker rebate (dYdX fill.fee
  // convention). Subtracted from total so rebates ADD to the bottom line.
  //
  // Used by Overview chart tooltip AND Performance-by-Asset table so the
  // same market never reads two different P&L numbers.
  function marketPnL(positions, feesMap, realizedByMarket, unrealizedByMarket) {
    const byMarket = {};
    function ensureSlot(m) {
      if (!byMarket[m]) {
        byMarket[m] = {
          realizedClosed: 0, unrealizedOpen: 0, netFunding: 0, fees: 0, total: 0,
          closedCount: 0, openCount: 0
        };
      }
      return byMarket[m];
    }
    (positions || []).forEach(p => {
      if (!p) return;
      const slot = ensureSlot(p.market || 'Unknown');
      if (p.status === 'CLOSED') {
        // Sum the indexer field only as a fallback for when realizedByMarket
        // is absent; it gets overwritten below when the FIFO map is supplied.
        slot.realizedClosed += parseFloat(p.realizedPnl || 0);
        slot.closedCount += 1;
      } else if (p.status === 'OPEN') {
        slot.unrealizedOpen += parseFloat(p.unrealizedPnl || 0);
        slot.openCount += 1;
      }
      slot.netFunding += parseFloat(p.netFunding || 0);
    });
    if (realizedByMarket) {
      Object.keys(byMarket).forEach(m => { byMarket[m].realizedClosed = 0; });
      Object.keys(realizedByMarket).forEach(m => {
        const v = parseFloat(realizedByMarket[m]);
        if (!isNumber(v)) return;
        ensureSlot(m).realizedClosed = v;
      });
    }
    if (unrealizedByMarket) {
      Object.keys(byMarket).forEach(m => { byMarket[m].unrealizedOpen = 0; });
      Object.keys(unrealizedByMarket).forEach(m => {
        const v = parseFloat(unrealizedByMarket[m]);
        if (!isNumber(v)) return;
        ensureSlot(m).unrealizedOpen = v;
      });
    }
    if (feesMap) {
      Object.keys(feesMap).forEach(m => {
        const v = parseFloat(feesMap[m]);
        if (!isNumber(v)) return;
        ensureSlot(m).fees += v;
      });
    }
    Object.values(byMarket).forEach(s => {
      s.total = s.realizedClosed + s.unrealizedOpen + s.netFunding - s.fees;
    });
    return byMarket;
  }

  // Lifetime trading profit now, on the equity-based definition: the latest
  // /historical-pnl totalPnl (equity − net transfers, sampled hourly) moved
  // by the equity change since that row. Assumes no transfer since the
  // row. Null when there are no rows or either equity does not parse. The
  // reference the Total Profit reconciliation guard compares against.
  function equityAdjustedTotalPnl(historicalPnl, equityNow) {
    if (!Array.isArray(historicalPnl) || historicalPnl.length === 0) return null;
    const latest = historicalPnl.reduce((a, b) => ((b.createdAt || '') > (a.createdAt || '') ? b : a));
    const totalPnl = parseFloat(latest.totalPnl);
    const rowEquity = parseFloat(latest.equity);
    const equity = parseFloat(equityNow);
    if (!isNumber(totalPnl) || !isNumber(rowEquity) || !isNumber(equity)) return null;
    return totalPnl + (equity - rowEquity);
  }

  // Sum of netFunding across every position (CLOSED + OPEN). Used by the
  // Total Profit headline so realized + unrealized + funding agrees with
  // /historical-pnl totalPnl (which is equity-based and already includes
  // funding). Unparseable values (missing field, 'NaN', '') contribute 0
  // rather than poisoning the sum. Returns 0 on empty input.
  function netFundingTotal(positions) {
    return (positions || []).reduce((s, p) => {
      if (!p) return s;
      const v = parseFloat(p.netFunding);
      return isNumber(v) ? s + v : s;
    }, 0);
  }

  // Active child subaccount detector. Returns the subset of subaccounts
  // (≥ 1, where dYdX convention places isolated-margin subs at 128 and
  // 256) that currently have any state worth surfacing — non-zero equity,
  // open positions, or asset balances. Dashboard analyses sub=0; any
  // child with activity is a blind spot the operator must be warned
  // about so headline isn't trusted as the account's full picture.
  // Empty input → empty array.
  function activeChildSubaccounts(subaccounts) {
    if (!Array.isArray(subaccounts)) return [];
    return subaccounts.filter(s => {
      if (!s || s.subaccountNumber === 0 || s.subaccountNumber == null) return false;
      const eq = parseFloat(s.equity || 0);
      if (isNumber(eq) && eq !== 0) return true;
      const open = s.openPerpetualPositions && typeof s.openPerpetualPositions === 'object'
        && Object.keys(s.openPerpetualPositions).length > 0;
      if (open) return true;
      const assets = Array.isArray(s.assetPositions) && s.assetPositions.length > 0;
      if (assets) return true;
      return false;
    });
  }

  // Net size within this tolerance of zero counts as flat. Fill sizes are
  // decimal strings; summing them in binary floating point leaves residue
  // that grows with magnitude (a few 1e-9 units on a 1e7-unit position)
  // and stays behind after the position is scaled down, so the tolerance
  // is the larger of an absolute floor and a fraction of the largest size
  // involved since the market was last flat. Both stay far below any
  // exchange step size.
  var FLAT_SIZE_EPSILON = 1e-9;
  var FLAT_SIZE_RELATIVE_EPSILON = 1e-12;

  function flatTolerance(...sizes) {
    return Math.max(FLAT_SIZE_EPSILON, ...sizes.map(s => Math.abs(s) * FLAT_SIZE_RELATIVE_EPSILON));
  }

  // Chain order shared by every FIFO walk: `createdAt`, then
  // `createdAtHeight` (block times never decrease, so the two agree on real
  // rows; `createdAt` first keeps a fill missing its height in place).
  // Fills of one block keep their input order (the sort is stable), which is
  // chain order because /fills is fetched in page mode, eventId ascending.
  // Fill ids are hashes of the event id, so their order means nothing.
  function compareFillsChronologically(a, b) {
    const ta = a.createdAt || '';
    const tb = b.createdAt || '';
    if (ta !== tb) return ta < tb ? -1 : 1;
    const ha = parseInt(a.createdAtHeight || '0', 10);
    const hb = parseInt(b.createdAtHeight || '0', 10);
    if (ha !== hb) return ha - hb;
    return 0;
  }

  function groupFillsByMarketChronologically(fills) {
    const buckets = {};
    (fills || []).forEach(f => {
      if (!f) return;
      const m = f.market || 'Unknown';
      if (!buckets[m]) buckets[m] = [];
      buckets[m].push(f);
    });
    Object.values(buckets).forEach(arr => arr.sort(compareFillsChronologically));
    return buckets;
  }

  // { size, price, signed } for a fill the FIFO walk can use, else null.
  function parseFillTrade(f) {
    const size = Math.abs(parseFloat(f && f.size));
    const price = parseFloat(f && f.price);
    if (!isNumber(size) || size <= 0 || !isNumber(price)) return null;
    const side = (f.side || '').toUpperCase();
    if (side !== 'BUY' && side !== 'SELL') return null;
    return { size, price, signed: side === 'BUY' ? size : -size };
  }

  // True when the FIFO walk can use the fill: positive size, finite price,
  // BUY or SELL side. Any other fill is skipped and makes the attribution
  // of every position whose window holds it incomplete.
  function isFifoUsableFill(f) {
    return parseFillTrade(f) !== null;
  }

  // The one FIFO inventory walk over a single market's chronologically
  // sorted fills. Every realized-P&L helper below is a fold over its steps.
  //
  // Cost-basis convention: FIFO (first-in, first-out). For a position
  // that returns to zero size, the LIFETIME realized total is invariant
  // to convention (FIFO / LIFO / HIFO all sum to the same number); only
  // per-trade attribution differs. FIFO is the transparent default.
  //
  // Each usable fill yields one step splitting it into a closing portion
  // (`closeQty`, which realizes `realized` against the oldest lots) and an
  // opening portion (`openQty`, which becomes a new lot). A flip fill
  // (long → through zero → short in one fill) has both: the chain treats
  // it atomically, closing all inventory at the fill price and opening
  // the residual on the other side at the same price. `netBefore` /
  // `netAfter` are signed (positive = LONG) and snap to exactly 0 within
  // flatTolerance. Fills whose size/price/side do not parse go to
  // `onSkip` and leave inventory untouched. Returns the lots still open
  // after the last fill ({ size, price }, FIFO order), their side and the
  // signed net size the walk ends on (`netSize`, 0 when flat).
  function walkMarketFifo(sortedFills, onStep, onSkip) {
    const inventory = []; // [{ size, price }] FIFO order, always positive size
    let netSize = 0;
    let peakSinceFlat = 0;
    sortedFills.forEach(fill => {
      const trade = parseFillTrade(fill);
      if (!trade) {
        if (onSkip) onSkip(fill);
        return;
      }
      const netBefore = netSize;
      const tolerance = flatTolerance(netBefore, trade.size, peakSinceFlat);
      const reducing = (netBefore > 0 && trade.signed < 0) || (netBefore < 0 && trade.signed > 0);
      const closeQty = reducing ? Math.min(trade.size, Math.abs(netBefore)) : 0;
      const residual = trade.size - closeQty;
      const openQty = residual > tolerance ? residual : 0;
      let realized = 0;
      let toMatch = closeQty;
      while (toMatch > tolerance && inventory.length > 0) {
        const lot = inventory[0];
        const matched = Math.min(toMatch, lot.size);
        realized += netBefore > 0
          ? (trade.price - lot.price) * matched
          : (lot.price - trade.price) * matched;
        lot.size -= matched;
        toMatch -= matched;
        if (lot.size <= tolerance) inventory.shift();
      }
      if (openQty > 0) inventory.push({ size: openQty, price: trade.price });
      netSize = netBefore + trade.signed;
      if (Math.abs(netSize) <= tolerance) {
        netSize = 0;
        inventory.length = 0;
        peakSinceFlat = 0;
      } else {
        peakSinceFlat = Math.max(peakSinceFlat, Math.abs(netSize));
      }
      onStep({
        fill, size: trade.size, price: trade.price,
        closeQty, openQty, realized, netBefore, netAfter: netSize
      });
    });
    return { lots: inventory, side: Math.sign(netSize), netSize };
  }

  // FIFO realized P&L computed bottom-up from /fills.
  //
  // Why this over /perpetualPositions.realizedPnl: the indexer's per-
  // position `realizedPnl` field has observed accounting gaps — it
  // undercounts lifetime realized for accounts that scale in/out heavily
  // (verified against equity-truth via /historical-pnl totalPnl). FIFO
  // over the raw fill records reconciles to the equity-based number
  // within float-rounding, with no dependence on the indexer-computed
  // realizedPnl field.
  //
  // Returns { total, byMarket } where byMarket maps market → realized.
  // Markets with only OPEN inventory (no closing fills yet) emit 0 —
  // their unrealized P&L still comes from /perpetualPositions.unrealizedPnl
  // mark-to-market.
  function computeRealizedFromFills(fills) {
    let total = 0;
    const byMarket = {};
    if (!Array.isArray(fills)) return { total, byMarket };
    const buckets = groupFillsByMarketChronologically(fills);
    Object.entries(buckets).forEach(([market, mfills]) => {
      let realized = 0;
      walkMarketFifo(mfills, step => { realized += step.realized; });
      byMarket[market] = realized;
      total += realized;
    });
    return { total, byMarket };
  }

  // FIFO unrealized P&L: the lots the walk leaves open in each market,
  // marked at marketsMap[market].oraclePrice. Pairs with
  // computeRealizedFromFills on the same cost basis, so realized +
  // unrealized equals the fills' cash flow plus the marked inventory.
  // (The indexer's per-position unrealizedPnl marks against the average
  // entry of every opening fill, which double-counts profit FIFO has
  // already realized on a partly reduced position.)
  //
  // Returns { total, byMarket, unpricedMarkets, openMarkets }. A flat market
  // contributes 0. openMarkets lists every market with open lots. A market
  // with open lots and no positive oracle price is null in byMarket and
  // listed in unpricedMarkets, and total is then null.
  function computeUnrealizedFromFills(fills, marketsMap) {
    const byMarket = {};
    const unpricedMarkets = [];
    const openMarkets = [];
    let total = 0;
    if (!Array.isArray(fills)) return { total, byMarket, unpricedMarkets, openMarkets };
    Object.entries(groupFillsByMarketChronologically(fills)).forEach(([market, mfills]) => {
      const { lots, side } = walkMarketFifo(mfills, () => {});
      if (lots.length === 0) {
        byMarket[market] = 0;
        return;
      }
      openMarkets.push(market);
      const oracle = parseFloat(marketsMap && marketsMap[market] && marketsMap[market].oraclePrice);
      if (!(oracle > 0)) {
        byMarket[market] = null;
        unpricedMarkets.push(market);
        return;
      }
      byMarket[market] = lots.reduce((s, lot) => s + (oracle - lot.price) * lot.size * side, 0);
      total += byMarket[market];
    });
    return { total: unpricedMarkets.length ? null : total, byMarket, unpricedMarkets, openMarkets };
  }

  // Per-position P&L, size and prices attributed from /fills. Replaces the
  // indexer's per-position realizedPnl / maxSize / entryPrice / exitPrice,
  // which are wrong on scaled positions (realizedPnl undercounts), on every
  // SHORT (maxSize is the max of the SIGNED size, i.e. the smallest short)
  // and on both rows of a flip (the flip fill's size is split wrongly).
  //
  // One FIFO walk per market (walkMarketFifo) cuts the fills into segments:
  // net size leaves 0 and returns to 0, or flips. A flip fill's closing
  // portion ends the older segment and its opening portion starts the new
  // one. Each segment belongs to the position in that market whose
  // createdAt equals its first fill's time to the millisecond (when
  // several share it, see createdAtOwner); failing that, to the
  // earliest-created position whose [createdAt, closedAt] window
  // (open-ended while OPEN) contains that fill.
  //
  // Cost: the per-market sort plus one FIFO pass, O(n log n) in fills,
  // and a linear scan over the market's positions only for a segment whose
  // first fill matches no position's createdAt.
  //
  // Returns Map<position, attribution> with an entry for every position:
  //   realized    FIFO realized on the position's closing portions (gross)
  //   fees        Σ fill.fee over its portions, a flip fill's fee split by
  //               size (positive = paid, negative = rebate)
  //   profit      realized − fees (funding is separate)
  //   peakSize    largest |net size| during the position, base units, > 0
  //   entryVwap   size-weighted price of the opening portions (null if none)
  //   exitVwap    size-weighted price of the closing portions (null if none)
  //   fillCount   fills touching the position (a flip fill counts for both)
  //   openedByFlip / closedByFlip
  //   complete    false when fills are missing, no segment (or more than
  //               one) matched, the segment's side disagrees with the
  //               position's, a CLOSED position's segment did not return to
  //               flat by its closedAt, a same-side position shares both
  //               its createdAt and closedAt, a fill in the market that
  //               the walk cannot use lies inside the position's window, or
  //               one of its segments starts or ends with a flip that no
  //               opposite-side position closes or opens at that instant
  //               (see flipPartnersListed), or an OPEN position's signed
  //               indexer size is not the net size the walk ends its
  //               market on (see openSizeMatchesWalk).
  //               Consumers render '—' for an incomplete position's values.
  //   openSizeDisagrees  true only for an OPEN position incomplete because
  //               its indexer size is not the walk's final net size: the
  //               market's fills do not add up to the open position, so
  //               the market's FIFO totals are off too.
  // Pure: the positions and fills passed in are never mutated.
  function attributeFillsToPositions(positions, fills) {
    const out = new Map();
    const positionsByMarket = {};
    (positions || []).forEach(p => {
      if (!p) return;
      out.set(p, emptyAttribution());
      const m = p.market || 'Unknown';
      if (!positionsByMarket[m]) positionsByMarket[m] = [];
      const closeMs = timestampMs(p.closedAt);
      positionsByMarket[m].push({
        p,
        openMs: timestampMs(p.createdAt),
        windowEndMs: closeMs === null ? Infinity : closeMs,
        segments: []
      });
    });
    if (!Array.isArray(fills)) return out;

    const timedFills = [];
    const marketsWithUntimedFills = new Set();
    fills.forEach(f => {
      if (!f) return;
      if (timestampMs(f.createdAt) === null) marketsWithUntimedFills.add(f.market || 'Unknown');
      else timedFills.push(f);
    });
    const fillsByMarket = groupFillsByMarketChronologically(timedFills);

    Object.entries(positionsByMarket).forEach(([market, candidates]) => {
      candidates.sort((a, b) => (a.openMs ?? Infinity) - (b.openMs ?? Infinity));
      const createdAtIndex = new Map();
      candidates.forEach(c => {
        if (c.openMs === null) return;
        if (!createdAtIndex.has(c.openMs)) createdAtIndex.set(c.openMs, []);
        createdAtIndex.get(c.openMs).push(c);
      });
      const indistinguishable = new Set();
      createdAtIndex.forEach(sameMs => {
        sameMs.sort((a, b) => a.windowEndMs - b.windowEndMs);
        sameMs.forEach((c, i) => {
          const twin = sameMs.find((o, j) => j !== i && o.windowEndMs === c.windowEndMs
            && positionSide(o.p) === positionSide(c.p));
          if (twin) indistinguishable.add(c);
        });
      });
      const { segments, skippedMs, netSize } = segmentMarketFills(fillsByMarket[market] || []);
      skippedMs.sort((a, b) => a - b);
      const flipPartners = flipPartnerIndex(candidates);
      const unpartneredFlip = new Set();
      segments.forEach(seg => {
        const owner = createdAtOwner(createdAtIndex.get(seg.startMs), seg)
          || candidates.find(c => c.openMs !== null && c.openMs <= seg.startMs && seg.startMs <= c.windowEndMs);
        if (!owner) return;
        owner.segments.push(seg);
        if (!flipPartnersListed(seg, flipPartners)) unpartneredFlip.add(owner);
      });
      candidates.forEach(c => {
        const unusableFillInWindow = marketsWithUntimedFills.has(market)
          || (c.openMs !== null && anyWithin(skippedMs, c.openMs, c.windowEndMs));
        const summary = summarizeSegments(c.p, c.segments, c.windowEndMs, unusableFillInWindow);
        const openSizeDisagrees = c.p.status === 'OPEN' && !openSizeMatchesWalk(c.p, netSize, summary.peakSize);
        if (indistinguishable.has(c) || unpartneredFlip.has(c) || openSizeDisagrees) summary.complete = false;
        summary.openSizeDisagrees = openSizeDisagrees;
        out.set(c.p, summary);
      });
    });
    return out;
  }

  // Among positions created in the segment's first millisecond (sorted by
  // close time, OPEN last), the earliest-closing one on the segment's side
  // that has no segment yet. Two positions share a createdAt when one is
  // opened and reversed, or closed and reopened, within a block; segments
  // arrive in chain order, so the earlier segment belongs to the position
  // that closed first, whatever order the indexer listed them in. Same-side
  // positions that also share a close time cannot be told apart and are
  // marked incomplete by the caller. Falls back to the first position.
  function createdAtOwner(sameMs, seg) {
    if (!sameMs) return null;
    return sameMs.find(c => c.segments.length === 0 && positionSide(c.p) === seg.side)
      || sameMs[0];
  }

  function positionSide(p) {
    return (p.side || '').toUpperCase();
  }

  const OPPOSITE_SIDE = { LONG: 'SHORT', SHORT: 'LONG' };

  // Per side, the createdAt and closedAt milliseconds of the market's
  // positions (OPEN ones close at Infinity).
  function flipPartnerIndex(candidates) {
    const index = {
      LONG: { openMs: new Set(), closeMs: new Set() },
      SHORT: { openMs: new Set(), closeMs: new Set() }
    };
    candidates.forEach(c => {
      const times = index[positionSide(c.p)];
      if (!times) return;
      times.openMs.add(c.openMs);
      times.closeMs.add(c.windowEndMs);
    });
    return index;
  }

  // A flip fill closes one position and opens the opposite-side one in
  // the same fill, so a segment the walk opened by a flip needs an
  // opposite-side position closed at its start, and one it closed by a
  // flip needs an opposite-side position created at its reversal. A
  // missing partner means a fill is missing and the walk's net size, and
  // with it this segment, is off.
  function flipPartnersListed(seg, flipPartners) {
    const partner = flipPartners[OPPOSITE_SIDE[seg.side]];
    return (!seg.openedByFlip || partner.closeMs.has(seg.startMs))
      && (!seg.closedByFlip || partner.openMs.has(seg.flatMs));
  }

  // An OPEN row's indexer size is signed (negative for a SHORT) and
  // reliable, so it must equal the net size the walk ends the market on,
  // within the walk's flat tolerance. A fill missing before the position
  // leaves the walk holding a different size, which the side and flip
  // checks cannot see when the missing fill only shifts the size.
  function openSizeMatchesWalk(position, walkNetSize, peakSize) {
    const indexerSize = parseFloat(position.size);
    return isNumber(indexerSize)
      && Math.abs(walkNetSize - indexerSize) <= flatTolerance(walkNetSize, indexerSize, peakSize || 0);
  }

  // True when the fill walk over the position's market ends holding a
  // position on its side that opened at its createdAt: the position is
  // still open by its fills. Tells a position reopened on the same side
  // within its predecessor's closing block apart from a stale OPEN copy
  // of a position that has since closed.
  function isOpenInFills(position, fills) {
    const openMs = timestampMs(position && position.createdAt);
    if (openMs === null || !Array.isArray(fills)) return false;
    const timedFills = fills.filter(f => f && timestampMs(f.createdAt) !== null);
    const marketFills = groupFillsByMarketChronologically(timedFills)[position.market || 'Unknown'];
    const { segments } = segmentMarketFills(marketFills || []);
    const last = segments[segments.length - 1];
    return !!last && !last.flat && last.side === positionSide(position) && last.startMs === openMs;
  }

  // True when the ascending `sortedMs` holds a value in [fromMs, toMs].
  function anyWithin(sortedMs, fromMs, toMs) {
    let lo = 0, hi = sortedMs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sortedMs[mid] < fromMs) lo = mid + 1; else hi = mid;
    }
    return lo < sortedMs.length && sortedMs[lo] <= toMs;
  }

  // Milliseconds since epoch of an ISO timestamp, null when absent or
  // unparseable. The one timestamp parser the attribution and the tax
  // report share, so both window fills identically.
  function timestampMs(iso) {
    const t = Date.parse(iso || '');
    return Number.isFinite(t) ? t : null;
  }

  function emptyAttribution() {
    return {
      realized: 0, fees: 0, profit: 0,
      peakSize: null, entryVwap: null, exitVwap: null,
      fillCount: 0, complete: false,
      openedByFlip: false, closedByFlip: false,
      openSizeDisagrees: false
    };
  }

  // Cuts one market's sorted fills into position segments. Each segment
  // holds its fill portions ({ fill, qty, price, feeShare, realized,
  // closing }), its peak |net size|, whether it returned to flat and at
  // which millisecond (`flatMs`), and its flip flags. `skippedMs` lists
  // the timestamps of unusable fills; `netSize` is the signed net size
  // the walk ends on.
  function segmentMarketFills(sortedFills) {
    const segments = [];
    const skippedMs = [];
    let current = null;
    const { netSize } = walkMarketFifo(sortedFills, step => {
      if (step.closeQty > 0 && current) {
        current.portions.push({
          fill: step.fill, qty: step.closeQty, price: step.price,
          feeShare: step.closeQty / step.size, realized: step.realized, closing: true
        });
        const fullyClosed = step.netAfter === 0 || Math.sign(step.netAfter) !== Math.sign(step.netBefore);
        if (fullyClosed) {
          current.flat = true;
          current.flatMs = timestampMs(step.fill.createdAt);
          current.closedByFlip = step.openQty > 0;
          current = null;
        }
      }
      if (step.openQty > 0) {
        if (!current) {
          current = {
            startMs: timestampMs(step.fill.createdAt),
            side: step.netAfter > 0 ? 'LONG' : 'SHORT',
            openedByFlip: step.closeQty > 0,
            closedByFlip: false,
            flat: false,
            flatMs: null,
            peakSize: 0,
            portions: []
          };
          segments.push(current);
        }
        current.portions.push({
          fill: step.fill, qty: step.openQty, price: step.price,
          feeShare: step.openQty / step.size, realized: 0, closing: false
        });
        current.peakSize = Math.max(current.peakSize, Math.abs(step.netAfter));
      }
    }, fill => skippedMs.push(timestampMs(fill.createdAt)));
    return { segments, skippedMs, netSize };
  }

  function summarizeSegments(position, segments, windowEndMs, unusableFillInWindow) {
    if (segments.length === 0) return emptyAttribution();
    let realized = 0, fees = 0, peakSize = 0;
    let openQty = 0, openNotional = 0, closeQty = 0, closeNotional = 0;
    const touched = new Set();
    segments.forEach(seg => {
      peakSize = Math.max(peakSize, seg.peakSize);
      seg.portions.forEach(part => {
        touched.add(part.fill);
        realized += part.realized;
        const fee = parseFloat(part.fill.fee);
        if (isNumber(fee)) fees += fee * part.feeShare;
        if (part.closing) {
          closeQty += part.qty;
          closeNotional += part.qty * part.price;
        } else {
          openQty += part.qty;
          openNotional += part.qty * part.price;
        }
      });
    });
    const only = segments.length === 1 ? segments[0] : null;
    const side = positionSide(position);
    const sideAgrees = !side || (only !== null && only.side === side);
    const flatByClose = only !== null && only.flat && only.flatMs <= windowEndMs;
    const flatWhenRequired = position.status !== 'CLOSED' || flatByClose;
    return {
      realized,
      fees,
      profit: realized - fees,
      peakSize,
      entryVwap: openQty > 0 ? openNotional / openQty : null,
      exitVwap: closeQty > 0 ? closeNotional / closeQty : null,
      fillCount: touched.size,
      complete: only !== null && sideAgrees && flatWhenRequired && !unusableFillInWindow,
      openedByFlip: segments[0].openedByFlip,
      closedByFlip: segments[segments.length - 1].closedByFlip,
      openSizeDisagrees: false
    };
  }

  // Sum of trading fees across every fill. dYdX v4 indexer convention:
  // `fill.fee` is a string USD amount where POSITIVE = paid by the user
  // (taker fees and most maker fills) and NEGATIVE = maker rebate received.
  // The caller subtracts this from profit so rebates ADD to the bottom
  // line. NaN-safe; returns 0 on empty input. The complement to
  // netFundingTotal in the equity-based reconciliation:
  //   totalPnl ≈ realized + unrealized + netFunding − fees + …
  function feesTotal(fills) {
    return (fills || []).reduce((s, f) => {
      if (!f) return s;
      const v = parseFloat(f.fee);
      return isNumber(v) ? s + v : s;
    }, 0);
  }

  // Per-market fees map keyed by `fill.market`. Same NaN-safety and same
  // dYdX positive-paid sign convention as feesTotal. Returns
  // { [market]: feesPaid }. Fed into marketPnL(positions, feesMap) so the
  // per-asset table and chart tooltip reconcile to the headline.
  function marketFees(fills) {
    const out = {};
    (fills || []).forEach(f => {
      if (!f) return;
      const v = parseFloat(f.fee);
      if (!isNumber(v)) return;
      const m = f.market || 'Unknown';
      out[m] = (out[m] || 0) + v;
    });
    return out;
  }

  // Monthly Δ totalPnl from /historical-pnl rows. Returns
  // { [monthKey]: { delta, hasData } } where monthKey is the same
  // `month long, year numeric` formatting the Monthly Performance
  // Breakdown already uses, `delta` is `lastOfMonth.totalPnl −
  // lastOfPriorMonth.totalPnl`, and `hasData=false` when the month
  // contributed no rows (the caller renders "—" per the no-metric-better-
  // than-wrong-metric rule). The earliest observed month receives
  // `delta = firstRow.totalPnl − 0`, which slightly overstates that
  // first-month contribution when the series does not start at the
  // account's inception; the dashboard does not flag that case.
  function histPnlMonthly(historicalPnl) {
    if (!Array.isArray(historicalPnl) || historicalPnl.length === 0) return {};
    const sorted = historicalPnl
      .slice()
      .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
    const monthLastValue = new Map();
    const monthOrder = [];
    for (const row of sorted) {
      const d = new Date(row.createdAt);
      if (isNaN(d)) continue;
      const key = d.toLocaleString('en-US', { month: 'long', year: 'numeric' });
      if (!monthLastValue.has(key)) monthOrder.push(key);
      const v = parseFloat(row.totalPnl);
      if (isNumber(v)) monthLastValue.set(key, v);
    }
    const out = {};
    let prev = 0;
    for (const key of monthOrder) {
      const last = monthLastValue.get(key);
      if (typeof last !== 'number') {
        out[key] = { delta: 0, hasData: false };
        continue;
      }
      out[key] = { delta: last - prev, hasData: true };
      prev = last;
    }
    return out;
  }

  // Per-position liquidation price under cross-margin assuming OTHER open
  // positions hold their current uPnL contribution. Exact for accounts with
  // a single open position; an isolation approximation otherwise.
  //
  // Derivation — at liquidation, equity equals maintenance margin requirement
  // computed off liquidation-price notional:
  //   LONG:  E + S·(P_liq − O) = S·P_liq·MMF  →  P_liq = (S·O − E) / (S·(1 − MMF))
  //   SHORT: E + |S|·(O − P_liq) = |S|·P_liq·MMF  →  P_liq = (E + |S|·O) / (|S|·(1 + MMF))
  // Returns null when MMF / size / equity unavailable.
  function crossMarginLiqPrice(position, subaccount, marketsMap) {
    if (!position || !subaccount) return null;
    const market = position.market;
    const m = (marketsMap && marketsMap[market]) || {};
    const size = Math.abs(parseFloat(position.size || 0));
    const oracle = parseFloat(position.oraclePrice || m.oraclePrice || 0);
    const mmf = parseFloat(m.maintenanceMarginFraction || 0);
    const equity = parseFloat(subaccount.equity || 0);
    const side = (position.side || '').toUpperCase();
    if (!(size > 0) || !(oracle > 0) || !(mmf > 0) || !(equity > 0)) return null;
    if (side === 'LONG') {
      const denom = size * (1 - mmf);
      if (denom <= 0) return null;
      return Math.max(0, (size * oracle - equity) / denom);
    }
    if (side === 'SHORT') {
      const denom = size * (1 + mmf);
      if (denom <= 0) return null;
      return (equity + oracle * size) / denom;
    }
    return null;
  }

  // Open-position notional: |size| × price, where price prefers ORACLE
  // (mark) to match dYdX's official UI: the position's own oraclePrice,
  // then marketsMap[market].oraclePrice (position objects from
  // /perpetualPositions don't carry oraclePrice; the markets map is the
  // canonical source), then entryPrice. Null when no positive size or price.
  // Single definition behind leverageUtilization, liquidationRow and the
  // Positions board's Active Positions card.
  function positionNotional(position, marketsMap) {
    if (!position) return null;
    const m = (marketsMap && marketsMap[position.market]) || {};
    const size = Math.abs(parseFloat(position.size || 0));
    const price = parseFloat(position.oraclePrice || m.oraclePrice || position.entryPrice || 0);
    return size > 0 && price > 0 ? size * price : null;
  }

  // Account-level leverage utilization — sum of positionNotional across open
  // positions ÷ subaccount equity. Returns null when equity is non-positive
  // or no usable notional exists.
  function leverageUtilization(positions, subaccount, marketsMap) {
    const equity = subaccount ? parseFloat(subaccount.equity || 0) : 0;
    if (!(equity > 0)) return null;
    const notional = (positions || [])
      .filter(p => p && p.status === 'OPEN')
      .reduce((s, p) => s + (positionNotional(p, marketsMap) || 0), 0);
    return notional > 0 ? notional / equity : null;
  }

  // Per-row liquidation table data. Pure compute; the caller renders.
  // Notional and leverage use positionNotional (oracle-first, entry as
  // fallback) so the account-level card and per-row LEVERAGE column never
  // diverge. The oracle, liquidation price and distance need an oracle
  // price and have no entry fallback (0 / null without one).
  function liquidationRow(position, subaccount, marketsMap) {
    if (!position || !subaccount) return null;
    const m = (marketsMap && marketsMap[position.market]) || {};
    const size = Math.abs(parseFloat(position.size || 0));
    const entry = parseFloat(position.entryPrice || 0);
    const oracle = parseFloat(position.oraclePrice || m.oraclePrice || 0);
    const equity = parseFloat(subaccount.equity || 0);
    const notional = positionNotional(position, marketsMap) || 0;
    const lev = (equity > 0 && notional > 0) ? notional / equity : null;
    const liq = crossMarginLiqPrice(position, subaccount, marketsMap);
    const distancePct = (oracle > 0 && liq !== null && isFinite(liq))
      ? Math.abs((oracle - liq) / oracle) * PERCENT
      : null;
    return { size, entry, oracle, notional, lev, liq, distancePct };
  }

  window.RiskMetrics = {
    computeReturnsFromEquitySeries,
    computeTimeWeightedReturnsFromHist,
    computeSharpe,
    computeSortino,
    computeFromHistoricalPnl,
    detectPeriodsPerYearFromTimestamps,
    computeAnnualizedFromReturns,
    computeAnnualizedFromHistoricalPnl,
    hasCompleteAttribution,
    classifyClosed,
    classifyByMonth,
    peakNotional,
    tradeReturn,
    validDrawdownFromEquity,
    assessAdequacy,
    tradeSystemDrawdown,
    tradeSystemDrawdownEvents,
    tradeSystemCurrentDrawdown,
    histPnlDrawdown,
    histPnlDrawdownEvents,
    histPnlCurrentDrawdown,
    buildCumulativeTotalPnlSeries,
    marketPnL,
    netFundingTotal,
    feesTotal,
    marketFees,
    computeRealizedFromFills,
    computeUnrealizedFromFills,
    equityAdjustedTotalPnl,
    attributeFillsToPositions,
    isOpenInFills,
    isFifoUsableFill,
    timestampMs,
    activeChildSubaccounts,
    histPnlMonthly,
    crossMarginLiqPrice,
    positionNotional,
    leverageUtilization,
    liquidationRow,
    ADEQUACY: {
      MIN_RETS: ADEQUACY_MIN_RETS,
      MIN_YEARS: ADEQUACY_MIN_YEARS,
      MIN_COVERAGE: ADEQUACY_MIN_COVERAGE
    }
  };
})();


