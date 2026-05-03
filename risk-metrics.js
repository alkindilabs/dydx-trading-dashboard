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

  window.RiskMetrics = {
    computeReturnsFromEquitySeries,
    computeTimeWeightedReturnsFromHist,
    computeSharpe,
    computeSortino,
    computeFromHistoricalPnl,
    detectPeriodsPerYearFromTimestamps,
    computeAnnualizedFromReturns,
    computeAnnualizedFromHistoricalPnl
  };
})();


