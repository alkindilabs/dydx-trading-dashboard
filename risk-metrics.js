/**
 * Risk metrics utilities (no dependencies)
 * Exposes global `RiskMetrics` with helpers to compute Sharpe and Sortino.
 * All returns are fractional per-period returns (e.g., 0.01 = 1%).
 */

(function () {
  'use strict';

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
   * Compute Sortino ratio from per-period returns.
   * Both denominator modes use the canonical sum-of-squares of negative excess
   * returns; they only differ in the divisor:
   *   'all'      → divide by total period count N (target semi-deviation, the
   *                Sortino downside deviation as defined by Frank Sortino).
   *   'negative' → divide by N as well; preserved as an alias of 'all' for
   *                backward compatibility. (Earlier versions divided by the
   *                count of negative periods, which is a non-standard
   *                semi-deviation that overstates Sortino.)
   * @param {number[]} returns fractional returns per period
   * @param {number} mar minimum acceptable return per period (default 0)
   * @param {'all'|'negative'} denominator deviation divisor mode (default 'all')
   * @returns {number|null} null when undefined; Infinity only if no downside variance
   */
  function computeSortino(returns, mar = 0, denominator = 'all') {
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
   * @param {{mar?: number, denominator?: 'all'|'negative'}} options
   */
  function computeFromHistoricalPnl(historicalPnl, options = {}) {
    const mar = options.mar ?? 0;
    const denominator = options.denominator ?? 'all';
    const returns = computeTimeWeightedReturnsFromHist(historicalPnl);
    const sharpe = computeSharpe(returns, mar);
    const sortino = computeSortino(returns, mar, denominator);
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
    const denominator = options.denominator ?? 'all';
    const perPeriodSharpe = computeSharpe(returns, mar);
    const perPeriodSortino = computeSortino(returns, mar, denominator);
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
    const denominator = options.denominator ?? 'all';
    const series = Array.isArray(historicalPnl) ? historicalPnl.slice().sort((a, b) => (
      (a.createdAt || '').localeCompare(b.createdAt || '')
    )) : [];
    const timestamps = series.map(p => p.createdAt).filter(Boolean);
    const returns = computeTimeWeightedReturnsFromHist(series);
    const { sharpe, sortino, sharpeAnnualized, sortinoAnnualized, ppy } = computeAnnualizedFromReturns(returns, timestamps, { mar, denominator });
    return { returns, sharpe, sortino, sharpeAnnualized, sortinoAnnualized, ppy };
  }

  // ---------------------------------------------------------------------------
  // Shared classifiers / helpers used across the dashboard. Single source of
  // truth — every UI surface that reports trade counts, win rate, P&L, or
  // drawdown calls these instead of recomputing inline.
  // ---------------------------------------------------------------------------

  // Repair indexer-zeroed realizedPnl for older closed positions. dYdX's
  // indexer is observed to return realizedPnl=0 for many positions before a
  // certain date even when entry/exit prices clearly diverge. Without this
  // patch the dashboard mis-classifies real losses/wins as scratches and
  // shows $0 P&L for entire months. The fallback uses VWAP entry/exit and
  // the maxSize field (peak position size; falls through to sumOpen / size
  // when absent), producing gross price-difference P&L. Approximate — does
  // NOT include fees — but a far better signal than zero.
  //
  // Mutates positions in place: sets `p.realizedPnl` to a stringified
  // number and `p._derivedRealizedPnl = true` for transparency. Returns a
  // summary `{correctedCount, totalCorrectedAbs}` so the caller can surface
  // a banner.
  function normalizeRealizedPnl(positions) {
    let correctedCount = 0;
    let totalCorrectedAbs = 0;
    (positions || []).forEach(p => {
      if (!p || p.status !== 'CLOSED') return;
      const indexerRp = parseFloat(p.realizedPnl);
      // Trust the indexer when it reports a non-zero value.
      if (isNumber(indexerRp) && indexerRp !== 0) return;
      const e = parseFloat(p.entryPrice || 0);
      const x = parseFloat(p.exitPrice || 0);
      const sz = Math.abs(parseFloat(p.maxSize || p.sumOpen || p.size || 0));
      // Need real prices, real size, and a price move; otherwise leave the
      // zero in place (truly a scratch or insufficient data).
      if (!(e > 0) || !(x > 0) || !(sz > 0) || e === x) return;
      const sideMult = (p.side || '').toUpperCase() === 'LONG' ? 1 : -1;
      const computed = (x - e) * sz * sideMult;
      if (!isNumber(computed) || computed === 0) return;
      p.realizedPnl = String(computed);
      p._derivedRealizedPnl = true;
      correctedCount++;
      totalCorrectedAbs += Math.abs(computed);
    });
    return { correctedCount, totalCorrectedAbs };
  }

  // Classify closed positions into wins / losses / scratches by realizedPnl
  // sign. Scratches (realizedPnl == 0) are tracked separately and excluded
  // from win-rate-style ratios.
  function classifyClosed(positions) {
    const closed = (positions || []).filter(p => p && p.status === 'CLOSED');
    const wins = [], losses = [], scratches = [];
    let grossWin = 0, grossLoss = 0;
    closed.forEach(p => {
      const r = parseFloat(p.realizedPnl || 0);
      if (!isNumber(r)) return;
      if (r > 0)      { wins.push(p);     grossWin  += r;          }
      else if (r < 0) { losses.push(p);   grossLoss += Math.abs(r); }
      else            { scratches.push(p); }
    });
    return {
      wins, losses, scratches, all: closed,
      grossWin, grossLoss,
      totalRealized: grossWin - grossLoss,
      winCount: wins.length,
      lossCount: losses.length,
      scratchCount: scratches.length,
      decisiveCount: wins.length + losses.length, // non-scratch
      closedCount: closed.length
    };
  }

  // Per-trade fractional return on max-instantaneous notional.
  // Denominator: maxSize × entryPrice — the largest position notional
  // ever held during the lifecycle, NOT the cumulative entered size.
  // For scaled-in/out positions, sumOpen overstates capital deployed
  // and biases per-trade ratios low; maxSize (when the indexer
  // exposes it) is the honest "peak capital at risk." Falls back to
  // sumOpen / size when maxSize is absent so legacy responses still
  // produce a number, with the caveat that scaled positions read
  // smaller-than-actual returns.
  // Used by per-trade Sharpe (fallback) AND asset-level Sharpe AND
  // win/loss distribution. Returns null when notional is undefined.
  function tradeReturn(p) {
    const sz = Math.abs(parseFloat(p.maxSize || p.sumOpen || p.size || 0));
    const px = parseFloat(p.entryPrice || 0);
    const pnl = parseFloat(p.realizedPnl || 0);
    if (!(sz > 0) || !(px > 0)) return null;
    const r = pnl / (sz * px);
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
      pct: Math.abs(maxDD) * 100,
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
      reason = `Coverage ${(coverage * 100).toFixed(0)}% — most periods filtered (likely post-wipeout sample bias)`;
    }
    return { adequate, reason, ppy, years, coverage, n };
  }

  // Sort closed positions chronologically and build the cumulative
  // realizedPnl series. Shared by tradeSystemDrawdown (worst single event)
  // and tradeSystemDrawdownEvents (every peak→recovery cycle) so the two
  // can never operate on different inputs.
  function buildCumulativeRealizedSeries(closedPositions) {
    const closed = (closedPositions || [])
      .filter(p => p && p.status === 'CLOSED' && p.closedAt)
      .slice()
      .sort((a, b) => (
        new Date(a.closedAt).getTime() - new Date(b.closedAt).getTime()
      ));
    let cum = 0;
    const cums = closed.map(p => {
      cum += parseFloat(p.realizedPnl || 0);
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
  // Single source of truth for both the totalPnl-based and realizedPnl-based
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
        pctOfPeakProfit: ddPeak > 0 ? (ddAbs / ddPeak) * 100 : 0,
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

  // Trade-system drawdown: peak-to-trough on cumulative realizedPnl over
  // closed trades, in chronological order. Used as the fallback when
  // historical-pnl is unavailable. Cumulative realizedPnl never has
  // synthetic-equity artifacts, so no negative-trough filter is needed.
  function tradeSystemDrawdown(closedPositions) {
    const { closed, cums } = buildCumulativeRealizedSeries(closedPositions);
    const out = scanDrawdownEvents(cums).worst;
    out.n = closed.length;
    out.closed = closed;
    return out;
  }

  // Find every peak-to-recovery drawdown event on the cumulative realizedPnl
  // curve. Used as the fallback for the Drawdown Periods table when
  // historical-pnl is unavailable.
  function tradeSystemDrawdownEvents(closedPositions) {
    const { cums } = buildCumulativeRealizedSeries(closedPositions);
    return scanDrawdownEvents(cums).events;
  }

  // Per-market P&L. Single definition: realized of CLOSED + unrealized of
  // OPEN. Used by Overview chart tooltip AND Performance-by-Asset table so
  // the same market never reads two different P&L numbers.
  function marketPnL(positions) {
    const byMarket = {};
    (positions || []).forEach(p => {
      if (!p) return;
      const m = p.market || 'Unknown';
      if (!byMarket[m]) {
        byMarket[m] = {
          realizedClosed: 0, unrealizedOpen: 0, total: 0,
          closedCount: 0, openCount: 0
        };
      }
      const slot = byMarket[m];
      if (p.status === 'CLOSED') {
        slot.realizedClosed += parseFloat(p.realizedPnl || 0);
        slot.closedCount += 1;
      } else if (p.status === 'OPEN') {
        slot.unrealizedOpen += parseFloat(p.unrealizedPnl || 0);
        slot.openCount += 1;
      }
    });
    Object.values(byMarket).forEach(s => {
      s.total = s.realizedClosed + s.unrealizedOpen;
    });
    return byMarket;
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

  // Account-level leverage utilization — sum of |size|×oracle across open
  // positions ÷ subaccount equity. Notional prefers ORACLE (mark) over entry
  // to match dYdX's official UI; falls back to entry when oracle is missing.
  // Position objects from /perpetualPositions don't carry oraclePrice; the
  // marketsMap lookup is the canonical source. Returns null when equity is
  // non-positive or no usable notional exists.
  function leverageUtilization(positions, subaccount, marketsMap) {
    const equity = subaccount ? parseFloat(subaccount.equity || 0) : 0;
    if (!(equity > 0)) return null;
    const open = (positions || []).filter(p => p && p.status === 'OPEN');
    const notional = open.reduce((s, p) => {
      const sz = Math.abs(parseFloat(p.size || 0));
      const m = (marketsMap && marketsMap[p.market]) || {};
      const px = parseFloat(p.oraclePrice || m.oraclePrice || p.entryPrice || 0);
      return (sz > 0 && px > 0) ? s + sz * px : s;
    }, 0);
    return notional > 0 ? notional / equity : null;
  }

  // Per-row liquidation table data. Pure compute; the caller renders. Notional
  // / leverage source matches leverageUtilization (oracle-first) so the
  // account-level card and per-row LEVERAGE column never diverge.
  function liquidationRow(position, subaccount, marketsMap) {
    if (!position || !subaccount) return null;
    const m = (marketsMap && marketsMap[position.market]) || {};
    const size = Math.abs(parseFloat(position.size || 0));
    const entry = parseFloat(position.entryPrice || 0);
    const oracle = parseFloat(position.oraclePrice || m.oraclePrice || 0);
    const equity = parseFloat(subaccount.equity || 0);
    const notional = size * (oracle || entry || 0);
    const lev = (equity > 0 && notional > 0) ? notional / equity : null;
    const liq = crossMarginLiqPrice(position, subaccount, marketsMap);
    const distancePct = (oracle > 0 && liq !== null && isFinite(liq))
      ? Math.abs((oracle - liq) / oracle) * 100
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
    classifyClosed,
    normalizeRealizedPnl,
    tradeReturn,
    validDrawdownFromEquity,
    assessAdequacy,
    tradeSystemDrawdown,
    tradeSystemDrawdownEvents,
    histPnlDrawdown,
    histPnlDrawdownEvents,
    buildCumulativeTotalPnlSeries,
    marketPnL,
    crossMarginLiqPrice,
    leverageUtilization,
    liquidationRow,
    ADEQUACY: {
      MIN_RETS: ADEQUACY_MIN_RETS,
      MIN_YEARS: ADEQUACY_MIN_YEARS,
      MIN_COVERAGE: ADEQUACY_MIN_COVERAGE
    }
  };
})();


