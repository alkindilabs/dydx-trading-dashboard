// Overview tab: Strategy Edge phase diagram, Total Profit ledger, and the
// Max Drawdown / Current Drawdown cards. The Kelly criterion renderer
// (renderKelly) stays inline in processData() in index.html because it
// closes over processData's locals (the classifier output).
//
// Depends on: window.Format (formatCents, formatCurrency, CENTS,
// signClass, displaysAsLoss, drawdownAsDisplayed, formatDuration, fmtDateTimeUTC, esc,
// formatPercent, asDisplayed, PERCENT_DECIMALS, fmtRatio, RATIO_DECIMALS),
// window.AppDom (updateElement, updateMetric), window.AppConstants
// (PERCENT), and at call time window.RiskMetrics (NO_DRAWDOWN_REASON).

(function () {
  'use strict';

  const { PERCENT } = window.AppConstants;

  // --- Strategy Edge phase diagram ---

  const SE_PLOT = { x0: 80, x1: 600, y0: 40, y1: 540 };
  const SE_PF_MIN = 0.25;
  const SE_PF_MAX = 4.0;
  const SE_LOG_RANGE = Math.log(SE_PF_MAX) - Math.log(SE_PF_MIN);

  function seWrToX(wr) {
    const t = Math.max(0, Math.min(PERCENT, wr)) / PERCENT;
    return SE_PLOT.x0 + t * (SE_PLOT.x1 - SE_PLOT.x0);
  }
  function sePfToY(pf) {
    const clamped = Math.max(SE_PF_MIN, Math.min(SE_PF_MAX, pf));
    const t = (Math.log(SE_PF_MAX) - Math.log(clamped)) / SE_LOG_RANGE;
    return SE_PLOT.y0 + t * (SE_PLOT.y1 - SE_PLOT.y0);
  }
  function seIsoRRPath(rr) {
    // PF = WR × R:R / (1 − WR). Sample WR finely for smooth log-Y curve.
    const pts = [];
    for (let i = 0; i <= 200; i++) {
      const wr = 0.005 + (i / 200) * 0.99;
      const pf = (wr * rr) / (1 - wr);
      if (!isFinite(pf) || pf < SE_PF_MIN / 4 || pf > SE_PF_MAX * 4) continue;
      const x = seWrToX(wr * PERCENT);
      const y = sePfToY(pf);
      if (y < SE_PLOT.y0 - 4 || y > SE_PLOT.y1 + 4) continue;
      pts.push([x, y]);
    }
    if (!pts.length) return '';
    return 'M' + pts.map(p => p[0].toFixed(2) + ',' + p[1].toFixed(2)).join(' L');
  }
  // Gross wins equal gross losses: the average trade neither makes nor
  // loses money.
  const BREAK_EVEN_PROFIT_FACTOR = 1.0;
  // The archetype lines of the phase diagram: a win rate (percent) from
  // HIGH_WIN_RATE_PCT up wins often, one below LOW_WIN_RATE_PCT seldom;
  // a frequent winner is Excellent from EXCELLENT_MIN_PROFIT_FACTOR, a
  // seldom one Trend Following from TREND_FOLLOWING_MIN_PROFIT_FACTOR.
  const HIGH_WIN_RATE_PCT = 60;
  const LOW_WIN_RATE_PCT = 40;
  const EXCELLENT_MIN_PROFIT_FACTOR = 1.5;
  const TREND_FOLLOWING_MIN_PROFIT_FACTOR = 2.0;

  // unavailableReason: the classifier's incompleteReason ('' when its
  // inputs are complete), shown instead of the generic empty-data text.
  function seVerdict(wrPct, pf, unavailableReason) {
    if (unavailableReason) {
      return {
        name: 'Unavailable',
        cls:  'is-pending',
        desc: `${unavailableReason} — win rate and profit factor cannot be computed, so the phase diagram cannot place a verdict.`
      };
    }
    if (wrPct == null || pf == null) {
      return {
        name: 'Awaiting',
        cls:  'is-pending',
        desc: 'No decisive trades or no recorded losses — the phase diagram needs both to place a verdict.'
      };
    }
    if (wrPct >= HIGH_WIN_RATE_PCT && pf >= EXCELLENT_MIN_PROFIT_FACTOR) return {
      name: 'Excellent',
      cls:  'is-excellent',
      desc: 'High win frequency paired with payouts that comfortably exceed losses. Consistent, repeatable edge.'
    };
    if (wrPct >= HIGH_WIN_RATE_PCT && pf < BREAK_EVEN_PROFIT_FACTOR) return {
      name: 'Sniper Trap',
      cls:  'is-dangerous',
      desc: 'You win often, but rare losses are large enough to erase the cumulative gains. Profit factor below one means the strategy bleeds even with a high win rate.'
    };
    if (wrPct < LOW_WIN_RATE_PCT && pf >= TREND_FOLLOWING_MIN_PROFIT_FACTOR) return {
      name: 'Trend Following',
      cls:  'is-strong',
      desc: 'You lose more trades than you win — but when you win, the payouts dwarf the losses. Classic trend-follower or convex profile.'
    };
    if (wrPct < LOW_WIN_RATE_PCT && pf < BREAK_EVEN_PROFIT_FACTOR) return {
      name: 'Failing',
      cls:  'is-failing',
      desc: 'Both frequency and size are inadequate. The expected value per trade is negative; cutting losers faster or sharpening entries is the priority.'
    };
    return {
      name: 'Transitional',
      cls:  'is-pending',
      desc: transitionalDesc(pf)
    };
  }

  // A Transitional verdict's description by the profit factor as
  // displayed: profitable only above break-even, break-even at it.
  function transitionalDesc(pf) {
    if (pf > BREAK_EVEN_PROFIT_FACTOR) {
      return 'Profitable but in between archetypes — refine R:R or selectivity to land in Excellent or Trend-Following territory.';
    }
    if (pf === BREAK_EVEN_PROFIT_FACTOR) {
      return 'Break-even: gross wins and gross losses cancel (profit factor reads 1.00), so the average trade neither makes nor loses money.';
    }
    return 'Negative edge: gross losses exceed gross wins (profit factor below one), so the average trade loses money.';
  }

  // The verdict classifies the values as the readout shows them, so a
  // win rate that reads 60.0% is never placed below the 60% line, nor a
  // profit factor that reads 1.00 below one. The win rate reads through
  // Format.formatPercent like every win rate; the profit factor through
  // Format.fmtRatio like every profit factor (the Profit Factor card and
  // the Monthly column).
  const winRateAsDisplayed = (v) => window.Format.asDisplayed(v, window.Format.PERCENT_DECIMALS);
  const profitFactorAsDisplayed = (v) => window.Format.asDisplayed(v, window.Format.RATIO_DECIMALS);

  // winRatePct, profitFactor and payoff are classifyClosed's winRate,
  // profitFactor and payoff (null when undefined).
  function renderStrategyEdge(winRatePct, profitFactor, payoff, unavailableReason = '') {
    const svg = document.getElementById('strategyEdgeSvg');
    if (!svg) return;
    const { x0, x1, y0, y1 } = SE_PLOT;

    const xLowWinRate = seWrToX(LOW_WIN_RATE_PCT);
    const xHighWinRate = seWrToX(HIGH_WIN_RATE_PCT);
    const yBreakEven = sePfToY(BREAK_EVEN_PROFIT_FACTOR);
    const yExcellentPf = sePfToY(EXCELLENT_MIN_PROFIT_FACTOR);
    const yTrendPf = sePfToY(TREND_FOLLOWING_MIN_PROFIT_FACTOR);

    const ISO = [
      { rr: 0.5, label: '0.5 : 1', labelAtWR: 62 },
      { rr: 1.0, label: '1 : 1',   labelAtWR: 47 },
      { rr: 2.0, label: '2 : 1',   labelAtWR: 32 },
      { rr: 3.0, label: '3 : 1',   labelAtWR: 25 },
      { rr: 5.0, label: '5 : 1',   labelAtWR: 18 }
    ];

    const xTicks = [0, 20, 40, 60, 80, 100];
    const yTicks = [0.25, 0.5, 1.0, 1.5, 2.0, 3.0, 4.0];
    // '0.25', '0.50', then '1.0' … '4.0'.
    const PF_TICK_DECIMALS_BELOW_ONE = 2;
    const PF_TICK_DECIMALS = 1;

    const verdict = seVerdict(winRateAsDisplayed(winRatePct),
      profitFactorAsDisplayed(profitFactor), unavailableReason);

    const hasPoint = winRatePct != null && profitFactor != null;
    const markerX = hasPoint ? seWrToX(winRatePct) : null;
    const markerY = hasPoint ? sePfToY(profitFactor) : null;
    const markerOutOfRange = hasPoint && (profitFactor > SE_PF_MAX || profitFactor < SE_PF_MIN);

    const quadrants = [
      { x: x0,    y: y0,    w: xLowWinRate - x0,    h: yTrendPf - y0,    fill: 'rgba(215,172,96,0.07)' },
      { x: xHighWinRate, y: y0,    w: x1 - xHighWinRate,    h: yExcellentPf - y0,    fill: 'rgba(143,170,114,0.10)' },
      { x: xHighWinRate, y: yBreakEven, w: x1 - xHighWinRate,    h: y1 - yBreakEven,    fill: 'rgba(203,92,80,0.10)' },
      { x: x0,    y: yBreakEven, w: xLowWinRate - x0,    h: y1 - yBreakEven,    fill: 'rgba(120,108,95,0.10)' }
    ];

    const labels = [
      { x: (x0 + xLowWinRate) / 2, y: y0 + 44, name: 'Strong',    sub: 'Trend Following', fill: 'var(--gold)' },
      { x: (xHighWinRate + x1) / 2, y: y0 + 44, name: 'Excellent', sub: 'Consistent Edge', fill: 'var(--gain)' },
      { x: (xHighWinRate + x1) / 2, y: y1 - 32, name: 'Dangerous', sub: 'Sniper Trap',     fill: 'var(--loss)' },
      { x: (x0 + xLowWinRate) / 2, y: y1 - 32, name: 'Failing',   sub: 'No Edge',         fill: 'var(--ink-3)' }
    ];

    const esc = window.Format.esc;

    const quadFills = quadrants.map(q =>
      `<rect x="${q.x}" y="${q.y}" width="${q.w}" height="${q.h}" fill="${q.fill}"/>`
    ).join('');

    const frame = `<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" fill="none" stroke="var(--rule-strong)" stroke-width="1"/>`;

    const thresholds = `
      <line x1="${xLowWinRate}" y1="${y0}" x2="${xLowWinRate}" y2="${y1}" stroke="var(--rule)" stroke-width="1" stroke-dasharray="4 4"/>
      <line x1="${xHighWinRate}" y1="${y0}" x2="${xHighWinRate}" y2="${y1}" stroke="var(--rule)" stroke-width="1" stroke-dasharray="4 4"/>
      <line x1="${x0}" y1="${yBreakEven}" x2="${x1}" y2="${yBreakEven}" stroke="var(--rule-strong)" stroke-width="1"/>
      <line x1="${x0}" y1="${yExcellentPf}" x2="${x1}" y2="${yExcellentPf}" stroke="var(--rule)" stroke-width="1" stroke-dasharray="3 5"/>
      <line x1="${x0}" y1="${yTrendPf}" x2="${x1}" y2="${yTrendPf}" stroke="var(--rule)" stroke-width="1" stroke-dasharray="3 5"/>
    `;

    const ISO_MARKER_GUARD = 40;
    const isoCurves = ISO.map(({ rr, label, labelAtWR }) => {
      const d = seIsoRRPath(rr);
      if (!d) return '';
      const wrFrac = labelAtWR / PERCENT;
      const pfAt = (wrFrac * rr) / (1 - wrFrac);
      const lx = seWrToX(labelAtWR);
      let ly = sePfToY(pfAt) - 6;
      ly = Math.max(y0 + 12, Math.min(y1 - 6, ly));
      const labelWidth = label.length * 5.4 + 8;
      const curve = `<path d="${d}" fill="none" stroke="var(--gold)" stroke-width="0.7" stroke-opacity="0.5" stroke-dasharray="${rr === 1 ? '0' : '2 3'}"/>`;
      const collides = hasPoint && markerX != null && markerY != null
        && Math.hypot(lx - markerX, ly - markerY) < ISO_MARKER_GUARD;
      if (collides) return curve;
      return `
        ${curve}
        <rect x="${lx - labelWidth / 2}" y="${ly - 8}" width="${labelWidth}" height="11" fill="var(--paper-2)" opacity="0.85"/>
        <text class="se-iso-label" x="${lx}" y="${ly}" text-anchor="middle">${esc(label)}</text>
      `;
    }).join('');

    const xTicksSvg = xTicks.map(t => {
      const x = seWrToX(t);
      return `
        <line x1="${x}" y1="${y1}" x2="${x}" y2="${y1 + 5}" stroke="var(--rule-strong)" stroke-width="1"/>
        <text class="se-tick" x="${x}" y="${y1 + 18}" text-anchor="middle">${t}%</text>
      `;
    }).join('');
    const yTicksSvg = yTicks.map(t => {
      const y = sePfToY(t);
      return `
        <line x1="${x0 - 5}" y1="${y}" x2="${x0}" y2="${y}" stroke="var(--rule-strong)" stroke-width="1"/>
        <text class="se-tick" x="${x0 - 9}" y="${y + 3.5}" text-anchor="end">${window.Format.fmtFixed(t, t < 1 ? PF_TICK_DECIMALS_BELOW_ONE : PF_TICK_DECIMALS)}</text>
      `;
    }).join('');

    const axisLabels = `
      <text class="se-axis-label" x="${(x0 + x1) / 2}" y="${y1 + 38}" text-anchor="middle">Win rate</text>
      <text class="se-axis-label" transform="rotate(-90 ${x0 - 46} ${(y0 + y1) / 2})" x="${x0 - 46}" y="${(y0 + y1) / 2}" text-anchor="middle">Profit factor</text>
    `;

    const quadLabelsSvg = labels.map(l => `
      <text class="se-quadrant-label" x="${l.x}" y="${l.y}" text-anchor="middle" fill="${l.fill}">${esc(l.name)}</text>
      <text class="se-quadrant-sublabel" x="${l.x}" y="${l.y + 14}" text-anchor="middle">${esc(l.sub)}</text>
    `).join('');

    let markerSvg = '';
    if (hasPoint && markerX != null && markerY != null) {
      const mx = Math.max(x0, Math.min(x1, markerX));
      const my = Math.max(y0, Math.min(y1, markerY));
      markerSvg = `
        <line x1="${mx}" y1="${y1}" x2="${mx}" y2="${my}" stroke="var(--gold)" stroke-width="0.8" stroke-opacity="0.55" stroke-dasharray="2 3"/>
        <line x1="${x0}" y1="${my}" x2="${mx}" y2="${my}" stroke="var(--gold)" stroke-width="0.8" stroke-opacity="0.55" stroke-dasharray="2 3"/>
        <circle cx="${mx}" cy="${my}" r="11" fill="none" stroke="var(--gold)" stroke-width="1" opacity="0.55"/>
        <circle cx="${mx}" cy="${my}" r="5" fill="var(--gold)"/>
        <circle cx="${mx}" cy="${my}" r="5" fill="none" stroke="var(--paper)" stroke-width="1"/>
      `;
      if (markerOutOfRange) {
        markerSvg += `<text class="se-iso-label" x="${mx + 12}" y="${my - 10}">clamped</text>`;
      }
    }

    const eyebrow = `<text x="${x0}" y="${y0 - 16}" font-family="var(--ff-mono)" font-size="9.5" letter-spacing="0.22em" fill="var(--ink-4)" style="text-transform: uppercase;">Plot · WR × PF</text>`;

    svg.innerHTML = `
      ${quadFills}
      ${thresholds}
      ${isoCurves}
      ${frame}
      ${xTicksSvg}
      ${yTicksSvg}
      ${axisLabels}
      ${quadLabelsSvg}
      ${markerSvg}
      ${eyebrow}
    `;

    const nameEl = document.getElementById('seVerdictName');
    const descEl = document.getElementById('seVerdictDesc');
    if (nameEl) {
      nameEl.textContent = verdict.name;
      nameEl.className = 'se-verdict-name ' + verdict.cls;
    }
    if (descEl) descEl.textContent = verdict.desc;
    // A null value is unknown ('—') while the classifier's inputs are
    // incomplete, else undefined for an empty win or loss bucket ('N/A').
    const unavailable = unavailableReason ? '—' : 'N/A';
    const fmtPct = (v) => v == null ? unavailable : window.Format.formatPercent(v);
    const fmtPf  = (v) => v == null ? unavailable : window.Format.fmtRatio(v);
    const fmtRR = (v) => (v == null || !isFinite(v)) ? unavailable : window.Format.fmtPayoff(v);
    const wrOut = document.getElementById('seWinRateOut');
    const pfOut = document.getElementById('seProfitFactorOut');
    const rrOut = document.getElementById('seImpliedRR');
    if (wrOut) wrOut.textContent = fmtPct(winRatePct);
    if (pfOut) pfOut.textContent = fmtPf(profitFactor);
    if (rrOut) rrOut.textContent = fmtRR(payoff);
  }

  // --- Total Profit ledger ---

  // At cents (RiskMetrics.profitLedger), so the three cells add up to the
  // headline as displayed. FEES uses dYdX's positive-paid convention:
  // positive feesPaid means the user paid the venue. The cell renders the
  // signed cost so a positive feesPaid shows as a negative dollar amount
  // in red. A null component (its inputs failed to load) renders '—'.
  function renderTotalProfitBreakdown(trading, funding, feesPaid) {
    const F = window.Format;
    const paint = (id, v) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.textContent = v === null ? '—' : F.formatCents(v);
      el.className = `mono ${v === null ? '' : F.signClass(v, F.CENTS)}`.trim();
    };
    paint('totalPnLTrading', trading);
    paint('totalPnLFunding', funding);
    paint('totalPnLFees', feesPaid === null ? null : -feesPaid);
  }

  // --- Max Drawdown and Current Drawdown cards ---

  const isoDate = (ts) => (ts ? ts.slice(0, 10) : '—');

  // Current Drawdown at peak is good news, not a signed zero: the one
  // drawdown $0 shown in the profit colour.
  const AT_PEAK_TONE = 'profit';

  // The tooltips of the cards measured on the drawdown series, by the
  // series drawdownSource picked: on 'trade' they describe cumulative
  // closed-trade profit; on 'hist' they read the markup's own text, which
  // describes the totalPnl curve.
  const TRADE_PATH_TITLES = {
    maxDrawdownCard: 'Worst peak-to-trough $ excursion of cumulative closed-trade profit (fill-attributed, net of fees, excluding funding and unrealized profit), from 0 at the first close, in closing order. /historical-pnl is unavailable, so this is the closed-trade fallback, not the totalPnl curve: it cannot see unrealized peaks. A drawdown that rounds to $0 is no drawdown. Pair with Current Drawdown to see now-vs-worst, and Recovery Factor for the ratio of closed-trade profit to this number.',
    currentDrawdownCard: 'Current Drawdown = how far below the peak of cumulative closed-trade profit (fill-attributed, net of fees, excluding funding and unrealized profit) the account sits now. /historical-pnl is unavailable, so this is the closed-trade fallback, not the totalPnl curve or the Total Profit headline. $0 means at-or-above the prior peak. The time below peak runs to now, the same span as the ongoing Drawdown Periods row. Computed on the same closed-trade profit series as Max Drawdown.',
    recoveryFactorLabel: 'Recovery Factor = cumulative closed-trade profit now (fill-attributed, net of fees, excluding funding and unrealized profit) ÷ its max drawdown; N/A while the max drawdown rounds to $0. /historical-pnl is unavailable, so both come from the closed-trade fallback, not the Total Profit headline. Above 5 = strong recovery; above 1 = made back the worst DD; below 1 = haven\'t recovered the worst DD; ≤ 0 = lifetime loss. Numerator and denominator come from the SAME series.'
  };

  // On 'hist' without a live point (Total Profit unavailable) the series
  // ends at its last hourly row: the tooltips whose markup names the
  // headline as the latest value say so instead.
  const NO_LIVE_TITLES = {
    recoveryFactorLabel: 'Recovery Factor = lifetime profit at the last hourly totalPnl row of /historical-pnl ÷ max drawdown: the Total Profit headline is unavailable, so the totalPnl curve ends at that row (the Current Drawdown caption dates it). N/A while the max drawdown rounds to $0. Above 5 = strong recovery; above 1 = made back the worst DD; below 1 = haven\'t recovered the worst DD; ≤ 0 = lifetime loss. Numerator and denominator come from the SAME P&L series.'
  };

  function sourceTitle(id, source, hasLive) {
    if (source === 'trade') return TRADE_PATH_TITLES[id];
    return hasLive ? undefined : NO_LIVE_TITLES[id];
  }

  function renderSourceTitles(source, hasLive) {
    Object.keys(TRADE_PATH_TITLES).forEach(id => {
      const node = document.getElementById(id);
      if (!node) return;
      if (node.dataset.defaultTitle === undefined) node.dataset.defaultTitle = node.title;
      node.title = sourceTitle(id, source, hasLive) || node.dataset.defaultTitle;
    });
  }

  // The Current Drawdown caption on the closed-trade fallback opens by
  // naming its series, as the Max Drawdown caption does.
  const TRADE_PATH_CAPTION_PREFIX = 'Closed-trade profit · ';

  // tsd / cdd: the worst and the current drawdown on the series
  // RiskMetrics.drawdownSource picked (histPnlDrawdown /
  // histPnlCurrentDrawdown with the live point, or the trade-system
  // pair). opts: { source ('hist' | 'trade'), hasLive (the totalPnl
  // series ends at a live point), gap (why the series cannot be measured:
  // the trade path's incompleteReason, or /historical-pnl rows that do not
  // reach inception; '' otherwise), closedCount, seriesStart (the first
  // /historical-pnl row's createdAt, or null) }. With a gap both cards
  // read '—' with it. Max Drawdown is its caption's peak less its trough
  // as they display (Format.drawdownAsDisplayed), Current Drawdown the
  // displayed peak less the displayed current value. A drawdown that
  // displays as $0 (Format.displaysAsLoss) is no drawdown: Max Drawdown reads $0,
  // neutral, on either path once there is a series ('—' only without a
  // closed trade on the trade path); Current Drawdown reads $0 in the
  // profit colour, at peak. The Max and Current Drawdown and Recovery
  // Factor tooltips follow `source` and, on 'hist', `hasLive`
  // (renderSourceTitles), and on 'trade'
  // the Current Drawdown caption names closed-trade profit. The percent of
  // peak shows only beside a peak that displays as a gain at whole dollars.
  function renderDrawdownCards(tsd, cdd, opts) {
    const F = window.Format;
    const D = window.AppDom;
    const { source, hasLive, gap, closedCount, seriesStart } = opts;
    const seriesSince = seriesStart ? ` · series since ${isoDate(seriesStart)}` : '';
    renderSourceTitles(source, hasLive);
    const seriesName = source === 'trade' ? TRADE_PATH_CAPTION_PREFIX : '';

    if (gap) {
      ['maxDrawdown', 'currentDrawdown'].forEach(id => {
        D.updateMetric(id, '—');
        D.updateElement(`${id}Detail`, gap);
      });
      return;
    }

    const shownDrawdown = F.drawdownAsDisplayed(tsd.peakValue, tsd.troughValue);
    if (F.displaysAsLoss(shownDrawdown)) {
      D.updateMetric('maxDrawdown', F.formatCurrency(-shownDrawdown), 'loss');
      D.updateElement('maxDrawdownDetail', source === 'hist'
        ? `Peak ${F.formatCurrency(tsd.peakValue)} (${isoDate(tsd.peakAt)}) → trough ${F.formatCurrency(tsd.troughValue)} (${isoDate(tsd.troughAt)})${seriesSince}`
        : `Trade-system peak-to-trough · n=${tsd.n} closed`);
    } else if (source === 'hist' || closedCount > 0) {
      D.updateMetric('maxDrawdown', F.formatCurrency(0), F.signClass(0));
      D.updateElement('maxDrawdownDetail', `${window.RiskMetrics.NO_DRAWDOWN_REASON}${seriesSince}`);
    } else {
      D.updateMetric('maxDrawdown', '—');
      D.updateElement('maxDrawdownDetail', 'No closed trades');
    }

    // Without a live point the series ends at its last hourly row.
    const asOf = source === 'hist' && !hasLive && cdd.currentAt
      ? ` · as of ${F.fmtDateTimeUTC(cdd.currentAt)} UTC, last hourly row (Total Profit unavailable)`
      : '';
    const since = cdd.peakAt ? ` (since ${isoDate(cdd.peakAt)})` : '';
    const shownCurrent = F.drawdownAsDisplayed(cdd.peakValue, cdd.currentValue);
    if (!cdd.hasData) {
      D.updateMetric('currentDrawdown', '—');
      D.updateElement('currentDrawdownDetail', closedCount > 0 ? 'No equity series available' : 'No closed trades');
    } else if (!F.displaysAsLoss(shownCurrent)) {
      D.updateMetric('currentDrawdown', F.formatCurrency(0), AT_PEAK_TONE);
      D.updateElement('currentDrawdownDetail',
        seriesName + (cdd.peakAt ? `At peak (${isoDate(cdd.peakAt)})` : 'At peak') + asOf);
    } else {
      D.updateMetric('currentDrawdown', F.formatCurrency(-shownCurrent), 'loss');
      // The same span, in the same units, as the ongoing Drawdown
      // Periods row's DURATION.
      const below = cdd.peakAt && cdd.currentAt
        ? `${F.formatDuration(new Date(cdd.currentAt) - new Date(cdd.peakAt))} below peak`
        : 'below peak';
      const pctText = cdd.pctOfPeakProfit === null ? '' : ` · ${F.formatPercent(cdd.pctOfPeakProfit)} of peak`;
      D.updateElement('currentDrawdownDetail', `${seriesName}${below}${since}${pctText}${asOf}`);
    }
  }

  window.AppPanels = window.AppPanels || {};
  window.AppPanels.overview = { renderStrategyEdge, renderTotalProfitBreakdown, renderDrawdownCards };
})();
