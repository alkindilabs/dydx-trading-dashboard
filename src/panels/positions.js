// Positions tab renderer: active-position summary + recent-closed table.
//
// Per-position size, prices and profit come from the fill attribution
// processData merges onto every position (RiskMetrics.attributeFillsToPositions:
// peakSize, entryVwap, exitVwap, profit, complete, openedByFlip,
// closedByFlip). A position whose attribution is incomplete renders '—' in
// those columns, with the missing fills' reason or its incompleteCause on
// hover. A CLOSED list that did not load reads as its reason in the table,
// never as an account without closed positions; a closed trade the fills
// hold but no listed position owns puts its reason above the rows.
//
// Depends on: window.AppConstants (TUNABLES, PERCENT), window.RiskMetrics
// (hasCompleteAttribution, tradeReturn, positionNotional, oppositeSide,
// positionNetFunding, NO_NET_FUNDING, holdMs, timestampMs),
// window.Format (formatPrice, formatCurrency, formatPercent, fmtNotional, fmtSignedPct,
// signClass, formatDuration, fmtDateTimeUTC, fmtAssetSize), window.AppDom
// (updateElement, appendCell, tagCells).

(function () {
  'use strict';

  // PROFIT %: the decimals the Win/Loss Distribution bins each return on.
  const PERCENT_DECIMALS = window.Format.TRADE_RETURN_DECIMALS;
  const HISTORY_TABLE_COLUMNS = 10;
  const TAKER_SHARE_CAPTION = 'Taker fills ÷ all fills, by count';
  // The indexer's fill `liquidity` flags.
  const LIQUIDITY = Object.freeze({ TAKER: 'TAKER', MAKER: 'MAKER' });
  const FLIP_TAG = '⇄';
  const FLIP_SPLIT_NOTE = "the reversing fill's size and fee are split between both rows.";

  function flipNote(p) {
    const otherSide = window.RiskMetrics.oppositeSide((p.side || '').toUpperCase());
    const notes = [];
    if (p.openedByFlip) notes.push(`Opened by reversing a ${otherSide} in one order; ${FLIP_SPLIT_NOTE}`);
    if (p.closedByFlip) notes.push(`Closed by reversing into a ${otherSide} in one order; ${FLIP_SPLIT_NOTE}`);
    return notes.join(' ');
  }

  function appendSideCell(tr, p) {
    const td = window.AppDom.appendCell(tr, (p.side || '').toUpperCase(), ['mono']);
    const note = flipNote(p);
    if (note) {
      const tag = document.createElement('span');
      tag.className = 'flip-tag';
      tag.textContent = FLIP_TAG;
      tag.title = note;
      tag.setAttribute('aria-label', note);
      td.appendChild(tag);
    }
  }

  // RiskMetrics.positionNotional summed (the Risk tab's leverage and
  // liquidation-table notional), or null when any open position cannot be
  // valued.
  function openNotional(openPositions, marketsMap) {
    let total = 0;
    for (const p of openPositions) {
      const notional = window.RiskMetrics.positionNotional(p, marketsMap);
      if (notional === null) return null;
      total += notional;
    }
    return total;
  }

  function renderActive(positions, context) {
    const F = window.Format;
    const D = window.AppDom;
    if (context.openPositionsGap) {
      D.updateElement('positionsActiveCount', '—');
      D.updateElement('positionsActiveNotional', context.openPositionsGap);
      return;
    }
    const openPositions = positions.filter(p => p.status === 'OPEN');
    D.updateElement('positionsActiveCount', String(openPositions.length));
    if (openPositions.length === 0) {
      D.updateElement('positionsActiveNotional', 'No open notional');
      return;
    }
    const notional = openNotional(openPositions, context.marketsMap);
    D.updateElement('positionsActiveNotional',
      notional === null ? (context.openNotionalGap || '—') : `${F.fmtNotional(notional)} notional`);
  }

  // Taker fills over taker and maker fills, by count. A fill flagged as
  // neither has unknown liquidity, never a maker fill: the share then reads
  // '—' with the count of such fills as its caption.
  function renderTakerShare(fills, fillsGap) {
    const D = window.AppDom;
    const allFills = Array.isArray(fills) ? fills : [];
    const count = flag => allFills.filter(f => f && f.liquidity === flag).length;
    const takerFills = count(LIQUIDITY.TAKER);
    const unflagged = allFills.length - takerFills - count(LIQUIDITY.MAKER);
    const unflaggedGap = unflagged === 0 ? ''
      : `${unflagged} fill${unflagged === 1 ? '' : 's'} without a liquidity flag`;
    const gap = fillsGap || unflaggedGap;
    D.updateElement('positionsTakerShareDetail', gap || TAKER_SHARE_CAPTION);
    if (gap || allFills.length === 0) {
      D.updateElement('positionsTakerShare', '—');
      return;
    }
    D.updateElement('positionsTakerShare', window.Format.formatPercent((takerFills / allFills.length) * window.AppConstants.PERCENT));
  }

  // fillsGap: why the fills are missing ('' when they loaded); otherwise
  // an incomplete row's blanked cells name its incompleteCause.
  function appendHistoryRow(body, p, fillsGap) {
    const F = window.Format;
    const D = window.AppDom;
    const tr = document.createElement('tr');
    const complete = window.RiskMetrics.hasCompleteAttribution(p);
    const blankReason = complete ? '' : (fillsGap || p.incompleteCause || '');
    const appendAttributed = (text, classes) => {
      const td = D.appendCell(tr, complete ? text() : '—', classes);
      if (blankReason) td.title = blankReason;
    };
    const profit = complete ? p.profit : null;
    const ret = window.RiskMetrics.tradeReturn(p);
    const pct = ret === null ? null : ret * window.AppConstants.PERCENT;
    const funding = window.RiskMetrics.positionNetFunding(p);
    const durationMs = window.RiskMetrics.holdMs(p);

    D.appendCell(tr, F.fmtDateTimeUTC(p.closedAt), ['mono']);
    D.appendCell(tr, p.market || '-', ['mono']);
    appendSideCell(tr, p);
    appendAttributed(() => F.fmtAssetSize(p.peakSize, p.market), ['mono']);
    appendAttributed(() => F.formatPrice(p.entryVwap), ['mono']);
    appendAttributed(() => F.formatPrice(p.exitVwap), ['mono']);
    appendAttributed(() => F.formatCurrency(profit), ['mono', F.signClass(profit)]);
    appendAttributed(() => F.fmtSignedPct(pct, PERCENT_DECIMALS), ['mono', F.signClass(pct, PERCENT_DECIMALS)]);
    D.appendCell(tr, F.formatDuration(durationMs), ['mono']);
    const fundingCell = D.appendCell(tr, funding === null ? '—' : F.formatCurrency(funding), ['mono', F.signClass(funding)]);
    if (funding === null) fundingCell.title = window.RiskMetrics.NO_NET_FUNDING;
    body.appendChild(tr);
  }

  function appendHistoryNote(body, text) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = HISTORY_TABLE_COLUMNS;
    td.style.textAlign = 'center';
    td.style.fontStyle = 'italic';
    td.style.color = 'var(--ink-3)';
    td.textContent = text;
    tr.appendChild(td);
    body.appendChild(tr);
  }

  // The one closing order (RiskMetrics.byClosingOrder: closes in one
  // millisecond in their closing fills' chain order), newest first; a row
  // without a parseable closedAt still last.
  function newestCloseFirst(fills) {
    const oldestFirst = window.RiskMetrics.byClosingOrder(fills);
    const untimed = p => window.RiskMetrics.timestampMs(p.closedAt) === null;
    return (a, b) => (untimed(a) - untimed(b)) || oldestFirst(b, a);
  }

  // context: { marketsMap, openPositionsGap, openNotionalGap, closedGap,
  // unlistedTradeGap, fillsGap } where openPositionsGap is processData's
  // reason the OPEN rows are unknown ('' when known): the OPEN list
  // failed, or the fills that resolve an OPEN/CLOSED collision are
  // missing; openNotionalGap is its reason an OPEN position has no
  // notional (no oracle price for its market); closedGap and fillsGap are
  // why the CLOSED list and the fills did not load ('' when they did);
  // unlistedTradeGap is why the list misses a closed trade the fills hold
  // ('' when none), shown above the listed rows.
  function render(positions, fills, context) {
    const C = window.AppConstants;
    const closedGap = context.closedGap || '';
    const fillsGap = context.fillsGap || '';
    renderActive(positions, context);
    renderTakerShare(fills, fillsGap);

    const body = document.getElementById('positionsHistoryBody');
    if (!body) return;
    body.innerHTML = '';
    if (closedGap) {
      appendHistoryNote(body, closedGap);
      return;
    }
    if (context.unlistedTradeGap) appendHistoryNote(body, context.unlistedTradeGap);
    positions
      .filter(p => p.status === 'CLOSED')
      .sort(newestCloseFirst(fills))
      .slice(0, C.TUNABLES.RECENT_POSITIONS_CAP)
      .forEach(p => appendHistoryRow(body, p, fillsGap));
    window.AppDom.tagCells('positionsHistoryBody');
  }

  window.AppPanels = window.AppPanels || {};
  window.AppPanels.positions = { render };
})();
