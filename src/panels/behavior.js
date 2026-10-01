// Behavior tab: time-of-day analysis card, activity heatmap, and detected
// trading-pattern table. All three are bucketed by ENTRY (createdAt) so
// "best trading hour" reads as a statement about when the trader chose
// to enter, not when the position happened to close.
//
// Profit-based numbers (hold time of wins vs losses, best/worst hour,
// pattern win rate and average) come from the account-wide
// RiskMetrics.classifyClosed result processData passes in and the
// fill-attributed `profit`; while its incompleteReason is set (a closed
// position lacks complete fill data, or the CLOSED list failed to load)
// they render '—'.
//
// Depends on: window.AppConstants (TUNABLES, MS_PER_HOUR, HOURS_PER_DAY,
// DAYS_PER_WEEK, MINUTES_PER_HOUR),
// window.RiskMetrics (classifyClosed, peakNotional, hasCompleteAttribution), window.Format
// (formatCurrency, formatDuration, signClass), window.AppDom
// (updateElement, appendCell, tagCells).

(function () {
  'use strict';

  // Pattern verdicts: CONTINUE needs a positive average and at least
  // CONTINUE_WIN_RATE; AVOID a negative average below BREAK_EVEN_WIN_RATE.
  const BREAK_EVEN_WIN_RATE = 50;
  const CONTINUE_WIN_RATE = 55;

  // accountCls: RiskMetrics.classifyClosed over every position.
  function renderTimeAnalysis(positions, accountCls) {
    const C = window.AppConstants;
    const F = window.Format;
    const D = window.AppDom;

    const closed = positions.filter(p => p.status === 'CLOSED' && p.closedAt && p.createdAt);
    if (!closed.length) {
      ['avgHoldWin','avgHoldLoss','bestHour','worstHour','mostActiveDay']
        .forEach(id => D.updateElement(id, '—'));
      return;
    }
    const cls = window.RiskMetrics.classifyClosed(closed);
    const profitKnown = accountCls.incompleteReason === '';
    const holdMs = (p) => new Date(p.closedAt).getTime() - new Date(p.createdAt).getTime();
    const meanMs = (arr) => arr.reduce((s, p) => s + holdMs(p), 0) / arr.length;
    D.updateElement('avgHoldWin',  profitKnown && cls.winCount  ? F.formatDuration(meanMs(cls.wins))   : '—');
    D.updateElement('avgHoldLoss', profitKnown && cls.lossCount ? F.formatDuration(meanMs(cls.losses)) : '—');

    // Hour-of-day buckets weighted by fill-attributed profit (net of
    // fees). Min sample size guards against a single mega-loss owning the
    // "worst hour" slot.
    const hourPnl = new Array(C.HOURS_PER_DAY).fill(0);
    const hourCount = new Array(C.HOURS_PER_DAY).fill(0);
    if (profitKnown) closed.forEach(p => {
      const d = new Date(p.createdAt);
      const ms = d.getTime();
      if (!isFinite(ms)) return;
      const h = d.getUTCHours();
      hourPnl[h] += p.profit;
      hourCount[h] += 1;
    });
    let bestH = -1, worstH = -1, bestPnl = -Infinity, worstPnl = Infinity;
    for (let h = 0; h < C.HOURS_PER_DAY; h++) {
      if (hourCount[h] < C.TUNABLES.HOUR_MIN_SAMPLE) continue;
      const avg = hourPnl[h] / hourCount[h];
      if (avg > bestPnl)  { bestPnl  = avg; bestH  = h; }
      if (avg < worstPnl) { worstPnl = avg; worstH = h; }
    }
    const padHr = (h) => String(h).padStart(2, '0') + ':00 UTC';
    D.updateElement('bestHour',  bestH  >= 0 ? padHr(bestH)  : '—');
    D.updateElement('worstHour', worstH >= 0 ? padHr(worstH) : '—');

    const dayCount = new Array(C.DAYS_PER_WEEK).fill(0);
    closed.forEach(p => {
      const d = new Date(p.createdAt);
      if (!isFinite(d.getTime())) return;
      dayCount[d.getUTCDay()] += 1;
    });
    const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    let topDay = -1, topCount = 0;
    for (let d = 0; d < C.DAYS_PER_WEEK; d++) if (dayCount[d] > topCount) { topCount = dayCount[d]; topDay = d; }
    D.updateElement('mostActiveDay', topDay >= 0 ? dayNames[topDay] : '—');
  }

  // closedGap: '' when the CLOSED list loaded, else why it did not; the
  // grid then shows that reason instead of an empty-looking account.
  function renderActivityHeatmap(positions, closedGap = '') {
    const C = window.AppConstants;
    const container = document.getElementById('activityHeatmap');
    if (!container) return;
    container.innerHTML = '';
    if (closedGap) {
      const note = document.createElement('p');
      note.className = 'distribution-empty';
      note.style.gridColumn = '1 / -1';
      note.textContent = closedGap;
      container.appendChild(note);
      return;
    }
    const grid = Array.from({ length: C.DAYS_PER_WEEK }, () => new Array(C.HOURS_PER_DAY).fill(0));
    const closed = positions.filter(p => p.status === 'CLOSED' && p.createdAt);
    closed.forEach(p => {
      const d = new Date(p.createdAt);
      if (!isFinite(d.getTime())) return;
      grid[d.getUTCDay()][d.getUTCHours()] += 1;
    });
    const max = Math.max(1, ...grid.flat());
    const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    for (let day = 0; day < C.DAYS_PER_WEEK; day++) {
      for (let hour = 0; hour < C.HOURS_PER_DAY; hour++) {
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

  // accountCls: RiskMetrics.classifyClosed over every position.
  function renderDetectedPatterns(positions, accountCls) {
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

    // Peak notional from fills, the same size measure as tradeReturn and
    // the Position Size Distribution; null when it cannot be computed.
    const sizeUsd = (p) => window.RiskMetrics.peakNotional(p);
    const holdH = (p) => (new Date(p.closedAt) - new Date(p.createdAt)) / C.MS_PER_HOUR;

    // Pattern 1: Post-Loss Double Down — a loser followed within
    // DOUBLE_DOWN_GAP_HOURS in the same market by ≥DOUBLE_DOWN_SIZE_MULT × size.
    const doubleDown = [];
    for (let i = 0; i < closed.length - 1; i++) {
      const cur = closed[i], nxt = closed[i + 1];
      if (cur.market !== nxt.market) continue;
      if (!(window.RiskMetrics.hasCompleteAttribution(cur) && cur.profit < 0)) continue;
      const gapH = (new Date(nxt.createdAt) - new Date(cur.closedAt)) / C.MS_PER_HOUR;
      if (gapH < 0 || gapH > C.TUNABLES.DOUBLE_DOWN_GAP_HOURS) continue;
      const curSize = sizeUsd(cur), nxtSize = sizeUsd(nxt);
      if (curSize !== null && nxtSize !== null
          && nxtSize >= C.TUNABLES.DOUBLE_DOWN_SIZE_MULT * curSize) doubleDown.push(nxt);
    }
    const trend = closed.filter(p => holdH(p) > C.TUNABLES.TREND_HOLD_HOURS);
    const flips = closed.filter(p => holdH(p) < C.TUNABLES.FLIP_HOLD_HOURS);

    // Win rate and average are the classifier's (decisive trades only).
    // All-or-nothing across the account: the double-down detector can
    // only see complete positions, so any incomplete one blanks every row.
    const profitKnown = accountCls.incompleteReason === '';
    const summarize = (label, set, recommend) => {
      const n = set.length;
      if (n === 0) return null;
      const setCls = window.RiskMetrics.classifyClosed(set);
      const wr = profitKnown ? setCls.winRate : null;
      const avg = profitKnown ? setCls.expectancy : null;
      let rec, recCls;
      if (wr === null || avg === null) {
        rec = '—'; recCls = '';
      } else if (typeof recommend === 'function') {
        const r = recommend(wr, avg, n);
        rec = r.label; recCls = r.cls;
      } else {
        rec = '—'; recCls = '';
      }
      return { label, n, wr, avg, rec, recCls };
    };
    const recommendByEdge = (wr, avg, n) => {
      if (n < C.TUNABLES.PATTERN_MIN_N) return { label: 'REVIEW (low n)', cls: 'warning' };
      if (avg > 0 && wr >= CONTINUE_WIN_RATE)  return { label: 'CONTINUE', cls: 'profit' };
      if (avg < 0 && wr < BREAK_EVEN_WIN_RATE) return { label: 'AVOID',    cls: 'loss' };
      return { label: 'REVIEW', cls: 'warning' };
    };
    const rows = [
      summarize(`Post-Loss Double Down (same market, ≤${C.TUNABLES.DOUBLE_DOWN_GAP_HOURS}h, ≥${C.TUNABLES.DOUBLE_DOWN_SIZE_MULT}×)`, doubleDown, recommendByEdge),
      summarize(`Trend Following (>${C.TUNABLES.TREND_HOLD_HOURS}h hold)`, trend, recommendByEdge),
      summarize(`Quick Flip (<${Math.round(C.TUNABLES.FLIP_HOLD_HOURS * C.MINUTES_PER_HOUR)}m hold)`, flips, recommendByEdge)
    ].filter(Boolean);
    rows.forEach(r => {
      const tr = document.createElement('tr');
      D.appendCell(tr, r.label);
      D.appendCell(tr, String(r.n), ['mono']);
      D.appendCell(tr, r.wr === null ? '—' : r.wr.toFixed(1) + '%',
        ['mono', r.wr === null ? '' : (r.wr >= BREAK_EVEN_WIN_RATE ? 'profit' : 'loss')]);
      D.appendCell(tr, r.avg === null ? '—' : F.formatCurrency(r.avg), ['mono', F.signClass(r.avg)]);
      const recTd = D.appendCell(tr, r.rec);
      recTd.style.color = r.recCls === 'warning' ? 'var(--warn)'
        : r.recCls === 'profit' ? 'var(--gain)'
        : r.recCls === 'loss' ? 'var(--loss)'
        : 'var(--ink-3)';
      body.appendChild(tr);
    });
    D.tagCells('patternsBody');
  }

  window.AppPanels = window.AppPanels || {};
  window.AppPanels.behavior = { renderTimeAnalysis, renderActivityHeatmap, renderDetectedPatterns };
})();
