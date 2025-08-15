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
   * @returns {number}
   */
  function computeSharpe(returns, mar = 0) {
    if (!Array.isArray(returns) || returns.length === 0) return 0;
    const excess = returns.map(r => r - mar);
    const mu = mean(excess);
    const sd = stdDev(excess);
    return sd > 0 ? (mu / sd) : 0;
  }

  /**
   * Compute Sortino ratio from per-period returns.
   * @param {number[]} returns fractional returns per period
   * @param {number} mar minimum acceptable return per period (default 0)
   * @param {'all'|'negative'} denominator Use all periods in denominator ('all') or only negative periods ('negative')
   * @returns {number}
   */
  function computeSortino(returns, mar = 0, denominator = 'negative') {
    if (!Array.isArray(returns) || returns.length === 0) return 0;
    const excess = returns.map(r => r - mar);
    const mu = mean(excess);
    const downs = excess.map(x => Math.min(0, x));

    let dd;
    if (denominator === 'all') {
      const downVarAll = downs.reduce((a, d) => a + d * d, 0) / returns.length;
      dd = Math.sqrt(downVarAll);
    } else {
      const neg = downs.filter(d => d < 0);
      if (neg.length === 0) return Infinity; // No downside
      const downVarNeg = neg.reduce((a, d) => a + d * d, 0) / neg.length;
      dd = Math.sqrt(downVarNeg);
    }
    return dd > 0 ? (mu / dd) : Infinity;
  }

  /**
   * Compute risk metrics from historicalPnl objects as returned by /v4/historical-pnl
   * @param {Array} historicalPnl array of { equity, createdAt, ... }
   * @param {{mar?: number, denominator?: 'all'|'negative'}} options
   */
  function computeFromHistoricalPnl(historicalPnl, options = {}) {
    const mar = options.mar ?? 0;
    const denominator = options.denominator ?? 'negative';
    const series = Array.isArray(historicalPnl) ? historicalPnl.slice().sort((a, b) => (
      (a.createdAt || '').localeCompare(b.createdAt || '')
    )) : [];
    const equity = series.map(p => parseFloat(p.equity || 0)).filter(isNumber);
    const returns = computeReturnsFromEquitySeries(equity);
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
    const denominator = options.denominator ?? 'negative';
    const perPeriodSharpe = computeSharpe(returns, mar);
    const perPeriodSortino = computeSortino(returns, mar, denominator);
    const ppy = detectPeriodsPerYearFromTimestamps(timestamps);
    const factor = ppy > 0 ? Math.sqrt(ppy) : 1;
    return {
      sharpe: perPeriodSharpe,
      sortino: perPeriodSortino,
      sharpeAnnualized: perPeriodSharpe * factor,
      sortinoAnnualized: perPeriodSortino * factor,
      ppy
    };
  }

  function computeAnnualizedFromHistoricalPnl(historicalPnl, options = {}) {
    const mar = options.mar ?? 0;
    const denominator = options.denominator ?? 'negative';
    const series = Array.isArray(historicalPnl) ? historicalPnl.slice().sort((a, b) => (
      (a.createdAt || '').localeCompare(b.createdAt || '')
    )) : [];
    const equity = series.map(p => parseFloat(p.equity || 0)).filter(isNumber);
    const timestamps = series.map(p => p.createdAt).filter(Boolean);
    const returns = computeReturnsFromEquitySeries(equity);
    const { sharpe, sortino, sharpeAnnualized, sortinoAnnualized, ppy } = computeAnnualizedFromReturns(returns, timestamps, { mar, denominator });
    return { returns, sharpe, sortino, sharpeAnnualized, sortinoAnnualized, ppy };
  }

  window.RiskMetrics = {
    computeReturnsFromEquitySeries,
    computeSharpe,
    computeSortino,
    computeFromHistoricalPnl,
    detectPeriodsPerYearFromTimestamps,
    computeAnnualizedFromReturns,
    computeAnnualizedFromHistoricalPnl
  };
})();


