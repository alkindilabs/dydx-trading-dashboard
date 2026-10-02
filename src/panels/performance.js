// Performance tab + per-trade Sharpe fallback + histogram primitive.
// Eight exports under window.AppPanels.performance:
//
//   renderMetrics           — top-of-tab KPI cards + WL distribution.
//   renderTables            — Monthly Performance + Performance-by-Asset
//                             tables.
//   renderTradeBasedRatios  — per-trade Sharpe/Sortino/Calmar fallback
//                             surface (called from risk-ratios IIFE when
//                             the time-series adequacy gate fails).
//   renderRatioMeta         — the Sharpe / Sortino captions on either
//                             path, NO_SPREAD_REASON for a null ratio.
//   renderRatioCardTitles   — the Sharpe / Sortino card tooltips for the
//                             path their values came from.
//   renderCalmar            — the Calmar card and its caption, for the
//                             time-series and the per-trade path.
//   computeTradeBasedMetrics — pure helper over a classifyClosed result.
//   compoundedReturnText    — a compounded return as every Sharpe caption
//                             and per-row SHARPE tooltip shows it.
//
// Module-private helpers:
//
//   renderHistogram         — generic SVG-free bar chart primitive used by
//                             distribution displays (win/loss returns,
//                             hold time, size).
//   assetTradeSharpe        — per-asset Sharpe column. It and
//                             computeTradeBasedMetrics both read
//                             RiskMetrics.perTradeRatios, so the ratios
//                             card and the asset-Sharpe column can never
//                             adopt different definitions.
//
// Depends on: window.RiskMetrics (classifyClosed, classifyByMonth,
// byClosingOrder, closeTimeGap, holdMs, holdTimeGap, tradeReturn, peakNotional, perTradeRatios, histPnlMonthlyDrawdown, exactSum,
// histPnlMonthly, NO_MONTH_ROWS_REASON, timeWeightedReturnPointsByMonth, compoundReturns,
// CALMAR_DRAWDOWN_DECIMALS, NO_DRAWDOWN_REASON,
// assessMonthAdequacy, monthKeyUTC, monthLabel, timestampMs, chronologicalHistoricalPnl,
// computeAnnualizedFromReturns, marketPnL, wholeCents, quotientCents,
// exactSum), window.AppConstants
// (MS_PER_HOUR, MONTHS_PER_YEAR, PERCENT, CENTS_PER_DOLLAR,
// TUNABLES.RECENT_DECISIVE_CAP, TUNABLES.ASSET_SHARPE_MIN_N),
// window.Format (formatCurrency, formatCents, fmtFixed,
// formatShortNumber, displayedShortNumber, fmtRatio, fmtSignedPct, signClass, displaysAsLoss, drawdownAsDisplayed,
// breakevenVerdict, asDisplayed, WHOLE_DOLLARS, TRADE_RETURN_DECIMALS,
// displayedDurationMs, formatPercent: every win rate),
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
  // Each return is binned as the Positions board's PROFIT % displays it
  // (Format.TRADE_RETURN_DECIMALS), so an exact -14% (-14.000000000000002
  // in binary) lands in '-14% to -12%', but never across the 0 edge: a
  // loss that displays as 0.00% still bins below 0 and a win at or above it.
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
      const shown = window.Format.asDisplayed(r, window.Format.TRADE_RETURN_DECIMALS);
      const shownBin = Math.floor(shown / RETURN_BIN_WIDTH);
      const i = r < 0 ? Math.min(shownBin, -1) : Math.max(shownBin, 0);
      const clamped = Math.max(-RETURN_BINS_PER_SIDE, Math.min(RETURN_BINS_PER_SIDE - 1, i));
      bins[clamped + RETURN_BINS_PER_SIDE].count += 1;
    });
    return bins;
  }

  // Wins and losses (scratches excluded) in closing order
  // (RiskMetrics.byClosingOrder over `fills`: closes in one millisecond in
  // chain order), every one of them: one whose closedAt does not parse
  // sorts last, and RiskMetrics.perTradeRatios names it rather than leave
  // it out.
  function decisiveByCloseTime(cls, fills) {
    const decisive = new Set(cls.wins.concat(cls.losses));
    return cls.all.filter(p => decisive.has(p)).sort(window.RiskMetrics.byClosingOrder(fills));
  }

  const COMPOUNDED_DECIMALS = 1;

  // A compounded return (RiskMetrics.compoundReturns' `compounded`, a
  // fraction) as every Sharpe caption and tooltip shows it: a signed
  // percent, '—' once the compounded wealth reached zero (null).
  function compoundedReturnText(compounded) {
    return window.Format.fmtSignedPct(
      compounded === null || compounded === undefined ? null : compounded * window.AppConstants.PERCENT,
      COMPOUNDED_DECIMALS);
  }

  const SHARPE_ROW_CAVEAT = 'SHARPE is the arithmetic mean of the returns ÷ their standard deviation: above 0 does not mean the row made money.';

  // A per-row SHARPE cell whose returns passed their gate but are all
  // alike: no standard deviation, so no ratio.
  const NO_SPREAD_REASON = 'Returns have no spread';

  // The tooltip of a per-row SHARPE cell that shows a value: the row's
  // returns compounded (`returnsName` names them) and the caveat.
  function sharpeCellTitle(compounded, returnsName) {
    return `Compounded over ${returnsName}: ${compoundedReturnText(compounded)}. ${SHARPE_ROW_CAVEAT}`;
  }

  // Annualized per-trade Sharpe of one classifyClosed result (the
  // per-asset SHARPE column): RiskMetrics.perTradeRatios over its decisive
  // trades, each return on the account equity at the trade's open from
  // `historicalPnl`, in closing order over `fills`. { text, reason }: '—'
  // with the classifier's reason, `historicalPnlGap` (why the rows these
  // trades need are missing) or perTradeRatios' reason, in that order, when
  // there is no value; else the value, its reason the compounded return
  // (sharpeCellTitle).
  function assetTradeSharpe(cls, minSampleSize, historicalPnl, historicalPnlGap, fills) {
    if (cls.incompleteReason) return { text: '—', reason: cls.incompleteReason };
    if (historicalPnlGap) return { text: '—', reason: historicalPnlGap };
    const ratios = window.RiskMetrics.perTradeRatios(decisiveByCloseTime(cls, fills), historicalPnl, minSampleSize);
    if (!ratios.ok) return { text: '—', reason: ratios.reason };
    if (ratios.sharpe === null) return { text: '—', reason: NO_SPREAD_REASON };
    return {
      text: window.Format.fmtRatio(ratios.sharpe),
      reason: sharpeCellTitle(ratios.compounded, 'the trades (return on equity at open)')
    };
  }

  // Per-trade Sharpe/Sortino/Calmar fallback: RiskMetrics.perTradeRatios
  // over every decisive trade, on equity at open from `historicalPnl`.
  // Independent statistic from the time-series Sharpe — meaningful when
  // the equity time-series sample is biased (post-wipeout window) but the
  // trade log is rich enough. Trades in closing order over `fills`
  // (decisiveByCloseTime). { ok: false, reason } while the classifier's
  // inputs are incomplete, like every other classifier-derived number, or
  // while perTradeRatios has no value.
  function computeTradeBasedMetrics(cls, historicalPnl, fills = []) {
    if (cls.incompleteReason) return { ok: false, n: 0, reason: cls.incompleteReason };
    return window.RiskMetrics.perTradeRatios(decisiveByCloseTime(cls, fills), historicalPnl);
  }

  // The per-trade ratios' tooltip: trades per year whole, spans in months
  // at one decimal.
  const TRADES_PER_YEAR_DECIMALS = 0;
  const SPAN_MONTHS_DECIMALS = 1;

  // The Calmar card: `compounding` is a RiskMetrics.compoundReturns
  // result (perTradeRatios carries the same fields), `curve` names the
  // compounded curve whose worst drawdown the ratio divides by, so the
  // caption never reads as the dollar Max Drawdown card. Without a
  // result the card reads '—' with `reason` (why there is none, as the
  // Sharpe caption gives it) as its caption and tooltip, or under the
  // markup's caption without one. A compounded curve that never drew
  // down (compoundReturns' maxDrawdownPct null while its compounded
  // return is known: a drawdown that displays as 0.0% included) has no
  // Calmar to show and reads RiskMetrics.NO_DRAWDOWN_REASON the same way.
  function renderCalmar(compounding, curve = '', reason = '') {
    const RM = window.RiskMetrics;
    const noDrawdown = Boolean(compounding) && compounding.maxDrawdownPct === null && compounding.compounded !== null;
    const shown = noDrawdown ? null : compounding;
    const gap = noDrawdown ? RM.NO_DRAWDOWN_REASON : reason;
    const D = window.AppDom;
    D.updateElement('calmarRatio', window.Format.fmtRatio(shown ? shown.calmar : null));
    const caption = document.getElementById('calmarDetail');
    if (!caption) return;
    if (caption.dataset.defaultText === undefined) caption.dataset.defaultText = caption.textContent;
    caption.title = shown ? '' : gap;
    if (!shown) {
      caption.textContent = gap || caption.dataset.defaultText;
      return;
    }
    const pct = compounding.maxDrawdownPct;
    const drawdown = pct === null || pct === undefined ? '—' : `${window.Format.fmtFixed(pct, RM.CALMAR_DRAWDOWN_DECIMALS)}%`;
    caption.textContent = `CAGR ÷ max DD of ${curve} (${drawdown})`;
  }

  // The Sharpe and Sortino card tooltips by the path their values came
  // from: 'trade' (the per-trade fallback) describes trade returns; any
  // other path reads the markup's own text, which describes the
  // time-weighted returns of /historical-pnl.
  const PER_TRADE_RATIO_TITLES = {
    sharpeCard: 'Sharpe Ratio (per-trade fallback) = arithmetic mean of the per-trade returns (profit ÷ account equity at the position\'s open) ÷ their standard deviation, annualized by √(trades per year), with the risk-free rate taken as 0. The /historical-pnl sample failed its adequacy gate (the caption\'s tooltip says why), so the ratio is measured on the decisive closed trades instead. Below 0 means the mean trade return is negative; above 0 does not mean the account made money: the compounded return over the trades is in the caption.',
    sortinoCard: 'Sortino Ratio (per-trade fallback) = mean of the per-trade returns (profit ÷ account equity at the position\'s open) ÷ their downside deviation (target semi-deviation over every trade), annualized by √(trades per year), with the risk-free rate taken as 0. The /historical-pnl sample failed its adequacy gate (the caption\'s tooltip says why), so the ratio is measured on the decisive closed trades instead. Below 0 means the mean trade return is negative; read it beside the compounded return in the caption.'
  };

  function renderRatioCardTitles(source) {
    Object.entries(PER_TRADE_RATIO_TITLES).forEach(([id, perTradeTitle]) => {
      const node = document.getElementById(id);
      if (!node) return;
      if (node.dataset.defaultTitle === undefined) node.dataset.defaultTitle = node.title;
      node.title = source === 'trade' ? perTradeTitle : node.dataset.defaultTitle;
    });
  }

  // tm: a computeTradeBasedMetrics result with ok: true.
  function renderTradeBasedRatios(tm, tsReason) {
    const F = window.Format;
    const D = window.AppDom;
    renderRatioCardTitles('trade');
    D.updateElement('sharpeRatio', F.fmtRatio(tm.sharpe));
    D.updateElement('sortinoRatio', F.fmtRatio(tm.sortino));
    renderCalmar(tm, 'compounded trade returns');

    const compounded = compoundedReturnText(tm.compounded);
    const meta = `Per-trade · n=${tm.n} · compounded ${compounded} ⓘ`;
    const tipBase = `Per-trade Sharpe/Sortino computed from ${tm.n} decisive trades (scratches excluded).
Time-series fallback: ${tsReason}.
Return per trade: profit ÷ account equity at the position's open (the /historical-pnl row at or before it, plus the deposits on the row after it).
Annualized via √(trades per year ≈ ${F.fmtFixed(tm.tpy, TRADES_PER_YEAR_DECIMALS)}): (n − 1) close-to-close intervals over ${F.fmtFixed(tm.yearsSpan * window.AppConstants.MONTHS_PER_YEAR, SPAN_MONTHS_DECIMALS)} months.
Calmar: CAGR over ${F.fmtFixed(tm.calmarYears * window.AppConstants.MONTHS_PER_YEAR, SPAN_MONTHS_DECIMALS)} months from the first open to the last close.
Arithmetic mean: compounded over the trades the return is ${compounded}.
Small-N caveat: standard error widens; not a forward-Sharpe forecast.`;
    renderRatioMeta({ sharpe: tm.sharpe, sortino: tm.sortino }, meta, tipBase, {
      sharpe: 'standard deviation of trade returns.',
      sortino: 'downside deviation of trade returns (target semi-deviation).'
    });
  }

  // The Sharpe and Sortino captions (#sharpeMeta, #sortinoMeta) on either
  // path: `metaText` with `tipBase` and the ratio's denominator on hover,
  // or, for a ratio that is null (returns that are all alike have no
  // deviation to divide by), NO_SPREAD_REASON as caption and tooltip, as
  // the monthly and per-asset SHARPE cells read.
  function renderRatioMeta(ratios, metaText, tipBase, denominators) {
    ['sharpe', 'sortino'].forEach(ratio => {
      const node = document.getElementById(`${ratio}Meta`);
      if (!node) return;
      const noSpread = ratios[ratio] === null;
      node.textContent = noSpread ? `${NO_SPREAD_REASON} ⓘ` : metaText;
      node.title = noSpread ? NO_SPREAD_REASON : `${tipBase}\nDenominator: ${denominators[ratio]}`;
    });
  }

  // The longest run of wins and of losses in closing order
  // (RiskMetrics.byClosingOrder), each with the summed profit of that run
  // (added exactly, RiskMetrics.exactSum);
  // of runs of equal length the one with the larger summed |profit| counts
  // (the best winning, the worst losing run). Scratches (profit 0) are
  // skipped: they neither extend nor break a run.
  function recordStreaks(closedSorted) {
    const win = { length: 0, profit: 0 };
    const loss = { length: 0, profit: 0 };
    let run = { sign: 0, length: 0, profit: 0 };
    closedSorted.forEach(p => {
      const sign = Math.sign(p.profit);
      if (sign === 0) return;
      run = sign === run.sign
        ? { sign, length: run.length + 1, profit: window.RiskMetrics.exactSum([run.profit, p.profit]) }
        : { sign, length: 1, profit: p.profit };
      const record = sign > 0 ? win : loss;
      const longer = run.length > record.length;
      const largerAtEqualLength = run.length === record.length
        && Math.abs(run.profit) > Math.abs(record.profit);
      if (longer || largerAtEqualLength) {
        record.length = run.length;
        record.profit = run.profit;
      }
    });
    return { win, loss };
  }

  // The caption is the run's $ toned by the sign it shows
  // (Format.signClass), or the classifier's reason, untoned.
  function renderStreak(id, streak, cls) {
    const F = window.Format;
    const D = window.AppDom;
    D.updateElement(id, streak.length > 0 ? String(streak.length) : '—');
    const showsRun = !cls.incompleteReason && streak.length > 0;
    D.updateElement(`${id}Detail`, cls.incompleteReason || (showsRun ? F.formatCurrency(streak.profit) : ''));
    const detail = document.getElementById(`${id}Detail`);
    if (detail) detail.className = ['metric-change', 'mono', showsRun ? F.signClass(streak.profit) : ''].filter(Boolean).join(' ');
  }

  // The Win Rate Trend's recent window: the last RECENT_DECISIVE_CAP
  // decisive trades, but never more than half of them, so it is a part of
  // the history it is compared with rather than all of it.
  const MIN_TREND_WINDOW = 2;
  const TREND_WINDOW_SHARE_OF_HISTORY = 2;
  // The recent win rate reads up (green) or down (red) when it is more
  // than this many percentage points from the all-time rate, both as
  // displayed.
  const TREND_TONE_POINTS = 1;

  // closedGap: '' when every closed trade is listed, else why not (the
  // CLOSED list failed, or the fills hold a closed trade no listed
  // position owns); the hold-time histogram, which needs no fill data,
  // then shows it. fills: the fetched /fills, whose chain order takes
  // closes in one millisecond in the streaks and the win-rate trend
  // (RiskMetrics.byClosingOrder).
  function renderMetrics(positions, precomputedCls, closedGap = '', fills = []) {
    const C = window.AppConstants;
    const F = window.Format;
    const D = window.AppDom;

    const cls = precomputedCls || window.RiskMetrics.classifyClosed(positions);
    const classifierGap = cls.incompleteReason !== '';
    const closedSorted = classifierGap ? [] : cls.all.slice().sort(window.RiskMetrics.byClosingOrder(fills));
    const streaks = recordStreaks(closedSorted);
    renderStreak('maxConsecWins', streaks.win, cls);
    renderStreak('maxConsecLosses', streaks.loss, cls);

    const rrr = cls.payoff;
    const rrrDetailEl = document.getElementById('avgRRRDetail');
    if (rrr !== null) {
      D.updateElement('avgRRR', F.fmtPayoff(rrr));
      const breakevenWR = cls.breakevenWinRate;
      const actualWR = cls.winRate;
      if (actualWR !== null && rrrDetailEl) {
        const verdict = F.breakevenVerdict(actualWR, breakevenWR, cls.expectancy);
        rrrDetailEl.textContent = verdict.text;
        rrrDetailEl.className = `metric-change mono ${verdict.toneClass}`;
      } else {
        D.updateElement('avgRRRDetail', `${F.formatPercent(breakevenWR)} WR needed to break even`);
        if (rrrDetailEl) rrrDetailEl.className = 'metric-change mono';
      }
    } else {
      D.updateElement('avgRRR', classifierGap ? '—' : 'N/A');
      D.updateElement('avgRRRDetail',
        classifierGap ? cls.incompleteReason : window.RiskMetrics.payoffEmptyBucketReason(cls));
      if (rrrDetailEl) rrrDetailEl.className = 'metric-change mono';
    }

    const decisive = classifierGap ? [] : decisiveByCloseTime(cls, fills);
    const allTimeWR = cls.winRate !== null ? cls.winRate : 0;
    const N = Math.min(C.TUNABLES.RECENT_DECISIVE_CAP,
      Math.floor(decisive.length / TREND_WINDOW_SHARE_OF_HISTORY));
    const hasTrend = N >= MIN_TREND_WINDOW;
    const recent = decisive.slice(-N);
    const recentWins = recent.filter(p => p.profit > 0).length;
    const recentWR = recent.length ? (recentWins / recent.length) * window.AppConstants.PERCENT : 0;
    const trendEl = document.getElementById('winRateTrend');
    if (trendEl) {
      if (!hasTrend) {
        trendEl.textContent = '—';
        trendEl.className = 'metric-value mono';
      } else {
        const shown = (rate) => F.asDisplayed(rate, F.PERCENT_DECIMALS);
        const delta = shown(shown(recentWR) - shown(allTimeWR));
        const arrow = delta > TREND_TONE_POINTS ? '↑' : delta < -TREND_TONE_POINTS ? '↓' : '→';
        const klass = delta > TREND_TONE_POINTS ? 'profit' : delta < -TREND_TONE_POINTS ? 'loss' : '';
        trendEl.textContent = `${arrow} ${F.formatPercent(recentWR)}`;
        trendEl.className = 'metric-value mono ' + klass;
      }
    }
    D.updateElement('winRateTrendDetail',
      classifierGap ? cls.incompleteReason
        : hasTrend ? `Last ${N} decisive (vs ${F.formatPercent(allTimeWR)} all-time)`
          : `Needs ≥${MIN_TREND_WINDOW * TREND_WINDOW_SHARE_OF_HISTORY} decisive trades (have ${decisive.length})`);
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

    // Hold time + size distributions on Positions tab from real data.
    // The hold-time bins add up to the closed count, or the histogram
    // shows why they cannot (a closed trade missing, or one without a
    // valid hold window). Each hold is binned as its DURATION displays it
    // (Format.displayedDurationMs), each bin [lo, hi), so the open-ended
    // last bin takes a hold that reads exactly '7d 0h' and says ≥.
    const closedPos = positions.filter(p => p.status === 'CLOSED');
    const holdGap = closedGap || window.RiskMetrics.holdTimeGap(positions);
    const holdHours = holdGap ? [] : closedPos
      .map(p => F.displayedDurationMs(window.RiskMetrics.holdMs(p)) / C.MS_PER_HOUR);
    const holdBuckets = [
      { label: '0–1h',     range: [0, 1],     count: 0 },
      { label: '1–4h',     range: [1, 4],     count: 0 },
      { label: '4–12h',    range: [4, 12],    count: 0 },
      { label: '12–24h',   range: [12, 24],   count: 0 },
      { label: '1–3d',     range: [24, 72],   count: 0 },
      { label: '3–7d',     range: [72, 168],  count: 0 },
      { label: '≥7d',      range: [168, Infinity], count: 0 }
    ];
    holdHours.forEach(h => {
      const b = holdBuckets.find(b => h >= b.range[0] && h < b.range[1]);
      if (b) b.count += 1;
    });
    renderHistogram('holdTimeDistribution', holdGap ? [] : holdBuckets,
      { tone: 'gain', emptyText: holdGap });

    // Peak notional (RiskMetrics.peakNotional), the same denominator as
    // tradeReturn. All-or-nothing like the classifier.
    const notionals = classifierGap ? [] : closedPos
      .map(p => window.RiskMetrics.peakNotional(p))
      .filter(v => v !== null)
      .sort((a, b) => a - b);
    if (notionals.length) {
      renderHistogram('sizeDistribution', sizeBins(notionals), { tone: 'gain' });
    } else {
      renderHistogram('sizeDistribution', [], {
        emptyText: classifierGap ? cls.incompleteReason : 'No closed positions'
      });
    }
  }

  // Position Size Distribution bins over ascending notionals: equal-width
  // bins from the smallest notional, the last one open-ended. Up to one
  // bin per trade within [SIZE_BINS_MIN, SIZE_BINS_MAX], fewer while two
  // bin edges would print alike (a spread smaller than the label's
  // precision), down to one bin; a single bin is labelled by the range it
  // holds, or by the one notional when every trade prints alike. Each
  // notional is binned as its label prints (Format.displayedShortNumber)
  // against the edges as they print, so $1,799 ('$1.80K') lands in the
  // bin '$1.80K' opens.
  function sizeBins(notionals) {
    const fmt = n => `$${window.Format.formatShortNumber(n)}`;
    const min = notionals[0], max = notionals[notionals.length - 1];
    const edgesPrintApart = (numBins, step) => {
      const printed = Array.from({ length: numBins + 1 }, (_, i) => fmt(min + i * step));
      return new Set(printed).size === printed.length;
    };
    let numBins = Math.min(SIZE_BINS_MAX, Math.max(SIZE_BINS_MIN, notionals.length));
    while (numBins > 1 && !edgesPrintApart(numBins, (max - min) / numBins)) numBins -= 1;
    if (numBins === 1) {
      const label = fmt(min) === fmt(max) ? fmt(min) : `${fmt(min)}–${fmt(max)}`;
      return [{ label, count: notionals.length }];
    }
    const step = (max - min) / numBins;
    const bins = Array.from({ length: numBins }, (_, i) => {
      const lo = min + i * step;
      const last = i === numBins - 1;
      return { label: `${fmt(lo)}–${last ? '∞' : fmt(lo + step)}`, count: 0 };
    });
    const shown = window.Format.displayedShortNumber;
    const shownEdges = bins.map((_, i) => shown(min + i * step));
    notionals.forEach(n => {
      const shownNotional = shown(n);
      let i = numBins - 1;
      while (i > 0 && shownNotional < shownEdges[i]) i -= 1;
      bins[i].count += 1;
    });
    return bins;
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
    return cls.winRate === null ? '—' : window.Format.formatPercent(cls.winRate);
  }

  function profitFactorText(cls) {
    if (cls.profitFactor !== null) return window.Format.fmtRatio(cls.profitFactor);
    return cls.incompleteReason || cls.decisiveCount === 0 ? '—' : 'N/A';
  }

  // A Performance-by-Asset money cell at cents (Format.formatCents), the
  // precision the Overview ledger shows, so the PROFIT / FUNDING / FEES
  // rows add up to it; '—' for a null value, with `gap` on hover when its
  // inputs are unknown.
  function appendAssetMoneyCell(tr, value, gap = '') {
    const F = window.Format;
    const cell = window.AppDom.appendCell(tr, gap ? '—' : F.formatCents(value),
      ['mono', gap ? '' : F.signClass(value, F.CENTS)]);
    if (gap) cell.title = gap;
  }

  // A single trade's amount (BEST, WORST) at whole cents through the one
  // cent rule (RiskMetrics.wholeCents), as the row's PROFIT is; null stays
  // null.
  function classifierCents(value) {
    return value === null
      ? null
      : window.RiskMetrics.wholeCents(value) / window.AppConstants.CENTS_PER_DOLLAR;
  }

  // AVG PROFIT (the classifier's expectancy) at whole cents, rounded once
  // from the exact quotient (RiskMetrics.quotientCents) of the decisive
  // trades' exact profit sum over their count; null with no expectancy.
  function expectancyCents(cls) {
    if (cls.expectancy === null) return null;
    const RM = window.RiskMetrics;
    const profitSum = RM.exactSum(cls.wins.concat(cls.losses).map(p => p.profit));
    return RM.quotientCents(profitSum, cls.decisiveCount) / window.AppConstants.CENTS_PER_DOLLAR;
  }

  // A month's PROFIT cell: its RiskMetrics.histPnlMonthly end and start,
  // each at whole dollars, differenced, so the column telescopes to the
  // Total Profit headline rounded to whole dollars; null while the change
  // is unknown.
  function displayedMonthChange(entry) {
    if (entry.delta === null) return null;
    const shown = (total) => window.Format.asDisplayed(total, window.Format.WHOLE_DOLLARS);
    return shown(entry.end) - shown(entry.start);
  }

  // A classifier cell of `cls`: its reason on hover while the
  // classifier's inputs are incomplete (the cell then reads '—').
  function appendClassifierCell(tr, cls, text, classes) {
    const cell = window.AppDom.appendCell(tr, text, classes);
    if (cls.incompleteReason) cell.title = cls.incompleteReason;
    return cell;
  }

  function appendAvgCell(tr, cls, value) {
    const F = window.Format;
    appendClassifierCell(tr, cls, value === null ? '—' : F.formatCurrency(value), ['mono', F.signClass(value)]);
  }

  // A month needs more /historical-pnl rows than this for its SHARPE cell.
  const MIN_MONTH_ROWS = 2;

  // A month's annualized Sharpe from `monthPoints`, the account's
  // time-weighted returns ending in the month
  // (RiskMetrics.timeWeightedReturnPointsByMonth), sampled at its own rows'
  // interval, each weighted by the intervals it spans
  // (computeAnnualizedFromReturns), and gated by
  // RiskMetrics.assessMonthAdequacy, its reason the
  // month's compounded return (sharpeCellTitle); '—' with the gate's
  // reason otherwise, or with NO_SPREAD_REASON when the returns that pass
  // it are all alike.
  function monthSharpe(monthHist, monthPoints, key) {
    if (monthHist.length <= MIN_MONTH_ROWS) {
      return { sharpeTxt: '—', sharpeReason: `Needs more than ${MIN_MONTH_ROWS} /historical-pnl rows this month` };
    }
    const points = monthPoints || [];
    const rets = points.map(p => p.r);
    const timestamps = monthHist.map(p => p.createdAt);
    const adq = window.RiskMetrics.assessMonthAdequacy(rets, timestamps, monthHist.length, key);
    if (!adq.adequate) return { sharpeTxt: '—', sharpeReason: adq.reason };
    const ann = window.RiskMetrics.computeAnnualizedFromReturns(rets, timestamps,
      { mar: 0, intervalsMs: points.map(p => p.intervalMs) });
    if (ann.sharpeAnnualized === null) return { sharpeTxt: '—', sharpeReason: NO_SPREAD_REASON };
    const { compounded } = window.RiskMetrics.compoundReturns(rets);
    return {
      sharpeTxt: window.Format.fmtRatio(ann.sharpeAnnualized),
      sharpeReason: sharpeCellTitle(compounded, 'the month\'s time-weighted returns')
    };
  }

  // marketAggIn: RiskMetrics.profitLedger's byMarket (marketPnL's slots at
  // cents), so the asset rows add up to the Overview ledger.
  // gaps: { funding, fees, marketFunding, marketFees, marketProfit,
  // openPositions, closed, classifier } from processData, each '' when
  // its inputs loaded, else the reason they did not. marketProfit(ticker)
  // / marketFunding(ticker) (else funding) / marketFees(ticker) (else
  // fees) blank the asset table's
  // PROFIT / FUNDING / FEES; openPositions (the OPEN rows are unknown)
  // makes a market's open count unknown, so no market is hidden for
  // holding no known position; closed (the CLOSED list failed) and
  // classifier (the account classifier's incompleteReason) blank every
  // classifier cell; historicalPnl (/historical-pnl failed to load) is the
  // reason of every monthly PROFIT, MAX DD and SHARPE and of the asset
  // SHARPE ahead of their empty-data wording; historyCut (the rows do not
  // reach inception: RiskMetrics.buildCumulativeTotalPnlSeries) is the
  // reason of the month the rows start in and every month before it, its
  // SHARPE included, and of an asset SHARPE with a trade opened before
  // the first row. profitReconciliation (the fills-based headline
  // disagrees with /historical-pnl: RiskMetrics.profitReconciliation) is
  // the reason of every monthly SHARPE, whose returns are built from that
  // totalPnl; PROFIT and MAX DD show the rows' dollars.
  // `live` (RiskMetrics.livePnlPoint, or
  // null) ends the current month's PROFIT and MAX DD at the live point;
  // the monthly SHARPE stays on the rows' returns. `fills` (the fetched
  // /fills) orders each asset's trades for its SHARPE
  // (RiskMetrics.byClosingOrder).
  // MAX DD (RiskMetrics.histPnlMonthlyDrawdown) runs from the prior
  // month-end, like PROFIT, and reads the month's deepest drawdown as
  // displayed: its displayed peak less its displayed trough
  // (Format.drawdownAsDisplayed); one that displays as $0 reads $0, neutral.
  function renderTables(positions, historicalPnl = [], marketAggIn = null, gaps = {}, live = null, fills = []) {
    const C = window.AppConstants;
    const F = window.Format;
    const D = window.AppDom;

    // Bucket closed trades by month with the header's classifier, so
    // monthly win-rate denominators match the header's (decisive trades
    // only). The classifier is all-or-nothing account-wide: while any
    // closed position is incomplete (or the CLOSED list is unknown) every
    // month's and every asset's ratios blank together with the header's.
    // The PNL column for each month comes from /historical-pnl deltas.
    // A closed position without a valid close time belongs to a month no
    // one knows, so every month's classifier cells, TRADES included, read
    // '—' with RiskMetrics.closeTimeGap while one exists.
    const classifierReason = gaps.classifier || gaps.closed || '';
    const monthCountGap = gaps.closed || window.RiskMetrics.closeTimeGap(positions);
    const monthReason = classifierReason || monthCountGap;
    const monthly = window.RiskMetrics.classifyByMonth(positions, monthReason);

    const hist = window.RiskMetrics.chronologicalHistoricalPnl(historicalPnl);
    const byMonthHist = {};
    if (hist.length > MIN_MONTH_ROWS) {
      hist.forEach(pt => {
        const key = window.RiskMetrics.monthKeyUTC(pt.createdAt);
        if (key === null) return;
        if (!byMonthHist[key]) byMonthHist[key] = [];
        byMonthHist[key].push(pt);
      });
    }
    const historicalPnlGap = gaps.historicalPnl || '';
    const historyCut = gaps.historyCut || '';
    const monthlyHistDeltas = window.RiskMetrics.histPnlMonthly(hist, live, historyCut);
    const monthlyDrawdowns = window.RiskMetrics.histPnlMonthlyDrawdown(hist, live, historyCut);
    const monthlyReturns = window.RiskMetrics.timeWeightedReturnPointsByMonth(hist, historyCut);
    // Rows cut by the cache leave the month they start in, and every
    // month and trade open before them, without the history they need.
    const cutMonth = historyCut ? Object.keys(monthlyHistDeltas).sort()[0] : null;
    const firstRowMs = hist.length ? window.RiskMetrics.timestampMs(hist[0].createdAt) : null;
    const monthHistGap = key => historicalPnlGap || (cutMonth !== null && key <= cutMonth ? historyCut : '');
    const tradesHistGap = trades => historicalPnlGap
      || (historyCut && trades.some(p => !(window.RiskMetrics.timestampMs(p.createdAt) >= firstRowMs)) ? historyCut : '');
    const monthSharpeGap = key => monthHistGap(key) || gaps.profitReconciliation || '';
    const histSharpe = (monthHist, key) => (
      monthSharpeGap(key) ? { sharpeTxt: '—', sharpeReason: monthSharpeGap(key) }
        : monthSharpe(monthHist, monthlyReturns[key], key));
    Object.keys(monthlyHistDeltas).forEach(key => {
      if (!monthly[key]) monthly[key] = window.RiskMetrics.classifyClosed([], monthReason);
    });
    const bodyM = document.getElementById('monthlyPerformanceBody');
    if (bodyM) {
      bodyM.innerHTML = '';
      Object.entries(monthly)
        .sort(([a], [b]) => b.localeCompare(a))
        .forEach(([key, m]) => {
          const tr = document.createElement('tr');
          const monthHist = byMonthHist[key] || [];
          const { sharpeTxt, sharpeReason } = histSharpe(monthHist, key);
          const monthDD = monthlyDrawdowns[key] || { dollarDrawdown: null, reason: window.RiskMetrics.NO_MONTH_ROWS_REASON };
          const shownMonthDD = monthDD.dollarDrawdown === null ? null : F.drawdownAsDisplayed(monthDD.peakValue, monthDD.troughValue);
          const ddShown = shownMonthDD !== null && F.displaysAsLoss(shownMonthDD);
          const histEntry = monthlyHistDeltas[key];
          const pnlDelta = histEntry ? displayedMonthChange(histEntry) : null;
          D.appendCell(tr, window.RiskMetrics.monthLabel(key));
          const profitCell = D.appendCell(tr, pnlDelta === null ? '—' : F.formatCurrency(pnlDelta), ['mono', F.signClass(pnlDelta)]);
          if (pnlDelta === null) {
            profitCell.title = monthHistGap(key) || (histEntry ? histEntry.reason : window.RiskMetrics.NO_MONTH_ROWS_REASON);
          }
          appendClassifierCell(tr, m, winRateText(m), ['mono']);
          appendTradesCell(tr, m, monthCountGap);
          appendAvgCell(tr, m, m.avgWin);
          appendAvgCell(tr, m, m.avgLoss === null ? null : -m.avgLoss);
          appendClassifierCell(tr, m, profitFactorText(m), ['mono']);
          const mddCell = monthDD.dollarDrawdown === null
            ? D.appendCell(tr, '—', ['mono'])
            : D.appendCell(tr, F.formatCurrency(ddShown ? -shownMonthDD : 0), ['mono', ddShown ? 'loss' : F.signClass(0)]);
          if (monthDD.dollarDrawdown === null) mddCell.title = monthHistGap(key) || monthDD.reason;
          D.appendCell(tr, sharpeTxt, ['mono']).title = sharpeReason;
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
    const marketFundingGap = ticker => (gaps.marketFunding ? gaps.marketFunding(ticker) : (gaps.funding || ''));
    const marketFeesGap = ticker => (gaps.marketFees ? gaps.marketFees(ticker) : (gaps.fees || ''));
    // Listed while it holds a position, while the OPEN rows are unknown,
    // or while it adds to the ledger (fills no listed position covers), so
    // the rows add up to the Overview ledger.
    const addsToLedger = v => v.total !== 0 || v.fees !== 0;
    if (bodyA) {
      bodyA.innerHTML = '';
      Object.entries(market)
        .filter(([_, v]) => v.closedCount > 0 || v.openCount > 0 || openCountUnknown || addsToLedger(v))
        .sort((a, b) => Math.abs(b[1].total) - Math.abs(a[1].total))
        .forEach(([ticker, slot]) => {
          const assetCls = window.RiskMetrics.classifyClosed(
            positionsByMarket.get(ticker) || [], classifierReason
          );
          const assetSharpe = assetTradeSharpe(assetCls, C.TUNABLES.ASSET_SHARPE_MIN_N, hist,
            tradesHistGap(decisiveByCloseTime(assetCls, fills)), fills);
          const tr = document.createElement('tr');
          D.appendCell(tr, ticker);
          appendAssetMoneyCell(tr, slot.total, marketProfitGap(ticker));
          appendAssetMoneyCell(tr, slot.netFunding, marketFundingGap(ticker));
          appendAssetMoneyCell(tr, -(slot.fees || 0), marketFeesGap(ticker));
          appendTradesCell(tr, assetCls, gaps.closed);
          appendClassifierCell(tr, assetCls, winRateText(assetCls), ['mono']);
          appendAssetMoneyCell(tr, expectancyCents(assetCls), assetCls.incompleteReason);
          appendAssetMoneyCell(tr, classifierCents(assetCls.bestTrade), assetCls.incompleteReason);
          appendAssetMoneyCell(tr, classifierCents(assetCls.worstTrade), assetCls.incompleteReason);
          D.appendCell(tr, assetSharpe.text, ['mono']).title = assetSharpe.reason;
          bodyA.appendChild(tr);
        });
      D.tagCells('assetPerformanceBody');
    }
  }

  window.AppPanels = window.AppPanels || {};
  window.AppPanels.performance = {
    renderMetrics,
    renderTables,
    renderTradeBasedRatios,
    renderRatioMeta,
    renderRatioCardTitles,
    renderCalmar,
    computeTradeBasedMetrics,
    compoundedReturnText,
    NO_SPREAD_REASON
  };
})();
