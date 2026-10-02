// Cumulative profit chart (candlestick + running-peak overlay) for the
// Overview tab. Closure-scoped singleton replaces the previous
// window.pnlChart leak so external scripts can't reach or clobber the
// Chart.js instance.
//
// Depends on: Chart (CDN), chartjs-chart-financial (CDN), window.RiskMetrics
// (buildCumulativeTotalPnlSeries, deeperDrawdownFirst), window.Format
// (formatCurrency, displaysAsLoss, drawdownAsDisplayed, asDisplayed), window.AppConstants
// (MS_PER_DAY).

(function () {
  'use strict';

  let instance = null;
  const MONTH_AXIS_MIN_DAYS = 350;
  const WEEK_AXIS_MIN_DAYS = 50;

  // Tick labels per axis unit, formatted in UTC like the tooltips and the
  // candles' bucket keys (the date adapter would format in the viewer's
  // timezone).
  const TICK_LABEL_FORMATS = {
    day: new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }),
    week: new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }),
    month: new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', year: 'numeric' })
  };

  const DAYS_PER_WEEK = 7;
  const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

  // A candle's tooltip title per axis unit, from its UTC bucket start:
  // the period the candle covers, so its Close never reads as the value
  // on the bucket's first day. A month by name ('Sep 2026', as its tick),
  // a week as its Monday to Sunday, a day as its date.
  const TOOLTIP_TITLES = {
    day: (startMs) => isoDate(startMs),
    week: (startMs, msPerDay) => `${isoDate(startMs)} – ${isoDate(startMs + (DAYS_PER_WEEK - 1) * msPerDay)}`,
    month: (startMs) => TICK_LABEL_FORMATS.month.format(new Date(startMs))
  };

  // Candle fill and border per direction. A candle's direction is its
  // open and close as displayed at whole dollars (candleDirection), so a
  // candle whose open and close read alike is unchanged, never up or down
  // by a sub-dollar move. chartjs-chart-financial compares the raw open
  // and close in pixels and reads one of up / down / unchanged from its
  // backgroundColors and borderColors options, so each candle hands it its
  // own colour under all three (a string border is taken for all three).
  const CANDLE_COLOURS = {
    up: { fill: 'rgba(143,170,114,0.92)', border: '#8FAA72' },
    down: { fill: 'rgba(203,92,80,0.92)', border: '#CB5C50' },
    unchanged: { fill: 'rgba(215,172,96,0.92)', border: '#D7AC60' }
  };

  function candleDirection(candle) {
    if (!candle) return 'unchanged';
    const shown = v => window.Format.asDisplayed(v, window.Format.WHOLE_DOLLARS);
    const open = shown(candle.o);
    const close = shown(candle.c);
    return close > open ? 'up' : close < open ? 'down' : 'unchanged';
  }

  const candleFill = (ctx) => {
    const fill = CANDLE_COLOURS[candleDirection(ctx.raw)].fill;
    return { up: fill, down: fill, unchanged: fill };
  };
  const candleBorder = (ctx) => CANDLE_COLOURS[candleDirection(ctx.raw)].border;

  // A candlestick chart needs a series of at least two points.
  const MIN_SERIES_POINTS = 2;
  const TOO_FEW_POINTS = 'Not enough /historical-pnl rows to chart';

  // The chart's empty state reads `reason`, or hides without one.
  function renderEmptyState(reason) {
    const empty = document.getElementById('pnlCumulativeChartEmpty');
    if (!empty) return;
    empty.textContent = reason ? `— ${reason}` : '';
    empty.hidden = !reason;
  }

  // `live` (RiskMetrics.livePnlPoint, or null) is the series' last point,
  // so the last candle closes at the account's profit now. `historyCut`
  // ('' when the rows reach inception, else why not) is
  // buildCumulativeTotalPnlSeries', so cut rows start at their first row.
  // `gap` ('' when the rows are known) is why the series is unknown (the
  // endpoint failed, or holds no rows). Every call first clears the
  // previous chart, so a load never keeps an earlier load's candles; with
  // a gap, or a series too short to chart, the empty state gives why.
  function render(historicalPnl, live = null, historyCut = '', gap = '') {
    const el = document.getElementById('pnlCumulativeChart');
    if (!el) return;
    if (instance) {
      instance.destroy();
      instance = null;
    }
    const cumsRaw = gap ? [] : window.RiskMetrics.buildCumulativeTotalPnlSeries(historicalPnl || [], live, historyCut);
    const emptyReason = gap || (cumsRaw.length < MIN_SERIES_POINTS ? TOO_FEW_POINTS : '');
    renderEmptyState(emptyReason);
    if (emptyReason) return;

    const MS_PER_DAY = window.AppConstants.MS_PER_DAY;
    const formatCurrency = window.Format.formatCurrency;

    const spanMs = new Date(cumsRaw[cumsRaw.length - 1].t).getTime() - new Date(cumsRaw[0].t).getTime();
    const spanDays = spanMs / MS_PER_DAY;
    const xAxisUnit = spanDays > MONTH_AXIS_MIN_DAYS ? 'month' : spanDays > WEEK_AXIS_MIN_DAYS ? 'week' : 'day';

    // Aggregate OHLC per period from the full hourly series so each candle
    // shows intra-period high/low/open/close of cumulative profit.
    const bucketKey = (t) => {
      const d = new Date(t);
      if (xAxisUnit === 'week') {
        const dow = d.getUTCDay() || 7;
        return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - (dow - 1));
      }
      if (xAxisUnit === 'month') {
        return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
      }
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    };

    const ohlcMap = new Map();
    for (const p of cumsRaw) {
      const k = bucketKey(p.t);
      let b = ohlcMap.get(k);
      if (!b) {
        ohlcMap.set(k, { x: k, o: p.c, h: p.c, l: p.c, c: p.c });
      } else {
        if (p.c > b.h) b.h = p.c;
        if (p.c < b.l) b.l = p.c;
        b.c = p.c;
      }
    }
    const ohlc = [...ohlcMap.values()];

    // Running peak sampled at end-of-bucket: the dashed peak line stays
    // honest about all-time peaks ever seen on the full hourly series.
    // The bucket's drawdown is the deepest drop below the running peak at
    // any point inside it, ranked and shown as displayed (the displayed
    // running peak less the displayed point, RiskMetrics.deeperDrawdownFirst)
    // like the Max Drawdown card: the bucket low against the end-of-bucket
    // peak would pair a low with a peak reached after it.
    const fullPeakByBucket = new Map();
    const drawdownByBucket = new Map();
    let peak = -Infinity;
    for (const p of cumsRaw) {
      if (p.c > peak) peak = p.c;
      const k = bucketKey(p.t);
      fullPeakByBucket.set(k, peak);
      const drop = { shownDepth: window.Format.drawdownAsDisplayed(peak, p.c), depthAbs: peak - p.c };
      const deepest = drawdownByBucket.get(k);
      if (!deepest || window.RiskMetrics.deeperDrawdownFirst(drop, deepest) < 0) drawdownByBucket.set(k, drop);
    }
    const peakLine = ohlc.map(b => ({ x: b.x, y: fullPeakByBucket.get(b.x) }));

    try {
      instance = new Chart(el.getContext('2d'), {
        type: 'candlestick',
        data: {
          datasets: [{
            type: 'candlestick',
            label: 'Cumulative Profit',
            data: ohlc,
            backgroundColors: candleFill,
            borderColors: candleBorder
          }, {
            type: 'line',
            label: 'Running Peak',
            data: peakLine,
            borderColor: 'rgba(215,172,96,0.55)',
            borderDash: [4, 4],
            borderWidth: 1,
            fill: false,
            pointRadius: 0
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          scales: {
            x: {
              type: 'time',
              time: { unit: xAxisUnit },
              ticks: {
                // One candidate tick per candle, at its UTC bucket start,
                // so a tick never sits on a local-time boundary.
                source: 'data',
                callback: (value) => TICK_LABEL_FORMATS[xAxisUnit].format(new Date(value)),
                color: 'rgba(176,161,135,0.85)',
                font: { family: "'JetBrains Mono', monospace", size: 10 },
                maxRotation: 0,
                autoSkip: true,
                autoSkipPadding: 16,
                maxTicksLimit: 12
              },
              grid: { color: 'rgba(74,62,44,0.32)' }
            },
            y: {
              ticks: {
                color: 'rgba(239,229,210,0.85)',
                font: { family: "'JetBrains Mono', monospace", size: 10 },
                callback: (v) => formatCurrency(v)
              },
              grid: { color: 'rgba(74,62,44,0.32)' }
            }
          },
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: 'rgba(14,12,9,0.97)',
              titleColor: 'rgba(239,229,210,0.98)',
              bodyColor: 'rgba(239,229,210,0.92)',
              borderColor: 'rgba(74,62,44,0.9)',
              borderWidth: 1,
              padding: 12,
              cornerRadius: 0,
              titleFont: { family: "'Fraunces', serif", style: 'italic', size: 13, weight: '400' },
              bodyFont: { family: "'JetBrains Mono', monospace", size: 11 },
              callbacks: {
                title: (items) => items[0]
                  ? TOOLTIP_TITLES[xAxisUnit](items[0].parsed.x, MS_PER_DAY)
                  : '',
                label: (ctx) => {
                  if (ctx.dataset.label === 'Running Peak') {
                    return `Peak:  ${formatCurrency(ctx.parsed.y)}`;
                  }
                  const r = ctx.raw;
                  const dd = drawdownByBucket.get(r.x).shownDepth;
                  const lines = [
                    `Open:  ${formatCurrency(r.o)}`,
                    `High:  ${formatCurrency(r.h)}`,
                    `Low:   ${formatCurrency(r.l)}`,
                    `Close: ${formatCurrency(r.c)}`
                  ];
                  if (window.Format.displaysAsLoss(dd)) lines.push(`Below peak: ${formatCurrency(-dd)}`);
                  return lines;
                }
              }
            }
          }
        }
      });
    } catch (e) {
      console.warn('Failed to render PnL chart', e);
    }
  }

  window.AppCharts = window.AppCharts || {};
  window.AppCharts.pnl = { render };
})();
