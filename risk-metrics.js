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
  // sign. Scratches (realizedPnl == 0) are excluded from win-rate-style
  // ratios. Derived fields (winRate, profitFactor, avgWin, avgLoss,
  // expectancy) are computed once here so consumers cannot adopt different
  // definitions in different panels. Each is null when its denominator is
  // zero — surface as '—' per the no-metric-better-than-wrong-metric rule.
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
    const winCount = wins.length;
    const lossCount = losses.length;
    const decisiveCount = winCount + lossCount;
    const totalRealized = grossWin - grossLoss;
    return {
      wins, losses, scratches, all: closed,
      grossWin, grossLoss,
      totalRealized,
      winCount,
      lossCount,
      scratchCount: scratches.length,
      decisiveCount,
      closedCount: closed.length,
      winRate:      decisiveCount > 0 ? (winCount / decisiveCount) * 100 : null,
      profitFactor: grossLoss > 0     ? grossWin / grossLoss            : null,
      avgWin:       winCount > 0      ? grossWin / winCount              : null,
      avgLoss:      lossCount > 0     ? grossLoss / lossCount            : null,
      expectancy:   decisiveCount > 0 ? totalRealized / decisiveCount    : null
    };
  }

  // Bucket closed positions by closedAt month, then run classifyClosed per
  // bucket. Returns { [monthKey]: Classification } where monthKey matches
  // the "Month long, year numeric" format the Monthly Performance Breakdown
  // table uses. Months with zero closed positions are omitted — caller
  // merges them in from histPnlMonthly when funding-only months matter.
  function classifyByMonth(positions) {
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
    Object.keys(byMonth).forEach(k => { out[k] = classifyClosed(byMonth[k]); });
    return out;
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
      pctOfPeakProfit: peak > 0 ? (dollarDrawdown / peak) * 100 : 0,
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

  // Fallback path: current drawdown on cumulative realizedPnl. Used when
  // historical-pnl is unavailable, mirroring tradeSystemDrawdown's role.
  function tradeSystemCurrentDrawdown(closedPositions) {
    const { closed, cums } = buildCumulativeRealizedSeries(closedPositions);
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
  // `feesMap` is optional: `{ [market]: feesPaid }` where positive = USD
  // paid (taker / most maker), negative = maker rebate (dYdX fill.fee
  // convention). Subtracted from total so rebates ADD to the bottom line.
  //
  // Used by Overview chart tooltip AND Performance-by-Asset table so the
  // same market never reads two different P&L numbers.
  function marketPnL(positions, feesMap, realizedByMarket) {
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

  // FIFO realized P&L computed bottom-up from /fills. Walks each market's
  // fills chronologically, maintaining a signed inventory of open lots;
  // realizes profit/loss whenever a fill reduces the existing position.
  //
  // Why this over /perpetualPositions.realizedPnl: the indexer's per-
  // position `realizedPnl` field has observed accounting gaps — it
  // undercounts lifetime realized for accounts that scale in/out heavily
  // (verified against equity-truth via /historical-pnl totalPnl). FIFO
  // over the raw fill records reconciles to the equity-based number
  // within float-rounding, with no dependence on the indexer-computed
  // realizedPnl field.
  //
  // Cost-basis convention: FIFO (first-in, first-out). For a position
  // that returns to zero size, the LIFETIME realized total is invariant
  // to convention (FIFO / LIFO / HIFO all sum to the same number); only
  // per-trade attribution differs. FIFO is the transparent default.
  //
  // Handles position flips (long → through zero → short in a single
  // fill) by closing all current inventory at the fill price, then
  // opening fresh opposite-side inventory at the same price for the
  // residual size.
  //
  // Returns { total, byMarket } where byMarket maps market → realized.
  // Markets with only OPEN inventory (no closing fills yet) emit 0 —
  // their unrealized P&L still comes from /perpetualPositions.unrealizedPnl
  // mark-to-market.
  //
  // Tie-breaking for same-block fills: primary sort `createdAt`,
  // secondary `createdAtHeight`, tertiary `id` (UUID string compare).
  // dYdX sequences fills deterministically within a block; this matches
  // their order so realized accrues in chain-time sequence.
  function computeRealizedFromFills(fills) {
    if (!Array.isArray(fills) || fills.length === 0) {
      return { total: 0, byMarket: {} };
    }
    const buckets = {};
    for (const f of fills) {
      if (!f) continue;
      const m = f.market || 'Unknown';
      if (!buckets[m]) buckets[m] = [];
      buckets[m].push(f);
    }
    let total = 0;
    const byMarket = {};
    Object.entries(buckets).forEach(([market, mfills]) => {
      mfills.sort((a, b) => {
        const ta = a.createdAt || '';
        const tb = b.createdAt || '';
        if (ta !== tb) return ta < tb ? -1 : 1;
        const ha = parseInt(a.createdAtHeight || '0', 10);
        const hb = parseInt(b.createdAtHeight || '0', 10);
        if (ha !== hb) return ha - hb;
        const ia = a.id || '';
        const ib = b.id || '';
        return ia < ib ? -1 : ia > ib ? 1 : 0;
      });
      const inventory = []; // [{ size, price }] FIFO order, always positive size
      let netSize = 0;     // signed: positive = LONG, negative = SHORT
      let realized = 0;
      for (const f of mfills) {
        const sz = Math.abs(parseFloat(f.size));
        const px = parseFloat(f.price);
        if (!isNumber(sz) || sz <= 0 || !isNumber(px)) continue;
        const side = (f.side || '').toUpperCase();
        if (side !== 'BUY' && side !== 'SELL') continue;
        const signed = side === 'BUY' ? sz : -sz;
        const extending =
          netSize === 0 ||
          (netSize > 0 && signed > 0) ||
          (netSize < 0 && signed < 0);
        if (extending) {
          inventory.push({ size: sz, price: px });
          netSize += signed;
          continue;
        }
        // Reducing — consume FIFO lots. The sign of the EXISTING position
        // (netSize before this fill) determines the P&L formula: long
        // closed by a sell → (sellPrice − costBasis) × matched; short
        // closed by a buy → (costBasis − buyPrice) × matched.
        const closingLong = netSize > 0;
        let remaining = sz;
        while (remaining > 0 && inventory.length > 0) {
          const lot = inventory[0];
          const matched = Math.min(remaining, lot.size);
          const pnl = closingLong
            ? (px - lot.price) * matched
            : (lot.price - px) * matched;
          realized += pnl;
          lot.size -= matched;
          remaining -= matched;
          if (lot.size <= 1e-12) inventory.shift();
        }
        netSize += signed;
        // Flip residual opens fresh inventory in the new direction at
        // the same fill price — the chain treats a flip atomically.
        if (remaining > 1e-12) {
          inventory.push({ size: remaining, price: px });
        }
      }
      byMarket[market] = realized;
      total += realized;
    });
    return { total, byMarket };
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
  // first-month contribution when /historical-pnl was paginated-capped;
  // the existing `historyCapped` banner already discloses that case.
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
    classifyByMonth,
    normalizeRealizedPnl,
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
    activeChildSubaccounts,
    histPnlMonthly,
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


