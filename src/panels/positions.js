// Positions tab renderer: active-position summary + recent-closed table.
//
// Depends on: window.AppConstants (MS_PER_HOUR, MS_PER_MIN, TUNABLES),
// window.Format (formatPrice, formatCurrency, fmtNum), window.AppDom
// (updateElement, appendCell, tagCells).

(function () {
  'use strict';

  function render(positions, fills, subaccount) {
    const C = window.AppConstants;
    const F = window.Format;
    const D = window.AppDom;

    const openPositions = positions.filter(p => p.status === 'OPEN');
    const activeCount = openPositions.length;
    const activeNotional = openPositions.reduce((sum, p) => {
      const size = parseFloat(p.size || 0);
      const entry = parseFloat(p.entryPrice || 0);
      return sum + (size * entry);
    }, 0);
    D.updateElement('positionsActiveCount', String(activeCount));
    D.updateElement('positionsActiveNotional', activeCount > 0 ? F.formatPrice(activeNotional) : '-');

    const totalFills = Array.isArray(fills) ? fills.length : 0;
    if (totalFills > 0) {
      const takerFills = fills.filter(f => f.liquidity === 'TAKER').length;
      D.updateElement('positionsFillRate', ((takerFills / totalFills) * 100).toFixed(1) + '%');
    } else {
      D.updateElement('positionsFillRate', '-');
    }

    const body = document.getElementById('positionsHistoryBody');
    if (!body) return;
    body.innerHTML = '';

    const closedPositions = positions
      .filter(p => p.status === 'CLOSED')
      .sort((a, b) => new Date(b.closedAt) - new Date(a.closedAt))
      .slice(0, C.TUNABLES.RECENT_POSITIONS_CAP);

    closedPositions.forEach(p => {
      const tr = document.createElement('tr');
      const created = new Date(p.createdAt);
      const closed = new Date(p.closedAt);
      const durationMs = closed - created;
      let durationText = '—';
      if (isFinite(durationMs) && durationMs >= 0) {
        const hours = Math.floor(durationMs / C.MS_PER_HOUR);
        const minutes = Math.floor((durationMs % C.MS_PER_HOUR) / C.MS_PER_MIN);
        durationText = (hours > 0 ? `${hours}h ` : '') + `${minutes}m`;
      }
      const realized = parseFloat(p.realizedPnl || 0);
      const pct = (parseFloat(p.exitPrice || 0) && parseFloat(p.entryPrice || 0))
        ? ((parseFloat(p.exitPrice) - parseFloat(p.entryPrice)) / parseFloat(p.entryPrice)) * (p.side === 'LONG' ? 100 : -100)
        : 0;
      const funding = parseFloat(p.netFunding || 0);
      const sizeShown = F.fmtNum(p.maxSize || p.sumOpen || p.size || 0);

      D.appendCell(tr, isFinite(closed.getTime()) ? closed.toLocaleString() : '—', ['mono']);
      D.appendCell(tr, p.market || '-', ['mono']);
      D.appendCell(tr, (p.side || '').toUpperCase(), ['mono']);
      D.appendCell(tr, sizeShown, ['mono']);
      D.appendCell(tr, F.formatPrice(p.entryPrice), ['mono']);
      D.appendCell(tr, F.formatPrice(p.exitPrice), ['mono']);
      D.appendCell(tr, F.formatCurrency(realized), ['mono', realized >= 0 ? 'profit' : 'loss']);
      D.appendCell(tr, pct.toFixed(2) + '%', ['mono', pct >= 0 ? 'profit' : 'loss']);
      D.appendCell(tr, durationText, ['mono']);
      D.appendCell(tr, F.formatCurrency(funding), ['mono', funding >= 0 ? 'profit' : 'loss']);
      body.appendChild(tr);
    });
    D.tagCells('positionsHistoryBody');
  }

  window.AppPanels = window.AppPanels || {};
  window.AppPanels.positions = { render };
})();
