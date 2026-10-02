// Risk tab: liquidation table, leverage utilization, VaR/CVaR, Drawdown
// Periods table. The Sharpe/Sortino/Calmar renderer (renderRiskRatios)
// stays inline in processData() in index.html because it closes over
// processData's locals (allPositions, histArr, subaccount, marketAgg, the
// classifier output).
//
// Depends on: window.RiskMetrics (liquidationRow, LIQUIDATION_STATE, LIQUIDATION_INPUT, leverageUtilization,
// usableEquity, positionNotional, historicalVaR, varSampleGap, drawdownSource,
// histPnlDrawdownEvents, tradeSystemDrawdownEvents), window.AppConstants
// (PERCENT), window.Format (formatCurrency, formatPrice, fmtAssetSize,
// formatDuration, signClass, displaysAsLoss, drawdownAsDisplayed, fmtSignedPct, asDisplayed,
// PERCENT_DECIMALS), window.AppDom (appendCell, tagCells,
// updateMetric).

(function () {
  'use strict';

  const LIQUIDATION_TABLE_COLUMNS = 8;
  const DRAWDOWN_PERIODS_COLUMNS = 7;
  const HIGH_RISK_MAX_DISTANCE_PCT = 10;
  const MEDIUM_RISK_MAX_DISTANCE_PCT = 20;
  const HIGH_LEVERAGE = 5;
  const ELEVATED_LEVERAGE = 2;
  const LEVERAGE_BAR_FULL_SCALE = 10;
  const LEVERAGE_DECIMALS = 2;

  // Leverage as every leverage cell shows it ('2.00x'); its tier is
  // decided from the same rounded value, so 1.9996x reads 2.00x and is
  // not conservative.
  function leverageAsDisplayed(lev) {
    return window.Format.asDisplayed(lev, LEVERAGE_DECIMALS);
  }
  function fmtLeverage(lev) {
    return `${window.Format.fmtFixed(lev, LEVERAGE_DECIMALS)}x`;
  }

  // RISK SCORE of a DISTANCE as the row shows it (signed, at
  // Format.PERCENT_DECIMALS): BREACHED once it shows below zero, so never
  // beside '0.0%'; then HIGH, MEDIUM and LOW by the tier bounds.
  function riskScore(distancePct) {
    const F = window.Format;
    const shown = F.asDisplayed(distancePct, F.PERCENT_DECIMALS);
    if (shown < 0)                            return BREACHED;
    if (shown < HIGH_RISK_MAX_DISTANCE_PCT)   return { scoreClass: 'loss',    scoreLabel: 'HIGH' };
    if (shown < MEDIUM_RISK_MAX_DISTANCE_PCT) return { scoreClass: 'warning', scoreLabel: 'MEDIUM' };
    return { scoreClass: 'profit', scoreLabel: 'LOW' };
  }

  const BREACHED = { scoreClass: 'loss', scoreLabel: 'BREACHED' };

  // Why a row has no LIQ PRICE, by RiskMetrics.liquidationRow's liqState
  // (LIQUIDATION_STATE): an account below maintenance margin at every
  // price is already liquidatable (BREACHED); a LONG no price above $0
  // liquidates keeps its full 100% DISTANCE.
  const STATE = window.RiskMetrics.LIQUIDATION_STATE;
  const NO_LIQ_PRICE_REASONS = {
    [STATE.BELOW_MAINTENANCE]: 'Below maintenance margin at every price',
    [STATE.NO_PRICE_LIQUIDATES]: 'No liquidation price: the account stays above maintenance margin even at a price of $0'
  };
  const UNKNOWN_STATES = [STATE.UNKNOWN, STATE.OTHER_MARGIN_UNKNOWN];

  // Why a row's liquidation is unknown, from liquidationRow's `missing`
  // (RiskMetrics.LIQUIDATION_INPUT): a market input reads `marketsGap`
  // (the markets endpoint's missing-input reason) when set, else the input
  // and its market; on OTHER_MARGIN_UNKNOWN it names the other positions
  // whose maintenance margin is unknown. liquidationRow is null only
  // without a subaccount, whose equity is then unknown.
  function unknownLiquidationReason(row, marketsGap) {
    if (!row) return EQUITY_UNAVAILABLE;
    const text = [...new Set(row.missing.map(({ market, input }) =>
      market === null ? input : (marketsGap || `${input} for ${market}`)))].join('; ');
    if (row.liqState !== STATE.OTHER_MARGIN_UNKNOWN) return text;
    const singleMarket = new Set(row.missing.map(m => m.market)).size === 1;
    return `${text}: ${singleMarket ? 'its maintenance margin is' : 'their maintenance margins are'} unknown`;
  }

  // A row spanning the table's `columns` holding `text`.
  function appendTableNote(body, columns, text) {
    const noteTr = document.createElement('tr');
    const noteTd = document.createElement('td');
    noteTd.colSpan = columns;
    noteTd.style.textAlign = 'center';
    noteTd.style.fontStyle = 'italic';
    noteTd.style.color = 'var(--ink-3)';
    noteTd.textContent = text;
    noteTr.appendChild(noteTd);
    body.appendChild(noteTr);
  }

  // Per-row cross-margin liquidation table. Each row's liq price holds the
  // OTHER open positions at their current oracle price (their uPnL and
  // maintenance margin): exact for single-position accounts. DISTANCE is
  // signed (positive = room left); one that shows below zero means the
  // oracle is already past the liq price and the row reads BREACHED.
  // openPositionsGap is processData's reason the OPEN rows are unknown
  // ('' when known): the OPEN list failed, or the fills that resolve an
  // OPEN/CLOSED collision are missing. The table then holds only that reason.
  // marketsGap is the markets endpoint's missing-input reason ('' when it
  // loaded): a row whose liquidation is unknown carries its reason
  // (unknownLiquidationReason) on LIQ PRICE, DISTANCE and RISK SCORE.
  function renderLiquidationTable(positions, marketsMap, subaccount, openPositionsGap, marketsGap = '') {
    const F = window.Format;
    const D = window.AppDom;

    const body = document.getElementById('liquidationRiskBody');
    if (!body) return;
    body.innerHTML = '';
    if (openPositionsGap) {
      appendTableNote(body, LIQUIDATION_TABLE_COLUMNS, openPositionsGap);
      return;
    }
    const open = positions.filter(p => p.status === 'OPEN');
    if (!open.length) return;
    open.forEach(p => {
      const market = p.market || '—';
      const side = (p.side || '').toUpperCase();
      const computed = window.RiskMetrics.liquidationRow(p, subaccount, marketsMap, positions);
      const row = computed || {};
      const { size, entry, oracle, lev, liq, distancePct, liqState } = row;
      const unknownReason = !computed || UNKNOWN_STATES.includes(liqState)
        ? unknownLiquidationReason(computed, marketsGap) : '';
      const hasDistance = distancePct !== null && distancePct !== undefined;
      const { scoreClass, scoreLabel } = liqState === STATE.BELOW_MAINTENANCE ? BREACHED
        : hasDistance ? riskScore(distancePct) : { scoreClass: '', scoreLabel: '—' };
      const tr = document.createElement('tr');
      D.appendCell(tr, `${market} ${side}`);
      D.appendCell(tr, size ? F.fmtAssetSize(size, p.market) : '—', ['mono']);
      D.appendCell(tr, lev !== null && lev !== undefined ? fmtLeverage(lev) : '—', ['mono']);
      D.appendCell(tr, entry ? F.formatPrice(entry) : '—', ['mono']);
      D.appendCell(tr, oracle ? F.formatPrice(oracle) : '—', ['mono']);
      const liqCell = D.appendCell(tr, (liq !== null && liq !== undefined && isFinite(liq)) ? F.formatPrice(liq) : '—', ['mono', scoreClass]);
      const distanceCell = D.appendCell(tr, hasDistance ? F.fmtSignedPct(distancePct, F.PERCENT_DECIMALS) : '—', ['mono']);
      if (NO_LIQ_PRICE_REASONS[liqState]) liqCell.title = NO_LIQ_PRICE_REASONS[liqState];
      if (!hasDistance && NO_LIQ_PRICE_REASONS[liqState]) distanceCell.title = NO_LIQ_PRICE_REASONS[liqState];
      const scoreCell = D.appendCell(tr, scoreLabel, ['mono', scoreClass]);
      if (unknownReason) [liqCell, distanceCell, scoreCell].forEach(c => { c.title = unknownReason; });
      body.appendChild(tr);
    });
    if (open.length > 1) {
      appendTableNote(body, LIQUIDATION_TABLE_COLUMNS, 'Multi-position cross-margin: each liquidation price holds the other positions at their current mark price (their unrealized profit and maintenance margin). Approximation.');
    }
    D.tagCells('liquidationRiskBody');
  }

  const EQUITY_UNAVAILABLE = window.RiskMetrics.EQUITY_UNAVAILABLE;
  const INSUFFICIENT_DATA = 'Insufficient data';
  const NO_OPEN_POSITIONS = 'No open positions';
  const OPEN_NOTIONAL_UNAVAILABLE = 'Open position notional unavailable';

  // The caption reads `caption` when there is one, else the markup's own text.
  function renderLeverageDetail(caption) {
    const detail = document.getElementById('leverageUtilDetail');
    if (!detail) return;
    if (detail.dataset.defaultText === undefined) {
      detail.dataset.defaultText = detail.textContent;
    }
    detail.textContent = caption || detail.dataset.defaultText;
  }

  // The card's { lev, caption }, in precedence order: while
  // openPositionsGap holds a reason the OPEN rows are unknown, '—' with
  // that reason even when some OPEN rows are present; without
  // RiskMetrics.usableEquity, '—'; with no open position, 0x; with an open
  // position RiskMetrics.positionNotional cannot value, '—' (a sum over the
  // others would understate leverage) with notionalGap, processData's reason
  // (e.g. no oracle price for its market); else
  // RiskMetrics.leverageUtilization under the markup's caption.
  function leverageReading(positions, subaccount, marketsMap, openPositionsGap, notionalGap) {
    const RM = window.RiskMetrics;
    if (openPositionsGap) return { lev: null, caption: openPositionsGap };
    if (RM.usableEquity(subaccount) === null) return { lev: null, caption: EQUITY_UNAVAILABLE };
    const open = positions.filter(p => p.status === 'OPEN');
    if (!open.length) return { lev: 0, caption: NO_OPEN_POSITIONS };
    if (open.some(p => RM.positionNotional(p, marketsMap) === null)) {
      return { lev: null, caption: notionalGap || OPEN_NOTIONAL_UNAVAILABLE };
    }
    return { lev: RM.leverageUtilization(positions, subaccount, marketsMap), caption: '' };
  }

  // The Leverage card's tiers, highest first: a leverage as displayed at
  // or above a tier's floor takes its tone; below every floor it is
  // conservative. The card's tooltip states them from the same list.
  const LEVERAGE_TIERS = [
    { floor: HIGH_LEVERAGE, name: 'high', tone: 'loss' },
    { floor: ELEVATED_LEVERAGE, name: 'elevated', tone: 'warning' }
  ];
  const CONSERVATIVE = { name: 'conservative', tone: 'profit' };
  const LOWEST_TIER_FLOOR = LEVERAGE_TIERS[LEVERAGE_TIERS.length - 1].floor;
  const LEVERAGE_TIERS_TEXT = [
    ...LEVERAGE_TIERS.map(t => `${t.floor}x or more = ${t.name}`),
    `below ${LOWEST_TIER_FLOOR}x = ${CONSERVATIVE.name}`
  ].join('; ') + ' (leverage as displayed).';

  function leverageTier(lev) {
    const shown = leverageAsDisplayed(lev);
    return LEVERAGE_TIERS.find(t => shown >= t.floor) || CONSERVATIVE;
  }

  // The card's tooltip: the markup's own text followed by the tiers.
  function renderLeverageCardTitle() {
    const card = document.getElementById('leverageUtilCard');
    if (!card) return;
    if (card.dataset.defaultTitle === undefined) card.dataset.defaultTitle = card.title;
    card.title = `${card.dataset.defaultTitle} ${LEVERAGE_TIERS_TEXT}`;
  }

  // Tier-based styling so high leverage never renders in profit-green
  // by accident, decided from the leverage as displayed.
  function renderLeverageUtilization(positions, subaccount, marketsMap, openPositionsGap, notionalGap) {
    const { lev, caption } = leverageReading(positions, subaccount, marketsMap, openPositionsGap, notionalGap);
    renderLeverageDetail(caption);
    renderLeverageCardTitle();
    const el = document.getElementById('leverageUtil');
    if (el) {
      el.textContent = lev !== null ? fmtLeverage(lev) : '—';
      const cls = lev !== null ? leverageTier(lev).tone : '';
      el.className = 'metric-value mono' + (cls ? ' ' + cls : '');
    }
    const bar = document.getElementById('leverageUtilBar');
    if (bar) {
      const fullBarPct = window.AppConstants.PERCENT;
      const pctPerLeverage = fullBarPct / LEVERAGE_BAR_FULL_SCALE;
      bar.style.width = `${Math.min(fullBarPct, (lev || 0) * pctPerLeverage).toFixed(1)}%`;
    }
  }

  // A card caption reads `text` when given, else the markup's own text.
  function renderCaption(id, text) {
    const caption = document.getElementById(id);
    if (!caption) return;
    if (caption.dataset.defaultText === undefined) {
      caption.dataset.defaultText = caption.textContent;
    }
    caption.textContent = text || caption.dataset.defaultText;
  }

  const VAR_CARDS = [
    { id: 'var95', captionId: 'var95Detail' },
    { id: 'expectedShortfall', captionId: 'expectedShortfallDetail' }
  ];

  // VaR and ES read '—' with `reason` as their tooltip, under the
  // markup's captions.
  function renderVarUnavailable(reason) {
    const D = window.AppDom;
    VAR_CARDS.forEach(({ id, captionId }) => {
      D.updateMetric(id, '—');
      const el = document.getElementById(id);
      if (el) el.title = reason;
      renderCaption(captionId, '');
    });
  }

  // VaR / CVaR (RiskMetrics.historicalVaR) in dollars at current usable
  // equity, over one sampling period of `returns`
  // (RiskMetrics.varSampleReturns). `sampling` names that
  // period: { label: 'hourly' | 'daily' | 'periodic', ppy }. The caller
  // already ran the sample-adequacy gate on all returns; a sample that
  // fails that gate's count or span rule on its own (fewer returns than
  // its minimum, or spanning less than its month at `ppy`) reads '—' with
  // RiskMetrics.varSampleGap's reason. A tail made of gains reads as a
  // $0 loss, never as a profit, and a loss that displays as $0
  // (Format.displaysAsLoss) takes the "no loss" caption its card shows.
  function renderFromHistorical(returns, subaccount, sampling) {
    const F = window.Format;
    const D = window.AppDom;
    if (window.RiskMetrics.usableEquity(subaccount) === null) {
      renderVarUnavailable(EQUITY_UNAVAILABLE);
      return;
    }
    const sampleGap = window.RiskMetrics.varSampleGap(returns, sampling.ppy);
    if (sampleGap) {
      renderVarUnavailable(sampleGap);
      return;
    }
    const v = window.RiskMetrics.historicalVaR(returns, subaccount);
    if (!v) {
      renderVarUnavailable(INSUFFICIENT_DATA);
      return;
    }
    const label = sampling.label;
    const horizon = label.charAt(0).toUpperCase() + label.slice(1);
    const periodTip = `Horizon: one ${label} sampling period of /historical-pnl (≈ ${window.Format.fmtFixed(sampling.ppy, window.Format.PERIODS_PER_YEAR_DECIMALS)} periods per year), historical, not scaled to a longer horizon. Only returns over 1 ÷ ${window.RiskMetrics.VAR_MAX_INTERVAL_MULTIPLE} to ${window.RiskMetrics.VAR_MAX_INTERVAL_MULTIPLE} sampling periods are kept: a return over a longer gap or a shorter step is not a one-period outcome.`;
    const cards = [
      { card: VAR_CARDS[0], loss: v.varLoss,
        caption: `${horizon} · 5th pctile`,
        noLossCaption: `${horizon} · no loss at 95%` },
      { card: VAR_CARDS[1], loss: v.esLoss,
        caption: `${horizon} · CVaR 95%`,
        noLossCaption: `${horizon} · no loss in worst 5%` }
    ];
    cards.forEach(({ card, loss, caption, noLossCaption }) => {
      const shown = -loss;
      D.updateMetric(card.id, F.formatCurrency(shown), F.signClass(shown));
      const el = document.getElementById(card.id);
      if (el) el.title = periodTip;
      renderCaption(card.captionId, F.displaysAsLoss(loss) ? caption : noLossCaption);
    });
  }

  // The table title: the markup's own text, followed by the count of
  // listed drawdowns unless `count` is null (no rows to count).
  function renderDrawdownPeriodsTitle(count) {
    const title = document.getElementById('drawdownPeriodsTitle');
    if (!title) return;
    if (title.dataset.defaultText === undefined) {
      title.dataset.defaultText = title.textContent;
    }
    title.textContent = count === null ? title.dataset.defaultText
      : `${title.dataset.defaultText} (${count}, deepest first)`;
  }

  // Drawdown Periods table — every peak-to-trough event on the series
  // RiskMetrics.drawdownSource picks, deepest first, the title counting
  // them (the table scrolls): cumulative trading P&L (totalPnl from
  // historical-pnl, ending at `live`, RiskMetrics.livePnlPoint or null)
  // whenever it has a row, else the closed-trade ledger, its series
  // built with `tradeOpts` ({ fills, nowMs }:
  // RiskMetrics.tradeSystemDrawdownEvents), so it too ends now. DURATION
  // is the time under water, peak → recovery (peak → the series' last
  // point while ongoing, the Current Drawdown card's days); TO TROUGH is
  // peak → trough with the trough's date; RECOVERY is trough → recovery
  // (an event recovers where its gap to the peak displays as $0,
  // RiskMetrics.regainsPeak, so every listed event displays as a loss).
  // Spans render in Format.formatDuration units so
  // sub-day spans keep their hours. DEPTH is the event's `shownDepth`,
  // the displayed PEAK less the displayed TROUGH, so the row foots as
  // shown; events are sorted by RiskMetrics.deeperDrawdownFirst (the
  // ranking that picks the Max Drawdown card's event, so the top row is
  // that event). `gap`
  // (processData's reason the series cannot be measured, as on the
  // drawdown cards; '' when it can) replaces the rows with that reason.
  function renderDrawdownPeriods(positions, historicalPnl, live = null, gap = '', tradeOpts = {}) {
    const F = window.Format;
    const D = window.AppDom;
    const RM = window.RiskMetrics;

    const body = document.getElementById('drawdownPeriodsBody');
    if (!body) return;
    body.innerHTML = '';
    if (gap) {
      renderDrawdownPeriodsTitle(null);
      appendTableNote(body, DRAWDOWN_PERIODS_COLUMNS, gap);
      return;
    }
    const events = (RM.drawdownSource(historicalPnl) === 'hist'
      ? RM.histPnlDrawdownEvents(historicalPnl, live)
      : RM.tradeSystemDrawdownEvents(positions || [], tradeOpts));
    events.sort(RM.deeperDrawdownFirst);
    renderDrawdownPeriodsTitle(events.length);
    const fmtDate = (iso) => new Date(iso).toISOString().slice(0, 10);
    const span = (a, b) => F.formatDuration(new Date(b) - new Date(a));
    events.forEach(ev => {
      const tr = document.createElement('tr');
      const { recoveryAt } = ev;
      const period = `${fmtDate(ev.peakAt)} → ${recoveryAt ? fmtDate(recoveryAt) : 'ongoing'}`;
      D.appendCell(tr, period);
      D.appendCell(tr, F.formatCurrency(-ev.shownDepth), ['mono', 'loss']);
      D.appendCell(tr, span(ev.peakAt, ev.endAt), ['mono']);
      D.appendCell(tr, `${span(ev.peakAt, ev.troughAt)} · ${fmtDate(ev.troughAt)}`, ['mono']);
      D.appendCell(tr, recoveryAt ? span(ev.troughAt, recoveryAt) : '—', ['mono']);
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
    renderVarUnavailable,
    renderDrawdownPeriods
  };
})();
