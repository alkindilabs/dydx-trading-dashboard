// Behavior tab: time-of-day analysis card, activity heatmap, and detected
// trading-pattern table. All three are bucketed by ENTRY (createdAt) so
// "best trading hour" reads as a statement about when the trader chose
// to enter, not when the position happened to close.
//
// Depends on: window.AppConstants (TUNABLES, MS_PER_MIN, MS_PER_HOUR),
// window.Format (formatCurrency), window.AppDom (updateElement,
// appendCell, tagCells).

(function () {
  'use strict';

  function renderTimeAnalysis(positions) {
    const C = window.AppConstants;
    const D = window.AppDom;

    const closed = positions.filter(p => p.status === 'CLOSED' && p.closedAt && p.createdAt);
    if (!closed.length) {
      ['avgHoldWin','avgHoldLoss','bestHour','worstHour','mostActiveDay']
        .forEach(id => D.updateElement(id, '—'));
      return;
    }
    const holdMs = (p) => new Date(p.closedAt).getTime() - new Date(p.createdAt).getTime();
    const fmtDur = (ms) => {
      if (!isFinite(ms) || ms <= 0) return '—';
      const totalMin = Math.round(ms / C.MS_PER_MIN);
      const h = Math.floor(totalMin / 60);
      const m = totalMin % 60;
      return h > 0 ? `${h}h ${m}m` : `${m}m`;
    };
    const winsArr = closed.filter(p => parseFloat(p.realizedPnl || 0) > 0);
    const lossArr = closed.filter(p => parseFloat(p.realizedPnl || 0) < 0);
    const meanMs = (arr) => arr.length ? arr.reduce((s, p) => s + holdMs(p), 0) / arr.length : NaN;
    D.updateElement('avgHoldWin',  winsArr.length ? fmtDur(meanMs(winsArr)) : '—');
    D.updateElement('avgHoldLoss', lossArr.length ? fmtDur(meanMs(lossArr)) : '—');

    // Hour-of-day buckets weighted by realized P&L. Min sample size
    // guards against a single mega-loss owning the "worst hour" slot.
    const hourPnl = new Array(24).fill(0);
    const hourCount = new Array(24).fill(0);
    closed.forEach(p => {
      const d = new Date(p.createdAt);
      const ms = d.getTime();
      if (!isFinite(ms)) return;
      const h = d.getUTCHours();
      if (!Number.isInteger(h) || h < 0 || h > 23) return;
      hourPnl[h] += parseFloat(p.realizedPnl || 0);
      hourCount[h] += 1;
    });
    let bestH = -1, worstH = -1, bestPnl = -Infinity, worstPnl = Infinity;
    for (let h = 0; h < 24; h++) {
      if (hourCount[h] < C.TUNABLES.HOUR_MIN_SAMPLE) continue;
      const avg = hourPnl[h] / hourCount[h];
      if (avg > bestPnl)  { bestPnl  = avg; bestH  = h; }
      if (avg < worstPnl) { worstPnl = avg; worstH = h; }
    }
    const padHr = (h) => String(h).padStart(2, '0') + ':00 UTC';
    D.updateElement('bestHour',  bestH  >= 0 ? padHr(bestH)  : '—');
    D.updateElement('worstHour', worstH >= 0 ? padHr(worstH) : '—');

    const dayCount = new Array(7).fill(0);
    closed.forEach(p => {
      const d = new Date(p.createdAt);
      if (!isFinite(d.getTime())) return;
      dayCount[d.getUTCDay()] += 1;
    });
    const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    let topDay = -1, topCount = 0;
    for (let d = 0; d < 7; d++) if (dayCount[d] > topCount) { topCount = dayCount[d]; topDay = d; }
    D.updateElement('mostActiveDay', topDay >= 0 ? dayNames[topDay] : '—');
  }

  function renderActivityHeatmap(positions) {
    const container = document.getElementById('activityHeatmap');
    if (!container) return;
    container.innerHTML = '';
    const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
    const closed = positions.filter(p => p.status === 'CLOSED' && p.createdAt);
    closed.forEach(p => {
      const d = new Date(p.createdAt);
      if (!isFinite(d.getTime())) return;
      grid[d.getUTCDay()][d.getUTCHours()] += 1;
    });
    const max = Math.max(1, ...grid.flat());
    const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    for (let day = 0; day < 7; day++) {
      for (let hour = 0; hour < 24; hour++) {
        const cell = document.createElement('div');
        cell.className = 'heatmap-cell';
        const count = grid[day][hour];
        const intensity = count / max;
        const alpha = count === 0 ? 0.06 : (0.18 + 0.55 * intensity);
        cell.style.backgroundColor = `rgba(215,172,96,${alpha.toFixed(3)})`;
        cell.title = `${dayNames[day]} ${String(hour).padStart(2,'0')}:00 UTC — ${count} entr${count === 1 ? 'y' : 'ies'}`;
        container.appendChild(cell);
      }
    }
  }

  function renderDetectedPatterns(positions) {
    const C = window.AppConstants;
    const F = window.Format;
    const D = window.AppDom;

    const body = document.getElementById('patternsBody');
    if (!body) return;
    body.innerHTML = '';
    const closed = positions
      .filter(p => p.status === 'CLOSED' && p.closedAt && p.createdAt)
      .sort((a, b) => new Date(a.closedAt) - new Date(b.closedAt));
    if (!closed.length) return;

    const pnl = (p) => parseFloat(p.realizedPnl || 0);
    const sizeUsd = (p) => Math.abs(parseFloat(p.maxSize || p.sumOpen || p.size || 0)) * parseFloat(p.entryPrice || 0);
    const holdH = (p) => (new Date(p.closedAt) - new Date(p.createdAt)) / C.MS_PER_HOUR;

    // Pattern 1: Post-Loss Double Down — a loser followed within
    // DOUBLE_DOWN_GAP_HOURS in the same market by ≥DOUBLE_DOWN_SIZE_MULT × size.
    const doubleDown = [];
    for (let i = 0; i < closed.length - 1; i++) {
      const cur = closed[i], nxt = closed[i + 1];
      if (cur.market !== nxt.market) continue;
      if (pnl(cur) >= 0) continue;
      const gapH = (new Date(nxt.createdAt) - new Date(cur.closedAt)) / C.MS_PER_HOUR;
      if (gapH < 0 || gapH > C.TUNABLES.DOUBLE_DOWN_GAP_HOURS) continue;
      const curSize = sizeUsd(cur), nxtSize = sizeUsd(nxt);
      if (curSize > 0 && nxtSize >= C.TUNABLES.DOUBLE_DOWN_SIZE_MULT * curSize) doubleDown.push(nxt);
    }
    const trend = closed.filter(p => holdH(p) > C.TUNABLES.TREND_HOLD_HOURS);
    const flips = closed.filter(p => holdH(p) < C.TUNABLES.FLIP_HOLD_HOURS);

    const summarize = (label, set, recommend) => {
      const n = set.length;
      if (n === 0) return null;
      const wins = set.filter(p => pnl(p) > 0).length;
      const wr = (wins / n) * 100;
      const avg = set.reduce((s, p) => s + pnl(p), 0) / n;
      let rec, recCls;
      if (typeof recommend === 'function') {
        const r = recommend(wr, avg, n);
        rec = r.label; recCls = r.cls;
      } else {
        rec = '—'; recCls = '';
      }
      return { label, n, wr, avg, rec, recCls };
    };
    const recommendByEdge = (wr, avg, n) => {
      if (n < C.TUNABLES.PATTERN_MIN_N) return { label: 'REVIEW (low n)', cls: 'warning' };
      if (avg > 0 && wr >= 55) return { label: 'CONTINUE', cls: 'profit' };
      if (avg < 0 && wr < 50)  return { label: 'AVOID',    cls: 'loss' };
      return { label: 'REVIEW', cls: 'warning' };
    };
    const rows = [
      summarize(`Post-Loss Double Down (same market, ≤${C.TUNABLES.DOUBLE_DOWN_GAP_HOURS}h, ≥${C.TUNABLES.DOUBLE_DOWN_SIZE_MULT}×)`, doubleDown, recommendByEdge),
      summarize(`Trend Following (>${C.TUNABLES.TREND_HOLD_HOURS}h hold)`, trend, recommendByEdge),
      summarize(`Quick Flip (<${Math.round(C.TUNABLES.FLIP_HOLD_HOURS * 60)}m hold)`, flips, recommendByEdge)
    ].filter(Boolean);
    rows.forEach(r => {
      const tr = document.createElement('tr');
      D.appendCell(tr, r.label);
      D.appendCell(tr, String(r.n), ['mono']);
      D.appendCell(tr, r.wr.toFixed(1) + '%', ['mono', r.wr >= 50 ? 'profit' : 'loss']);
      D.appendCell(tr, F.formatCurrency(r.avg), ['mono', r.avg >= 0 ? 'profit' : 'loss']);
      const recTd = D.appendCell(tr, r.rec);
      recTd.style.color = r.recCls === 'warning' ? 'var(--warn)'
        : r.recCls === 'profit' ? 'var(--gain)'
        : r.recCls === 'loss' ? 'var(--loss)'
        : 'var(--ink-3)';
      body.appendChild(tr);
    });
    D.tagCells('patternsBody');
  }

  function render(positions) {
    renderTimeAnalysis(positions);
    renderActivityHeatmap(positions);
    renderDetectedPatterns(positions);
  }

  window.AppPanels = window.AppPanels || {};
  window.AppPanels.behavior = { render, renderTimeAnalysis, renderActivityHeatmap, renderDetectedPatterns };
})();
