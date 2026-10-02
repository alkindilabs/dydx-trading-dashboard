/**
 * Risk metrics utilities. Depends on window.AppConstants (PERCENT,
 * MS_PER_HOUR, MS_PER_YEAR, MONTHS_PER_YEAR, CENTS_PER_DOLLAR,
 * NOISE_FREE_SIGNIFICANT_DIGITS), and at
 * call time on window.Format (drawdownAsDisplayed, the depth a drawdown's
 * cells show, by which the drawdown scanner ranks events; asDisplayed, by
 * which compoundReturns reads a drawdown the Calmar caption shows as 0.0%).
 * Exposes global `RiskMetrics`: the single source for fill attribution,
 * trade classification, P&L, drawdown, sample-adequacy and
 * liquidation/leverage math.
 * All returns are fractional per-period returns (e.g., 0.01 = 1%).
 */

(function () {
  'use strict';

  const {
    PERCENT, MS_PER_HOUR, MS_PER_YEAR, MONTHS_PER_YEAR, CENTS_PER_DOLLAR,
    NOISE_FREE_SIGNIFICANT_DIGITS
  } = window.AppConstants;

  function isNumber(n) {
    return typeof n === 'number' && !isNaN(n) && isFinite(n);
  }

  // A period whose return base is below this share of the median positive
  // equity of the rows is dust (e.g. the hour after a near-total
  // withdrawal) and its return is excluded, which lowers the adequacy
  // gate's coverage.
  const TWR_MIN_BASE_SHARE_OF_MEDIAN_EQUITY = 0.01;

  // The smallest return base that is not dust: the account-wide floor of
  // the time-weighted returns and the per-trade return on equity at open,
  // from every /historical-pnl row's equity. Null when no row has
  // positive equity.
  function minReturnBase(historicalPnl) {
    const positiveEquities = (historicalPnl || [])
      .map(r => parseFloat(r && r.equity))
      .filter(e => e > 0);
    return positiveEquities.length === 0 ? null
      : median(positiveEquities) * TWR_MIN_BASE_SHARE_OF_MEDIAN_EQUITY;
  }

  // The Modified Dietz base of a period between two /historical-pnl rows:
  // the equity at its start plus its inflow at full weight,
  // equity_{t-1} + max(0, netTransfers_t). `netTransfers` is per row (the
  // transfers since the prior row), so a deposit onto an empty account
  // joins the base and an outflow never shrinks it. The one base the
  // time-weighted returns and the per-trade return on equity at open share.
  function periodReturnBase(startEquity, netTransfers) {
    return startEquity + Math.max(0, parseFloat(netTransfers) || 0);
  }

  // A /historical-pnl row whose time and amounts can be read: a createdAt
  // timestampMs parses, and totalPnl, equity and netTransfers are each
  // wholly numeric (amountDecimal; absent or blank is unknown, never $0:
  // the time-weighted returns and the per-trade base read equity and
  // netTransfers). A row that fails is unknown: the series builders below
  // refuse rows holding one (never dropping it, never sorting on an
  // unparsed time), and historicalPnlRowGap says why.
  function isValidHistoricalPnlRow(r) {
    return Boolean(r) && timestampMs(r.createdAt) !== null && amountDecimal(r.totalPnl) !== null
      && amountDecimal(r.equity) !== null && amountDecimal(r.netTransfers) !== null;
  }

  // '' when every /historical-pnl row is valid (isValidHistoricalPnlRow),
  // else why every view built on the rows is unknown.
  function historicalPnlRowGap(historicalPnl) {
    const n = (historicalPnl || []).filter(r => !isValidHistoricalPnlRow(r)).length;
    return n === 0 ? '' : `${n} /historical-pnl row${n === 1 ? '' : 's'} without a valid time or amount`;
  }

  // Rows in chronological order of their parsed createdAt; [] while any
  // row is invalid (historicalPnlRowGap).
  function chronologicalHistoricalPnl(historicalPnl) {
    if (!Array.isArray(historicalPnl) || historicalPnlRowGap(historicalPnl)) return [];
    return historicalPnl
      .map(r => ({ row: r, ms: timestampMs(r.createdAt) }))
      .sort((a, b) => a.ms - b.ms)
      .map(({ row }) => row);
  }

  // Transfer-aware time-weighted returns from dYdX historical-pnl rows,
  // Modified Dietz (periodReturnBase):
  //   r_t = (totalPnl_t − totalPnl_{t-1}) / (equity_{t-1} + max(0, netTransfers_t))
  // The totalPnl delta isolates trading P&L (excludes deposits and
  // withdrawals). Each kept return comes with the row it starts at
  // (`from`), the row it ends at (`t`) and the period's length
  // (`intervalMs`, NaN when a timestamp does not parse), in chronological
  // order. A base below minReturnBase is dust and its return is dropped.
  //
  // Rows that reach inception (`historyCut` '', as in
  // buildCumulativeTotalPnlSeries) whose first row already holds a profit
  // or loss open with the inception period: from INCEPTION_TOTAL_PNL on
  // an empty account to the first row, r = totalPnl_0 ÷ (0 +
  // max(0, netTransfers_0)), dated at that row (`from` = `t`) like the
  // series' inception value. Its length is unknown (no /transfers), so
  // `intervalMs` is NaN. None while any row is invalid
  // (historicalPnlRowGap).
  function timeWeightedReturnPoints(historicalPnl, historyCut = '') {
    const series = chronologicalHistoricalPnl(historicalPnl);
    if (series.length === 0) return [];
    const minBase = minReturnBase(series);
    if (minBase === null) return [];
    const out = [];
    const keep = (pnlDelta, base, from, t, intervalMs) => {
      if (base > 0 && base >= minBase && isFinite(pnlDelta)) out.push({ r: pnlDelta / base, from, t, intervalMs });
    };
    const first = series[0];
    const firstPnl = parseFloat(first.totalPnl || 0);
    if (!historyCut && firstPnl !== INCEPTION_TOTAL_PNL) {
      keep(firstPnl - INCEPTION_TOTAL_PNL, periodReturnBase(0, first.netTransfers), first.createdAt, first.createdAt, NaN);
    }
    for (let i = 1; i < series.length; i++) {
      const base = periodReturnBase(parseFloat(series[i - 1].equity), series[i].netTransfers);
      const pnlDelta = parseFloat(series[i].totalPnl || 0) - parseFloat(series[i - 1].totalPnl || 0);
      const intervalMs = (timestampMs(series[i].createdAt) ?? NaN) - (timestampMs(series[i - 1].createdAt) ?? NaN);
      keep(pnlDelta, base, series[i - 1].createdAt, series[i].createdAt, intervalMs);
    }
    return out;
  }

  function computeTimeWeightedReturnsFromHist(historicalPnl, historyCut = '') {
    return timeWeightedReturnPoints(historicalPnl, historyCut).map(p => p.r);
  }

  // The account's time-weighted returns (one series, one dust floor)
  // bucketed by the UTC month (monthKeyUTC) of the row each return ends
  // at: { [monthKey]: number[] }. A month's returns are the periods ending
  // in it whose start row is in the same month or the one just before, so
  // the period from the prior month's last row to this month's first
  // counts here, as it does in the month's PROFIT, and a period spanning a
  // month without rows counts nowhere, as histPnlMonthly leaves the next
  // month's PROFIT unknown. `historyCut` as in timeWeightedReturnPoints.
  // timeWeightedReturnPointsByMonth keeps each return's point
  // ({ r, from, t, intervalMs }), so a month's ratios can weight it by its
  // length (computeAnnualizedFromReturns).
  function timeWeightedReturnPointsByMonth(historicalPnl, historyCut = '') {
    const out = {};
    timeWeightedReturnPoints(historicalPnl, historyCut).forEach(p => {
      const key = monthKeyUTC(p.t);
      const startKey = monthKeyUTC(p.from);
      if (key === null || startKey === null) return;
      if (startKey !== key && nextMonthKey(startKey) !== key) return;
      if (!out[key]) out[key] = [];
      out[key].push(p);
    });
    return out;
  }

  function timeWeightedReturnsByMonth(historicalPnl, historyCut = '') {
    const out = {};
    Object.entries(timeWeightedReturnPointsByMonth(historicalPnl, historyCut))
      .forEach(([key, points]) => { out[key] = points.map(p => p.r); });
    return out;
  }

  // The VaR / Expected Shortfall sample: the time-weighted returns whose
  // period lies within VAR_MAX_INTERVAL_MULTIPLE of the rows' median
  // sampling interval either way (from the median ÷ the multiple to the
  // median × the multiple), so neither a return over a multi-hour or
  // multi-day gap in the rows nor one over an hour inside daily sampling
  // stands in for a one-interval outcome.
  const VAR_MAX_INTERVAL_MULTIPLE = 1.5;

  function varSampleReturns(historicalPnl) {
    const timestamps = (historicalPnl || []).map(r => r && r.createdAt);
    const medianIntervalMs = medianSamplingIntervalMs(timestamps);
    const minIntervalMs = medianIntervalMs / VAR_MAX_INTERVAL_MULTIPLE;
    const maxIntervalMs = medianIntervalMs * VAR_MAX_INTERVAL_MULTIPLE;
    return timeWeightedReturnPoints(historicalPnl)
      .filter(p => p.intervalMs >= minIntervalMs && p.intervalMs <= maxIntervalMs)
      .map(p => p.r);
  }

  // '' when the VaR sample (varSampleReturns) passes the Sharpe gate's
  // count and span rules on its own: at least ADEQUACY_MIN_RETS returns,
  // spanning at least ADEQUACY_MIN_YEARS at `ppy` periods per year (the
  // rows' sampling, as assessAdequacy measures it); else why VaR / ES
  // cannot be read from it. Rows sampled hourly while the account was
  // empty and daily once funded pass the gate on all their returns yet
  // leave few one-period outcomes, covering hours rather than a month.
  function varSampleGap(returns, ppy) {
    const n = Array.isArray(returns) ? returns.length : 0;
    if (n < ADEQUACY_MIN_RETS) {
      return `Only ${n} ${n === 1 ? 'return spans' : 'returns span'} one sampling period (need ≥${ADEQUACY_MIN_RETS})`;
    }
    return spanShortReason(ppy > 0 ? n / ppy : 0);
  }

  // True when every value stands for the same decimal (read at
  // NOISE_FREE_SIGNIFICANT_DIGITS, the display core's noise floor): such
  // returns have no spread, though the float residue of their mean would
  // leave a standard deviation of ~1e-18 and a ratio of ~1e15.
  function allAlike(values) {
    const decimal = v => v.toPrecision(NOISE_FREE_SIGNIFICANT_DIGITS);
    return values.every(v => decimal(v) === decimal(values[0]));
  }

  // How many sampling intervals each return spans: `periods[i]` when it
  // is a positive number, else 1 (no `periods`, or a return of unknown
  // length such as the inception period).
  function intervalWeights(returns, periods) {
    return returns.map((_, i) => {
      const k = Array.isArray(periods) ? periods[i] : 1;
      return k > 0 && isFinite(k) ? k : 1;
    });
  }

  // Per-interval excess returns of `returns` spanning `periods` intervals
  // (intervalWeights) over `mar` per interval, with their per-interval
  // mean Σx ÷ Σk; null without returns or when every x ÷ k is alike (no
  // spread).
  function excessPerInterval(returns, mar, periods) {
    if (!Array.isArray(returns) || returns.length === 0) return null;
    const k = intervalWeights(returns, periods);
    const excess = returns.map((r, i) => r - mar * k[i]);
    if (allAlike(excess.map((x, i) => x / k[i]))) return null;
    const mu = excess.reduce((a, x) => a + x, 0) / k.reduce((a, w) => a + w, 0);
    return { excess, k, mu };
  }

  // A return spanning k sampling intervals is read as r ~ N(μ·k, σ²·k)
  // (independent increments), so μ and σ² are the weighted least squares
  // estimates (each squared residual over its variance scale k):
  //   μ = Σr ÷ Σk,  σ² = Σ (r − μ·k)² ÷ k ÷ (n − 1)
  // With every k = 1 (no `periods`, as for per-trade returns) this is the
  // plain mean over the sample standard deviation.
  /**
   * Compute Sharpe ratio per sampling interval.
   * @param {number[]} returns fractional returns
   * @param {number} mar minimum acceptable return per interval (default 0)
   * @param {number[]} [periods] intervals each return spans (default 1 each)
   * @returns {number|null} null when undefined (no data, or returns that
   *   are all alike per interval: no spread)
   */
  function computeSharpe(returns, mar = 0, periods = null) {
    const est = excessPerInterval(returns, mar, periods);
    if (est === null) return null;
    const { excess, k, mu } = est;
    const variance = excess.reduce((a, x, i) => a + (x - mu * k[i]) ** 2 / k[i], 0) / (returns.length - 1);
    const sd = Math.sqrt(variance);
    return sd > 0 ? (mu / sd) : null;
  }

  /**
   * Compute Sortino ratio per sampling interval. Frank-Sortino downside
   * deviation: squared negative excess returns, each over the intervals it
   * spans (as in computeSharpe), divided by N (the target semi-deviation;
   * NOT the non-standard divide-by-count-of-negatives).
   * @param {number[]} returns fractional returns
   * @param {number} mar minimum acceptable return per interval (default 0)
   * @param {number[]} [periods] intervals each return spans (default 1 each)
   * @returns {number|null} null when undefined (no data, or returns that
   *   are all alike per interval: no spread); Infinity only if no
   *   downside variance
   */
  function computeSortino(returns, mar = 0, periods = null) {
    const est = excessPerInterval(returns, mar, periods);
    if (est === null) return null;
    const { excess, k, mu } = est;
    const downVar = excess.reduce((a, x, i) => a + Math.min(0, x) ** 2 / k[i], 0) / returns.length;
    const dd = Math.sqrt(downVar);
    if (dd === 0) return mu > 0 ? Infinity : null;
    return mu / dd;
  }

  function median(values) {
    if (!values.length) return 0;
    const arr = values.slice().sort((a,b)=>a-b);
    const mid = Math.floor(arr.length/2);
    return arr.length % 2 ? arr[mid] : (arr[mid-1]+arr[mid])/2;
  }

  // The median gap between consecutive timestamps (an hour when that
  // median is 0), 0 with fewer than two parseable timestamps. The one
  // sampling interval behind the periods-per-year and the VaR sample.
  function medianSamplingIntervalMs(timestamps) {
    if (!Array.isArray(timestamps) || timestamps.length < 2) return 0;
    const ms = timestamps
      .map(t => (new Date(t)).getTime())
      .filter(n => !isNaN(n))
      .sort((a,b)=>a-b);
    if (ms.length < 2) return 0;
    const diffsMs = [];
    for (let i=1;i<ms.length;i++) diffsMs.push(ms[i]-ms[i-1]);
    return median(diffsMs) || MS_PER_HOUR;
  }

  function detectPeriodsPerYearFromTimestamps(timestamps) {
    const medianIntervalMs = medianSamplingIntervalMs(timestamps);
    return medianIntervalMs > 0 ? Math.max(1, MS_PER_YEAR / medianIntervalMs) : 0;
  }

  // Sharpe and Sortino of `returns` per sampling interval of the rows
  // (`timestamps`), annualized by √ppy. `options.intervalsMs[i]`, when
  // given, is how long return i ran (timeWeightedReturnPoints'
  // intervalMs): it then weighs as that many median sampling intervals
  // (computeSharpe), so a return over a multi-hour gap in the rows is not
  // read as a one-interval outcome. A length that is not a positive
  // number (the inception period's) counts as one interval.
  function computeAnnualizedFromReturns(returns, timestamps, options = {}) {
    const mar = options.mar ?? 0;
    const medianIntervalMs = medianSamplingIntervalMs(timestamps);
    const periods = Array.isArray(options.intervalsMs) && medianIntervalMs > 0
      ? options.intervalsMs.map(ms => ms / medianIntervalMs)
      : null;
    const perPeriodSharpe = computeSharpe(returns, mar, periods);
    const perPeriodSortino = computeSortino(returns, mar, periods);
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

  // (numerator ÷ 10^scale) ÷ denominator, both signed BigInt integers, as
  // the Number nearest the exact quotient at NOISE_FREE_SIGNIFICANT_DIGITS
  // (exactQuotientNumber); null when the denominator is zero. The
  // numerator is an exact decimal's units, so with its scale the quotient
  // is in dollars.
  function signedQuotient(numerator, denominator, scale = 0) {
    const magnitude = big => (big < 0n ? -big : big);
    const q = exactQuotientNumber({ units: magnitude(numerator), scale },
      { units: magnitude(denominator), scale: 0 });
    return q !== null && q !== 0 && (numerator < 0n) !== (denominator < 0n) ? -q : q;
  }

  // Which bucket leaves a classifyClosed result's payoff undefined, worded
  // for the Payoff cards' 'N/A' caption: 'No decisive trades', 'No wins
  // recorded' or 'No losses recorded'; '' while the payoff is defined or
  // the classifier's inputs are incomplete (incompleteReason says why).
  function payoffEmptyBucketReason(cls) {
    if (!cls || cls.incompleteReason || cls.payoff !== null) return '';
    if (cls.decisiveCount === 0) return 'No decisive trades';
    return cls.winCount === 0 ? 'No wins recorded' : 'No losses recorded';
  }

  // Classify closed positions into wins / losses / scratches by the sign
  // of their fill-attributed `profit` (net of fees, excluding funding).
  // Scratches (profit == 0) are excluded from win-rate-style ratios.
  // Derived fields (winRate, profitFactor, avgWin, avgLoss, expectancy,
  // payoff, breakevenWinRate, bestTrade, worstTrade) are computed once
  // here so consumers cannot adopt different definitions in different
  // panels. Each is null when its denominator is zero (bestTrade /
  // worstTrade: the single largest win / most negative loss, null without
  // a win / loss) — surface as '—' per the
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
    const winProfits = [], lossMagnitudes = [];
    let largestWin = -Infinity, largestLoss = Infinity;
    closed.forEach(p => {
      const r = completeProfit(p);
      if (r === null) { incomplete.push(p); return; }
      if (r > 0)      { wins.push(p);     winProfits.push(r);            largestWin = Math.max(largestWin, r); }
      else if (r < 0) { losses.push(p);   lossMagnitudes.push(Math.abs(r)); largestLoss = Math.min(largestLoss, r); }
      else            { scratches.push(p); }
    });
    const winCount = wins.length;
    const lossCount = losses.length;
    const decisiveCount = winCount + lossCount;
    const winSum = decimalSum(winProfits);
    const lossSum = decimalSum(lossMagnitudes);
    const grossWin = decimalNumber(winSum);
    const grossLoss = decimalNumber(lossSum);
    const totalProfit = exactSum([grossWin, -grossLoss]);
    const scale = Math.max(winSum.scale, lossSum.scale);
    const winUnits = unitsAtScale(winSum, scale);
    const lossUnits = unitsAtScale(lossSum, scale);
    const incompleteCount = incomplete.length;
    const incompleteReason = unavailableReason || (incompleteCount === 0 ? ''
      : `${incompleteCount} position${incompleteCount === 1 ? '' : 's'} missing fill data`);
    const ratio = (denominator, value) => (!incompleteReason && denominator > 0 ? value() : null);
    // Each mean and the payoff are exact quotients of the exact decimal
    // sums, so a mean that is a decimal tie stays one.
    const avgWin = ratio(winCount, () => signedQuotient(winUnits, BigInt(winCount), scale));
    const avgLoss = ratio(lossCount, () => signedQuotient(lossUnits, BigInt(lossCount), scale));
    const payoff = avgWin !== null && avgLoss !== null
      ? signedQuotient(winUnits * BigInt(lossCount), lossUnits * BigInt(winCount)) : null;
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
      profitFactor: ratio(grossLoss,     () => signedQuotient(winUnits, lossUnits)),
      avgWin,
      avgLoss,
      expectancy:   ratio(decisiveCount, () => signedQuotient(winUnits - lossUnits, BigInt(decisiveCount), scale)),
      payoff,
      // Win rate (percent) at which expectancy is zero for this payoff.
      breakevenWinRate: payoff === null ? null : PERCENT / (1 + payoff),
      bestTrade:  ratio(winCount,  () => largestWin),
      worstTrade: ratio(lossCount, () => largestLoss)
    };
  }

  // The Monthly Performance Breakdown's month: the UTC calendar month of a
  // timestamp as 'YYYY-MM', null when the timestamp is unparseable. UTC
  // like every other date view, so the table does not change with the
  // viewer's timezone; keys sort chronologically as plain strings.
  const ISO_MONTH_LENGTH = 'YYYY-MM'.length;
  function monthKeyUTC(timestamp) {
    const ms = timestampMs(timestamp);
    return ms === null ? null : new Date(ms).toISOString().slice(0, ISO_MONTH_LENGTH);
  }

  // [startMs, endMs) of a monthKeyUTC key.
  function monthSpanMs(key) {
    const [year, month] = key.split('-').map(Number);
    const monthIndex = month - 1;
    return { startMs: Date.UTC(year, monthIndex, 1), endMs: Date.UTC(year, monthIndex + 1, 1) };
  }

  function nextMonthKey(key) {
    return monthKeyUTC(new Date(monthSpanMs(key).endMs).toISOString());
  }

  // 'September 2026' for the key '2026-09'.
  function monthLabel(key) {
    return new Date(monthSpanMs(key).startMs)
      .toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  }

  // Bucket closed positions by their UTC closedAt month (monthKeyUTC),
  // then run classifyClosed per bucket. Returns { [monthKey]:
  // Classification }. Months with zero closed positions are omitted — caller
  // merges them in from histPnlMonthly when funding-only months matter.
  // `unavailableReason` (normally the account-wide classifier's
  // incompleteReason), else closeTimeGap (a closed position whose month is
  // unknown), is applied to every month, so one incomplete or untimed
  // position blanks the ratios of every month together.
  function classifyByMonth(positions, unavailableReason = '') {
    const reason = unavailableReason || closeTimeGap(positions);
    const byMonth = {};
    (positions || []).forEach(p => {
      if (!p || p.status !== 'CLOSED') return;
      const key = monthKeyUTC(p.closedAt);
      if (key === null) return;
      if (!byMonth[key]) byMonth[key] = [];
      byMonth[key].push(p);
    });
    const out = {};
    Object.keys(byMonth).forEach(k => { out[k] = classifyClosed(byMonth[k], reason); });
    return out;
  }

  // Peak notional: peakSize × entryVwap from attributeFillsToPositions,
  // the largest position value held during the lifecycle (NOT the
  // cumulative entered size, which overstates capital deployed on scaled
  // positions). The exact product of the two decimals at 15 significant
  // digits (exactQuotientNumber). Null when the attribution is incomplete
  // or either factor is not positive. The denominator of tradeReturn and the size measure
  // of the Position Size Distribution and the Behavior double-down detector.
  function peakNotional(p) {
    const notional = exactPeakNotional(p);
    return notional === null ? null : exactQuotientNumber(notional, EXACT_ONE);
  }

  // peakSize × entryVwap as the exact product of the decimals they stand
  // for (exactMagnitude), null as peakNotional.
  function exactPeakNotional(p) {
    if (!hasCompleteAttribution(p) || !(parseFloat(p.peakSize) > 0) || !(parseFloat(p.entryVwap) > 0)) return null;
    return exactProduct(exactMagnitude(p.peakSize), exactMagnitude(p.entryVwap));
  }

  // Per-trade return on peak notional: profit / peakNotional, both from
  // the fill attribution, as the exact quotient of the decimals they stand
  // for at 15 significant digits (exactQuotientNumber), so a decimal tie
  // stays one. The win/loss distribution and the Positions
  // board PROFIT % column read it; the per-trade Sharpe/Sortino/Calmar use
  // tradeReturnsOnEquity instead. Returns null when the attribution is
  // incomplete or the notional is undefined.
  function tradeReturn(p) {
    const profit = completeProfit(p);
    const notional = exactPeakNotional(p);
    if (profit === null || notional === null) return null;
    const r = exactQuotientNumber(exactMagnitude(Math.abs(profit)), notional);
    return profit < 0 && r ? -r : r;
  }

  // Index of the last of the ascending `sortedMs` at or before `ms`, -1
  // when every entry is later.
  function lastIndexAtOrBefore(sortedMs, ms) {
    let lo = 0, hi = sortedMs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sortedMs[mid] <= ms) lo = mid + 1; else hi = mid;
    }
    return lo - 1;
  }

  // Per-trade return on account equity at the position's open: profit ÷
  // the Modified Dietz base (periodReturnBase) of the /historical-pnl
  // period holding createdAt, the equity of the row at or before the open
  // (0 when the open precedes every row) plus the inflow on the row after
  // it, the base the time-weighted returns use. A deposit credited between
  // the prior row and the open therefore counts (the dashboard does not
  // fetch /transfers, so an inflow later in that period counts too). One
  // entry per position, in input order; null when the attribution is
  // incomplete or that base is not positive or is dust (below
  // minReturnBase, the floor the time-weighted returns apply). The
  // per-trade Sharpe/Sortino/Calmar (per-asset SHARPE column, trade-based
  // fallback cards) are built on it. Every entry is null while a row is
  // invalid (historicalPnlRowGap).
  function tradeReturnsOnEquity(positions, historicalPnl) {
    const rows = chronologicalHistoricalPnl(historicalPnl)
      .map(r => ({ ms: timestampMs(r.createdAt), equity: parseFloat(r.equity), netTransfers: r.netTransfers }));
    const rowMs = rows.map(r => r.ms);
    const minBase = minReturnBase(rows);
    return (positions || []).map(p => {
      const profit = completeProfit(p);
      const openMs = timestampMs(p && p.createdAt);
      if (profit === null || openMs === null) return null;
      const idx = lastIndexAtOrBefore(rowMs, openMs);
      const next = rows[idx + 1];
      const base = periodReturnBase(idx >= 0 ? rows[idx].equity : 0, next ? next.netTransfers : 0);
      return base > 0 && minBase !== null && base >= minBase ? profit / base : null;
    });
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
  var ADEQUACY_MIN_YEARS = 1 / MONTHS_PER_YEAR;
  var ADEQUACY_MIN_COVERAGE = 0.5;
  const MIN_MONTHS = ADEQUACY_MIN_YEARS * MONTHS_PER_YEAR;
  const SHORTFALL_MONTH_DECIMALS = 1;
  const COVERAGE_PERCENT_DECIMALS = 0;
  // A value is read at this many significant digits before it is
  // truncated, so a float product such as 0.29 × 100 = 28.999… reads 29.
  const TRUNCATION_SIGNIFICANT_DIGITS = 12;

  // `value` as text with `decimals` places, truncated rather than
  // rounded: the one rule for the numbers in a gate's reason, so a value
  // just short of its threshold reads below it ('0.9 months', '49%'),
  // never as the threshold itself.
  function truncatedText(value, decimals) {
    const scale = Math.pow(10, decimals);
    const scaled = Number((value * scale).toPrecision(TRUNCATION_SIGNIFICANT_DIGITS));
    return (Math.floor(scaled) / scale).toFixed(decimals);
  }

  // `years` in months for a reason that the span is under MIN_MONTHS.
  function monthsShortOfMinimum(years) {
    return truncatedText(years * MONTHS_PER_YEAR, SHORTFALL_MONTH_DECIMALS);
  }

  // A coverage fraction as a percent for a reason that it is under
  // ADEQUACY_MIN_COVERAGE.
  function coveragePercentShort(coverage) {
    return truncatedText(coverage * PERCENT, COVERAGE_PERCENT_DECIMALS);
  }

  // Why `years` of valid returns are too short for the gate, '' when they
  // are not.
  function spanShortReason(years) {
    return years < ADEQUACY_MIN_YEARS
      ? `Need ≥${MIN_MONTHS} month of valid data (have ${monthsShortOfMinimum(years)} months)`
      : '';
  }

  // The gate's verdict: the first failing rule in order (return count,
  // the caller's span rule, row coverage) names the reason.
  function adequacyVerdict(n, spanReason, coverage) {
    const reason = n < ADEQUACY_MIN_RETS ? `Need ≥${ADEQUACY_MIN_RETS} returns (have ${n})`
      : spanReason
        || (coverage < ADEQUACY_MIN_COVERAGE
          ? `Coverage ${coveragePercentShort(coverage)}% — most periods filtered (likely post-wipeout sample bias)`
          : '');
    return { adequate: reason === '', reason };
  }

  function assessAdequacy(returns, timestamps, histLength) {
    const n = Array.isArray(returns) ? returns.length : 0;
    const ppy = detectPeriodsPerYearFromTimestamps(timestamps || []);
    const years = ppy > 0 ? n / ppy : 0;
    const coverage = histLength > 0 ? n / histLength : 0;
    return { ...adequacyVerdict(n, spanShortReason(years), coverage), ppy, years, coverage, n };
  }

  // The gate for one month of the Monthly Performance Breakdown (key from
  // monthKeyUTC). The return-count and row-coverage rules are
  // assessAdequacy's; the span rule asks the valid returns to cover at
  // least ADEQUACY_MIN_COVERAGE of the month's own calendar periods (at the
  // sampling interval the timestamps show), so at hourly sampling a
  // complete month of any length passes, where the one-twelfth-year
  // minimum rejects every complete 28-, 29- and 30-day month. The
  // ADEQUACY_MIN_RETS minimum still applies: at daily sampling a complete
  // 28- to 30-day month holds fewer returns and fails it.
  function assessMonthAdequacy(returns, timestamps, histLength, monthKey) {
    const n = Array.isArray(returns) ? returns.length : 0;
    const ppy = detectPeriodsPerYearFromTimestamps(timestamps || []);
    const coverage = histLength > 0 ? n / histLength : 0;
    const { startMs, endMs } = monthSpanMs(monthKey);
    const monthPeriods = ppy * (endMs - startMs) / MS_PER_YEAR;
    const monthCoverage = monthPeriods > 0 ? n / monthPeriods : 0;
    const spanReason = monthCoverage < ADEQUACY_MIN_COVERAGE
      ? `Returns cover ${coveragePercentShort(monthCoverage)}% of the month (need ≥${truncatedText(ADEQUACY_MIN_COVERAGE * PERCENT, COVERAGE_PERCENT_DECIMALS)}%)`
      : '';
    return { ...adequacyVerdict(n, spanReason, coverage), ppy, monthCoverage, coverage, n };
  }

  // Compounded growth of a return sequence, wealth W = Π(1 + r) from 1:
  // compounded = W − 1; cagr = W^(1/years) − 1 over `years` of elapsed
  // time (null unless years > 0); maxDrawdownPct = the worst drawdown of
  // the wealth curve (validDrawdownFromEquity, null when it never drew
  // down, the curve is filtered, or the drawdown displays as zero at
  // CALMAR_DRAWDOWN_DECIMALS: no drawdown); calmar = cagr ÷ that drawdown as a
  // fraction, null when either is unavailable. Once the wealth reaches
  // zero or below (a return of −100% or worse) nothing compounds further,
  // so all four are null rather than a return below −100% or a sign that
  // flips back.
  const WIPED_OUT = { compounded: null, cagr: null, maxDrawdownPct: null, calmar: null };

  // The Calmar caption shows the compounded drawdown at this many decimals
  // of a percent; a drawdown it would show as 0.0% is no drawdown.
  const CALMAR_DRAWDOWN_DECIMALS = 1;
  const NO_DRAWDOWN_REASON = 'No drawdown recorded';

  function drawdownDisplaysAsZero(pct) {
    return window.Format.asDisplayed(pct, CALMAR_DRAWDOWN_DECIMALS) === 0;
  }

  function compoundReturns(returns, years) {
    const wealth = [1];
    (returns || []).forEach(r => wealth.push(wealth[wealth.length - 1] * (1 + r)));
    if (wealth.some(w => !(w > 0))) return { ...WIPED_OUT };
    const growth = wealth[wealth.length - 1];
    const drawdown = validDrawdownFromEquity(wealth);
    const maxDrawdownPct = drawdown && !drawdownDisplaysAsZero(drawdown.pct) ? drawdown.pct : null;
    const cagr = years > 0 ? Math.pow(growth, 1 / years) - 1 : null;
    const calmar = cagr !== null && maxDrawdownPct !== null ? cagr / (maxDrawdownPct / PERCENT) : null;
    return { compounded: growth - 1, cagr, maxDrawdownPct, calmar };
  }

  // Calendar years from the first to the last /historical-pnl row,
  // periods without capital included (the time-series Calmar's CAGR
  // horizon; assessAdequacy's `years` counts only the valid returns).
  function historicalPnlYears(historicalPnl) {
    const ms = (historicalPnl || [])
      .map(r => timestampMs(r && r.createdAt))
      .filter(v => v !== null);
    return ms.length < 2 ? 0 : (Math.max(...ms) - Math.min(...ms)) / MS_PER_YEAR;
  }

  // Fewer per-trade returns than this cannot produce a Sharpe.
  const MIN_TRADE_RETURNS = 2;

  // Annualized per-trade ratios of decisive closed positions (the
  // per-asset SHARPE column and the trade-based fallback cards). Returns
  // are tradeReturnsOnEquity in closing order; the span is first to last
  // close in years; Sharpe and Sortino scale by √tpy with
  // tpy = (n − 1) ÷ span; Calmar, its drawdown and the compounded return
  // come from compoundReturns over the calendar time those returns
  // accrued in, from the earliest open to the last close (`calmarYears`).
  // { ok: false, n, reason } unless every trade has a close time that
  // parses (a ratio over the others would leave a trade out), there are
  // at least `minTrades` trades (never fewer than MIN_TRADE_RETURNS),
  // every /historical-pnl row is valid (historicalPnlRowGap, the reason),
  // every one has a return, and the span is at least ADEQUACY_MIN_YEARS:
  // an annualized column never shows an unannualized value.
  function perTradeRatios(positions, historicalPnl, minTrades = MIN_TRADE_RETURNS) {
    const listed = (positions || []).filter(Boolean);
    const untimed = listed.filter(p => timestampMs(p.closedAt) === null).length;
    if (untimed > 0) {
      return { ok: false, n: listed.length, reason: `${untimed} of ${listed.length} trades without a valid close time` };
    }
    const trades = listed.slice().sort((a, b) => timestampMs(a.closedAt) - timestampMs(b.closedAt));
    const n = trades.length;
    const needed = Math.max(minTrades, MIN_TRADE_RETURNS);
    if (n < needed) return { ok: false, n, reason: `Need ≥${needed} decisive trades (have ${n})` };
    const incomplete = trades.filter(p => completeProfit(p) === null).length;
    if (incomplete > 0) return { ok: false, n, reason: `${incomplete} of ${n} trades missing fill data` };
    const rowGap = historicalPnlRowGap(historicalPnl);
    if (rowGap) return { ok: false, n, reason: rowGap };
    const returns = tradeReturnsOnEquity(trades, historicalPnl);
    const missing = returns.filter(r => r === null).length;
    if (missing > 0) {
      return { ok: false, n, reason: `No funded equity at open for ${missing} of ${n} trades` };
    }
    const yearsSpan = (timestampMs(trades[n - 1].closedAt) - timestampMs(trades[0].closedAt)) / MS_PER_YEAR;
    if (yearsSpan < ADEQUACY_MIN_YEARS) {
      return { ok: false, n, reason: `Need ≥${MIN_MONTHS} month from first to last close (have ${monthsShortOfMinimum(yearsSpan)} months)` };
    }
    const tpy = (n - 1) / yearsSpan;
    const annualize = (v) => (v === null || !isFinite(v)) ? v : v * Math.sqrt(tpy);
    const firstOpenMs = Math.min(...trades.map(p => timestampMs(p.createdAt)));
    const calmarYears = (timestampMs(trades[n - 1].closedAt) - firstOpenMs) / MS_PER_YEAR;
    const { compounded, calmar, maxDrawdownPct } = compoundReturns(returns, calmarYears);
    return {
      ok: true, reason: '', n, returns, yearsSpan, tpy, calmarYears,
      sharpe: annualize(computeSharpe(returns)),
      sortino: annualize(computeSortino(returns)),
      calmar, maxDrawdownPct, compounded
    };
  }

  // Cumulative profit is 0 before the account's first trade. A
  // cumulative series that reaches inception and already holds a profit
  // or loss at its first point opens with this inception value, dated at
  // that point, so every drawdown view measures a first loss from 0, the
  // origin histPnlMonthly's first month is measured from. The one
  // anchoring rule of the trade-profit and the totalPnl series.
  const INCEPTION_TOTAL_PNL = 0;

  function withInceptionPoint(series) {
    return series.length > 0 && series[0].c !== INCEPTION_TOTAL_PNL
      ? [{ t: series[0].t, c: INCEPTION_TOTAL_PNL }, ...series]
      : series;
  }

  // Every fill's place in chain order: its index once sorted as every
  // FIFO walk sorts them (compareFillsChronologically, stable on the
  // fetched order).
  function fillChainIndex(fills) {
    const sorted = (Array.isArray(fills) ? fills : []).filter(Boolean).sort(compareFillsChronologically);
    return new Map(sorted.map((f, i) => [f, i]));
  }

  // The fill that closed a position: its last attributed portion's.
  function closingFill(p) {
    const portions = Array.isArray(p.portions) ? p.portions : [];
    return portions.length > 0 ? portions[portions.length - 1].fill : null;
  }

  // The one closing order of closed positions: by closedAt, closes in one
  // millisecond by their closing fills' chain order in `fills`
  // (fillChainIndex), as the attribution walked them, never the order the
  // positions are listed in; a closedAt that does not parse sorts last.
  // A comparator for Array.prototype.sort. The trade-profit series, the
  // streaks, the win-rate trend and the per-trade ratios all sort by it,
  // and the Positions board and the Tax rows by its reverse.
  function byClosingOrder(fills) {
    const chainIndex = fillChainIndex(fills);
    const chainPlace = p => chainIndex.get(closingFill(p)) ?? Infinity;
    const closeMs = p => timestampMs(p.closedAt) ?? Infinity;
    return (a, b) => (closeMs(a) - closeMs(b)) || (chainPlace(a) - chainPlace(b)) || 0;
  }

  // Sort closed positions chronologically and build the cumulative
  // fill-attributed profit series, from the inception value at the first
  // close (withInceptionPoint): the closed trades are the account's whole
  // trade history. Shared by tradeSystemDrawdown (worst single event),
  // tradeSystemDrawdownEvents (every peak→recovery cycle) and
  // tradeSystemCurrentDrawdown so they can never operate on different
  // inputs. All-or-nothing like classifyClosed: while any closed position
  // lacks complete fill attribution, or a valid close time (timestampMs),
  // the series is empty, so every wrapper reports no drawdown and callers
  // show the classifier's incompleteReason or closeTimeGap. The profits
  // add exactly (exactAdd), each point the Number nearest the exact sum
  // (decimalNumber), so a cumulative half dollar rounds as the decimal.
  //
  // opts: { fills, nowMs }. Closes are taken in byClosingOrder(fills).
  // `nowMs`, the time the data was read, ends the series at a point holding
  // the last close's value, so the time under water of an ongoing drawdown
  // runs to now, as the live point makes it on the totalPnl series.
  function buildCumulativeProfitSeries(closedPositions, opts = {}) {
    const { fills = [], nowMs = null } = opts;
    const listed = (closedPositions || []).filter(p => p && p.status === 'CLOSED');
    if (listed.some(p => completeProfit(p) === null || timestampMs(p.closedAt) === null)) {
      return { closed: [], cums: [] };
    }
    const closed = listed.sort(byClosingOrder(fills));
    let cum = EXACT_ZERO;
    const cums = closed.map(p => {
      cum = exactAdd(cum, amountDecimal(completeProfit(p)));
      return { t: p.closedAt, c: decimalNumber(cum) };
    });
    const last = cums[cums.length - 1];
    const endsNow = last !== undefined && isNumber(nowMs) && nowMs > timestampMs(last.t);
    const series = withInceptionPoint(cums);
    return { closed, cums: endsNow ? series.concat([{ t: new Date(nowMs).toISOString(), c: last.c }]) : series };
  }

  // Build a clean cumulative trading-P&L series from /historical-pnl rows.
  // dYdX's `totalPnl` field is realized + unrealized P&L excluding net
  // transfers — the canonical "what did this account make from trading"
  // measurement at each timestamp. This series captures unrealized peaks
  // (e.g. a large open profit that was later given back) which the
  // closed-trade ledger cannot see.
  //
  // /historical-pnl is walked to inception (fetchAllHistoricalPnl; a page
  // that fails rejects the whole walk), and totalPnl is 0 before the first
  // deposit, so the series opens with the inception value
  // (withInceptionPoint). `historyCut` is '' for such rows, else why they
  // do not reach inception (the cache kept only the newest rows): the
  // series then starts at its first row, with no inception value.
  //
  // `live` (livePnlPoint, or null) is appended as the last point, so the
  // series ends at the account's profit now rather than at the last
  // hourly row. The one builder of the anchored series: every drawdown
  // view, the monthly PROFIT and MAX DD and the cumulative chart read it.
  // Empty, `live` included, while any row is invalid (historicalPnlRowGap).
  function buildCumulativeTotalPnlSeries(historicalPnl, live = null, historyCut = '') {
    if (historicalPnlRowGap(historicalPnl)) return [];
    const rows = chronologicalHistoricalPnl(historicalPnl)
      .map(r => ({ t: r.createdAt, c: parseFloat(r.totalPnl) }));
    const arr = historyCut ? rows : withInceptionPoint(rows);
    return live ? arr.concat([{ t: live.t, c: live.c }]) : arr;
  }

  // The live point's lead over the latest row when the clock reading
  // `nowMs` is at or behind it (a client clock trailing the indexer's).
  const LIVE_POINT_MIN_LEAD_MS = 1;

  // The live point of the totalPnl series: the dashboard's own Total
  // Profit headline (profitLedger's total, from fills, funding and fees)
  // dated `nowMs`, the time the data was read, or just after the latest
  // row when `nowMs` is not after it, so the series always ends at the
  // headline while it is available. It never reads equity, so a deposit
  // or withdrawal since the last hourly row is not profit. Null when the
  // headline is unavailable or there are no rows; the series then ends at
  // its latest row.
  function livePnlPoint(historicalPnl, headlineProfit, nowMs) {
    const series = buildCumulativeTotalPnlSeries(historicalPnl);
    const last = series[series.length - 1];
    if (!isNumber(headlineProfit) || !last) return null;
    const lastMs = new Date(last.t).getTime();
    const atMs = nowMs > lastMs ? nowMs : lastMs + LIVE_POINT_MIN_LEAD_MS;
    return { t: new Date(atMs).toISOString(), c: headlineProfit };
  }

  // Orders drawdowns deepest first by the depth their cells show,
  // `shownDepth` (Format.drawdownAsDisplayed: the displayed peak less the
  // displayed trough), the raw `depthAbs` breaking ties: the one ranking of
  // the Max Drawdown card, each month's MAX DD, the Drawdown Periods table
  // and the cumulative chart's Below peak line.
  function deeperDrawdownFirst(a, b) {
    return (b.shownDepth - a.shownDepth) || (b.depthAbs - a.depthAbs);
  }

  // True when `c` regains `peak`: their gap displays as $0 at whole
  // dollars (Format.drawdownAsDisplayed, Format.displaysAsLoss), the rule
  // by which Current Drawdown reads at peak. The one test of where a
  // drawdown ends and the running peak moves.
  function regainsPeak(peak, c) {
    const F = window.Format;
    return !F.displaysAsLoss(F.drawdownAsDisplayed(peak, c));
  }

  // The share of the peak a drawdown gives back, as its cells show it:
  // the displayed depth over the displayed peak; null unless the peak
  // displays as a gain, when there is no profit to give back. The one
  // rule for whether a "% of peak" shows.
  function pctOfPeakAsDisplayed(peak, trough) {
    const F = window.Format;
    const shownPeak = F.asDisplayed(peak, F.WHOLE_DOLLARS);
    return shownPeak > 0 ? (F.drawdownAsDisplayed(peak, trough) / shownPeak) * PERCENT : null;
  }

  // Single peak-to-trough/peak-to-recovery scanner over a {t, c}[] series.
  // Single source of truth for both the totalPnl-based and trade-profit-based
  // drawdown views — the wrappers below only differ in which series they
  // build. Returns the worst-event summary AND the full event list (in
  // time order) so a caller never has to re-scan. Each event's `endAt` is
  // its recoveryAt, or the series' last point while it is ongoing: peakAt
  // → endAt is its time under water.
  // A point that regains the running peak (regainsPeak: its gap to the
  // peak displays as $0) moves the peak to it, so a plateau's peak is its
  // last point, where the time under water starts, and an event ends at
  // the first such point, a later dip being its own event.
  // The worst event is the first by deeperDrawdownFirst (Format resolved
  // at call time: src/format.js loads after this file), so it is the
  // Drawdown Periods table's top row; without an event it is no drawdown
  // at the series' first point.
  function scanDrawdownEvents(cums) {
    if (cums.length === 0) {
      return {
        worst: { dollarDrawdown: 0, pctOfPeakProfit: null, n: 0,
                 peakAt: null, troughAt: null, peakValue: 0, troughValue: 0 },
        events: []
      };
    }

    const events = [];
    if (cums.length >= 2) {
      let pIdx = 0;
      for (let i = 1; i < cums.length; i++) {
        if (regainsPeak(cums[pIdx].c, cums[i].c)) { pIdx = i; continue; }
        let tIdx = i;
        while (i + 1 < cums.length && !regainsPeak(cums[pIdx].c, cums[i + 1].c)) {
          if (cums[i + 1].c < cums[tIdx].c) tIdx = i + 1;
          i += 1;
        }
        const recIdx = i + 1 < cums.length ? i + 1 : null;
        const peakV = cums[pIdx].c;
        const troughV = cums[tIdx].c;
        const depthAbs = Math.max(0, peakV - troughV);
        if (depthAbs > 0) {
          events.push({
            peakAt: cums[pIdx].t,
            troughAt: cums[tIdx].t,
            recoveryAt: recIdx !== null ? cums[recIdx].t : null,
            endAt: cums[recIdx !== null ? recIdx : cums.length - 1].t,
            peakCum: peakV,
            troughCum: troughV,
            depthAbs,
            shownDepth: window.Format.drawdownAsDisplayed(peakV, troughV)
          });
        }
        pIdx = recIdx !== null ? recIdx : tIdx;
      }
    }

    const deepest = events.slice().sort(deeperDrawdownFirst)[0];
    const worst = deepest
      ? { dollarDrawdown: deepest.depthAbs,
          pctOfPeakProfit: pctOfPeakAsDisplayed(deepest.peakCum, deepest.troughCum),
          peakAt: deepest.peakAt, troughAt: deepest.troughAt,
          peakValue: deepest.peakCum, troughValue: deepest.troughCum }
      : { dollarDrawdown: 0, pctOfPeakProfit: pctOfPeakAsDisplayed(cums[0].c, cums[0].c),
          peakAt: cums[0].t, troughAt: cums[0].t, peakValue: cums[0].c, troughValue: cums[0].c };
    return { worst: { ...worst, n: cums.length }, events };
  }

  // Worst peak-to-trough drawdown on the totalPnl series. Replaces the
  // trade-system-only definition for accounts that built large unrealized
  // gains and then gave them back (the trade ledger only sees the final
  // realized P&L, missing the peak entirely). `live` as in
  // buildCumulativeTotalPnlSeries, for this and the two below.
  function histPnlDrawdown(historicalPnl, live = null) {
    return scanDrawdownEvents(buildCumulativeTotalPnlSeries(historicalPnl, live)).worst;
  }

  // Find every peak-to-recovery drawdown event on the totalPnl series.
  // Recovery = the first point that regains the peak (regainsPeak).
  function histPnlDrawdownEvents(historicalPnl, live = null) {
    return scanDrawdownEvents(buildCumulativeTotalPnlSeries(historicalPnl, live)).events;
  }

  // Which series every drawdown card measures: 'hist' (cumulative totalPnl
  // from /historical-pnl) whenever there is a row, else 'trade'
  // (cumulative closed-trade profit). A series that never draws down stays
  // on 'hist': its true drawdown is $0, and the closed-trade ledger would
  // report a drawdown the account's P&L never had. Rows holding an invalid
  // one stay on 'hist' too, the views reading historicalPnlRowGap.
  function drawdownSource(historicalPnl) {
    return Array.isArray(historicalPnl) && historicalPnl.length > 0 ? 'hist' : 'trade';
  }

  // Trade-system drawdown: peak-to-trough on cumulative profit over
  // closed trades, in chronological order. Used as the fallback when
  // drawdownSource is 'trade' (historical-pnl missing or empty).
  // Cumulative profit never has
  // synthetic-equity artifacts, so no negative-trough filter is needed.
  // `opts` as in buildCumulativeProfitSeries, for this and the two below.
  function tradeSystemDrawdown(closedPositions, opts = {}) {
    const { closed, cums } = buildCumulativeProfitSeries(closedPositions, opts);
    const out = scanDrawdownEvents(cums).worst;
    out.n = closed.length;
    out.closed = closed;
    return out;
  }

  // Find every peak-to-recovery drawdown event on the cumulative profit
  // curve. Used as the fallback for the Drawdown Periods table when
  // drawdownSource is 'trade'.
  function tradeSystemDrawdownEvents(closedPositions, opts = {}) {
    const { cums } = buildCumulativeProfitSeries(closedPositions, opts);
    return scanDrawdownEvents(cums).events;
  }

  // Where is the series RIGHT NOW relative to its all-time peak? On the
  // totalPnl path that is the peak of cumulative trading P&L (excluding
  // deposits and withdrawals), not the equity peak.
  // dollarDrawdown = max(0, peak − latest). 0 when at-or-above prior peak.
  // pctOfPeakProfit = % of peak profit currently given back, as displayed
  // (pctOfPeakAsDisplayed; null when the peak is no gain).
  // peakAt/currentAt timestamps let callers surface "days below peak" without
  // re-scanning the series; peakAt is the LAST point that regained the
  // running peak (regainsPeak), where the ongoing drawdown event starts, so
  // the days below peak equal that event's time under water. peak is computed across the WHOLE series (not just
  // up to the latest point) so revisiting an old peak after a deeper one was
  // hit shows dollarDrawdown=0, matching the "currently above prior peak"
  // intent. Returns hasData=false on empty input so callers can render "—"
  // without recomputing emptiness.
  function currentDrawdownFromSeries(cums) {
    if (!cums || cums.length === 0) {
      return {
        dollarDrawdown: 0,
        pctOfPeakProfit: null,
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
      if (regainsPeak(peak, cums[i].c)) {
        peak = cums[i].c;
        peakIdx = i;
      }
    }
    const lastIdx = cums.length - 1;
    const current = cums[lastIdx].c;
    const dollarDrawdown = Math.max(0, peak - current);
    return {
      dollarDrawdown,
      pctOfPeakProfit: pctOfPeakAsDisplayed(peak, current),
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
  function histPnlCurrentDrawdown(historicalPnl, live = null) {
    return currentDrawdownFromSeries(buildCumulativeTotalPnlSeries(historicalPnl, live));
  }

  // Fallback path: current drawdown on cumulative profit. Used when
  // drawdownSource is 'trade', mirroring tradeSystemDrawdown's role.
  function tradeSystemCurrentDrawdown(closedPositions, opts = {}) {
    const { closed, cums } = buildCumulativeProfitSeries(closedPositions, opts);
    const out = currentDrawdownFromSeries(cums);
    out.closed = closed;
    return out;
  }

  // Profit from its components: trading (realized + unrealized) +
  // funding − fees, null while funding is unknown. The one composition
  // marketPnL and profitLedger share.
  function profitFromComponents(trading, funding, fees) {
    return funding === null ? null : trading + funding - fees;
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
  // Funding: Σ positionNetFunding over the market's positions; null, with
  // `total` null too, while any of them has no netFunding (unknown, never
  // $0; the caller words it with netFundingGap).
  //
  // `feesMap` is optional: `{ [market]: feesPaid }` where positive = USD
  // paid (taker / most maker), negative = maker rebate (dYdX fill.fee
  // convention). Subtracted from total so rebates ADD to the bottom line.
  // A null entry (a fill without a fee, marketFees) leaves the market's
  // `fees` and `total` null.
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
      const funding = positionNetFunding(p);
      slot.netFunding = slot.netFunding === null || funding === null ? null : exactSum([slot.netFunding, funding]);
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
        if (feesMap[m] === null) {
          ensureSlot(m).fees = null;
          return;
        }
        const v = parseFloat(feesMap[m]);
        if (!isNumber(v)) return;
        ensureSlot(m).fees += v;
      });
    }
    Object.values(byMarket).forEach(s => {
      s.total = s.fees === null ? null
        : profitFromComponents(s.realizedClosed + s.unrealizedOpen, s.netFunding, s.fees);
    });
    return byMarket;
  }

  // A plain decimal: optional sign, integer digits, optional fraction.
  const DECIMAL_TEXT = /^([+-]?)(\d*)(?:\.(\d*))?$/;

  // Σ amounts in dollars, each the exact decimal it stands for
  // (amountDecimal: decimal text digit by digit, a computed number at
  // NOISE_FREE_SIGNIFICANT_DIGITS), added exactly, so a sum of indexer
  // amounts (funding payments, fees) or of FIFO amounts carries no binary
  // drift and no rounding: the sum is the Number nearest the exact decimal
  // at NOISE_FREE_SIGNIFICANT_DIGITS (decimalNumber). null when any amount
  // is not a number; 0 for none.
  function exactSum(amounts) {
    const sum = decimalSum(amounts);
    return sum === null ? null : decimalNumber(sum);
  }

  // Σ amounts as an exact signed decimal (amountDecimal), null when any is
  // not a number.
  function decimalSum(amounts) {
    let sum = EXACT_ZERO;
    for (const amount of amounts || []) {
      const d = amountDecimal(amount);
      if (d === null) return null;
      sum = exactAdd(sum, d);
    }
    return sum;
  }

  // Exact fractions { num, den } (value = num ÷ den, both BigInt, den
  // positive) for the fee shares, which need not end as decimals (a third
  // of a fee), so a sum of shares is the exact sum.
  function decimalFraction(d) {
    return { num: d.units, den: DECIMAL_BASE ** BigInt(d.scale) };
  }

  function fractionAdd(a, b) {
    const num = a.num * b.den + b.num * a.den;
    const den = a.den * b.den;
    const divisor = bigGcd(num < 0n ? -num : num, den);
    return { num: num / divisor, den: den / divisor };
  }

  function bigGcd(a, b) {
    while (b !== 0n) [a, b] = [b, a % b];
    return a === 0n ? 1n : a;
  }

  // The fraction as the Number nearest it at NOISE_FREE_SIGNIFICANT_DIGITS.
  function fractionNumber(f) {
    return signedQuotient(f.num, f.den);
  }

  // amount × part ÷ whole, exact decimals (part and whole positive), as
  // the exact fraction: a reversing fill's fee share, never a float
  // product.
  function exactShare(amount, part, whole) {
    const product = exactProduct(amount, part);
    return {
      num: product.units * DECIMAL_BASE ** BigInt(whole.scale),
      den: whole.units * DECIMAL_BASE ** BigInt(product.scale)
    };
  }

  // Each attribution portion's fee share as its exact fraction, keyed by
  // the portion attributeFillsToPositions handed out, so portionFeesTotal
  // sums the shares, not the Numbers they are handed out as.
  const PORTION_FEE_SHARES = new WeakMap();

  // Σ the portions' fees: the exact sum of their exact fee shares, as the
  // Number nearest it at NOISE_FREE_SIGNIFICANT_DIGITS (a third of a fee
  // three times is the whole fee). A portion not handed out by
  // attributeFillsToPositions counts as the decimal its fee stands for.
  // null when any portion's fee is unknown; 0 for none.
  function portionFeesTotal(portions) {
    const sum = portionFeesFraction(portions);
    return sum === null ? null : fractionNumber(sum);
  }

  function portionFeesFraction(portions) {
    let sum = decimalFraction(EXACT_ZERO);
    for (const part of portions || []) {
      const share = PORTION_FEE_SHARES.get(part);
      const fee = share || (amountDecimal(part.fee) && decimalFraction(amountDecimal(part.fee)));
      if (!fee) return null;
      sum = fractionAdd(sum, fee);
    }
    return sum;
  }

  // A signed exact decimal as the Number nearest it at
  // NOISE_FREE_SIGNIFICANT_DIGITS (exactQuotientNumber's rule), the form
  // every exact amount is handed to the panels in.
  function decimalNumber(d) {
    return signedQuotient(d.units, 1n, d.scale);
  }

  // An amount as the exact signed decimal it stands for, { units, scale }
  // (value = units ÷ 10^scale, units a signed BigInt), null when it is not
  // a number. Decimal text converts digit by digit ('1.005' is exact); a
  // computed number is read at NOISE_FREE_SIGNIFICANT_DIGITS, the display
  // core's noise floor, which drops the binary noise its arithmetic left
  // (0.004999999960000001 → 0.00499999996) and rounds nothing else.
  function amountDecimal(amount) {
    if (typeof amount === 'number') {
      if (!isNumber(amount)) return null;
      const d = exactDecimal(Number(amount.toPrecision(NOISE_FREE_SIGNIFICANT_DIGITS)));
      return { units: d.negative ? -d.units : d.units, scale: d.scale };
    }
    const text = amount === null || amount === undefined ? '' : String(amount).trim();
    const parts = DECIMAL_TEXT.exec(text);
    if (!parts || !(parts[2] || parts[3])) return text === '' ? null : amountDecimal(Number(text));
    const [, sign, whole, fraction = ''] = parts;
    const units = BigInt((whole || '0') + fraction);
    return { units: sign === '-' ? -units : units, scale: fraction.length };
  }

  // An indexer value as a number, null when it is absent, blank or not
  // wholly numeric ('60000abc', '1x'): unknown, never its leading digits
  // or 0. A reported '0' is a known zero. The one reader of an indexer
  // number (amountDecimal's rule).
  function decimalNumberOf(value) {
    return amountDecimal(value) === null ? null : Number(value);
  }

  // An amount as whole cents (an integer), NaN when it is not a number:
  // the one rounding rule for every figure that must add up as displayed
  // at cents (profitLedger here, the Market tab's funding ledger, the Tax
  // report's rows and totals). It rounds the decimal the amount stands
  // for (amountDecimal) once, half away from zero on both signs, so a
  // decimal tie rounds as the decimal it is (−0.125 → −13 as 0.125 → 13)
  // and an amount under half a cent never passes through a rounded micro.
  function wholeCents(amount) {
    const d = amountDecimal(amount);
    return d === null ? NaN : decimalCents(d);
  }

  function decimalCents(d) {
    const numerator = (d.units < 0n ? -d.units : d.units) * BigInt(CENTS_PER_DOLLAR);
    const denominator = DECIMAL_BASE ** BigInt(d.scale);
    const roundsUp = (numerator % denominator) * HALF_DIVISOR_NUMERATOR >= denominator;
    const magnitude = Number(numerator / denominator + (roundsUp ? 1n : 0n));
    return d.units < 0n && magnitude ? -magnitude : magnitude;
  }

  const DECIMAL_BASE = 10n;

  // The shortest round-trip text of a non-negative number: digits, an
  // optional fraction, an optional exponent ('1.2001', '1.25e-7').
  const NUMBER_TEXT = /^(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/;

  // A number as the exact decimal it is written as (its shortest
  // round-trip text, which for a published quote is the quote as
  // published: 1.2001): { negative, units, scale } with |n| = units ÷
  // 10^scale, units a BigInt; null when it is not a finite number.
  function exactDecimal(n) {
    if (!isNumber(n)) return null;
    const [, whole, fraction = '', exponent = '0'] = NUMBER_TEXT.exec(String(Math.abs(n)));
    const scale = fraction.length - Number(exponent);
    const digits = BigInt(whole + fraction);
    return scale >= 0
      ? { negative: n < 0, units: digits, scale }
      : { negative: n < 0, units: digits * DECIMAL_BASE ** BigInt(-scale), scale: 0 };
  }

  const HALF_DIVISOR_NUMERATOR = 2n;

  // amount ÷ divisor in whole cents (an integer), rounded once, half away
  // from zero, from the exact decimal quotient: the decimal the amount
  // stands for (amountDecimal) over the divisor as written (exactDecimal),
  // in integers, so 48.01 ÷ 1.2001 = 40.004999… is 4000 and never passes
  // through a rounded micro (40.005000 → 4001). NaN when either is not a
  // number or the divisor is zero. The Tax report's EUR = USD ÷ quote.
  function quotientCents(amount, divisor) {
    const a = amountDecimal(amount);
    const d = exactDecimal(divisor);
    if (a === null || d === null || d.units === 0n) return NaN;
    const numerator = (a.units < 0n ? -a.units : a.units) * BigInt(CENTS_PER_DOLLAR) * DECIMAL_BASE ** BigInt(d.scale);
    const denominator = DECIMAL_BASE ** BigInt(a.scale) * d.units;
    const remainder = numerator % denominator;
    const roundsUp = remainder * HALF_DIVISOR_NUMERATOR >= denominator;
    const magnitude = Number(numerator / denominator + (roundsUp ? 1n : 0n));
    return (a.units < 0n) !== d.negative && magnitude ? -magnitude : magnitude;
  }

  // Exact decimals { units, scale } (value = units ÷ 10^scale, units a
  // signed BigInt) for the FIFO walk's sizes, prices and amounts and the
  // fill attribution's VWAPs.
  const EXACT_ZERO = { units: 0n, scale: 0 };
  const EXACT_ONE = { units: 1n, scale: 0 };

  // A fill's size or price magnitude as the exact decimal its text is
  // written as, digit by digit ('0.1' is exactly one tenth); text that is
  // not a plain decimal is taken as the number the FIFO walk parsed.
  function exactMagnitude(amount) {
    const parts = DECIMAL_TEXT.exec(String(amount).trim());
    if (parts && (parts[2] || parts[3])) {
      const [, , whole, fraction = ''] = parts;
      return { units: BigInt(whole + fraction), scale: fraction.length };
    }
    const d = exactDecimal(Math.abs(parseFloat(amount)));
    return d && { units: d.units, scale: d.scale };
  }

  function unitsAtScale(d, scale) {
    return d.units * DECIMAL_BASE ** BigInt(scale - d.scale);
  }

  function exactAdd(a, b) {
    const scale = Math.max(a.scale, b.scale);
    return { units: unitsAtScale(a, scale) + unitsAtScale(b, scale), scale };
  }

  // a − b, never below zero.
  function exactSubtractFloored(a, b) {
    const scale = Math.max(a.scale, b.scale);
    const units = unitsAtScale(a, scale) - unitsAtScale(b, scale);
    return { units: units > 0n ? units : 0n, scale };
  }

  function exactNegate(d) {
    return { units: -d.units, scale: d.scale };
  }

  function exactMagnitudeOf(d) {
    return d.units < 0n ? exactNegate(d) : d;
  }

  function exactProduct(a, b) {
    return { units: a.units * b.units, scale: a.scale + b.scale };
  }

  function exactMin(a, b) {
    const scale = Math.max(a.scale, b.scale);
    return unitsAtScale(a, scale) <= unitsAtScale(b, scale) ? a : b;
  }

  function exactMax(a, b) {
    return exactMin(a, b) === a ? b : a;
  }

  // The Number nearest an exact decimal.
  function exactNumber(d) {
    return Number(`${d.units}e-${d.scale}`);
  }

  // numerator ÷ denominator as the Number nearest the exact quotient
  // correctly rounded (half up) to NOISE_FREE_SIGNIFICANT_DIGITS, the
  // display core's noise floor, so one rounding by the core reads the
  // decimal the quotient stands for (an exact 4-decimal tie stays a tie).
  // null when the denominator is zero.
  function exactQuotientNumber(numerator, denominator) {
    if (denominator.units === 0n) return null;
    if (numerator.units === 0n) return 0;
    const num = numerator.units * DECIMAL_BASE ** BigInt(denominator.scale);
    const den = denominator.units * DECIMAL_BASE ** BigInt(numerator.scale);
    const lowestKept = DECIMAL_BASE ** BigInt(NOISE_FREE_SIGNIFICANT_DIGITS - 1);
    // (num × 10^shift) ÷ den as an integer fraction.
    const scaled = shift => (shift >= 0
      ? [num * DECIMAL_BASE ** BigInt(shift), den]
      : [num, den * DECIMAL_BASE ** BigInt(-shift)]);
    const whole = shift => { const [n, d] = scaled(shift); return n / d; };
    let shift = NOISE_FREE_SIGNIFICANT_DIGITS - (num.toString().length - den.toString().length);
    while (whole(shift) >= lowestKept * DECIMAL_BASE) shift -= 1;
    while (whole(shift) < lowestKept) shift += 1;
    const [n, d] = scaled(shift);
    const digits = n / d + ((n % d) * HALF_DIVISOR_NUMERATOR >= d ? 1n : 0n);
    return Number(`${digits}e${-shift}`);
  }

  // The Total Profit ledger at cents, from marketPnL's slots. Each
  // market's trading (realizedClosed + unrealizedOpen, added exactly as
  // the decimals they stand for, amountDecimal), netFunding and
  // fees are rounded to whole cents first; its total is trading +
  // netFunding − fees, and the account's trading / funding / fees / total
  // are the sums of the markets' cents. So the Performance-by-Asset rows
  // add up to the Overview ledger, and the ledger to the headline, exactly
  // as they display at cents. Returns { byMarket, trading, funding, fees,
  // total }, byMarket holding each slot with those four fields at cents
  // (its counts and raw realized / unrealized kept). A market's netFunding
  // and total, and the account's funding and total, are null while that
  // funding is unknown (marketPnL); its fees and total, and the account's
  // fees and total, likewise while those fees are.
  function profitLedger(marketAgg) {
    const byMarket = {};
    let trading = 0, funding = 0, fees = 0;
    Object.entries(marketAgg || {}).forEach(([market, slot]) => {
      const t = decimalCents(exactAdd(amountDecimal(slot.realizedClosed), amountDecimal(slot.unrealizedOpen)));
      const f = slot.netFunding === null ? null : wholeCents(slot.netFunding);
      const fee = slot.fees === null ? null : wholeCents(slot.fees);
      byMarket[market] = {
        ...slot,
        trading: t / CENTS_PER_DOLLAR,
        netFunding: f === null ? null : f / CENTS_PER_DOLLAR,
        fees: fee === null ? null : fee / CENTS_PER_DOLLAR,
        total: f === null || fee === null ? null : profitFromComponents(t, f, fee) / CENTS_PER_DOLLAR
      };
      trading += t;
      funding = funding === null || f === null ? null : funding + f;
      fees = fees === null || fee === null ? null : fees + fee;
    });
    return {
      byMarket,
      trading: trading / CENTS_PER_DOLLAR,
      funding: funding === null ? null : funding / CENTS_PER_DOLLAR,
      fees: fees === null ? null : fees / CENTS_PER_DOLLAR,
      total: funding === null || fees === null ? null
        : profitFromComponents(trading, funding, fees) / CENTS_PER_DOLLAR
    };
  }

  // Lifetime trading profit now, on the equity-based definition: the latest
  // /historical-pnl totalPnl (equity − net transfers, sampled hourly) moved
  // by the equity change since that row. Assumes no transfer since the
  // row. Null when there are no rows, a row is invalid
  // (historicalPnlRowGap) or the equity now does not parse. The
  // reference the Total Profit reconciliation gate checks against
  // (profitReconciliation).
  function equityAdjustedTotalPnl(historicalPnl, equityNow) {
    const series = chronologicalHistoricalPnl(historicalPnl);
    if (series.length === 0) return null;
    const latest = series[series.length - 1];
    const totalPnl = parseFloat(latest.totalPnl);
    const rowEquity = parseFloat(latest.equity);
    const equity = parseFloat(equityNow);
    if (!isNumber(totalPnl) || !isNumber(rowEquity) || !isNumber(equity)) return null;
    return totalPnl + (equity - rowEquity);
  }

  // The Total Profit reconciliation tolerance: 1% of the larger reference,
  // floored at $1, so a small account still surfaces dollar drift and a
  // large one does not trip on per-row rounding.
  const RECONCILE_FLOOR_USD = 1;
  const RECONCILE_TOLERANCE_FRACTION = 0.01;

  // Whether the fills-based Total Profit `headline` agrees with
  // /historical-pnl. The rows cannot say what happened since the last
  // hourly one: its totalPnl misses the price move since, and
  // equityAdjustedTotalPnl reads a transfer since as profit. So the
  // headline agrees when it lies within the tolerance of the span between
  // the two. { reference (equityAdjustedTotalPnl), rowTotalPnl, gap
  // (headline − the nearest value of that span, 0 inside it), tolerance,
  // reason ('' when they agree, else why the headline is no profit) }, or
  // null when there is no headline or no reference to check it against.
  function profitReconciliation(historicalPnl, equityNow, headline) {
    const reference = equityAdjustedTotalPnl(historicalPnl, equityNow);
    if (!isNumber(headline) || !isNumber(reference)) return null;
    const series = chronologicalHistoricalPnl(historicalPnl);
    const rowTotalPnl = parseFloat(series[series.length - 1].totalPnl);
    const low = Math.min(rowTotalPnl, reference);
    const high = Math.max(rowTotalPnl, reference);
    const gap = headline < low ? headline - low : headline > high ? headline - high : 0;
    const tolerance = Math.max(RECONCILE_FLOOR_USD,
      Math.max(Math.abs(low), Math.abs(high)) * RECONCILE_TOLERANCE_FRACTION);
    const reason = Math.abs(gap) > tolerance
      ? `Fills disagree with /historical-pnl by ${window.Format.formatCurrency(gap)}: `
        + 'fills may be incomplete, or /historical-pnl may count flows that are not trades'
      : '';
    return { reference, rowTotalPnl, gap, tolerance, reason };
  }

  // A position's indexer netFunding as a number, null when the field is
  // absent, blank or not wholly numeric ('12abc'): unknown, never $0. A
  // reported '0' is a known zero. The one netFunding reader.
  function positionNetFunding(p) {
    return decimalNumberOf(p ? p.netFunding : undefined);
  }

  const NO_NET_FUNDING = 'No netFunding reported';

  // Why the summed netFunding of `positions` is unknown: '' when every
  // position carries one (positionNetFunding), else NO_NET_FUNDING with
  // the count of positions that do not.
  function netFundingGap(positions) {
    const n = (positions || []).filter(p => p && positionNetFunding(p) === null).length;
    return n === 0 ? '' : `${NO_NET_FUNDING} for ${n} position${n === 1 ? '' : 's'}`;
  }

  // Sum of netFunding across every position (CLOSED + OPEN). Used by the
  // Total Profit headline so realized + unrealized + funding agrees with
  // /historical-pnl totalPnl (which is equity-based and already includes
  // funding). null while any position's netFunding is unknown
  // (netFundingGap says why). Returns 0 on empty input. Summed exactly
  // (exactSum).
  function netFundingTotal(positions) {
    if (netFundingGap(positions)) return null;
    return exactSum((positions || []).filter(Boolean).map(positionNetFunding));
  }

  // Active child subaccount detector. Returns the subset of subaccounts
  // (≥ 1, where dYdX convention places isolated-margin subs at 128 and
  // 256) that currently have any state worth surfacing — non-zero or
  // unknown equity (absent or not wholly numeric: it may hold funds), open
  // positions, or asset balances. Dashboard analyses sub=0; any
  // child with activity is a blind spot the operator must be warned
  // about so headline isn't trusted as the account's full picture.
  // Empty input → empty array.
  function activeChildSubaccounts(subaccounts) {
    if (!Array.isArray(subaccounts)) return [];
    return subaccounts.filter(s => {
      if (!s || s.subaccountNumber === 0 || s.subaccountNumber == null) return false;
      const eq = accountEquity(s);
      if (eq !== 0) return true;
      const open = s.openPerpetualPositions && typeof s.openPerpetualPositions === 'object'
        && Object.keys(s.openPerpetualPositions).length > 0;
      if (open) return true;
      const assets = s.assetPositions && typeof s.assetPositions === 'object'
        && Object.keys(s.assetPositions).length > 0;
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

  // { size, price, buy, exactSize, exactPrice } for a fill the FIFO walk
  // can use, else null: size and price as Numbers, and as the exact
  // decimals the fill's text is written as (exactMagnitude; the price
  // keeps its sign).
  function parseFillTrade(f) {
    const size = Math.abs(parseFloat(f && f.size));
    const price = parseFloat(f && f.price);
    if (!isNumber(size) || size <= 0 || !isNumber(price)) return null;
    const side = (f.side || '').toUpperCase();
    if (side !== 'BUY' && side !== 'SELL') return null;
    const priceMagnitude = exactMagnitude(f.price);
    return {
      size, price, buy: side === 'BUY',
      exactSize: exactMagnitude(f.size),
      exactPrice: price < 0 ? exactNegate(priceMagnitude) : priceMagnitude
    };
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
  // Lot sizes, prices, the net size and each step's realized are exact
  // decimals from the fills' text (exactMagnitude), so a realized amount
  // is (exit − entry) × size to its last digit; only the flat tolerance
  // compares Numbers (exactNumber), for fills whose sizes do not net to
  // exactly zero (sizes given as computed numbers).
  //
  // Each usable fill yields one step splitting it into a closing portion
  // (`closeQty`, which realizes `realized` against the oldest lots) and an
  // opening portion (`openQty`, which becomes a new lot). A flip fill
  // (long → through zero → short in one fill) has both: the chain treats
  // it atomically, closing all inventory at the fill price and opening
  // the residual on the other side at the same price. A step carries
  // `size`, `price`, `closeQty`, `openQty`, `netBefore` and `netAfter` as
  // Numbers (net sizes signed, positive = LONG, snapped to exactly 0
  // within flatTolerance), and `exact`: { size, price, closeQty, openQty,
  // heldAfter (|net size| after the fill), realized (signed) } as exact
  // decimals. Fills whose size/price/side do not parse go to `onSkip` and
  // leave inventory untouched. Returns the lots still open after the last
  // fill ({ size, price } exact decimals, FIFO order), their side and the
  // signed net size the walk ends on (`netSize`, a Number, 0 when flat).
  function walkMarketFifo(sortedFills, onStep, onSkip) {
    const inventory = []; // [{ size, price }] FIFO order, size > 0
    let net = EXACT_ZERO; // signed
    let peakSinceFlat = 0;
    sortedFills.forEach(fill => {
      const trade = parseFillTrade(fill);
      if (!trade) {
        if (onSkip) onSkip(fill);
        return;
      }
      const netBefore = exactNumber(net);
      const tolerance = flatTolerance(netBefore, trade.size, peakSinceFlat);
      const reducing = (netBefore > 0 && !trade.buy) || (netBefore < 0 && trade.buy);
      const closeQty = reducing ? exactMin(trade.exactSize, exactMagnitudeOf(net)) : EXACT_ZERO;
      const residual = exactSubtractFloored(trade.exactSize, closeQty);
      const openQty = exactNumber(residual) > tolerance ? residual : EXACT_ZERO;
      let realized = EXACT_ZERO;
      let toMatch = closeQty;
      while (exactNumber(toMatch) > tolerance && inventory.length > 0) {
        const lot = inventory[0];
        const matched = exactMin(toMatch, lot.size);
        const gain = netBefore > 0
          ? exactAdd(trade.exactPrice, exactNegate(lot.price))
          : exactAdd(lot.price, exactNegate(trade.exactPrice));
        realized = exactAdd(realized, exactProduct(gain, matched));
        lot.size = exactSubtractFloored(lot.size, matched);
        toMatch = exactSubtractFloored(toMatch, matched);
        if (exactNumber(lot.size) <= tolerance) inventory.shift();
      }
      if (openQty.units > 0n) inventory.push({ size: openQty, price: trade.exactPrice });
      net = exactAdd(net, trade.buy ? trade.exactSize : exactNegate(trade.exactSize));
      if (Math.abs(exactNumber(net)) <= tolerance) {
        net = EXACT_ZERO;
        inventory.length = 0;
        peakSinceFlat = 0;
      } else {
        peakSinceFlat = Math.max(peakSinceFlat, Math.abs(exactNumber(net)));
      }
      onStep({
        fill, size: trade.size, price: trade.price,
        closeQty: exactNumber(closeQty), openQty: exactNumber(openQty),
        netBefore, netAfter: exactNumber(net),
        exact: {
          size: trade.exactSize, price: trade.exactPrice, closeQty, openQty,
          heldAfter: exactMagnitudeOf(net), realized
        }
      });
    });
    const netSize = exactNumber(net);
    return { lots: inventory, side: Math.sign(netSize), netSize };
  }

  // Each market's signed net position size over time, from the same FIFO
  // walk as the attribution: { [market]: [{ ms, netSize, price }] }, one
  // entry per usable fill in chain order holding the net size after it
  // (positive = LONG, 0 when flat) and its price. Unusable fills leave the
  // size untouched, as in the walk. The funding hero reads the size held at
  // each hourly settlement from it.
  function netSizeHistory(fills) {
    const byMarket = {};
    Object.entries(groupFillsByMarketChronologically(fills)).forEach(([market, sorted]) => {
      const steps = [];
      walkMarketFifo(sorted, step => {
        steps.push({ ms: timestampMs(step.fill.createdAt), netSize: step.netAfter, price: step.price });
      });
      byMarket[market] = steps;
    });
    return byMarket;
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
  // Returns { total, byMarket } where byMarket maps market → realized:
  // the exact decimal sum of the walk's exact step amounts, as the
  // per-position attribution sums its portions, handed out as the Number
  // nearest it at NOISE_FREE_SIGNIFICANT_DIGITS (decimalNumber), so a
  // price difference that cancels (64000.13 − 64000.1) or an amount below
  // the micro never moves a cent.
  // Markets with only OPEN inventory (no closing fills yet) emit 0 —
  // their unrealized P&L still comes from /perpetualPositions.unrealizedPnl
  // mark-to-market.
  function computeRealizedFromFills(fills) {
    const byMarket = {};
    if (!Array.isArray(fills)) return { total: 0, byMarket };
    let total = EXACT_ZERO;
    const buckets = groupFillsByMarketChronologically(fills);
    Object.entries(buckets).forEach(([market, mfills]) => {
      let realized = EXACT_ZERO;
      walkMarketFifo(mfills, step => { realized = exactAdd(realized, step.exact.realized); });
      byMarket[market] = decimalNumber(realized);
      total = exactAdd(total, realized);
    });
    return { total: decimalNumber(total), byMarket };
  }

  // FIFO unrealized P&L: the lots the walk leaves open in each market,
  // marked at marketsMap[market].oraclePrice. Pairs with
  // computeRealizedFromFills on the same cost basis, so realized +
  // unrealized equals the fills' cash flow plus the marked inventory.
  // (The indexer's per-position unrealizedPnl marks against the average
  // entry of every opening fill, which double-counts profit FIFO has
  // already realized on a partly reduced position.)
  //
  // Each lot's (oracle − entry) × size is exact on the decimals the oracle
  // and the fills are written as, and every sum of them is exact; a market's
  // and the total are handed out as the Number nearest the exact decimal at
  // NOISE_FREE_SIGNIFICANT_DIGITS (decimalNumber), so an oracle that nearly
  // cancels the entry price rounds at cents from its exact value.
  //
  // Returns { total, byMarket, unpricedMarkets, openMarkets }. A flat market
  // contributes 0. openMarkets lists every market with open lots. A market
  // with open lots and no positive oracle price is null in byMarket and
  // listed in unpricedMarkets, and total is then null.
  function computeUnrealizedFromFills(fills, marketsMap) {
    const byMarket = {};
    const unpricedMarkets = [];
    const openMarkets = [];
    let total = EXACT_ZERO;
    if (!Array.isArray(fills)) return { total: 0, byMarket, unpricedMarkets, openMarkets };
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
      const mark = exactMagnitude(marketsMap[market].oraclePrice);
      const unrealized = lots.reduce((sum, lot) => {
        const gain = exactProduct(exactAdd(mark, exactNegate(lot.price)), lot.size);
        return exactAdd(sum, side > 0 ? gain : exactNegate(gain));
      }, EXACT_ZERO);
      byMarket[market] = decimalNumber(unrealized);
      total = exactAdd(total, unrealized);
    });
    return { total: unpricedMarkets.length ? null : decimalNumber(total), byMarket, unpricedMarkets, openMarkets };
  }

  // Why attributeFillsToPositions left a position incomplete (its
  // `incompleteCause`). Each value is a phrase a panel can show; declared
  // in precedence order, root causes before the open-size symptom.
  const INCOMPLETE_CAUSE = Object.freeze({
    // A fill in the market that the walk cannot use (unparseable size,
    // price or side, or no timestamp) lies inside the position's window.
    UNUSABLE_FILL: 'Unusable fill',
    // A segment starts or ends with a flip that no opposite-side position
    // closes or opens at that instant (flipPartnersListed).
    REVERSAL_PARTNER_MISSING: 'Reversal partner missing',
    // A same-side position shares both its createdAt and its closedAt.
    INDISTINGUISHABLE: 'Indistinguishable positions',
    // No segment belongs to the position.
    NO_MATCHING_FILLS: 'No matching fills',
    // More than one segment belongs to it: its fills return to flat
    // inside a window the indexer holds as one position.
    FLAT_MID_POSITION: 'Fills go flat mid-position',
    // Its segment is on the other side.
    SIDE_MISMATCH: 'Fills on the opposite side',
    // A CLOSED position's segment is not flat by its closedAt.
    NOT_FLAT_AT_CLOSE: 'Fills not flat at close',
    // An OPEN position's signed indexer size is not the net size the walk
    // ends its market on (openSizeMatchesWalk).
    OPEN_SIZE_MISMATCH: 'Fills do not match open positions',
    // One of the position's fills has no fee (fillFee null). Realized,
    // size and prices stay right, so every cause above, which makes them
    // wrong, says more.
    UNKNOWN_FEE: 'Unknown fill fee',
    // Set on every CLOSED position of a market whose fills hold a closed
    // round trip that no listed position owns: a CLOSED row is missing, so
    // the market's closed trades are not all listed.
    UNLISTED_TRADE: 'Fills hold a closed trade no listed position owns'
  });

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
  // (open-ended while OPEN) contains that fill. A segment that returned
  // to flat with no owner is a closed trade missing from the CLOSED list,
  // so every CLOSED position of its market reads incomplete
  // (INCOMPLETE_CAUSE.UNLISTED_TRADE); an open segment with no owner is
  // left to the caller's open-lots check. The returned Map also carries
  // `unlistedTradeMarkets`, the sorted markets whose fills hold such a
  // trade, a market with fills but no listed position at all included:
  // the account's closed trades are not all listed.
  //
  // Cost: the per-market sort plus one FIFO pass, O(n log n) in fills,
  // and a linear scan over the market's positions only for a segment whose
  // first fill matches no position's createdAt.
  //
  // Returns Map<position, attribution> with an entry for every position:
  //   realized    FIFO realized on the position's closing portions (gross)
  //   fees        Σ fill.fee over its portions, a flip fill's fee split by
  //               size (positive = paid, negative = rebate); null when a
  //               portion's fill has no fee (INCOMPLETE_CAUSE.UNKNOWN_FEE)
  //   profit      realized − fees (funding is separate), null with fees
  //   peakSize    largest |net size| during the position, base units, > 0,
  //               the exact held size summed from the fills' decimal text
  //   entryVwap   size-weighted price of the opening portions (null if none)
  //   exitVwap    size-weighted price of the closing portions (null if none),
  //               both exact on the fills' decimal text and given at 15
  //               significant digits (exactQuotientNumber)
  //   fillCount   fills touching the position (a flip fill counts for both)
  //   portions    the position's fill portions in walk order, { fill,
  //               realized, fee }: realized is non-zero only on a closing
  //               portion, fee is the portion's size share of fill.fee
  //               (null when the fill has no fee, fillFee). They sum to
  //               realized and fees, and the tax report dates each by its
  //               fill.
  //   openedByFlip / closedByFlip
  //   complete    false exactly when incompleteCause is set. Consumers
  //               render '—' for an incomplete position's values.
  //   incompleteCause  null when complete, else the INCOMPLETE_CAUSE value
  //               naming why; when several apply, the first in
  //               INCOMPLETE_CAUSE order (root causes before the open-size
  //               symptom they produce).
  //   openSizeDisagrees  true only for an OPEN position whose indexer size
  //               is not the walk's final net size (whatever else made it
  //               incomplete): the market's fills do not add up to the open
  //               position, so the market's FIFO totals are off too.
  // Pure: the positions and fills passed in are never mutated.
  function attributeFillsToPositions(positions, fills) {
    const out = new Map();
    out.unlistedTradeMarkets = [];
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
      let holdsUnlistedTrade = false;
      segments.forEach(seg => {
        const owner = createdAtOwner(createdAtIndex.get(seg.startMs), seg)
          || candidates.find(c => c.openMs !== null && c.openMs <= seg.startMs && seg.startMs <= c.windowEndMs);
        if (!owner) {
          if (seg.flat) holdsUnlistedTrade = true;
          return;
        }
        owner.segments.push(seg);
        if (!flipPartnersListed(seg, flipPartners)) unpartneredFlip.add(owner);
      });
      candidates.forEach(c => {
        const unusableFillInWindow = marketsWithUntimedFills.has(market)
          || (c.openMs !== null && anyWithin(skippedMs, c.openMs, c.windowEndMs));
        const summary = summarizeSegments(c.p, c.segments, c.windowEndMs);
        const openSizeDisagrees = c.p.status === 'OPEN' && !openSizeMatchesWalk(c.p, netSize, summary.peakSize);
        const incompleteCause = (unusableFillInWindow && INCOMPLETE_CAUSE.UNUSABLE_FILL)
          || (unpartneredFlip.has(c) && INCOMPLETE_CAUSE.REVERSAL_PARTNER_MISSING)
          || (indistinguishable.has(c) && INCOMPLETE_CAUSE.INDISTINGUISHABLE)
          || summary.incompleteCause
          || (openSizeDisagrees && INCOMPLETE_CAUSE.OPEN_SIZE_MISMATCH)
          || (summary.fees === null && INCOMPLETE_CAUSE.UNKNOWN_FEE)
          || (holdsUnlistedTrade && c.p.status === 'CLOSED' && INCOMPLETE_CAUSE.UNLISTED_TRADE)
          || null;
        out.set(c.p, { ...summary, complete: incompleteCause === null, incompleteCause, openSizeDisagrees });
      });
      if (holdsUnlistedTrade) out.unlistedTradeMarkets.push(market);
    });
    Object.entries(fillsByMarket)
      .filter(([market]) => !positionsByMarket[market])
      .filter(([, marketFills]) => segmentMarketFills(marketFills).segments.some(seg => seg.flat))
      .forEach(([market]) => out.unlistedTradeMarkets.push(market));
    out.unlistedTradeMarkets.sort();
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

  // The other side of an upper-case position side ('LONG' ↔ 'SHORT'),
  // null for anything else.
  function oppositeSide(side) {
    return OPPOSITE_SIDE[side] || null;
  }

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
    const partner = flipPartners[oppositeSide(seg.side)];
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

  // A position's hold time, closedAt − createdAt in ms; null when either
  // timestamp is absent or unparseable or the close precedes the entry.
  // The one hold-time rule the hold-time histogram, the Behavior tab's
  // hold-time figures and the Positions board's DURATION share.
  function holdMs(p) {
    const entryMs = timestampMs(p && p.createdAt);
    const closeMs = timestampMs(p && p.closedAt);
    if (entryMs === null || closeMs === null || closeMs < entryMs) return null;
    return closeMs - entryMs;
  }

  // '' when no CLOSED position fails `isValid`, else e.g. "2 closed
  // positions without a valid <what>".
  function closedPositionsGap(positions, isValid, what) {
    const missing = (positions || []).filter(p => p && p.status === 'CLOSED' && !isValid(p)).length;
    if (missing === 0) return '';
    return `${missing} closed position${missing === 1 ? '' : 's'} without a valid ${what}`;
  }

  // '' when every CLOSED position has a hold time (holdMs), else why a
  // hold-time figure over them would leave positions out.
  function holdTimeGap(positions) {
    return closedPositionsGap(positions, p => holdMs(p) !== null, 'entry and close time');
  }

  // '' when every CLOSED position has a valid closedAt (timestampMs), else
  // why a figure bucketed by close time (the monthly classifier cells)
  // would leave positions out.
  function closeTimeGap(positions) {
    return closedPositionsGap(positions, p => timestampMs(p.closedAt) !== null, 'close time');
  }

  // '' when every position, OPEN included, has a valid entry time
  // (timestampMs of createdAt), else why an entry-based count (the entry
  // heatmap, Most Active Day, Post-Loss Double Down) would leave one out.
  function entryTimeGap(positions) {
    const missing = (positions || []).filter(p => p && timestampMs(p.createdAt) === null).length;
    if (missing === 0) return '';
    return `${missing} position${missing === 1 ? '' : 's'} without a valid entry time`;
  }

  function emptyAttribution() {
    return {
      realized: 0, fees: 0, profit: 0,
      peakSize: null, entryVwap: null, exitVwap: null,
      fillCount: 0, portions: [], complete: false,
      incompleteCause: INCOMPLETE_CAUSE.NO_MATCHING_FILLS,
      openedByFlip: false, closedByFlip: false,
      openSizeDisagrees: false
    };
  }

  // Cuts one market's sorted fills into position segments. Each segment
  // holds its fill portions ({ fill, qty, fillSize, price, realized,
  // closing }, qty, fillSize, price and realized the walk's exact
  // decimals, so a reversing fill's two portions split its size, and its
  // fee, exactly), its peak
  // held size (`peakHeld`, the walk's exact held size, never a float
  // running net size), whether it returned to flat and at which millisecond
  // (`flatMs`), and its flip flags. `skippedMs` lists the timestamps of
  // unusable fills; `netSize` is the signed net size the walk ends on.
  function segmentMarketFills(sortedFills) {
    const segments = [];
    const skippedMs = [];
    let current = null;
    const { netSize } = walkMarketFifo(sortedFills, step => {
      const { closeQty, openQty, heldAfter, realized } = step.exact;
      const price = exactMagnitudeOf(step.exact.price);
      if (step.closeQty > 0 && current) {
        current.portions.push({
          fill: step.fill, qty: closeQty, fillSize: step.exact.size, price,
          realized, closing: true
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
            peakHeld: EXACT_ZERO,
            portions: []
          };
          segments.push(current);
        }
        current.portions.push({
          fill: step.fill, qty: openQty, fillSize: step.exact.size, price,
          realized: EXACT_ZERO, closing: false
        });
        current.peakHeld = exactMax(current.peakHeld, heldAfter);
      }
    }, fill => skippedMs.push(timestampMs(fill.createdAt)));
    return { segments, skippedMs, netSize };
  }

  // The position's figures from its segments, with the incompleteCause
  // their shape alone shows (null when it shows none). Realized, fees and
  // profit are exact decimal sums of the portions' amounts (the walk's
  // exact realized, the fees as written), handed out as the Number nearest
  // each at NOISE_FREE_SIGNIFICANT_DIGITS (decimalNumber), so a trade whose
  // decimal profit is 0 has profit exactly 0 and classifies as a scratch,
  // and a decimal tie rounds as the decimal. Each portion's realized is
  // handed out the same way.
  function summarizeSegments(position, segments, windowEndMs) {
    if (segments.length === 0) return emptyAttribution();
    let peakHeld = EXACT_ZERO;
    let openQty = EXACT_ZERO, openNotional = EXACT_ZERO, closeQty = EXACT_ZERO, closeNotional = EXACT_ZERO;
    const touched = new Set();
    const portions = [];
    segments.forEach(seg => {
      peakHeld = exactMax(peakHeld, seg.peakHeld);
      seg.portions.forEach(part => {
        touched.add(part.fill);
        const share = fillFee(part.fill) === null ? null
          : exactShare(amountDecimal(part.fill.fee), part.qty, part.fillSize);
        const portion = { fill: part.fill, realized: decimalNumber(part.realized), fee: share && fractionNumber(share) };
        if (share) PORTION_FEE_SHARES.set(portion, share);
        portions.push(portion);
        if (part.closing) {
          closeQty = exactAdd(closeQty, part.qty);
          closeNotional = exactAdd(closeNotional, exactProduct(part.qty, part.price));
        } else {
          openQty = exactAdd(openQty, part.qty);
          openNotional = exactAdd(openNotional, exactProduct(part.qty, part.price));
        }
      });
    });
    const only = segments.length === 1 ? segments[0] : null;
    const side = positionSide(position);
    const sideAgrees = !side || (only !== null && only.side === side);
    const flatByClose = only !== null && only.flat && only.flatMs <= windowEndMs;
    const flatWhenRequired = position.status !== 'CLOSED' || flatByClose;
    const incompleteCause = (only === null && INCOMPLETE_CAUSE.FLAT_MID_POSITION)
      || (!sideAgrees && INCOMPLETE_CAUSE.SIDE_MISMATCH)
      || (!flatWhenRequired && INCOMPLETE_CAUSE.NOT_FLAT_AT_CLOSE)
      || null;
    const realized = segments.reduce((sum, seg) => seg.portions.reduce((acc, part) => exactAdd(acc, part.realized), sum), EXACT_ZERO);
    const fees = portionFeesFraction(portions);
    return {
      realized: decimalNumber(realized),
      fees: fees === null ? null : fractionNumber(fees),
      profit: fees === null ? null : fractionNumber(fractionAdd(decimalFraction(realized), { num: -fees.num, den: fees.den })),
      peakSize: exactNumber(peakHeld),
      entryVwap: exactQuotientNumber(openNotional, openQty),
      exitVwap: exactQuotientNumber(closeNotional, closeQty),
      fillCount: touched.size,
      portions,
      complete: incompleteCause === null,
      incompleteCause,
      openedByFlip: segments[0].openedByFlip,
      closedByFlip: segments[segments.length - 1].closedByFlip,
      openSizeDisagrees: false
    };
  }

  // Sum of trading fees across every fill. dYdX v4 indexer convention:
  // `fill.fee` is a string USD amount where POSITIVE = paid by the user
  // (taker fees and most maker fills) and NEGATIVE = maker rebate received.
  // The caller subtracts this from profit so rebates ADD to the bottom
  // line. null while any fill's fee is unknown (feeGap says why); 0 on
  // empty input. Summed exactly (exactSum). The complement to
  // netFundingTotal in the equity-based reconciliation:
  //   totalPnl ≈ realized + unrealized + netFunding − fees + …
  function feesTotal(fills) {
    return exactSum(presentFills(fills).map(fillFee));
  }

  function presentFills(fills) {
    return (fills || []).filter(Boolean);
  }

  // A fill's fee as a number, null when the field is absent, blank or not
  // wholly numeric ('12abc'): unknown, never $0. A reported '0' is a known
  // zero. The one fee reader.
  function fillFee(f) {
    return decimalNumberOf(f ? f.fee : undefined);
  }

  // Why the summed fees of `fills` are unknown: '' when every fill carries
  // a fee (fillFee), else the count of fills that do not.
  function feeGap(fills) {
    const n = presentFills(fills).filter(f => fillFee(f) === null).length;
    return n === 0 ? '' : `${n} fill${n === 1 ? '' : 's'} without a fee`;
  }

  // Per-market fees map keyed by `fill.market`. Same parsing, exact sum
  // and dYdX positive-paid sign convention as feesTotal: { [market]:
  // feesPaid }, null for a market holding a fill without a fee. Fed into
  // marketPnL(positions, feesMap) so the per-asset table and chart tooltip
  // reconcile to the headline.
  function marketFees(fills) {
    const byMarket = {};
    presentFills(fills).forEach(f => {
      const m = f.market || 'Unknown';
      (byMarket[m] = byMarket[m] || []).push(fillFee(f));
    });
    const out = {};
    Object.entries(byMarket).forEach(([m, fees]) => { out[m] = exactSum(fees); });
    return out;
  }

  // The anchored totalPnl series (buildCumulativeTotalPnlSeries with
  // `live` and `historyCut`) split by UTC month (monthKeyUTC): `keys` is
  // every calendar month from the first point's to the last point's, gap
  // months included, and `points` maps a month with points to them in
  // order. The one bucketing behind the monthly PROFIT and MAX DD, so both
  // measure from the same prior month-end.
  function seriesByMonth(historicalPnl, live, historyCut) {
    const points = new Map();
    buildCumulativeTotalPnlSeries(historicalPnl, live, historyCut).forEach(pt => {
      const key = monthKeyUTC(pt.t);
      if (key === null) return;
      if (!points.has(key)) points.set(key, []);
      points.get(key).push(pt);
    });
    const sorted = [...points.keys()].sort();
    const keys = [];
    for (let key = sorted[0]; sorted.length && key <= sorted[sorted.length - 1]; key = nextMonthKey(key)) {
      keys.push(key);
    }
    return { keys, points };
  }

  // Monthly Δ totalPnl from /historical-pnl rows. Returns
  // { [monthKey]: { delta, start, end, hasData, reason } } for every UTC
  // calendar month (monthKeyUTC) from the first row's to the last row's,
  // where `start` is lastOfPriorMonth.totalPnl (the inception 0 for the
  // first month), `end` is lastOfMonth.totalPnl and `delta` is
  // `end − start`, taken exactly on the decimals (exactSum). The
  // PROFIT column shows `end` and `start` each at whole dollars
  // differenced, so its cells sum to the headline as displayed.
  // A month without a usable row reads `hasData: false` and `delta`,
  // `start`, `end` null;
  // the month after it has no known prior month-end either, so its
  // `delta` is null too rather than absorbing the gap month's change.
  // `reason` says why a delta is null ('' when known); the caller renders
  // "—" with it per the no-metric-better-than-wrong-metric rule, and
  // NO_MONTH_ROWS_REASON for a month outside the rows' span. The
  // earliest observed month is measured from the inception value 0
  // (INCEPTION_TOTAL_PNL) when the rows reach inception; when they do not
  // (`historyCut`, as in buildCumulativeTotalPnlSeries) that month is cut
  // short and reads `delta: null` with `historyCut` as its reason. The
  // months read buildCumulativeTotalPnlSeries with `live`, so the current
  // month ends at the live point.
  const NO_MONTH_ROWS_REASON = 'No /historical-pnl rows this month';
  const UNKNOWN_CHANGE = Object.freeze({ delta: null, start: null, end: null });

  function histPnlMonthly(historicalPnl, live = null, historyCut = '') {
    if (!Array.isArray(historicalPnl) || historicalPnl.length === 0) return {};
    const { keys, points } = seriesByMonth(historicalPnl, live, historyCut);
    const out = {};
    let prev = INCEPTION_TOTAL_PNL;
    let unknownMonth = null;
    keys.forEach((key, i) => {
      if (!points.has(key)) {
        out[key] = { ...UNKNOWN_CHANGE, hasData: false, reason: NO_MONTH_ROWS_REASON };
        unknownMonth = key;
        return;
      }
      const monthPoints = points.get(key);
      const last = monthPoints[monthPoints.length - 1].c;
      const cutShort = i === 0 && historyCut;
      out[key] = cutShort ? { ...UNKNOWN_CHANGE, hasData: true, reason: historyCut }
        : unknownMonth === null
          ? { delta: exactSum([last, -prev]), start: prev, end: last, hasData: true, reason: '' }
          : { ...UNKNOWN_CHANGE, hasData: true,
            reason: `Change unknown: no /historical-pnl rows in ${monthLabel(unknownMonth)}` };
      prev = last;
      unknownMonth = null;
    });
    return out;
  }

  // A month's MAX DD needs a drawdown scan over at least this many points.
  const MIN_DRAWDOWN_POINTS = 2;

  // Monthly MAX DD on the anchored totalPnl series: the worst
  // peak-to-trough (scanDrawdownEvents) from the prior month-end point,
  // when the prior calendar month has points (the base the month's PROFIT
  // is measured from), through the month's own points, the live point
  // included in its month, the deepest as displayed (scanDrawdownEvents'
  // worst). Returns { [monthKey]: { dollarDrawdown, peakValue,
  // troughValue, reason } } for the months histPnlMonthly lists:
  // `dollarDrawdown` is the raw depth of that drawdown from `peakValue`
  // to `troughValue` (0, the two alike, for a month that never drew
  // down); all three are null with `reason` for a month without rows
  // (NO_MONTH_ROWS_REASON), with fewer than MIN_DRAWDOWN_POINTS points,
  // or cut short by `historyCut` (the first month, as in histPnlMonthly).
  function histPnlMonthlyDrawdown(historicalPnl, live = null, historyCut = '') {
    if (!Array.isArray(historicalPnl) || historicalPnl.length === 0) return {};
    const { keys, points } = seriesByMonth(historicalPnl, live, historyCut);
    const out = {};
    let priorPoints = null;
    const unknown = reason => ({ dollarDrawdown: null, peakValue: null, troughValue: null, reason });
    keys.forEach((key, i) => {
      const monthPoints = points.get(key) || null;
      if (!monthPoints) {
        out[key] = unknown(NO_MONTH_ROWS_REASON);
      } else if (i === 0 && historyCut) {
        out[key] = unknown(historyCut);
      } else {
        const scanned = priorPoints ? [priorPoints[priorPoints.length - 1], ...monthPoints] : monthPoints;
        if (scanned.length >= MIN_DRAWDOWN_POINTS) {
          const { dollarDrawdown, peakValue, troughValue } = scanDrawdownEvents(scanned).worst;
          out[key] = { dollarDrawdown, peakValue, troughValue, reason: '' };
        } else {
          out[key] = unknown(`Needs ≥${MIN_DRAWDOWN_POINTS} points: one /historical-pnl point this month and no prior month-end`);
        }
      }
      priorPoints = monthPoints;
    });
    return out;
  }

  // The oracle (mark) price of a position's market: the position's own
  // oraclePrice, else marketsMap[market].oraclePrice (position objects from
  // /perpetualPositions don't carry oraclePrice; the markets map is the
  // canonical source). Null when neither is a positive number. There is no
  // entry-price fallback: an entry-priced figure under an oracle label is
  // a wrong number, not an approximation.
  function positionOraclePrice(position, marketsMap) {
    if (!position) return null;
    const m = (marketsMap && marketsMap[position.market]) || {};
    const price = parseFloat(position.oraclePrice || m.oraclePrice);
    return price > 0 ? price : null;
  }

  // Maintenance margin requirement of a position at its oracle price,
  // |S|·O·MMF: 0 for a reported zero size, null when the size is absent
  // or not wholly numeric (decimalNumberOf) or the oracle or MMF is unknown.
  function maintenanceMarginAtOracle(position, marketsMap) {
    const size = openSizeOf(position);
    if (size === null) return null;
    if (size === 0) return 0;
    const m = (marketsMap && marketsMap[position.market]) || {};
    const oracle = positionOraclePrice(position, marketsMap);
    const mmf = parseFloat(m.maintenanceMarginFraction);
    return oracle !== null && mmf > 0 ? size * oracle * mmf : null;
  }

  // |size| of an open position, null when the size is absent or not
  // wholly numeric: unknown, never 0 or its leading digits.
  function openSizeOf(position) {
    const size = decimalNumberOf(position.size);
    return size === null ? null : Math.abs(size);
  }

  // Per-position liquidation price under cross-margin, holding every OTHER
  // open position at its current oracle price (its uPnL and its maintenance
  // margin requirement). Exact for accounts with a single open position.
  //
  // dYdX liquidates when total account value falls below the total
  // maintenance margin requirement, Σ |S_j|·P_j·MMF_j over every open
  // position (docs.dydx.xyz/concepts/trading/margin). With E the equity,
  // O the oracle and R = Σ_{j≠i} |S_j|·O_j·MMF_j the other positions'
  // requirement:
  //   LONG:  E + S·(P_liq − O) = S·P_liq·MMF + R    →  P_liq = (S·O − E + R) / (S·(1 − MMF))
  //   SHORT: E + |S|·(O − P_liq) = |S|·P_liq·MMF + R →  P_liq = (E − R + |S|·O) / (|S|·(1 + MMF))
  // `positions` is the account's position list (CLOSED rows and the
  // position's own market are skipped: one open position per market).
  // Returns null when MMF / size / oracle / equity is unavailable, when
  // another open position's requirement is unknown, or for a SHORT whose
  // numerator E − R + |S|·O is not positive: the account is then below its
  // total maintenance margin at every price. A LONG whose numerator is not
  // positive is floored at 0: no price above $0 liquidates it.
  // liquidationRow names each case (LIQUIDATION_STATE).
  function crossMarginLiqPrice(position, subaccount, marketsMap, positions = []) {
    return position ? crossMarginLiquidation(position, subaccount, marketsMap, positions).liq : null;
  }

  // What a position's cross-margin liquidation price is: a price
  // (AT_PRICE), none because the account is below maintenance margin at
  // every price (BELOW_MAINTENANCE, a SHORT), none because no price above
  // $0 liquidates it (NO_PRICE_LIQUIDATES, a LONG), unknown because one of
  // the position's own inputs is (UNKNOWN), or unknown because another
  // open position's maintenance margin is (OTHER_MARGIN_UNKNOWN).
  const LIQUIDATION_STATE = Object.freeze({
    AT_PRICE: 'at-price',
    BELOW_MAINTENANCE: 'below-maintenance',
    NO_PRICE_LIQUIDATES: 'no-price-liquidates',
    UNKNOWN: 'unknown',
    OTHER_MARGIN_UNKNOWN: 'other-margin-unknown'
  });

  // Why a market's open position cannot be valued: no oracle price
  // (positionOraclePrice null). A panel adds " for <market>".
  const NO_ORACLE_PRICE = 'No oracle price';

  // Why an equity-denominated figure is unknown: usableEquity is null.
  const EQUITY_UNAVAILABLE = 'Equity unavailable';

  // The input an unknown liquidation lacks, as a phrase a panel can show;
  // ORACLE and MMF belong to a market.
  const LIQUIDATION_INPUT = Object.freeze({
    EQUITY: EQUITY_UNAVAILABLE,
    SIZE: 'No open position size',
    SIDE: 'No position side',
    ORACLE: NO_ORACLE_PRICE,
    MMF: 'No maintenance margin fraction'
  });

  const LIQUIDATION_SIDES = ['LONG', 'SHORT'];

  // Which input leaves a position's maintenance margin unknown: its size,
  // else its market's oracle or MMF.
  function missingMarketInput(position, marketsMap) {
    if (openSizeOf(position) === null) return LIQUIDATION_INPUT.SIZE;
    return positionOraclePrice(position, marketsMap) === null ? LIQUIDATION_INPUT.ORACLE : LIQUIDATION_INPUT.MMF;
  }

  // crossMarginLiqPrice's { liq, state, missing } (LIQUIDATION_STATE):
  // `missing` lists the { market, input } (LIQUIDATION_INPUT; market null
  // for an account-wide or position input) an unknown state lacks: the
  // position's first missing input on UNKNOWN, every other open position
  // whose maintenance margin is unknown on OTHER_MARGIN_UNKNOWN; [] otherwise.
  function crossMarginLiquidation(position, subaccount, marketsMap, positions) {
    const unknown = (market, input) => ({ liq: null, state: LIQUIDATION_STATE.UNKNOWN, missing: [{ market, input }] });
    const known = (liq, state) => ({ liq, state, missing: [] });
    const market = position.market;
    const m = (marketsMap && marketsMap[market]) || {};
    const size = Math.abs(parseFloat(position.size || 0));
    const oracle = positionOraclePrice(position, marketsMap);
    const mmf = parseFloat(m.maintenanceMarginFraction || 0);
    const equity = usableEquity(subaccount);
    const side = (position.side || '').toUpperCase();
    if (equity === null) return unknown(null, LIQUIDATION_INPUT.EQUITY);
    if (!(size > 0)) return unknown(null, LIQUIDATION_INPUT.SIZE);
    if (!LIQUIDATION_SIDES.includes(side)) return unknown(null, LIQUIDATION_INPUT.SIDE);
    if (oracle === null) return unknown(market, LIQUIDATION_INPUT.ORACLE);
    if (!(mmf > 0)) return unknown(market, LIQUIDATION_INPUT.MMF);
    let othersRequirement = 0;
    const unvalued = [];
    for (const other of positions || []) {
      if (!other || other.status !== 'OPEN' || other.market === market) continue;
      const requirement = maintenanceMarginAtOracle(other, marketsMap);
      if (requirement === null) unvalued.push({ market: other.market, input: missingMarketInput(other, marketsMap) });
      else othersRequirement += requirement;
    }
    if (unvalued.length) return { liq: null, state: LIQUIDATION_STATE.OTHER_MARGIN_UNKNOWN, missing: unvalued };
    if (side === 'LONG') {
      const denom = size * (1 - mmf);
      if (denom <= 0) return unknown(market, LIQUIDATION_INPUT.MMF);
      const numerator = size * oracle - equity + othersRequirement;
      return numerator > 0
        ? known(numerator / denom, LIQUIDATION_STATE.AT_PRICE)
        : known(0, LIQUIDATION_STATE.NO_PRICE_LIQUIDATES);
    }
    const denom = size * (1 + mmf);
    const numerator = equity - othersRequirement + oracle * size;
    return numerator > 0
      ? known(numerator / denom, LIQUIDATION_STATE.AT_PRICE)
      : known(null, LIQUIDATION_STATE.BELOW_MAINTENANCE);
  }

  // Open-position notional: |size| × positionOraclePrice (mark, matching
  // dYdX's official UI). Null without a positive size or an oracle price.
  // Single definition behind leverageUtilization, liquidationRow and the
  // Positions board's Active Positions card.
  function positionNotional(position, marketsMap) {
    if (!position) return null;
    const size = Math.abs(parseFloat(position.size || 0));
    const price = positionOraclePrice(position, marketsMap);
    return size > 0 && price !== null ? size * price : null;
  }

  // The subaccount's equity when it is positive, else null (no subaccount,
  // missing, unparseable, zero or negative). The one rule every
  // equity-denominated figure (leverage, liquidation price) gates on.
  function usableEquity(subaccount) {
    const equity = subaccount ? accountEquity(subaccount) : null;
    return equity !== null && equity > 0 ? equity : null;
  }

  // A subaccount's equity as a number, null when it is absent, blank or
  // not wholly numeric ('5abc'): unknown, never $0 or $5.
  function accountEquity(subaccount) {
    return decimalNumberOf(subaccount.equity);
  }

  // Historical VaR / Expected Shortfall at 95%: the 5th-percentile
  // per-period return (sorted[floor(VAR_TAIL·n)]) and the mean of the
  // worst VAR_TAIL of the returns, as dollar losses at current usable
  // equity. The mean is the discrete Expected Shortfall of Acerbi &
  // Tasche, "On the coherence of Expected Shortfall" (J. Banking & Finance, 2002):
  // with k = VAR_TAIL·n and m = floor(k), (Σ sorted[0..m−1] + (k − m)·
  // sorted[m]) ÷ k, the boundary return weighed by its fractional share,
  // so a return past the worst 5% never dilutes the tail. A loss is
  // max(0, −return) × equity, so a tail made of gains reads as a $0 loss,
  // never as a profit. Null without returns or usableEquity (a negative
  // equity would flip the sign). The horizon is one sampling period of
  // the returns (varSampleReturns); the caller names it.
  var VAR_TAIL = 0.05;

  function historicalVaR(returns, subaccount) {
    const equity = usableEquity(subaccount);
    if (!Array.isArray(returns) || returns.length === 0 || equity === null) return null;
    const sorted = returns.slice().sort((a, b) => a - b);
    const tailWeight = VAR_TAIL * sorted.length;
    const idx = Math.floor(tailWeight);
    const varReturn = sorted[idx];
    const wholeTail = sorted.slice(0, idx).reduce((s, v) => s + v, 0);
    const esReturn = (wholeTail + (tailWeight - idx) * sorted[idx]) / tailWeight;
    const lossAt = (ret) => Math.max(0, -ret) * equity;
    return { varReturn, esReturn, varLoss: lossAt(varReturn), esLoss: lossAt(esReturn) };
  }

  // Account-level leverage utilization — sum of positionNotional across open
  // positions ÷ subaccount equity. Returns null when usableEquity is null,
  // when any open position has no notional (a sum over the others would
  // understate leverage), or when the open notional is zero.
  function leverageUtilization(positions, subaccount, marketsMap) {
    const equity = usableEquity(subaccount);
    if (equity === null) return null;
    const notionals = (positions || [])
      .filter(p => p && p.status === 'OPEN')
      .map(p => positionNotional(p, marketsMap));
    if (notionals.includes(null)) return null;
    const notional = notionals.reduce((s, n) => s + n, 0);
    return notional > 0 ? notional / equity : null;
  }

  // Distance from the oracle to the liquidation price, in percent of the
  // oracle, signed so that a positive value is room left before
  // liquidation: (O − L)/O for a LONG, (L − O)/O for a SHORT. Zero or
  // negative means the oracle is already at or past the liquidation price.
  function liquidationDistancePct(side, oracle, liq) {
    if (side === 'LONG') return ((oracle - liq) / oracle) * PERCENT;
    if (side === 'SHORT') return ((liq - oracle) / oracle) * PERCENT;
    return null;
  }

  // Per-row liquidation table data. Pure compute; the caller renders.
  // Notional and leverage use positionNotional (oracle only) so the
  // account-level card and per-row LEVERAGE column never diverge. The
  // oracle (0 without one), liquidation price and distance (null without
  // one) need an oracle price. `positions` is the account's position list,
  // passed on to crossMarginLiqPrice for the other positions' margin.
  // `liqState` (LIQUIDATION_STATE) says what `liq` is: a price only at
  // AT_PRICE, else null; at NO_PRICE_LIQUIDATES the distance is the full
  // fall to $0 (100%), at BELOW_MAINTENANCE it is null.
  function liquidationRow(position, subaccount, marketsMap, positions = []) {
    if (!position || !subaccount) return null;
    const size = Math.abs(parseFloat(position.size || 0));
    const entry = parseFloat(position.entryPrice || 0);
    const oracle = positionOraclePrice(position, marketsMap) || 0;
    const equity = usableEquity(subaccount);
    const notional = positionNotional(position, marketsMap);
    const lev = (equity !== null && notional !== null) ? notional / equity : null;
    const { liq: solved, state: liqState, missing } = crossMarginLiquidation(position, subaccount, marketsMap, positions);
    const distancePct = (oracle > 0 && solved !== null && isFinite(solved))
      ? liquidationDistancePct((position.side || '').toUpperCase(), oracle, solved)
      : null;
    const liq = liqState === LIQUIDATION_STATE.AT_PRICE ? solved : null;
    return { size, entry, oracle, notional, lev, liq, distancePct, liqState, missing };
  }

  window.RiskMetrics = {
    computeTimeWeightedReturnsFromHist,
    computeSharpe,
    computeSortino,
    computeAnnualizedFromReturns,
    hasCompleteAttribution,
    classifyClosed,
    payoffEmptyBucketReason,
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
    deeperDrawdownFirst,
    regainsPeak,
    drawdownSource,
    histPnlCurrentDrawdown,
    buildCumulativeTotalPnlSeries,
    historicalPnlRowGap,
    livePnlPoint,
    compoundReturns,
    CALMAR_DRAWDOWN_DECIMALS,
    NO_DRAWDOWN_REASON,
    historicalPnlYears,
    tradeReturnsOnEquity,
    perTradeRatios,
    marketPnL,
    profitLedger,
    wholeCents,
    quotientCents,
    exactSum,
    portionFeesTotal,
    netFundingTotal,
    netFundingGap,
    positionNetFunding,
    decimalNumberOf,
    NO_NET_FUNDING,
    feesTotal,
    feeGap,
    marketFees,
    computeRealizedFromFills,
    netSizeHistory,
    computeUnrealizedFromFills,
    equityAdjustedTotalPnl,
    profitReconciliation,
    attributeFillsToPositions,
    INCOMPLETE_CAUSE,
    oppositeSide,
    isOpenInFills,
    isFifoUsableFill,
    timestampMs,
    holdMs,
    holdTimeGap,
    closeTimeGap,
    byClosingOrder,
    entryTimeGap,
    activeChildSubaccounts,
    histPnlMonthly,
    histPnlMonthlyDrawdown,
    NO_MONTH_ROWS_REASON,
    timeWeightedReturnPoints,
    timeWeightedReturnsByMonth,
    timeWeightedReturnPointsByMonth,
    varSampleReturns,
    varSampleGap,
    chronologicalHistoricalPnl,
    VAR_MAX_INTERVAL_MULTIPLE,
    monthKeyUTC,
    monthLabel,
    assessMonthAdequacy,
    crossMarginLiqPrice,
    LIQUIDATION_STATE,
    LIQUIDATION_INPUT,
    NO_ORACLE_PRICE,
    EQUITY_UNAVAILABLE,
    positionOraclePrice,
    positionNotional,
    usableEquity,
    historicalVaR,
    leverageUtilization,
    liquidationRow
  };
})();


