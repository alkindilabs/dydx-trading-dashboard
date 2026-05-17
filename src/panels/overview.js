// Overview tab: Strategy Edge phase diagram + Total Profit ledger.
// The Kelly criterion sub-IIFE inside renderFromAllData still lives in
// the inline block — it has tight closure over the classifier output and
// will move when process-data is extracted in Phase 2's final PR.
//
// Depends on: window.Format (formatCurrency, esc).

(function () {
  'use strict';

  // --- Strategy Edge phase diagram ---

  const SE_VIEW = { w: 640, h: 600 };
  const SE_PLOT = { x0: 80, x1: 600, y0: 40, y1: 540 };
  const SE_PF_MIN = 0.25;
  const SE_PF_MAX = 4.0;
  const SE_LOG_RANGE = Math.log(SE_PF_MAX) - Math.log(SE_PF_MIN);

  function seWrToX(wr) {
    const t = Math.max(0, Math.min(100, wr)) / 100;
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
      const x = seWrToX(wr * 100);
      const y = sePfToY(pf);
      if (y < SE_PLOT.y0 - 4 || y > SE_PLOT.y1 + 4) continue;
      pts.push([x, y]);
    }
    if (!pts.length) return '';
    return 'M' + pts.map(p => p[0].toFixed(2) + ',' + p[1].toFixed(2)).join(' L');
  }
  function seVerdict(wrPct, pf) {
    if (wrPct == null || pf == null) {
      return {
        name: 'Awaiting',
        cls:  'is-pending',
        desc: 'No decisive trades or no recorded losses — the phase diagram needs both to place a verdict.'
      };
    }
    if (wrPct >= 60 && pf >= 1.5) return {
      name: 'Excellent',
      cls:  'is-excellent',
      desc: 'High win frequency paired with payouts that comfortably exceed losses. Consistent, repeatable edge.'
    };
    if (wrPct >= 60 && pf < 1.0) return {
      name: 'Sniper Trap',
      cls:  'is-dangerous',
      desc: 'You win often, but rare losses are large enough to erase the cumulative gains. Profit factor below one means the strategy bleeds even with a high win rate.'
    };
    if (wrPct < 40 && pf >= 2.0) return {
      name: 'Trend Following',
      cls:  'is-strong',
      desc: 'You lose more trades than you win — but when you win, the payouts dwarf the losses. Classic trend-follower or convex profile.'
    };
    if (wrPct < 40 && pf < 1.0) return {
      name: 'Failing',
      cls:  'is-failing',
      desc: 'Both frequency and size are inadequate. The expected value per trade is negative; cutting losers faster or sharpening entries is the priority.'
    };
    return {
      name: 'Transitional',
      cls:  'is-pending',
      desc: pf >= 1.0
        ? 'Profitable but in between archetypes — refine R:R or selectivity to land in Excellent or Trend-Following territory.'
        : 'Marginal edge; small adjustments to either win rate or average win-to-loss ratio flip the regime.'
    };
  }

  function renderStrategyEdge(winRatePct, profitFactor) {
    const svg = document.getElementById('strategyEdgeSvg');
    if (!svg) return;
    const { x0, x1, y0, y1 } = SE_PLOT;

    const xWR40 = seWrToX(40);
    const xWR60 = seWrToX(60);
    const yPF10 = sePfToY(1.0);
    const yPF15 = sePfToY(1.5);
    const yPF20 = sePfToY(2.0);

    const ISO = [
      { rr: 0.5, label: '0.5 : 1', labelAtWR: 62 },
      { rr: 1.0, label: '1 : 1',   labelAtWR: 47 },
      { rr: 2.0, label: '2 : 1',   labelAtWR: 32 },
      { rr: 3.0, label: '3 : 1',   labelAtWR: 25 },
      { rr: 5.0, label: '5 : 1',   labelAtWR: 18 }
    ];

    const xTicks = [0, 20, 40, 60, 80, 100];
    const yTicks = [0.25, 0.5, 1.0, 1.5, 2.0, 3.0, 4.0];

    const verdict = seVerdict(winRatePct, profitFactor);

    const hasPoint = winRatePct != null && profitFactor != null;
    const markerX = hasPoint ? seWrToX(winRatePct) : null;
    const markerY = hasPoint ? sePfToY(profitFactor) : null;
    const markerOutOfRange = hasPoint && (profitFactor > SE_PF_MAX || profitFactor < SE_PF_MIN);

    const quadrants = [
      { x: x0,    y: y0,    w: xWR40 - x0,    h: yPF20 - y0,    fill: 'rgba(215,172,96,0.07)' },
      { x: xWR60, y: y0,    w: x1 - xWR60,    h: yPF15 - y0,    fill: 'rgba(143,170,114,0.10)' },
      { x: xWR60, y: yPF10, w: x1 - xWR60,    h: y1 - yPF10,    fill: 'rgba(203,92,80,0.10)' },
      { x: x0,    y: yPF10, w: xWR40 - x0,    h: y1 - yPF10,    fill: 'rgba(120,108,95,0.10)' }
    ];

    const labels = [
      { x: (x0 + xWR40) / 2, y: y0 + 44, name: 'Strong',    sub: 'Trend Following', fill: 'var(--gold)' },
      { x: (xWR60 + x1) / 2, y: y0 + 44, name: 'Excellent', sub: 'Consistent Edge', fill: 'var(--gain)' },
      { x: (xWR60 + x1) / 2, y: y1 - 32, name: 'Dangerous', sub: 'Sniper Trap',     fill: 'var(--loss)' },
      { x: (x0 + xWR40) / 2, y: y1 - 32, name: 'Failing',   sub: 'No Edge',         fill: 'var(--ink-3)' }
    ];

    const esc = window.Format.esc;

    const quadFills = quadrants.map(q =>
      `<rect x="${q.x}" y="${q.y}" width="${q.w}" height="${q.h}" fill="${q.fill}"/>`
    ).join('');

    const frame = `<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" fill="none" stroke="var(--rule-strong)" stroke-width="1"/>`;

    const thresholds = `
      <line x1="${xWR40}" y1="${y0}" x2="${xWR40}" y2="${y1}" stroke="var(--rule)" stroke-width="1" stroke-dasharray="4 4"/>
      <line x1="${xWR60}" y1="${y0}" x2="${xWR60}" y2="${y1}" stroke="var(--rule)" stroke-width="1" stroke-dasharray="4 4"/>
      <line x1="${x0}" y1="${yPF10}" x2="${x1}" y2="${yPF10}" stroke="var(--rule-strong)" stroke-width="1"/>
      <line x1="${x0}" y1="${yPF15}" x2="${x1}" y2="${yPF15}" stroke="var(--rule)" stroke-width="1" stroke-dasharray="3 5"/>
      <line x1="${x0}" y1="${yPF20}" x2="${x1}" y2="${yPF20}" stroke="var(--rule)" stroke-width="1" stroke-dasharray="3 5"/>
    `;

    const ISO_MARKER_GUARD = 40;
    const isoCurves = ISO.map(({ rr, label, labelAtWR }) => {
      const d = seIsoRRPath(rr);
      if (!d) return '';
      const wrFrac = labelAtWR / 100;
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
        <text class="se-tick" x="${x0 - 9}" y="${y + 3.5}" text-anchor="end">${t.toFixed(t < 1 ? 2 : 1)}</text>
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
    const fmtPct = (v) => v == null ? '—' : `${v.toFixed(1)}%`;
    const fmtPf  = (v) => v == null ? '—' : v.toFixed(2);
    let rr = null;
    if (winRatePct != null && profitFactor != null && winRatePct > 0 && winRatePct < 100) {
      const wr = winRatePct / 100;
      rr = (profitFactor * (1 - wr)) / wr;
    }
    const fmtRR = (v) => (v == null || !isFinite(v)) ? '—' : `${v.toFixed(2)} : 1`;
    const wrOut = document.getElementById('seWinRateOut');
    const pfOut = document.getElementById('seProfitFactorOut');
    const rrOut = document.getElementById('seImpliedRR');
    if (wrOut) wrOut.textContent = fmtPct(winRatePct);
    if (pfOut) pfOut.textContent = fmtPf(profitFactor);
    if (rrOut) rrOut.textContent = fmtRR(rr);
  }

  // --- Total Profit ledger ---

  // FEES uses dYdX's positive-paid convention: positive feesPaid means
  // the user paid the venue. The cell renders the signed cost so a
  // positive feesPaid shows as a negative dollar amount in red.
  function renderTotalProfitBreakdown(trading, funding, feesPaid) {
    const formatCurrency = window.Format.formatCurrency;
    const fmt = (v) => formatCurrency(v);
    const sign = (v) => v > 0 ? 'profit' : (v < 0 ? 'loss' : 'zero');
    const t = document.getElementById('totalPnLTrading');
    const f = document.getElementById('totalPnLFunding');
    const feesEl = document.getElementById('totalPnLFees');
    if (t) {
      t.textContent = fmt(trading);
      t.className = `mono ${sign(trading)}`;
    }
    if (f) {
      f.textContent = fmt(funding);
      f.className = `mono ${sign(funding)}`;
    }
    if (feesEl) {
      const feesContribution = -feesPaid;
      feesEl.textContent = fmt(feesContribution);
      feesEl.className = `mono ${sign(feesContribution)}`;
    }
  }

  window.AppPanels = window.AppPanels || {};
  window.AppPanels.overview = { renderStrategyEdge, renderTotalProfitBreakdown };
})();
