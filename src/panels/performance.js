// Performance tab + per-trade Sharpe fallback + histogram primitive.
// Six exports under window.AppPanels.performance:
//
//   renderHistogram         — generic SVG-free bar chart primitive used by
//                             distribution displays (win/loss returns,
//                             hold time, size).
//   renderMetrics           — top-of-tab KPI cards + WL distribution.
//   renderTables            — Monthly Performance + Performance-by-Asset
//                             tables.
//   renderTradeBasedRatios  — per-trade Sharpe/Sortino/Calmar fallback
//                             surface (called from risk-ratios IIFE when
//                             the time-series adequacy gate fails).
//   computeTradeBasedMetrics, computeAnnualizedTradeSharpe — pure helpers
//                             over a classifyClosed result; both build
//                             their returns and annualization factor with
//                             tradeReturnSample, so the ratios card and
//                             the asset-Sharpe column can never adopt
//                             different definitions.
//
// Depends on: window.RiskMetrics (classifyClosed, classifyByMonth,
// tradeReturn, peakNotional, computeSharpe, computeSortino,
// validDrawdownFromEquity, histPnlDrawdown, histPnlMonthly,
// computeTimeWeightedReturnsFromHist, assessAdequacy,
// computeAnnualizedFromReturns, marketPnL), window.AppConstants
// (MS_PER_HOUR, MS_PER_YEAR, PERCENT, TUNABLES.RECENT_DECISIVE_CAP,
// TUNABLES.ASSET_SHARPE_MIN_N), window.Format (formatCurrency,
// formatShortNumber, fmtRatio, signClass, breakevenVerdict),
// window.AppDom (updateElement, appendCell, tagCells).

(function () {
  'use strict';

  const MIN_BAR_PERCENT = 2;
  // Position Size Distribution bin count, clamped to this range.
  const SIZE_BINS_MIN = 4;
  const SIZE_BINS_MAX = 12;

  // Labeled horizontal histogram: one row per bin with its label, a bar
  // scaled to the largest count, and the count itself, so the chart reads
  // without hovering (and at phone width). A bin's `tone` ('gain' |
  // 'loss') colours its bar, else `opt.tone` does. `emptyText` replaces
  // the rows when there is nothing to plot.
  function renderHistogram(containerId, bins, opt = {}) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';
    container.classList.add('distribution-rows');
    if (!bins.length) {
      if (opt.emptyText) {
        const note = document.createElement('p');
        note.className = 'distribution-empty';
        note.textContent = opt.emptyText;
        container.appendChild(note);
      }
      return;
    }
    const maxC = Math.max(1, ...bins.map(b => b.count));
    bins.forEach(b => {
      const label = document.createElement('span');
      label.className = 'distribution-label mono';
      label.textContent = b.label;

      const track = document.createElement('div');
      track.className = 'distribution-track';
      const bar = document.createElement('div');
      bar.className = 'distribution-bar';
      bar.style.width = b.count > 0 ? `${Math.max(MIN_BAR_PERCENT, (b.count / maxC) * window.AppConstants.PERCENT)}%` : '0';
      const tone = b.tone || opt.tone;
      if (tone) bar.classList.add(`is-${tone}`);
      track.title = `${b.label}: ${b.count}`;
      track.appendChild(bar);

      const count = document.createElement('span');
      count.className = 'distribution-count mono';
      count.textContent = String(b.count);

      container.append(label, track, count);
    });
  }

  // Per-trade returns (percent) in RETURN_BIN_WIDTH-wide bins over
  // ±RETURN_RANGE, with an edge at 0 so a bin never mixes losses and
  // gains: bins below 0 read as losses, the rest as gains. The outer bins
  // also take everything beyond the range. Labels are the bin's range.
  const RETURN_RANGE = 20;
  const RETURN_BIN_WIDTH = 2;
  const RETURN_BINS_PER_SIDE = RETURN_RANGE / RETURN_BIN_WIDTH;

  function returnBins(returnsPercent) {
    if (!returnsPercent.length) return [];
    const bins = [];
    for (let i = -RETURN_BINS_PER_SIDE; i < RETURN_BINS_PER_SIDE; i++) {
      const lo = i * RETURN_BIN_WIDTH;
      const hi = lo + RETURN_BIN_WIDTH;
      const label = i === -RETURN_BINS_PER_SIDE ? `< ${hi}%`
        : i === RETURN_BINS_PER_SIDE - 1 ? `≥ ${lo}%`
        : `${lo}% to ${hi}%`;
      bins.push({ label, count: 0, tone: lo < 0 ? 'loss' : 'gain' });
    }
    returnsPercent.forEach(r => {
      const i = Math.floor(r / RETURN_BIN_WIDTH);
      const clamped = Math.max(-RETURN_BINS_PER_SIDE, Math.min(RETURN_BINS_PER_SIDE - 1, i));
      bins[clamped + RETURN_BINS_PER_SIDE].count += 1;
    });
    return bins;
  }

  // Wins and losses (scratches excluded) in closing order.
  function decisiveByCloseTime(cls) {
    return cls.wins.concat(cls.losses)
      .filter(p => p.closedAt)
      .sort((a, b) => new Date(a.closedAt) - new Date(b.closedAt));
  }

  // Fewer per-trade returns than this cannot produce a Sharpe.
  const MIN_TRADE_RETURNS = 2;
  // Per-trade Calmar needs at least one week of closed trades.
  const MIN_CALMAR_YEARS = 1 / 52;

  // Per-trade returns of the decisive trades in a classifyClosed result,
  // in closing order, with the span they cover and the √(trades per year)
  // annualization factor. { ok: false, reason } while the classifier's
  // inputs are incomplete or fewer than `minTrades` decisive trades exist.
  // The one place the per-trade fallback and the per-asset Sharpe column
  // get their returns and annualization from.
  function tradeReturnSample(cls, minTrades = MIN_TRADE_RETURNS) {
    if (cls.incompleteReason) return { ok: false, n: 0, reason: cls.incompleteReason };
    const decisive = decisiveByCloseTime(cls);
    const returns = decisive
      .map(p => window.RiskMetrics.tradeReturn(p))
      .filter(r => r !== null && isFinite(r));
    if (decisive.length < minTrades || returns.length < MIN_TRADE_RETURNS) {
      return { ok: false, n: returns.length };
    }
    const firstT = new Date(decisive[0].closedAt).getTime();
    const lastT = new Date(decisive[decisive.length - 1].closedAt).getTime();
    const yearsSpan = (lastT - firstT) / window.AppConstants.MS_PER_YEAR;
    const tpy = yearsSpan > 0 ? returns.length / yearsSpan : 0;
    const annualize = (v) => (v === null || !isFinite(v) || !(tpy > 0)) ? v : v * Math.sqrt(tpy);
    return { ok: true, n: returns.length, returns, yearsSpan, tpy, annualize };
  }

  // Annualized per-trade Sharpe of one classifyClosed result (the
  // per-asset Sharpe column), formatted; '—' when unavailable.
  function computeAnnualizedTradeSharpe(cls, minSampleSize) {
    const sample = tradeReturnSample(cls, minSampleSize);
    if (!sample.ok) return '—';
    const s = window.RiskMetrics.computeSharpe(sample.returns, 0);
    return s === null ? '—' : window.Format.fmtRatio(sample.annualize(s));
  }

  // Per-trade Sharpe/Sortino/Calmar fallback. Independent statistic from
  // time-series Sharpe — meaningful when the equity time-series sample is
  // biased (post-wipeout window) but the trade log is rich enough.
  // Returns { ok: false, reason } while the classifier's inputs are
  // incomplete, like every other classifier-derived number.
  function computeTradeBasedMetrics(cls) {
    const sample = tradeReturnSample(cls);
    if (!sample.ok) return sample;
    const { returns, yearsSpan, tpy, annualize } = sample;

    const sharpe = window.RiskMetrics.computeSharpe(returns, 0);
    const sortino = window.RiskMetrics.computeSortino(returns, 0);

    let w = 1;
    const wealth = [w];
    for (const r of returns) { w *= (1 + r); wealth.push(w); }
    const compoundFactor = wealth[wealth.length - 1];
    const wealthDD = window.RiskMetrics.validDrawdownFromEquity(wealth);
    const mddFraction = wealthDD ? wealthDD.pct / window.AppConstants.PERCENT : 0;
    const calmarAnn = (yearsSpan >= MIN_CALMAR_YEARS && compoundFactor > 0 && mddFraction > 0)
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
Return per trade: profit / (peak size × entry VWAP), all from fills.
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
    const classifierGap = cls.incompleteReason !== '';
    const closedSorted = cls.all.slice().sort((a, b) =>
      new Date(a.closedAt) - new Date(b.closedAt));
    let maxW = 0, curW = 0, maxL = 0, curL = 0;
    let bestPnL = 0, curBest = 0, worstPnL = 0, curWorst = 0;
    if (!classifierGap) closedSorted.forEach(p => {
      const pnl = p.profit;
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
    D.updateElement('maxConsecWinsDetail', classifierGap ? cls.incompleteReason
      : (maxW > 0 && bestPnL ? F.formatCurrency(bestPnL) : ''));
    D.updateElement('maxConsecLosses', maxL > 0 ? String(maxL) : '—');
    D.updateElement('maxConsecLossesDetail', classifierGap ? cls.incompleteReason
      : (maxL > 0 && worstPnL ? F.formatCurrency(worstPnL) : ''));

    const rrr = cls.payoff;
    const rrrDetailEl = document.getElementById('avgRRRDetail');
    if (rrr !== null) {
      D.updateElement('avgRRR', rrr.toFixed(2) + ':1');
      const breakevenWR = cls.breakevenWinRate;
      const actualWR = cls.winRate;
      if (actualWR !== null && rrrDetailEl) {
        const verdict = F.breakevenVerdict(actualWR, breakevenWR);
        rrrDetailEl.textContent = verdict.text;
        rrrDetailEl.className = `metric-change mono ${verdict.toneClass}`;
      } else {
        D.updateElement('avgRRRDetail', `${breakevenWR.toFixed(1)}% WR needed to break even`);
        if (rrrDetailEl) rrrDetailEl.className = 'metric-change mono';
      }
    } else {
      D.updateElement('avgRRR', '—');
      D.updateElement('avgRRRDetail', classifierGap ? cls.incompleteReason : '');
      if (rrrDetailEl) rrrDetailEl.className = 'metric-change mono';
    }

    const decisive = classifierGap ? [] : decisiveByCloseTime(cls);
    const allTimeWR = cls.winRate !== null ? cls.winRate : 0;
    const N = Math.min(C.TUNABLES.RECENT_DECISIVE_CAP, decisive.length);
    const recent = decisive.slice(-N);
    const recentWins = recent.filter(p => p.profit > 0).length;
    const recentWR = recent.length ? (recentWins / recent.length) * window.AppConstants.PERCENT : 0;
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
      classifierGap ? cls.incompleteReason
        : decisive.length && N >= 2
          ? `Last ${N} decisive (vs ${allTimeWR.toFixed(1)}% all-time)`
          : '');
    // Decisive trades only, like the Win Rate card, so the loss bins add
    // up to its losses and the gain bins to its wins.
    const returns = decisive
      .map(p => window.RiskMetrics.tradeReturn(p))
      .filter(r => r !== null)
      .map(r => r * window.AppConstants.PERCENT);
    renderHistogram('winLossDistribution', returnBins(returns));
    const winLossTitle = document.getElementById('winLossTitle');
    if (winLossTitle) {
      winLossTitle.textContent = returns.length > 0
        ? `Win/Loss Distribution (${returns.length} decisive trades)`
        : classifierGap
          ? `Win/Loss Distribution (${cls.incompleteReason})`
          : 'Win/Loss Distribution (no data)';
    }

    // Hold time + size distributions on Positions tab from real data
    const closedPos = positions.filter(p => p.status === 'CLOSED');
    const holdHours = closedPos.map(p => {
      const c = new Date(p.createdAt).getTime();
      const d = new Date(p.closedAt).getTime();
      return (isFinite(c) && isFinite(d) && d >= c) ? (d - c) / C.MS_PER_HOUR : null;
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
    renderHistogram('holdTimeDistribution', holdBuckets, { tone: 'gain' });

    // Peak notional (RiskMetrics.peakNotional), the same denominator as
    // tradeReturn. All-or-nothing like the classifier.
    const notionals = classifierGap ? [] : closedPos
      .map(p => window.RiskMetrics.peakNotional(p))
      .filter(v => v !== null)
      .sort((a, b) => a - b);
    if (notionals.length) {
      const numBins = Math.min(SIZE_BINS_MAX, Math.max(SIZE_BINS_MIN, notionals.length));
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
      renderHistogram('sizeDistribution', bins, { tone: 'gain' });
    } else {
      renderHistogram('sizeDistribution', [], {
        emptyText: classifierGap ? cls.incompleteReason : 'No closed positions'
      });
    }
  }

  // Table cells for a classifyClosed result. A null ratio renders '—'
  // (incomplete inputs, or no trade in the bucket), except a profit
  // factor with no losses, which reads 'N/A'. TRADES reads 'decisive
  // (+scratches)'; while fill data is incomplete the split is unknown, so
  // it shows the closed count alone with the reason on hover, and '—'
  // when the CLOSED list itself is unavailable (`closedGap`).
  function appendTradesCell(tr, cls, closedGap) {
    const D = window.AppDom;
    if (cls.incompleteReason) {
      D.appendCell(tr, closedGap ? '—' : String(cls.closedCount), ['mono']).title = cls.incompleteReason;
      return;
    }
    D.appendCell(tr, cls.scratchCount === 0
      ? String(cls.closedCount)
      : `${cls.decisiveCount} (+${cls.scratchCount})`, ['mono']);
  }

  function winRateText(cls) {
    return cls.winRate === null ? '—' : cls.winRate.toFixed(1) + '%';
  }

  function profitFactorText(cls) {
    if (cls.profitFactor !== null) return window.Format.fmtRatio(cls.profitFactor);
    return cls.incompleteReason || cls.decisiveCount === 0 ? '—' : 'N/A';
  }

  function appendLedgerCell(tr, value, gap) {
    const F = window.Format;
    if (gap) {
      window.AppDom.appendCell(tr, '—', ['mono']).title = gap;
      return;
    }
    window.AppDom.appendCell(tr, F.formatCurrency(value), ['mono', F.signClass(value)]);
  }

  function appendAvgCell(tr, value) {
    const F = window.Format;
    window.AppDom.appendCell(tr, value === null ? '—' : F.formatCurrency(value), ['mono', F.signClass(value)]);
  }

  // gaps: { funding, fees, marketProfit, openPositions, closed,
  // classifier } from processData, each '' when its inputs loaded, else
  // the reason they did not. marketProfit(ticker) / funding / fees blank
  // the asset table's PROFIT / FUNDING / FEES; openPositions (the OPEN
  // rows are unknown) makes a market's open count unknown, so no market
  // is hidden for holding no known position; closed (the CLOSED list
  // failed) and classifier (the account classifier's incompleteReason)
  // blank every classifier cell.
  function renderTables(positions, historicalPnl = [], marketAggIn = null, gaps = {}) {
    const C = window.AppConstants;
    const F = window.Format;
    const D = window.AppDom;

    // Bucket closed trades by month with the header's classifier, so
    // monthly win-rate denominators match the header's (decisive trades
    // only). The classifier is all-or-nothing account-wide: while any
    // closed position is incomplete (or the CLOSED list is unknown) every
    // month's and every asset's ratios blank together with the header's.
    // The PNL column for each month comes from /historical-pnl deltas.
    const classifierReason = gaps.classifier || gaps.closed || '';
    const monthly = window.RiskMetrics.classifyByMonth(positions, classifierReason);

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
      if (!monthly[key]) monthly[key] = window.RiskMetrics.classifyClosed([], classifierReason);
    });
    const bodyM = document.getElementById('monthlyPerformanceBody');
    if (bodyM) {
      bodyM.innerHTML = '';
      Object.entries(monthly)
        .sort((a, b) => new Date(b[0]) - new Date(a[0]))
        .forEach(([label, m]) => {
          const tr = document.createElement('tr');

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
          const histEntry = monthlyHistDeltas[label];
          const pnlDelta = histEntry && histEntry.hasData ? histEntry.delta : null;
          D.appendCell(tr, label);
          D.appendCell(tr, pnlDelta === null ? '—' : F.formatCurrency(pnlDelta), ['mono', F.signClass(pnlDelta)]);
          D.appendCell(tr, winRateText(m), ['mono']);
          appendTradesCell(tr, m, gaps.closed);
          appendAvgCell(tr, m.avgWin);
          appendAvgCell(tr, m.avgLoss === null ? null : -m.avgLoss);
          D.appendCell(tr, profitFactorText(m), ['mono']);
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
    const openCountUnknown = Boolean(gaps.openPositions);
    const marketProfitGap = ticker => (gaps.marketProfit ? gaps.marketProfit(ticker) : '');
    if (bodyA) {
      bodyA.innerHTML = '';
      Object.entries(market)
        .filter(([_, v]) => v.closedCount > 0 || v.openCount > 0 || openCountUnknown)
        .sort((a, b) => Math.abs(b[1].total) - Math.abs(a[1].total))
        .forEach(([ticker, slot]) => {
          const assetCls = window.RiskMetrics.classifyClosed(
            positionsByMarket.get(ticker) || [], classifierReason
          );
          const assetSharpeTxt = computeAnnualizedTradeSharpe(assetCls, C.TUNABLES.ASSET_SHARPE_MIN_N);
          const tr = document.createElement('tr');
          D.appendCell(tr, ticker);
          appendLedgerCell(tr, slot.total, marketProfitGap(ticker));
          appendLedgerCell(tr, slot.netFunding || 0, gaps.funding);
          appendLedgerCell(tr, -(slot.fees || 0), gaps.fees);
          appendTradesCell(tr, assetCls, gaps.closed);
          D.appendCell(tr, winRateText(assetCls), ['mono']);
          appendAvgCell(tr, assetCls.expectancy);
          appendAvgCell(tr, assetCls.bestTrade);
          appendAvgCell(tr, assetCls.worstTrade);
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
