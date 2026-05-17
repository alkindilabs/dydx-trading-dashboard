// Risk tab: liquidation table, leverage utilization, VaR/CVaR, Drawdown
// Periods table. The Sharpe/Sortino/Calmar IIFE that depends on inline
// closure variables (allPositions, histArr, subaccount, marketAgg, the
// classifier output) stays in place for now — it'll move with the
// process-data extraction in Phase 2's final PR.
//
// Depends on: window.RiskMetrics (liquidationRow, leverageUtilization,
// histPnlDrawdownEvents, tradeSystemDrawdownEvents), window.AppConstants
// (MS_PER_DAY), window.Format (formatCurrency, formatPrice, fmtNum),
// window.AppDom (appendCell, tagCells, updateMetric).

(function () {
  'use strict';

  // Per-row cross-margin liquidation table. Exact for single-position
  // accounts; an approximation for multi-position cross-margin (the
  // formula assumes OTHER open positions hold their current uPnL).
  function renderLiquidationTable(positions, marketsMap, subaccount) {
    const F = window.Format;
    const D = window.AppDom;

    const body = document.getElementById('liquidationRiskBody');
    if (!body) return;
    body.innerHTML = '';
    const open = positions.filter(p => p.status === 'OPEN');
    if (!open.length) return;
    open.forEach(p => {
      const market = p.market || '—';
      const side = (p.side || '').toUpperCase();
      const row = window.RiskMetrics.liquidationRow(p, subaccount, marketsMap) || {};
      const { size, entry, oracle, lev, liq, distancePct } = row;
      let scoreClass = '';
      let scoreLabel = '—';
      if (distancePct !== null && distancePct !== undefined) {
        if (distancePct < 10)      { scoreClass = 'loss';    scoreLabel = 'HIGH';   }
        else if (distancePct < 20) { scoreClass = 'warning'; scoreLabel = 'MEDIUM'; }
        else                       { scoreClass = 'profit';  scoreLabel = 'LOW';    }
      }
      const tr = document.createElement('tr');
      D.appendCell(tr, `${market} ${side}`);
      D.appendCell(tr, size ? F.fmtNum(size) : '—', ['mono']);
      D.appendCell(tr, lev !== null && lev !== undefined ? lev.toFixed(2) + 'x' : '—', ['mono']);
      D.appendCell(tr, entry ? F.formatPrice(entry) : '—', ['mono']);
      D.appendCell(tr, oracle ? F.formatPrice(oracle) : '—', ['mono']);
      D.appendCell(tr, (liq !== null && liq !== undefined && isFinite(liq)) ? F.formatPrice(liq) : '—', ['mono', scoreClass]);
      D.appendCell(tr, (distancePct !== null && distancePct !== undefined) ? distancePct.toFixed(1) + '%' : '—', ['mono']);
      D.appendCell(tr, scoreLabel, ['mono', scoreClass]);
      body.appendChild(tr);
    });
    if (open.length > 1) {
      const noteTr = document.createElement('tr');
      const noteTd = document.createElement('td');
      noteTd.colSpan = 8;
      noteTd.style.textAlign = 'center';
      noteTd.style.fontStyle = 'italic';
      noteTd.style.color = 'var(--ink-3)';
      noteTd.textContent = 'Multi-position cross-margin: liquidation prices assume other positions hold their current unrealized profit. Approximation.';
      noteTr.appendChild(noteTd);
      body.appendChild(noteTr);
    }
    D.tagCells('liquidationRiskBody');
  }

  // Tier-based styling so high leverage never renders in profit-green
  // by accident. Compute lives in RiskMetrics.leverageUtilization.
  function renderLeverageUtilization(positions, subaccount, marketsMap) {
    const lev = window.RiskMetrics.leverageUtilization(positions, subaccount, marketsMap);
    const el = document.getElementById('leverageUtil');
    if (el) {
      el.textContent = lev !== null ? lev.toFixed(2) + 'x' : '—';
      let cls = '';
      if (lev !== null) {
        if (lev >= 5)      cls = 'loss';
        else if (lev >= 2) cls = 'warning';
        else               cls = 'profit';
      }
      el.className = 'metric-value mono' + (cls ? ' ' + cls : '');
    }
    const bar = document.getElementById('leverageUtilBar');
    if (bar) bar.style.width = `${Math.min(100, (lev || 0) * 10).toFixed(1)}%`;
  }

  // VaR / CVaR per-period in dollars at current equity. Caller already
  // ran the sample-adequacy gate (MIN_RETS=30 etc.); this only guards
  // against zero-length input.
  function renderFromHistorical(returns, equityNow) {
    const F = window.Format;
    const D = window.AppDom;
    if (!returns || returns.length < 1 || !equityNow) {
      D.updateMetric('var95', '—', false);
      D.updateMetric('expectedShortfall', '—', false);
      return;
    }
    const sorted = returns.slice().sort((a, b) => a - b);
    const idx = Math.max(0, Math.floor(0.05 * sorted.length));
    const var95Ret = sorted[idx];
    const tail = sorted.slice(0, idx + 1);
    const cvar95Ret = tail.length
      ? tail.reduce((s, v) => s + v, 0) / tail.length
      : var95Ret;
    const var95Usd = var95Ret * equityNow;
    const cvar95Usd = cvar95Ret * equityNow;
    D.updateMetric('var95', F.formatCurrency(var95Usd), var95Usd >= 0);
    D.updateMetric('expectedShortfall', F.formatCurrency(cvar95Usd), cvar95Usd >= 0);
  }

  // Drawdown Periods table — every peak-to-trough event on cumulative
  // trading P&L (totalPnl from historical-pnl). Falls back to the closed-
  // trade ledger when historical-pnl is unavailable.
  function renderDrawdownPeriods(positions, historicalPnl) {
    const C = window.AppConstants;
    const F = window.Format;
    const D = window.AppDom;

    const body = document.getElementById('drawdownPeriodsBody');
    if (!body) return;
    body.innerHTML = '';
    const histEvents = window.RiskMetrics.histPnlDrawdownEvents(historicalPnl || []);
    const events = histEvents.length
      ? histEvents
      : window.RiskMetrics.tradeSystemDrawdownEvents(positions || []);
    events.sort((a, b) => b.depthAbs - a.depthAbs);
    const top = events.slice(0, 5);
    const fmtDate = (iso) => new Date(iso).toISOString().slice(0, 10);
    const dayDelta = (a, b) => Math.max(1,
      Math.round((new Date(b) - new Date(a)) / C.MS_PER_DAY));
    top.forEach(ev => {
      const tr = document.createElement('tr');
      const period = ev.recoveryAt
        ? `${fmtDate(ev.peakAt)} → ${fmtDate(ev.recoveryAt)}`
        : `${fmtDate(ev.peakAt)} → ongoing`;
      const duration = `${dayDelta(ev.peakAt, ev.troughAt)}d`;
      const recovery = ev.recoveryAt
        ? `${dayDelta(ev.troughAt, ev.recoveryAt)}d`
        : '—';
      D.appendCell(tr, period);
      D.appendCell(tr, F.formatCurrency(-ev.depthAbs), ['mono', 'loss']);
      D.appendCell(tr, duration, ['mono']);
      D.appendCell(tr, recovery, ['mono']);
      D.appendCell(tr, F.formatCurrency(ev.peakCum), ['mono']);
      D.appendCell(tr, F.formatCurrency(ev.troughCum), ['mono']);
      body.appendChild(tr);
    });
    D.tagCells('drawdownPeriodsBody');
  }

  window.AppPanels = window.AppPanels || {};
  window.AppPanels.risk = {
    renderLiquidationTable,
    renderLeverageUtilization,
    renderFromHistorical,
    renderDrawdownPeriods
  };
})();
