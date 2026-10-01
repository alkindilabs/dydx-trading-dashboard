// Positions tab renderer: active-position summary + recent-closed table.
//
// Per-position size, prices and profit come from the fill attribution
// processData merges onto every position (RiskMetrics.attributeFillsToPositions:
// peakSize, entryVwap, exitVwap, profit, complete, openedByFlip,
// closedByFlip). A position whose attribution is incomplete renders '—' in
// those columns.
//
// Depends on: window.AppConstants (TUNABLES, PERCENT), window.RiskMetrics
// (hasCompleteAttribution, tradeReturn, positionNotional, oppositeSide),
// window.Format (formatPrice, formatCurrency, fmtNotional, fmtSignedPct,
// signClass, formatDuration, fmtDateTimeUTC, fmtAssetSize), window.AppDom
// (updateElement, appendCell, tagCells).

(function () {
  'use strict';

  const PERCENT_DECIMALS = 2;
  const SHARE_DECIMALS = 1;
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
      notional === null ? '—' : `${F.fmtNotional(notional)} notional`);
  }

  function renderTakerShare(fills) {
    const totalFills = Array.isArray(fills) ? fills.length : 0;
    if (totalFills === 0) {
      window.AppDom.updateElement('positionsTakerShare', '—');
      return;
    }
    const takerFills = fills.filter(f => f.liquidity === 'TAKER').length;
    window.AppDom.updateElement('positionsTakerShare', ((takerFills / totalFills) * window.AppConstants.PERCENT).toFixed(SHARE_DECIMALS) + '%');
  }

  function appendHistoryRow(body, p) {
    const F = window.Format;
    const D = window.AppDom;
    const tr = document.createElement('tr');
    const complete = window.RiskMetrics.hasCompleteAttribution(p);
    const profit = complete ? p.profit : null;
    const ret = window.RiskMetrics.tradeReturn(p);
    const pct = ret === null ? null : ret * window.AppConstants.PERCENT;
    const funding = parseFloat(p.netFunding || 0);
    const durationMs = new Date(p.closedAt) - new Date(p.createdAt);

    D.appendCell(tr, F.fmtDateTimeUTC(p.closedAt), ['mono']);
    D.appendCell(tr, p.market || '-', ['mono']);
    appendSideCell(tr, p);
    D.appendCell(tr, complete ? F.fmtAssetSize(p.peakSize, p.market) : '—', ['mono']);
    D.appendCell(tr, complete ? F.formatPrice(p.entryVwap) : '—', ['mono']);
    D.appendCell(tr, complete ? F.formatPrice(p.exitVwap) : '—', ['mono']);
    D.appendCell(tr, profit === null ? '—' : F.formatCurrency(profit), ['mono', F.signClass(profit)]);
    D.appendCell(tr, F.fmtSignedPct(pct, PERCENT_DECIMALS), ['mono', F.signClass(pct, PERCENT_DECIMALS)]);
    D.appendCell(tr, F.formatDuration(durationMs), ['mono']);
    D.appendCell(tr, F.formatCurrency(funding), ['mono', F.signClass(funding)]);
    body.appendChild(tr);
  }

  // context: { marketsMap, openPositionsGap } where openPositionsGap is
  // processData's reason the OPEN rows are unknown ('' when known): the
  // OPEN list failed, or the fills that resolve an OPEN/CLOSED collision
  // are missing.
  function render(positions, fills, context) {
    const C = window.AppConstants;
    renderActive(positions, context);
    renderTakerShare(fills);

    const body = document.getElementById('positionsHistoryBody');
    if (!body) return;
    body.innerHTML = '';
    positions
      .filter(p => p.status === 'CLOSED')
      .sort((a, b) => new Date(b.closedAt) - new Date(a.closedAt))
      .slice(0, C.TUNABLES.RECENT_POSITIONS_CAP)
      .forEach(p => appendHistoryRow(body, p));
    window.AppDom.tagCells('positionsHistoryBody');
  }

  window.AppPanels = window.AppPanels || {};
  window.AppPanels.positions = { render };
})();
