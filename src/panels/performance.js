// Performance tab + per-trade Sharpe fallback + histogram primitive.
// Six exports under window.AppPanels.performance:
//
//   renderHistogram         — generic SVG-free bar chart primitive used by
//                             distribution displays (hold time / size).
//   renderMetrics           — top-of-tab KPI cards + WL distribution.
//   renderTables            — Monthly Performance + Performance-by-Asset
//                             tables.
//   renderTradeBasedRatios  — per-trade Sharpe/Sortino/Calmar fallback
//                             surface (called from risk-ratios IIFE when
//                             the time-series adequacy gate fails).
//   computeTradeBasedMetrics, computeAnnualizedTradeSharpe — pure helpers
//                             shared with the risk IIFE; exposed so the
//                             ratios card and the asset-Sharpe column can
//                             never adopt different return definitions.
//
// Depends on: window.RiskMetrics (classifyClosed, tradeReturn, computeSharpe,
// computeSortino, validDrawdownFromEquity, histPnlDrawdown, histPnlMonthly,
// computeTimeWeightedReturnsFromHist, assessAdequacy,
// computeAnnualizedFromReturns, marketPnL), window.AppConstants
// (MS_PER_HOUR, TUNABLES.RECENT_DECISIVE_CAP, TUNABLES.ASSET_SHARPE_MIN_N),
// window.Format (formatCurrency, formatShortNumber, fmtRatio),
// window.AppDom (updateElement, appendCell, tagCells).

(function () {
  'use strict';

  function renderHistogram(containerId, bins, opt = {}) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';
    if (!bins.length) return;
    const maxC = Math.max(1, ...bins.map(b => b.count));
    bins.forEach((b, i) => {
      const bar = document.createElement('div');
      bar.className = 'distribution-bar';
      const h = (b.count / maxC) * 100;
      bar.style.height = `${Math.max(2, h)}%`;
      if (opt.colorize === 'split') {
        const half = Math.floor(bins.length / 2);
        bar.style.background = i < half ? 'var(--loss)' : 'var(--gain)';
        bar.style.opacity = '0.55';
      } else if (opt.colorize === 'gain') {
        bar.style.background = 'var(--gain)';
        bar.style.opacity = '0.55';
      } else if (opt.colorize === 'loss') {
        bar.style.background = 'var(--loss)';
        bar.style.opacity = '0.55';
      }
      bar.title = `${b.label}: ${b.count}`;
      container.appendChild(bar);
    });
  }

  // Annualized per-trade Sharpe from a closed-trade list. Single helper
  // shared by the per-trade fallback (when the time-series gate fails)
  // and the per-asset Sharpe column so the two views can never adopt
  // different return definitions or annualization conventions.
  function computeAnnualizedTradeSharpe(closedAll, minSampleSize) {
    const F = window.Format;
    const decisive = (closedAll || [])
      .filter(p => p && p.closedAt && parseFloat(p.realizedPnl || 0) !== 0)
      .sort((a, b) => new Date(a.closedAt) - new Date(b.closedAt));
    if (decisive.length < minSampleSize) return '—';
    const rets = decisive
      .map(p => window.RiskMetrics.tradeReturn(p))
      .filter(r => r !== null && isFinite(r));
    if (rets.length < 2) return '—';
    const s = window.RiskMetrics.computeSharpe(rets, 0);
    if (s === null) return '—';
    const firstT = new Date(decisive[0].closedAt).getTime();
    const lastT = new Date(decisive[decisive.length - 1].closedAt).getTime();
    const years = (lastT - firstT) / (365.25 * 24 * 3600 * 1000);
    const tpy = years > 0 ? rets.length / years : 0;
    return F.fmtRatio(tpy > 0 ? s * Math.sqrt(tpy) : s);
  }

  // Per-trade Sharpe/Sortino/Calmar fallback. Independent statistic from
  // time-series Sharpe — meaningful when the equity time-series sample is
  // biased (post-wipeout window) but the trade log is rich enough.
  function computeTradeBasedMetrics(positions) {
    const decisive = (positions || [])
      .filter(p => p && p.status === 'CLOSED' && p.closedAt
        && parseFloat(p.realizedPnl || 0) !== 0)
      .sort((a, b) => new Date(a.closedAt) - new Date(b.closedAt));
    const returns = decisive
      .map(p => window.RiskMetrics.tradeReturn(p))
      .filter(r => r !== null && isFinite(r));
    if (returns.length < 2) return { ok: false, n: returns.length };

    const sharpe = window.RiskMetrics.computeSharpe(returns, 0);
    const sortino = window.RiskMetrics.computeSortino(returns, 0);

    const firstT = new Date(decisive[0].closedAt).getTime();
    const lastT = new Date(decisive[decisive.length - 1].closedAt).getTime();
    const yearsSpan = (lastT - firstT) / (365.25 * 24 * 3600 * 1000);
    const tpy = yearsSpan > 0 ? returns.length / yearsSpan : 0;
    const annFactor = tpy > 0 ? Math.sqrt(tpy) : 1;
    const annualize = (v) => (v === null || !isFinite(v)) ? v : v * annFactor;

    let w = 1;
    const wealth = [w];
    for (const r of returns) { w *= (1 + r); wealth.push(w); }
    const compoundFactor = wealth[wealth.length - 1];
    const wealthDD = window.RiskMetrics.validDrawdownFromEquity(wealth);
    const mddFraction = wealthDD ? wealthDD.pct / 100 : 0;
    const calmarAnn = (yearsSpan >= 1 / 52 && compoundFactor > 0 && mddFraction > 0)
      ? (Math.pow(compoundFactor, 1 / yearsSpan) - 1) / mddFraction
      : null;

    return {
      ok: true,
      n: returns.length,
      sharpeAnn: annualize(sharpe),
      sortinoAnn: annualize(sortino),
      calmarAnn,
      tpy,
      yearsSpan
    };
  }

  function renderTradeBasedRatios(tm, tsReason) {
    const F = window.Format;
    const D = window.AppDom;
    D.updateElement('sharpeRatio', F.fmtRatio(tm.sharpeAnn));
    D.updateElement('sortinoRatio', F.fmtRatio(tm.sortinoAnn));
    D.updateElement('calmarRatio', F.fmtRatio(tm.calmarAnn));

    const meta = `Per-trade · n=${tm.n} ⓘ`;
    const sharpeMeta = document.getElementById('sharpeMeta');
    const sortinoMeta = document.getElementById('sortinoMeta');
    const tipBase = `Per-trade Sharpe/Sortino computed from ${tm.n} decisive trades (scratches excluded).
Time-series fallback: ${tsReason}.
Return per trade: realizedPnl / (maxSize × entryPrice); falls back to sumOpen, then size, when maxSize is absent.
Annualized via √(trades-per-year ≈ ${tm.tpy.toFixed(0)}).
Small-N caveat: standard error widens; not a forward-Sharpe forecast.`;
    if (sharpeMeta) {
      sharpeMeta.textContent = meta;
      sharpeMeta.title = tipBase + '\nDenominator: standard deviation of trade returns.';
    }
    if (sortinoMeta) {
      sortinoMeta.textContent = meta;
      sortinoMeta.title = tipBase + '\nDenominator: downside deviation of trade returns (target semi-deviation).';
    }
  }

  function renderMetrics(positions, precomputedCls) {
    const C = window.AppConstants;
    const F = window.Format;
    const D = window.AppDom;

    const cls = precomputedCls || window.RiskMetrics.classifyClosed(positions);
    const closedSorted = cls.all.slice().sort((a, b) =>
      new Date(a.closedAt) - new Date(b.closedAt));
    let maxW = 0, curW = 0, maxL = 0, curL = 0;
    let bestPnL = 0, curBest = 0, worstPnL = 0, curWorst = 0;
    closedSorted.forEach(p => {
      const pnl = parseFloat(p.realizedPnl || 0);
      if (pnl > 0) {
        curW++; maxW = Math.max(maxW, curW); curBest += pnl;
        worstPnL = Math.min(worstPnL, curWorst);
        curL = 0; curWorst = 0;
      } else if (pnl < 0) {
        curL++; maxL = Math.max(maxL, curL); curWorst += pnl;
        bestPnL = Math.max(bestPnL, curBest);
        curW = 0; curBest = 0;
      }
    });
    bestPnL = Math.max(bestPnL, curBest);
    worstPnL = Math.min(worstPnL, curWorst);
    D.updateElement('maxConsecWins', maxW > 0 ? String(maxW) : '—');
    D.updateElement('maxConsecWinsDetail', maxW > 0 && bestPnL ? F.formatCurrency(bestPnL) : '');
    D.updateElement('maxConsecLosses', maxL > 0 ? String(maxL) : '—');
    D.updateElement('maxConsecLossesDetail', maxL > 0 && worstPnL ? F.formatCurrency(worstPnL) : '');

    const avgWin = cls.winCount ? cls.grossWin / cls.winCount : 0;
    const avgLoss = cls.lossCount ? cls.grossLoss / cls.lossCount : 0;
    const rrr = avgLoss > 0 ? avgWin / avgLoss : null;
    const rrrDetailEl = document.getElementById('avgRRRDetail');
    if (rrr != null) {
      D.updateElement('avgRRR', rrr.toFixed(2) + ':1');
      const breakevenWR = (1 / (1 + rrr)) * 100;
      const actualWR = cls.decisiveCount
        ? (cls.winCount / cls.decisiveCount) * 100
        : null;
      if (actualWR !== null && rrrDetailEl) {
        rrrDetailEl.textContent = `WR ${actualWR.toFixed(1)}% vs ${breakevenWR.toFixed(1)}% breakeven`;
        rrrDetailEl.className = `metric-change mono ${actualWR >= breakevenWR ? 'profit' : 'loss'}`;
      } else {
        D.updateElement('avgRRRDetail', `${breakevenWR.toFixed(1)}% WR needed to break even`);
        if (rrrDetailEl) rrrDetailEl.className = 'metric-change mono';
      }
    } else {
      D.updateElement('avgRRR', '—');
      D.updateElement('avgRRRDetail', '');
      if (rrrDetailEl) rrrDetailEl.className = 'metric-change mono';
    }

    const decisive = closedSorted.filter(p => {
      const r = parseFloat(p.realizedPnl || 0);
      return r > 0 || r < 0;
    });
    const allTimeWR = decisive.length
      ? (cls.winCount / decisive.length) * 100
      : 0;
    const N = Math.min(C.TUNABLES.RECENT_DECISIVE_CAP, decisive.length);
    const recent = decisive.slice(-N);
    const recentWins = recent.filter(p => parseFloat(p.realizedPnl || 0) > 0).length;
    const recentWR = recent.length ? (recentWins / recent.length) * 100 : 0;
    const trendEl = document.getElementById('winRateTrend');
    if (trendEl) {
      if (decisive.length === 0 || N < 2) {
        trendEl.textContent = '—';
        trendEl.className = 'metric-value mono';
      } else {
        const delta = recentWR - allTimeWR;
        const arrow = delta > 1 ? '↑' : delta < -1 ? '↓' : '→';
        const klass = delta > 1 ? 'profit' : delta < -1 ? 'loss' : '';
        trendEl.textContent = `${arrow} ${recentWR.toFixed(1)}%`;
        trendEl.className = 'metric-value mono ' + klass;
      }
    }
    D.updateElement('winRateTrendDetail',
      decisive.length && N >= 2
        ? `Last ${N} decisive (vs ${allTimeWR.toFixed(1)}% all-time)`
        : '');
    const closed = cls.all;

    const container = document.getElementById('winLossDistribution');
    if (container) {
      container.innerHTML = '';
      const returns = closed.map(p => {
        const entry = parseFloat(p.entryPrice || 0);
        const exit = parseFloat(p.exitPrice || 0);
        const side = (p.side || '').toUpperCase();
        if (!entry || !exit) return 0;
        const r = (exit - entry) / entry * (side === 'LONG' ? 1 : -1);
        return r;
      }).filter(v => isFinite(v));
      if (returns.length > 0) {
        const bins = 21;
        const minP = -0.2, maxP = 0.2;
        const counts = new Array(bins).fill(0);
        returns.forEach(r => {
          const clamped = Math.max(minP, Math.min(maxP, r));
          const idx = Math.min(bins - 1, Math.max(0, Math.floor((clamped - minP) / (maxP - minP) * bins)));
          counts[idx] += 1;
        });
        const maxC = Math.max(...counts);
        counts.forEach((c, i) => {
          const bar = document.createElement('div');
          bar.className = 'distribution-bar';
          const h = maxC > 0 ? (c / maxC) * 100 : 0;
          bar.style.height = `${Math.max(2, h)}%`;
          const isLoss = (i < Math.floor(bins / 2));
          bar.style.background = isLoss ? 'var(--loss)' : 'var(--gain)';
          bar.style.opacity = '0.55';
          let label;
          if (i === 0) label = `<${(minP * 100).toFixed(0)}% bin`;
          else if (i === bins - 1) label = `>${(maxP * 100).toFixed(0)}% bin`;
          else label = `${((minP + (i + 0.5) * (maxP - minP) / bins) * 100).toFixed(1)}% bin`;
          bar.title = `${label}: ${c}`;
          container.appendChild(bar);
        });
        const title = document.getElementById('winLossTitle');
        if (title) title.textContent = `Win/Loss Distribution (${returns.length} trades)`;
      } else {
        const title = document.getElementById('winLossTitle');
        if (title) title.textContent = 'Win/Loss Distribution (no data)';
      }
    }

    // Hold time + size distributions on Positions tab from real data
    const closedPos = positions.filter(p => p.status === 'CLOSED');
    const holdHours = closedPos.map(p => {
      const c = new Date(p.createdAt).getTime();
      const d = new Date(p.closedAt).getTime();
      return (isFinite(c) && isFinite(d) && d > c) ? (d - c) / C.MS_PER_HOUR : null;
    }).filter(v => v !== null);
    const holdBuckets = [
      { label: '0–1h',     range: [0, 1],     count: 0 },
      { label: '1–4h',     range: [1, 4],     count: 0 },
      { label: '4–12h',    range: [4, 12],    count: 0 },
      { label: '12–24h',   range: [12, 24],   count: 0 },
      { label: '1–3d',     range: [24, 72],   count: 0 },
      { label: '3–7d',     range: [72, 168],  count: 0 },
      { label: '>7d',      range: [168, Infinity], count: 0 }
    ];
    holdHours.forEach(h => {
      const b = holdBuckets.find(b => h >= b.range[0] && h < b.range[1]);
      if (b) b.count += 1;
    });
    renderHistogram('holdTimeDistribution', holdBuckets, { colorize: 'gain' });

    const notionals = closedPos.map(p => {
      const sz = parseFloat(p.sumOpen || p.size || 0);
      const px = parseFloat(p.entryPrice || 0);
      return (sz > 0 && px > 0) ? sz * px : null;
    }).filter(v => v !== null).sort((a, b) => a - b);
    if (notionals.length) {
      const numBins = Math.min(12, Math.max(4, notionals.length));
      const min = notionals[0], max = notionals[notionals.length - 1];
      const step = (max - min) / numBins || 1;
      const bins = [];
      for (let i = 0; i < numBins; i++) {
        const lo = min + i * step;
        const hi = i === numBins - 1 ? Infinity : min + (i + 1) * step;
        bins.push({
          label: `$${F.formatShortNumber(lo)}–${i === numBins - 1 ? '∞' : '$' + F.formatShortNumber(hi)}`,
          range: [lo, hi], count: 0
        });
      }
      notionals.forEach(n => {
        const b = bins.find(b => n >= b.range[0] && n < b.range[1]) || bins[bins.length - 1];
        b.count += 1;
      });
      renderHistogram('sizeDistribution', bins, { colorize: 'gain' });
    } else {
      renderHistogram('sizeDistribution', [], {});
    }
  }

  function renderTables(positions, historicalPnl = [], marketAggIn = null) {
    const C = window.AppConstants;
    const F = window.Format;
    const D = window.AppDom;

    // Bucket closed trades by month using the same classifier rules
    // as the header so monthly win-rate denominators match the header
    // win-rate denominator (decisive trades only). The PNL column for
    // each month comes from /historical-pnl deltas.
    const monthly = {};
    positions.filter(p => p.status === 'CLOSED').forEach(p => {
      const d = new Date(p.closedAt || p.createdAt);
      if (isNaN(d)) return;
      const key = d.toLocaleString('en-US', { month: 'long', year: 'numeric' });
      if (!monthly[key]) {
        monthly[key] = {
          closedCount: 0, decisiveCount: 0,
          wins: 0, losses: 0,
          winSum: 0, lossSum: 0
        };
      }
      const pnl = parseFloat(p.realizedPnl || 0);
      monthly[key].closedCount += 1;
      if (pnl > 0) {
        monthly[key].wins += 1;
        monthly[key].winSum += pnl;
        monthly[key].decisiveCount += 1;
      } else if (pnl < 0) {
        monthly[key].losses += 1;
        monthly[key].lossSum += Math.abs(pnl);
        monthly[key].decisiveCount += 1;
      }
    });

    const hist = Array.isArray(historicalPnl)
      ? historicalPnl.slice().sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''))
      : [];
    const byMonthHist = {};
    if (hist.length > 2) {
      hist.forEach(pt => {
        const d = new Date(pt.createdAt);
        if (isNaN(d)) return;
        const key = d.toLocaleString('en-US', { month: 'long', year: 'numeric' });
        if (!byMonthHist[key]) byMonthHist[key] = [];
        byMonthHist[key].push(pt);
      });
    }
    const monthlyHistDeltas = window.RiskMetrics.histPnlMonthly(hist);
    Object.keys(monthlyHistDeltas).forEach(key => {
      if (!monthly[key]) {
        monthly[key] = {
          closedCount: 0, decisiveCount: 0,
          wins: 0, losses: 0,
          winSum: 0, lossSum: 0
        };
      }
    });
    const bodyM = document.getElementById('monthlyPerformanceBody');
    if (bodyM) {
      bodyM.innerHTML = '';
      Object.entries(monthly)
        .sort((a, b) => new Date(b[0]) - new Date(a[0]))
        .forEach(([label, m]) => {
          const tr = document.createElement('tr');
          const winRate = m.decisiveCount
            ? (m.wins / m.decisiveCount) * 100
            : 0;
          const avgWin = m.wins ? m.winSum / m.wins : 0;
          const avgLoss = m.losses ? m.lossSum / m.losses : 0;
          const pf = m.lossSum > 0 ? (m.winSum / m.lossSum) : null;

          let sharpeTxt = '—';
          let mddTxt = '—';
          const monthHist = byMonthHist[label] || [];
          if (monthHist.length > 2) {
            const rets = window.RiskMetrics.computeTimeWeightedReturnsFromHist(monthHist);
            const tsSeg = monthHist.map(p => p.createdAt);
            const adq = window.RiskMetrics.assessAdequacy(rets, tsSeg, monthHist.length);
            if (adq.adequate) {
              const ann = window.RiskMetrics.computeAnnualizedFromReturns(
                rets, tsSeg, { mar: 0 });
              sharpeTxt = F.fmtRatio(ann.sharpeAnnualized);
            }
            const monthDD = window.RiskMetrics.histPnlDrawdown(monthHist);
            if (monthDD.dollarDrawdown > 0) {
              mddTxt = F.formatCurrency(-monthDD.dollarDrawdown);
            }
          }
          const tradesCol = m.closedCount === m.decisiveCount
            ? String(m.closedCount)
            : `${m.decisiveCount} (+${m.closedCount - m.decisiveCount})`;
          const histEntry = monthlyHistDeltas[label];
          const pnlCellTxt = histEntry && histEntry.hasData
            ? F.formatCurrency(histEntry.delta)
            : '—';
          const pnlCellCls = histEntry && histEntry.hasData
            ? (histEntry.delta >= 0 ? 'profit' : 'loss')
            : '';
          D.appendCell(tr, label);
          D.appendCell(tr, pnlCellTxt, ['mono', pnlCellCls]);
          D.appendCell(tr, winRate.toFixed(1) + '%', ['mono']);
          D.appendCell(tr, tradesCol, ['mono']);
          D.appendCell(tr, F.formatCurrency(avgWin), ['mono', avgWin >= 0 ? 'profit' : 'loss']);
          D.appendCell(tr, F.formatCurrency(-avgLoss), ['mono', 'loss']);
          D.appendCell(tr, pf === null ? 'N/A' : F.fmtRatio(pf), ['mono']);
          D.appendCell(tr, mddTxt, ['mono', mddTxt !== '—' ? 'loss' : '']);
          D.appendCell(tr, sharpeTxt, ['mono']);
          bodyM.appendChild(tr);
        });
      D.tagCells('monthlyPerformanceBody');
    }

    const market = marketAggIn || window.RiskMetrics.marketPnL(positions);
    const positionsByMarket = new Map();
    positions.forEach(p => {
      const m = p.market || 'Unknown';
      if (!positionsByMarket.has(m)) positionsByMarket.set(m, []);
      positionsByMarket.get(m).push(p);
    });
    const bodyA = document.getElementById('assetPerformanceBody');
    if (bodyA) {
      bodyA.innerHTML = '';
      Object.entries(market)
        .filter(([_, v]) => v.closedCount + v.openCount > 0)
        .sort((a, b) => Math.abs(b[1].total) - Math.abs(a[1].total))
        .forEach(([ticker, slot]) => {
          const assetCls = window.RiskMetrics.classifyClosed(
            positionsByMarket.get(ticker) || []
          );
          const winRate = assetCls.decisiveCount
            ? (assetCls.winCount / assetCls.decisiveCount) * 100
            : 0;
          const avgPnL = assetCls.decisiveCount
            ? assetCls.totalRealized / assetCls.decisiveCount
            : 0;
          const best = assetCls.winCount
            ? assetCls.grossWin / assetCls.winCount
            : 0;
          const worstAbs = assetCls.lossCount
            ? assetCls.grossLoss / assetCls.lossCount
            : 0;
          const assetSharpeTxt = computeAnnualizedTradeSharpe(assetCls.all, C.TUNABLES.ASSET_SHARPE_MIN_N);
          const tradesCol = assetCls.closedCount === assetCls.decisiveCount
            ? String(assetCls.closedCount)
            : `${assetCls.decisiveCount} (+${assetCls.scratchCount})`;
          const fundingCol = slot.netFunding || 0;
          const feesContribution = -(slot.fees || 0);
          const tr = document.createElement('tr');
          D.appendCell(tr, ticker);
          D.appendCell(tr, F.formatCurrency(slot.total), ['mono', slot.total >= 0 ? 'profit' : 'loss']);
          D.appendCell(tr, F.formatCurrency(fundingCol), ['mono', fundingCol > 0 ? 'profit' : (fundingCol < 0 ? 'loss' : '')]);
          D.appendCell(tr, F.formatCurrency(feesContribution), ['mono', feesContribution > 0 ? 'profit' : (feesContribution < 0 ? 'loss' : '')]);
          D.appendCell(tr, tradesCol, ['mono']);
          D.appendCell(tr, winRate.toFixed(1) + '%', ['mono']);
          D.appendCell(tr, F.formatCurrency(avgPnL), ['mono', avgPnL >= 0 ? 'profit' : 'loss']);
          D.appendCell(tr, F.formatCurrency(best), ['mono', 'profit']);
          D.appendCell(tr, F.formatCurrency(-worstAbs), ['mono', 'loss']);
          D.appendCell(tr, assetSharpeTxt, ['mono']);
          bodyA.appendChild(tr);
        });
      D.tagCells('assetPerformanceBody');
    }
  }

  window.AppPanels = window.AppPanels || {};
  window.AppPanels.performance = {
    renderHistogram,
    renderMetrics,
    renderTables,
    renderTradeBasedRatios,
    computeTradeBasedMetrics,
    computeAnnualizedTradeSharpe
  };
})();
