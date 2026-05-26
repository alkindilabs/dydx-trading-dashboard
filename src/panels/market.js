// Market Structure tab: funding hero + KPI cards + per-asset funding
// analysis table. Funding window selector is persisted in localStorage
// so the user's window preference survives reloads.
//
// Depends on: window.AppConstants (TUNABLES.ALWAYS_SHOW_TICKERS,
// HOURS_PER_YEAR, MS_PER_HOUR), window.Format (formatCurrency,
// fmtNotional, fmtSignedPct, fmtDateShort, formatFundingApr,
// formatHourlyDetail), window.AppDom (updateElement, appendCell,
// tagCells).

(function () {
  'use strict';

  const FUNDING_WINDOW_KEY = 'fundingWindow';

  function getFundingWindowDays() {
    try {
      const v = localStorage.getItem(FUNDING_WINDOW_KEY);
      if (v === '7' || v === '30' || v === '90' || v === 'all') return v;
    } catch (e) {}
    return '30';
  }

  function getFundingCutoff() {
    const w = getFundingWindowDays();
    return w === 'all' ? 0 : Date.now() - parseInt(w, 10) * 24 * 3600 * 1000;
  }

  function getFundingWindowLabel() {
    const w = getFundingWindowDays();
    return w === 'all' ? 'All time' : `Last ${w} days`;
  }

  // dYdX v4 settles funding hourly; each row carries the position size
  // and oracle price at settlement. Sum |size × price| over rows =
  // dollar-hours of exposure. APR = (Σ payment / Σ dollar-hours) ×
  // HOURS_PER_YEAR. Closed-position gaps produce no rows, so
  // hoursDeployed counts only the time the trader was actually exposed.
  function computeFundingHero(payments) {
    const C = window.AppConstants;
    const cutoff = getFundingCutoff();
    const inWin = (payments || []).filter(p => {
      const ts = new Date(p.createdAt || p.effectiveAt).getTime();
      return !isNaN(ts) && ts >= cutoff;
    });
    if (!inWin.length) return null;

    inWin.sort((a, b) => {
      const ta = new Date(a.createdAt || a.effectiveAt).getTime();
      const tb = new Date(b.createdAt || b.effectiveAt).getTime();
      return ta - tb;
    });
    const periodStart = new Date(inWin[0].createdAt || inWin[0].effectiveAt).getTime();
    const periodEnd = new Date(inWin[inWin.length - 1].createdAt || inWin[inWin.length - 1].effectiveAt).getTime();

    let received = 0, paid = 0, notionalHours = 0, hoursDeployed = 0;
    inWin.forEach(p => {
      const amt = parseFloat(p.payment) || 0;
      const size = Math.abs(parseFloat(p.size ?? p.positionSize) || 0);
      const price = parseFloat(p.oraclePrice ?? p.price) || 0;
      const notional = size * price;
      if (amt > 0) received += amt; else paid += Math.abs(amt);
      if (notional > 0) {
        notionalHours += notional;
        hoursDeployed += 1;
      }
    });
    if (notionalHours <= 0 || hoursDeployed <= 0) return null;

    const net = received - paid;
    const avgNotional = notionalHours / hoursDeployed;
    const hourlyRate = net / notionalHours;
    const apr = hourlyRate * C.HOURS_PER_YEAR;

    const windowKey = getFundingWindowDays();
    const windowHours = windowKey === 'all'
      ? Math.max(1, (Date.now() - periodStart) / C.MS_PER_HOUR)
      : parseInt(windowKey, 10) * 24;
    const capitalTurns = (avgNotional > 0) ? notionalHours / (avgNotional * windowHours) : 0;

    return { apr, net, received, paid, avgNotional, hoursDeployed,
             notionalHours, hourlyRate, periodStart, periodEnd,
             windowHours, capitalTurns };
  }

  function renderFundingHero(metrics) {
    const F = window.Format;
    const D = window.AppDom;
    const apr = document.getElementById('fundingApr');
    if (!apr) return;
    if (!metrics) {
      ['fundingApr', 'fundingCaption', 'fundingPeriod', 'fundingAvgNotional',
       'fundingHoursDeployed', 'fundingHourlyRate', 'fundingCapitalTurns']
        .forEach(id => D.updateElement(id, '—'));
      apr.classList.remove('profit', 'loss');
      return;
    }

    apr.textContent = F.fmtSignedPct(metrics.apr * 100, 2);
    apr.classList.toggle('profit', metrics.apr > 0);
    apr.classList.toggle('loss', metrics.apr < 0);

    D.updateElement('fundingCaption',
      `${F.formatCurrency(metrics.net)} net on ${F.fmtNum(metrics.notionalHours)} dollar·hours`);
    D.updateElement('fundingPeriod',
      `${F.fmtDateShort(metrics.periodStart)} → ${F.fmtDateShort(metrics.periodEnd)}`);
    D.updateElement('fundingAvgNotional', F.fmtNotional(metrics.avgNotional));
    D.updateElement('fundingHoursDeployed',
      `${metrics.hoursDeployed} / ${Math.round(metrics.windowHours)} h`);
    D.updateElement('fundingHourlyRate', F.fmtSignedPct(metrics.hourlyRate * 100, 5));
    D.updateElement('fundingCapitalTurns',
      isFinite(metrics.capitalTurns) ? `${metrics.capitalTurns.toFixed(2)}×` : '—');
  }

  function renderFundingKpiCards(payments) {
    const F = window.Format;
    const D = window.AppDom;
    const cutoff = getFundingCutoff();
    let received = 0, paid = 0;
    (payments || []).forEach(p => {
      const ts = new Date(p.createdAt || p.effectiveAt).getTime();
      if (isNaN(ts) || ts < cutoff) return;
      const amt = parseFloat(p.payment) || 0;
      if (amt > 0) received += amt; else paid += Math.abs(amt);
    });
    const net = received - paid;
    const windowLabel = getFundingWindowLabel();
    D.updateElement('fundingCaptured', F.formatCurrency(received));
    D.updateElement('fundingPaid', F.formatCurrency(-paid));
    D.updateElement('fundingNet', F.formatCurrency(net));
    D.updateElement('fundingCapturedWindow', windowLabel);
    D.updateElement('fundingPaidWindow', windowLabel);
    D.updateElement('fundingNetPct', windowLabel);
  }

  function renderFundingAnalysis(marketsMap, fundingPayments) {
    const C = window.AppConstants;
    const F = window.Format;
    const D = window.AppDom;

    const body = document.getElementById('fundingAnalysisBody');
    if (!body) return;
    body.innerHTML = '';

    const byMarket = {};
    const cutoff = getFundingCutoff();
    (fundingPayments || []).forEach(p => {
      const ts = new Date(p.createdAt).getTime();
      if (isNaN(ts) || ts < cutoff) return;
      const market = p.ticker || p.market || 'Unknown';
      const amt = parseFloat(p.payment || 0);
      if (!byMarket[market]) byMarket[market] = { received: 0, paid: 0, net: 0, count: 0 };
      if (amt > 0) byMarket[market].received += amt; else byMarket[market].paid += Math.abs(amt);
      byMarket[market].net += amt;
      byMarket[market].count += 1;
    });

    const entries = Object.keys(marketsMap || {}).map(ticker => {
      const m = marketsMap[ticker];
      const agg = byMarket[ticker] || { received: 0, paid: 0, net: 0, count: 0 };
      return {
        ticker,
        current: m?.nextFundingRate || '0',
        predicted: m?.defaultFundingRate1H || '0',
        received: agg.received,
        paid: agg.paid,
        net: agg.net,
      };
    });

    const filtered = entries
      .filter(e => Math.abs(e.net) > 0 || C.TUNABLES.ALWAYS_SHOW_TICKERS.includes(e.ticker))
      .slice(0, 15);

    filtered.forEach(e => {
      const tr = document.createElement('tr');
      const status = e.net > 0 ? 'profit' : e.net < 0 ? 'loss' : '';
      const currApr = (parseFloat(e.current) || 0);
      D.appendCell(tr, e.ticker);
      const currTd = D.appendCell(tr, F.formatFundingApr(parseFloat(e.current)), ['mono', currApr < 0 ? 'loss' : 'profit']);
      currTd.title = F.formatHourlyDetail(e.current);
      const predTd = D.appendCell(tr, F.formatFundingApr(parseFloat(e.predicted)), ['mono']);
      predTd.title = F.formatHourlyDetail(e.predicted);
      D.appendCell(tr, F.formatCurrency(e.received), ['mono', 'profit']);
      D.appendCell(tr, F.formatCurrency(-e.paid), ['mono', 'loss']);
      D.appendCell(tr, F.formatCurrency(e.net), ['mono', status]);
      D.appendCell(tr, status ? status.toUpperCase() : '-', ['mono']);
      body.appendChild(tr);
    });
    D.tagCells('fundingAnalysisBody');
  }

  // ─────────────────────────────────────────────────────────────────
  // Funding rate · price history chart
  // ─────────────────────────────────────────────────────────────────
  // Lazy-loaded on tab activation. In-memory cache keyed by ticker so
  // switching markets or returning to the tab doesn't refetch within
  // the freshness window. Refetch is triggered by: picker change, tab
  // re-activation when stale, or explicit consumer call.

  const CHART_FRESH_TTL_MS = 10 * 60 * 1000;
  const ChartState = {
    data: new Map(),    // ticker → { fundingRows, candleRows, fetchedAt }
    currentTicker: null,
    inflight: null,     // AbortController for the active fetch
    pickerInit: false
  };

  function isChartFresh(entry) {
    return entry && (Date.now() - entry.fetchedAt) < CHART_FRESH_TTL_MS;
  }

  function pickDefaultTicker(payments, marketsMap) {
    // Most-traded market by funding-payment count, scoped to tickers
    // still listed by /perpetualMarkets so we never offer a delisted
    // symbol the indexer will 404 on.
    const counts = new Map();
    (payments || []).forEach(p => {
      const tk = p.ticker || p.market;
      if (!tk || !marketsMap || !marketsMap[tk]) return;
      counts.set(tk, (counts.get(tk) || 0) + 1);
    });
    if (counts.size === 0) {
      if (marketsMap && marketsMap['ETH-USD']) return 'ETH-USD';
      const keys = Object.keys(marketsMap || {});
      return keys.length ? keys.sort()[0] : null;
    }
    let best = null, bestCount = -1;
    for (const [tk, c] of counts) {
      if (c > bestCount) { bestCount = c; best = tk; }
    }
    return best;
  }

  function populateChartPicker(payments, marketsMap) {
    const sel = document.getElementById('fundingChartTicker');
    if (!sel) return;
    const traded = new Set();
    (payments || []).forEach(p => {
      const tk = p.ticker || p.market;
      if (tk && marketsMap && marketsMap[tk]) traded.add(tk);
    });
    const all = Object.keys(marketsMap || {});
    const choices = Array.from(new Set([...traded, ...all])).sort();
    const prevSelection = ChartState.currentTicker || sel.value;
    sel.innerHTML = '';
    choices.forEach(tk => {
      const opt = document.createElement('option');
      opt.value = tk;
      opt.textContent = tk;
      sel.appendChild(opt);
    });
    if (prevSelection && choices.includes(prevSelection)) {
      sel.value = prevSelection;
      ChartState.currentTicker = prevSelection;
    } else {
      const def = pickDefaultTicker(payments, marketsMap) || choices[0] || null;
      if (def) { sel.value = def; ChartState.currentTicker = def; }
    }
  }

  function initChartPicker() {
    const sel = document.getElementById('fundingChartTicker');
    if (!sel || ChartState.pickerInit) return;
    ChartState.pickerInit = true;
    sel.addEventListener('change', () => {
      loadChartForTicker(sel.value);
    });
  }

  function setChartStatus(text, mode) {
    const el = document.getElementById('fundingChartStatus');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('fetching', mode === 'fetching');
    el.classList.toggle('error', mode === 'error');
  }

  function setChartEmpty(text) {
    const empty = document.getElementById('fundingChartEmpty');
    if (!empty) return;
    if (text) { empty.hidden = false; empty.textContent = text; }
    else      { empty.hidden = true;  empty.textContent = '—'; }
  }

  function currentChartCutoff() {
    const C = window.AppConstants;
    const w = getFundingWindowDays();
    const days = w === 'all'
      ? C.FUNDING_CHART_MAX_DAYS
      : Math.min(parseInt(w, 10), C.FUNDING_CHART_MAX_DAYS);
    return Date.now() - days * C.MS_PER_DAY;
  }

  function renderChartFromCache(ticker) {
    if (!window.AppCharts || !window.AppCharts.fundingRate) return;
    const entry = ChartState.data.get(ticker);
    if (!entry) { window.AppCharts.fundingRate.clear(); return; }
    const cutoffMs = currentChartCutoff();
    const hasFunding = (entry.fundingRows || []).some(r => {
      const t = Date.parse(r.effectiveAt);
      return !isNaN(t) && t >= cutoffMs;
    });
    if (!hasFunding) {
      window.AppCharts.fundingRate.clear();
      setChartEmpty(`No funding history for ${ticker} in window`);
      return;
    }
    setChartEmpty(null);
    window.AppCharts.fundingRate.render({
      ticker,
      fundingRows: entry.fundingRows,
      candleRows: entry.candleRows,
      cutoffMs
    });
  }

  async function fetchChartData(ticker, signal) {
    const C = window.AppConstants;
    const maxDays = C.FUNDING_CHART_MAX_DAYS;
    const fromMs = Date.now() - maxDays * C.MS_PER_DAY;
    const maxRows = maxDays * 24; // 1-hour cadence; +1 page slack handled by paginator
    const [fundingRes, candleRes] = await Promise.all([
      window.DydxApi.fetchHistoricalFunding(ticker, { maxRows }),
      window.DydxApi.fetchCandles(ticker, '1HOUR', { fromMs })
    ]);
    if (signal && signal.aborted) {
      const err = new Error('aborted'); err.name = 'AbortError'; throw err;
    }
    return {
      fundingRows: fundingRes.historicalFunding || [],
      candleRows: candleRes.candles || [],
      fetchedAt: Date.now()
    };
  }

  async function loadChartForTicker(ticker) {
    if (!ticker) return;
    ChartState.currentTicker = ticker;
    const entry = ChartState.data.get(ticker);
    if (isChartFresh(entry)) {
      renderChartFromCache(ticker);
      setChartStatus('', null);
      return;
    }
    if (ChartState.inflight) {
      try { ChartState.inflight.abort(); } catch (_) {}
    }
    const ctrl = new AbortController();
    ChartState.inflight = ctrl;
    setChartStatus('Fetching…', 'fetching');
    setChartEmpty(null);
    try {
      const data = await fetchChartData(ticker, ctrl.signal);
      if (ctrl.signal.aborted) return;
      ChartState.data.set(ticker, data);
      renderChartFromCache(ticker);
      setChartStatus('', null);
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      console.warn('[funding-chart] fetch failed', e && e.message);
      setChartStatus('Fetch failed', 'error');
      setChartEmpty('Fetch failed — try a different market');
    } finally {
      if (ChartState.inflight === ctrl) ChartState.inflight = null;
    }
  }

  // Called by activateTab('market'). Idempotent: re-renders from cache
  // when the data is still fresh; refetches when stale or absent.
  function ensureChartLoaded() {
    const tk = ChartState.currentTicker;
    if (!tk) return;
    const entry = ChartState.data.get(tk);
    if (isChartFresh(entry)) {
      renderChartFromCache(tk);
    } else {
      loadChartForTicker(tk);
    }
  }

  // Invoked by the dashboard's auto-refresh path. Drops the cache so
  // the next render/tab-activation refetches.
  function invalidateChartCache() {
    ChartState.data.clear();
  }

  // Single entry point for the Market Structure tab.
  function render(payments, marketsMap) {
    renderFundingHero(computeFundingHero(payments));
    renderFundingKpiCards(payments);
    renderFundingAnalysis(marketsMap, payments);
    populateChartPicker(payments, marketsMap);
    initChartPicker();
    // Re-render chart from cache (covers window-pill clicks). The
    // initial fetch happens via ensureChartLoaded on tab activation.
    if (ChartState.currentTicker) renderChartFromCache(ChartState.currentTicker);
  }

  // Window-toggle pills. Takes a no-arg rerender callback so the panel
  // module does not have to reach back into the inline orchestration's
  // allData state.
  function initToggle(rerender) {
    const pills = document.querySelectorAll('.funding-hero__pill');
    if (!pills.length) return;
    const active = getFundingWindowDays();
    pills.forEach(p => p.classList.toggle('active', p.dataset.window === active));
    pills.forEach(p => {
      p.addEventListener('click', () => {
        try { localStorage.setItem(FUNDING_WINDOW_KEY, p.dataset.window); } catch (e) {}
        pills.forEach(x => x.classList.toggle('active', x === p));
        if (typeof rerender === 'function') rerender();
      });
    });
  }

  window.AppPanels = window.AppPanels || {};
  window.AppPanels.market = {
    render,
    initToggle,
    getFundingWindowDays,
    getFundingCutoff,
    getFundingWindowLabel,
    ensureChartLoaded,
    invalidateChartCache,
    _internal: { pickDefaultTicker }
  };
})();
