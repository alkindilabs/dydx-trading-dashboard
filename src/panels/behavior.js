// Behavior tab: time-of-day analysis card, activity heatmap, and detected
// trading-pattern table. All three are bucketed by ENTRY (createdAt) so
// "best trading hour" reads as a statement about when the trader chose
// to enter, not when the position happened to close. The heatmap and
// Most Active Day count every position's entry once, the OPEN one
// included, and read '—' with the entries gap while an entry is unknown
// (a list failed, or a position has no valid createdAt:
// RiskMetrics.entryTimeGap in processData).
// Hold-time figures (RiskMetrics.holdMs) read '—' with the reason while
// the closed-trade list is short or a closed position has no hold window.
//
// Profit-based numbers (hold time of wins vs losses, best/worst hour,
// pattern win rate and expectancy) come from the account-wide
// RiskMetrics.classifyClosed result processData passes in and the
// fill-attributed `profit`; while its incompleteReason is set (a closed
// position lacks complete fill data, or the CLOSED list failed to load)
// they render '—' with that reason on hover, and an empty bucket (no
// wins, no losses, no hour with enough trades) reads 'N/A'.
//
// Depends on: window.AppConstants (TUNABLES, MS_PER_HOUR, HOURS_PER_DAY,
// DAYS_PER_WEEK, MINUTES_PER_HOUR),
// window.RiskMetrics (classifyClosed, peakNotional, hasCompleteAttribution,
// timestampMs, holdMs, holdTimeGap, exactSum, wholeCents, byClosingOrder), window.Format
// (formatCurrency, formatDuration, displayedDurationMs, signClass,
// formatPercent, asDisplayed, PERCENT_DECIMALS, breakevenVerdict),
// window.AppDom (appendCell, tagCells).

(function () {
  'use strict';

  // Pattern verdicts, on the win rate and expectancy as displayed:
  // CONTINUE needs a positive expectancy and a win rate of at least
  // CONTINUE_MIN_WIN_RATE; AVOID a negative expectancy and a win rate
  // below AVOID_BELOW_WIN_RATE.
  const CONTINUE_MIN_WIN_RATE = 55;
  const AVOID_BELOW_WIN_RATE = 50;

  // Why a pattern set's ratios are N/A: no closed win or loss to judge.
  const EMPTY_BUCKET_REASON = 'No closed winning or losing trade';

  // The Quick Flip hold limit in its label ('<15m hold').
  const WHOLE_MINUTES = 0;

  // Text and hover reason of a Time Analysis cell ('' clears the reason).
  function setTimeCell(id, text, reason = '') {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.title = reason;
  }

  function setLabelRule(id, rule) {
    const label = document.getElementById(id);
    if (label) label.title = rule;
  }

  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const DAY_ABBREVIATION_LENGTH = 3;

  // Every position's entry, OPEN included, as a Date: the population
  // the heatmap and Most Active Day both count.
  function entryDates(positions) {
    return positions
      .map(p => window.RiskMetrics.timestampMs(p.createdAt))
      .filter(ms => ms !== null)
      .map(ms => new Date(ms));
  }

  // The UTC weekday(s) with the most entries, every tied day named.
  function renderMostActiveDay(positions, entriesGap) {
    if (entriesGap) {
      setTimeCell('mostActiveDay', '—', entriesGap);
      return;
    }
    const dayCount = new Array(window.AppConstants.DAYS_PER_WEEK).fill(0);
    entryDates(positions).forEach(d => { dayCount[d.getUTCDay()] += 1; });
    const topCount = Math.max(...dayCount);
    if (topCount === 0) {
      setTimeCell('mostActiveDay', '—', 'No position entries');
      return;
    }
    const topDays = DAY_NAMES.filter((_, d) => dayCount[d] === topCount);
    const entries = `${topCount} entr${topCount === 1 ? 'y' : 'ies'}`;
    setTimeCell('mostActiveDay', topDays.join(' / '),
      `${topDays.length > 1 ? `${entries} each` : entries} (UTC entry day)`);
  }

  // accountCls: RiskMetrics.classifyClosed over every position.
  // entriesGap: '' when every entry is known, else why not (as for the
  // heatmap); Most Active Day then reads '—' with it.
  function renderTimeAnalysis(positions, accountCls, entriesGap = '') {
    const C = window.AppConstants;
    const F = window.Format;
    const RM = window.RiskMetrics;

    const hourRule = (extreme) => `Entry hour (UTC) whose closed trades have the ${extreme} mean `
      + `fill-attributed profit (net of fees, excluding funding), among hours with `
      + `≥${C.TUNABLES.HOUR_MIN_SAMPLE} trades; every hour tied at that mean is named`;
    setLabelRule('bestHourLabel', `${hourRule('highest')}.`);
    setLabelRule('worstHourLabel', `${hourRule('lowest')}; — when that would be the best hour.`);

    renderMostActiveDay(positions, entriesGap);

    // A profit-based cell reads '—' with `gap` (the classifier's reason
    // while its inputs are incomplete), 'N/A' with `emptyReason` for an
    // empty bucket, else `text` with `reason` on hover.
    const profitReason = accountCls.incompleteReason;
    const setProfitCell = (id, text, emptyReason, { gap = profitReason, reason = '' } = {}) => {
      if (gap) setTimeCell(id, '—', gap);
      else if (text === null) setTimeCell(id, 'N/A', emptyReason);
      else setTimeCell(id, text, reason);
    };
    const closed = positions.filter(p => p.status === 'CLOSED');
    if (!closed.length) {
      ['avgHoldWin','avgHoldLoss','bestHour','worstHour']
        .forEach(id => setProfitCell(id, null, 'No closed positions'));
      return;
    }
    const cls = RM.classifyClosed(closed);
    const holdGap = profitReason || RM.holdTimeGap(closed);
    const meanMs = (arr) => arr.reduce((s, p) => s + RM.holdMs(p), 0) / arr.length;
    setProfitCell('avgHoldWin', cls.winCount ? F.formatDuration(meanMs(cls.wins)) : null, 'No winning trades',
      { gap: holdGap });
    setProfitCell('avgHoldLoss', cls.lossCount ? F.formatDuration(meanMs(cls.losses)) : null, 'No losing trades',
      { gap: holdGap });

    // Mean fill-attributed profit (net of fees) per entry hour, over hours
    // with at least HOUR_MIN_SAMPLE trades, as whole cents: each hour's
    // profits summed exactly (RiskMetrics.exactSum) and the mean rounded to
    // cents once from the exact quotient (RiskMetrics.quotientCents), never
    // from a float mean. The extremes, the ties and worstIsBest all compare
    // these, so float residue never splits two equal means.
    const hourProfits = Array.from({ length: C.HOURS_PER_DAY }, () => []);
    if (!profitReason) closed.forEach(p => {
      const entryMs = RM.timestampMs(p.createdAt);
      if (entryMs === null) return;
      hourProfits[new Date(entryMs).getUTCHours()].push(p.profit);
    });
    const hourMeans = [];
    hourProfits.forEach((profits, h) => {
      if (profits.length < C.TUNABLES.HOUR_MIN_SAMPLE) return;
      hourMeans.push({ hour: h, mean: RM.quotientCents(RM.exactSum(profits), profits.length) });
    });
    const means = hourMeans.map(m => m.mean);
    const bestMean = Math.max(...means), worstMean = Math.min(...means);
    // Every qualifying hour at `mean`, joined ('09:00 / 14:00 UTC'), with
    // the tie on hover; null when no hour qualifies.
    const extremeHours = (mean, extreme) => {
      const hours = hourMeans.filter(m => m.mean === mean)
        .map(m => String(m.hour).padStart(2, '0') + ':00');
      if (!hours.length) return { text: null, reason: '' };
      return {
        text: `${hours.join(' / ')} UTC`,
        reason: hours.length > 1 ? `${hours.length} entry hours tie at the ${extreme} mean profit` : '',
      };
    };
    const thinHours = `No entry hour has ≥${C.TUNABLES.HOUR_MIN_SAMPLE} closed trades`;
    const best = extremeHours(bestMean, 'highest');
    setProfitCell('bestHour', best.text, thinHours, { reason: best.reason });
    const worstIsBest = !profitReason && hourMeans.length > 0 && worstMean === bestMean;
    if (worstIsBest) {
      setTimeCell('worstHour', '—', hourMeans.length === 1
        ? `Only one entry hour has ≥${C.TUNABLES.HOUR_MIN_SAMPLE} closed trades`
        : 'Every qualifying entry hour has the same mean profit');
    } else {
      const worst = extremeHours(worstMean, 'lowest');
      setProfitCell('worstHour', worst.text, thinHours, { reason: worst.reason });
    }
  }

  // entriesGap: '' when every entry is known, else why not (the OPEN or
  // CLOSED list failed, the fills hold a closed trade no listed position
  // owns, or a position has no valid entry time); the grid then shows
  // that reason instead of a count that leaves entries out.
  function renderActivityHeatmap(positions, entriesGap = '') {
    const C = window.AppConstants;
    const container = document.getElementById('activityHeatmap');
    if (!container) return;
    container.innerHTML = '';
    if (entriesGap) {
      const note = document.createElement('p');
      note.className = 'distribution-empty';
      note.style.gridColumn = '1 / -1';
      note.textContent = entriesGap;
      container.appendChild(note);
      return;
    }
    const grid = Array.from({ length: C.DAYS_PER_WEEK }, () => new Array(C.HOURS_PER_DAY).fill(0));
    entryDates(positions).forEach(d => { grid[d.getUTCDay()][d.getUTCHours()] += 1; });
    const max = Math.max(1, ...grid.flat());
    const dayNames = DAY_NAMES.map(name => name.slice(0, DAY_ABBREVIATION_LENGTH));
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

  // A position the loser's own reversing fill opened: the loser closed by
  // a flip and the next position in its market was opened by one.
  function openedByOwnReversal(loser, successor) {
    return loser.closedByFlip === true && successor.openedByFlip === true;
  }

  // Post-Loss Double Down: each complete CLOSED loser paired with the next
  // position in its market by entry (OPEN included, the loser's own
  // reversal skipped) when that one is on the same side, entered within
  // DOUBLE_DOWN_GAP_HOURS of the loser's close at ≥DOUBLE_DOWN_SIZE_MULT ×
  // its peak notional, both compared as the decimals they stand for
  // (Format.asDecimal), so exactly that multiple counts whatever binary
  // noise the products carry. Positions entered in one millisecond are taken in
  // closing order (RiskMetrics.byClosingOrder(fills): by close, closes in one
  // millisecond by their closing fills' chain order, OPEN last), as
  // attributeFillsToPositions orders them, so a position reversed at that
  // instant precedes the one its reversal opened, whatever order the
  // indexer listed them in. Returns the re-entries.
  function postLossDoubleDowns(positions, fills) {
    const C = window.AppConstants;
    const F = window.Format;
    const RM = window.RiskMetrics;
    const byMarket = new Map();
    positions.forEach(p => {
      const entryMs = RM.timestampMs(p.createdAt);
      if (entryMs === null) return;
      if (!byMarket.has(p.market)) byMarket.set(p.market, []);
      byMarket.get(p.market).push({ p, entryMs });
    });
    const inClosingOrder = RM.byClosingOrder(fills);
    const doubleDowns = [];
    byMarket.forEach(entries => {
      const inEntryOrder = entries.sort((a, b) => a.entryMs - b.entryMs || inClosingOrder(a.p, b.p)).map(e => e.p);
      inEntryOrder.forEach((loser, i) => {
        const closeMs = RM.timestampMs(loser.closedAt);
        if (loser.status !== 'CLOSED' || closeMs === null) return;
        if (!(RM.hasCompleteAttribution(loser) && loser.profit < 0)) return;
        let successor = inEntryOrder[i + 1];
        if (successor && openedByOwnReversal(loser, successor)) successor = inEntryOrder[i + 2];
        if (!successor || successor.side !== loser.side) return;
        const gapH = (RM.timestampMs(successor.createdAt) - closeMs) / C.MS_PER_HOUR;
        if (gapH < 0 || gapH > C.TUNABLES.DOUBLE_DOWN_GAP_HOURS) return;
        const loserSize = RM.peakNotional(loser), successorSize = RM.peakNotional(successor);
        if (loserSize !== null && successorSize !== null
            && F.asDecimal(successorSize) >= F.asDecimal(C.TUNABLES.DOUBLE_DOWN_SIZE_MULT * F.asDecimal(loserSize))) {
          doubleDowns.push(successor);
        }
      });
    });
    return doubleDowns;
  }

  // Why the double-down count is unknown ('' when it is known): the
  // detector can pair any position, OPEN included, so it needs every one's
  // profit and peak notional (the classifier's reason for a CLOSED one, an
  // OPEN one's own incompleteCause), every entry (entriesGap) and every
  // CLOSED one's close (RiskMetrics.holdTimeGap). A count over the rest
  // would be a lower bound.
  function doubleDownCountGap(positions, profitReason, entriesGap) {
    const RM = window.RiskMetrics;
    if (profitReason || entriesGap) return profitReason || entriesGap;
    const holdGap = RM.holdTimeGap(positions);
    if (holdGap) return holdGap;
    const incompleteOpen = positions.filter(p => p.status !== 'CLOSED' && !RM.hasCompleteAttribution(p));
    if (!incompleteOpen.length) return '';
    const n = incompleteOpen.length;
    const cause = incompleteOpen[0].incompleteCause;
    return `${n} open position${n === 1 ? '' : 's'} missing fill data${cause ? ` (${cause})` : ''}`;
  }

  // accountCls: RiskMetrics.classifyClosed over every position.
  // closedTradesGap: '' when every closed trade is listed, else why not
  // (the CLOSED list failed, or the fills hold a closed trade no listed
  // position owns). entriesGap: as for the heatmap, '' when every entry,
  // OPEN included, is known. fills: the fetched fills, whose chain order
  // breaks ties between closes in one millisecond.
  function renderDetectedPatterns(positions, accountCls, closedTradesGap = '', entriesGap = '', fills = []) {
    const C = window.AppConstants;
    const F = window.Format;
    const D = window.AppDom;
    const RM = window.RiskMetrics;

    const body = document.getElementById('patternsBody');
    if (!body) return;
    body.innerHTML = '';
    const profitReason = accountCls.incompleteReason;
    setLabelRule('patternVerdictLabel',
      `CONTINUE: positive expectancy and a win rate of at least ${CONTINUE_MIN_WIN_RATE}%. `
      + `AVOID: negative expectancy and a win rate below ${AVOID_BELOW_WIN_RATE}%. `
      + `REVIEW otherwise, or REVIEW (low n) with fewer than ${C.TUNABLES.PATTERN_MIN_N} decisive closed trades `
      + `(the wins and losses the win rate and expectancy are measured on). `
      + `Win rate and expectancy are compared as displayed.`);

    // A hold-time count over a short list, or one leaving out a closed
    // position without a hold window, is a lower bound: unknown instead.
    // Each hold is bucketed as its DURATION displays it
    // (Format.displayedDurationMs).
    const holdReason = closedTradesGap || RM.holdTimeGap(positions);
    const closed = holdReason ? [] : positions.filter(p => p.status === 'CLOSED');
    const holdH = (p) => F.displayedDurationMs(RM.holdMs(p)) / C.MS_PER_HOUR;
    const longHolds = closed.filter(p => holdH(p) > C.TUNABLES.LONG_HOLD_HOURS);
    const flips = closed.filter(p => holdH(p) < C.TUNABLES.FLIP_HOLD_HOURS);

    // A row's FREQUENCY is unknown ('—' with countGap) while countGap is
    // set, its win rate and expectancy (the classifier's, decisive closed
    // trades only, all-or-nothing across the account) while that or the
    // classifier's reason is. Only a row whose count is known to be zero
    // is left out.
    const summarize = (label, set, { labelRule = '', countGap = '' } = {}) => {
      const n = countGap ? null : set.length;
      if (n === 0) return null;
      const ratioGap = countGap || profitReason;
      const setCls = ratioGap ? null : RM.classifyClosed(set);
      const wr = setCls ? setCls.winRate : null;
      const avg = setCls ? setCls.expectancy : null;
      // The set's breakeven verdict tones SUCCESS RATE; none without a
      // breakeven rate (no win or no loss to give a payoff).
      const wrTone = wr === null || setCls.breakevenWinRate === null ? ''
        : F.breakevenVerdict(wr, setCls.breakevenWinRate, avg).toneClass;
      const rec = recommend(wr, avg, setCls ? setCls.decisiveCount : null, ratioGap);
      return { label, labelRule, n, wr, wrTone, avg, rec: rec.label, recCls: rec.cls, recReason: rec.reason, countGap, ratioGap };
    };
    // '—' with the reason while the ratios are unknown (a gap); a set
    // with fewer than PATTERN_MIN_N decisive closed trades (those the win
    // rate and expectancy are measured on; a set without one included)
    // reads REVIEW (low n). Otherwise the win rate as SUCCESS RATE
    // displays it and the expectancy's sign as EXPECTANCY displays it
    // (whole dollars, Format.signClass).
    const recommend = (wr, avg, decisiveCount, ratioGap) => {
      if (ratioGap) return { label: '—', cls: '', reason: ratioGap };
      if (decisiveCount < C.TUNABLES.PATTERN_MIN_N) return { label: 'REVIEW (low n)', cls: 'warning', reason: '' };
      const shownWr = F.asDisplayed(wr, F.PERCENT_DECIMALS);
      const shownEdge = F.signClass(avg);
      if (shownEdge === 'profit' && shownWr >= CONTINUE_MIN_WIN_RATE) return { label: 'CONTINUE', cls: 'profit', reason: '' };
      if (shownEdge === 'loss' && shownWr < AVOID_BELOW_WIN_RATE)     return { label: 'AVOID',    cls: 'loss', reason: '' };
      return { label: 'REVIEW', cls: 'warning', reason: '' };
    };
    const gapH = C.TUNABLES.DOUBLE_DOWN_GAP_HOURS;
    const sizeMult = C.TUNABLES.DOUBLE_DOWN_SIZE_MULT;
    const doubleDownRule = `A losing closed position followed by the next position in the same market `
      + `on the same side, entered within ${gapH}h of the loss's close at ≥${sizeMult}× its peak notional. `
      + `The next position is taken by entry time, an open one included; a position opened by the `
      + `loser's own reversal is skipped. Open re-entries count in FREQUENCY, not in SUCCESS RATE or EXPECTANCY.`;
    const doubleDownGap = doubleDownCountGap(positions, profitReason, entriesGap);
    const rows = [
      summarize(`Post-Loss Double Down (same market and side, ≤${gapH}h, ≥${sizeMult}×)`,
        doubleDownGap ? [] : postLossDoubleDowns(positions, fills),
        { labelRule: doubleDownRule, countGap: doubleDownGap }),
      summarize(`Long Hold (>${C.TUNABLES.LONG_HOLD_HOURS}h)`, longHolds, { countGap: holdReason }),
      summarize(`Quick Flip (<${F.fmtFixed(C.TUNABLES.FLIP_HOLD_HOURS * C.MINUTES_PER_HOUR, WHOLE_MINUTES)}m hold)`, flips,
        { countGap: holdReason })
    ].filter(Boolean);
    // A null value reads '—' with its gap when one is set, else 'N/A': a
    // set without a closed win or loss.
    const appendRowCell = (tr, value, text, classes, gap) => {
      const td = D.appendCell(tr, value !== null ? text() : gap ? '—' : 'N/A', classes);
      if (value === null) td.title = gap || EMPTY_BUCKET_REASON;
    };
    rows.forEach(r => {
      const tr = document.createElement('tr');
      D.appendCell(tr, r.label).title = r.labelRule;
      appendRowCell(tr, r.n, () => String(r.n), ['mono'], r.countGap);
      appendRowCell(tr, r.wr, () => F.formatPercent(r.wr), ['mono', r.wrTone], r.ratioGap);
      appendRowCell(tr, r.avg, () => F.formatCurrency(r.avg), ['mono', F.signClass(r.avg)], r.ratioGap);
      const recTd = D.appendCell(tr, r.rec);
      if (r.recReason) recTd.title = r.recReason;
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
