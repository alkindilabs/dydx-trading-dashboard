// Funding rate · price history chart for the Market Structure tab.
// Mixed dataset: signed bars for hourly funding rate (green/red by
// sign) + thin price line on a secondary y-axis. Closure-scoped
// singleton; destroy-before-recreate pattern mirrors pnl-chart.js.
//
// Inputs (passed to render):
//   ticker        — market symbol (display only; data is pre-filtered)
//   fundingRows   — [{ rate, price, effectiveAt }, ...]  raw from indexer
//   candleRows    — [{ startedAt, close }, ...]          raw from indexer
//   cutoffMs      — epoch ms; funding rows older than this are dropped
//
// Depends on: Chart (CDN), window.Format (formatPrice, fmtSignedPct,
// formatHourlyRate, HOURLY_RATE_ZERO_LABEL, fundingAprPercent, APR_DECIMALS),
// window.AppConstants (MS_PER_HOUR, MS_PER_DAY, DAYS_PER_WEEK, PERCENT),
// window.RiskMetrics (decimalNumberOf: a rate or close that is not wholly
// numeric draws nothing).

(function () {
  'use strict';

  let instance = null;

  // Palette matches the CSS custom properties by value (not by
  // getComputedStyle reference) — same convention as pnl-chart.js and
  // market-chart.js.
  const GAIN_FILL   = 'rgba(143,170,114,0.85)';
  const LOSS_FILL   = 'rgba(203,92,80,0.85)';
  const GAIN_BORDER = '#8FAA72';
  const LOSS_BORDER = '#CB5C50';
  const PRICE_COLOR = 'rgba(176,161,135,0.75)';
  const GRID_COLOR  = 'rgba(74,62,44,0.32)';
  const TICK_INK    = 'rgba(239,229,210,0.85)';
  const TICK_MUTED  = 'rgba(176,161,135,0.85)';

  const RATE_DETAIL_DECIMALS = 4;
  // Strips float noise from a tick step (0.00019999… → 0.0002) before
  // its magnitude picks the label precision.
  const STEP_SIGNIFICANT_DIGITS = 6;
  const PRICE_LEGEND_SWATCH = '.funding-chart__swatch--price';
  const LEGEND_ITEM = '.funding-chart__legend-item';
  const WEEK_AXIS_MIN_DAYS = 60;
  const DAY_AXIS_MIN_DAYS = 10;
  // The x axis reads UTC, the clock funding settles on: ticks fall on UTC
  // hours, UTC midnights or UTC Mondays (ISO weeks), counted from these
  // origins; 5 Jan 1970 is the first Monday after the epoch.
  const UTC_TICK_ORIGIN_MS = { hour: 0, day: 0, week: Date.UTC(1970, 0, 5) };
  const UTC_DATE = { month: 'short', day: 'numeric', timeZone: 'UTC' };
  const UTC_TIME = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' };

  function toEpoch(iso) {
    if (!iso) return null;
    const t = Date.parse(iso);
    return isNaN(t) ? null : t;
  }

  function buildFundingBars(rows, cutoffMs) {
    const out = [];
    for (const r of rows || []) {
      const t = toEpoch(r.effectiveAt);
      if (t == null || t < cutoffMs) continue;
      const rate = window.RiskMetrics.decimalNumberOf(r.rate);
      if (rate === null) continue;
      out.push({ x: t, y: rate * window.AppConstants.PERCENT });
    }
    out.sort((a, b) => a.x - b.x);
    return out;
  }

  function hourOf(ms) {
    return Math.floor(ms / window.AppConstants.MS_PER_HOUR);
  }

  // One price point per funding bar, at the bar's own instant: a candle's
  // close is the price at the end of its hour, so the candle that started
  // an hour before a settlement prices it. Sharing the bars' x values and
  // indices keeps the index-mode tooltip pairing a rate with its price.
  // A bar without a usable candle gets y: null; [] when no bar has one.
  function buildPriceLine(candleRows, bars) {
    const closeByHour = new Map();
    for (const r of candleRows || []) {
      const t = toEpoch(r.startedAt);
      const close = window.RiskMetrics.decimalNumberOf(r.close);
      if (t == null || close === null) continue;
      closeByHour.set(hourOf(t) + 1, close);
    }
    const line = (bars || []).map(b => ({ x: b.x, y: closeByHour.has(hourOf(b.x)) ? closeByHour.get(hourOf(b.x)) : null }));
    return line.some(p => p.y !== null) ? line : [];
  }

  function pickAxisUnit(spanMs) {
    const MS_PER_DAY = window.AppConstants.MS_PER_DAY;
    const days = spanMs / MS_PER_DAY;
    if (days > WEEK_AXIS_MIN_DAYS) return 'week';
    if (days > DAY_AXIS_MIN_DAYS) return 'day';
    return 'hour';
  }

  function axisUnitMs(unit) {
    const { MS_PER_HOUR, MS_PER_DAY, DAYS_PER_WEEK } = window.AppConstants;
    return { hour: MS_PER_HOUR, day: MS_PER_DAY, week: DAYS_PER_WEEK * MS_PER_DAY }[unit];
  }

  // Every UTC `unit` boundary from minMs to maxMs; Chart.js's autoSkip
  // thins them to fit.
  function utcTickValues(minMs, maxMs, unit) {
    const step = axisUnitMs(unit);
    const origin = UTC_TICK_ORIGIN_MS[unit];
    const values = [];
    for (let t = origin + Math.ceil((minMs - origin) / step) * step; t <= maxMs; t += step) values.push(t);
    return values;
  }

  // 'Sep 23, 17:00' on an hourly axis, 'Sep 23' on a daily or weekly one.
  function utcTickLabel(ms, unit) {
    const d = new Date(ms);
    const date = d.toLocaleDateString('en-US', UTC_DATE);
    return unit === 'hour' ? `${date}, ${d.toLocaleTimeString('en-GB', UTC_TIME)}` : date;
  }

  // Enough decimals that adjacent ticks, one `step` apart, never print alike.
  function rateTickDecimals(ticks) {
    if (!ticks || ticks.length < 2) return RATE_DETAIL_DECIMALS;
    const step = Number(Math.abs(ticks[1].value - ticks[0].value).toPrecision(STEP_SIGNIFICANT_DIGITS));
    if (!(step > 0)) return RATE_DETAIL_DECIMALS;
    return Math.max(0, -Math.floor(Math.log10(step)));
  }

  function rateTickLabel(value, ticks) {
    const fixed = window.Format.fmtFixed(value, rateTickDecimals(ticks));
    return Number(fixed) === 0 ? window.Format.HOURLY_RATE_ZERO_LABEL : `${fixed}%`;
  }

  function showPriceLegend(visible) {
    const swatch = document.querySelector(PRICE_LEGEND_SWATCH);
    const item = swatch && swatch.closest(LEGEND_ITEM);
    if (item) item.hidden = !visible;
  }

  function clear() {
    if (instance) { instance.destroy(); instance = null; }
  }

  function render(input) {
    const el = document.getElementById('fundingRateChart');
    if (!el) return false;
    const { ticker, fundingRows, candleRows, cutoffMs } = input || {};
    const cutoff = (typeof cutoffMs === 'number' && cutoffMs > 0) ? cutoffMs : 0;

    const bars = buildFundingBars(fundingRows, cutoff);
    const line = buildPriceLine(candleRows, bars);

    // Early exit: no funding data is the load-bearing signal. Price-only
    // would be off-topic for the panel. Returning false lets the caller
    // surface an explicit empty-state instead of leaving a blank canvas.
    if (bars.length < 2) { clear(); return false; }

    const { formatPrice, fmtSignedPct, formatHourlyRate, fundingAprPercent, APR_DECIMALS } = window.Format;
    // Candles failed or held no rows in the window: an empty right axis
    // would show a bogus $0..$1 scale, so the axis and its legend go.
    const hasPriceLine = line.length > 0;

    const allXs = bars.map(b => b.x).concat(line.map(p => p.x));
    const spanMs = Math.max(...allXs) - Math.min(...allXs);
    const xAxisUnit = pickAxisUnit(spanMs);

    clear();
    let rendered = false;
    try {
      instance = new Chart(el.getContext('2d'), {
        data: {
          datasets: [
            {
              type: 'bar',
              label: 'Funding rate (1h)',
              data: bars,
              yAxisID: 'yRate',
              backgroundColor: (ctx) => {
                const v = ctx.raw && ctx.raw.y;
                return v >= 0 ? GAIN_FILL : LOSS_FILL;
              },
              borderColor: (ctx) => {
                const v = ctx.raw && ctx.raw.y;
                return v >= 0 ? GAIN_BORDER : LOSS_BORDER;
              },
              borderWidth: 0,
              barPercentage: 0.95,
              categoryPercentage: 1.0
            },
            {
              type: 'line',
              label: 'Price (close)',
              data: line,
              yAxisID: 'yPrice',
              borderColor: PRICE_COLOR,
              borderWidth: 1.25,
              pointRadius: 0,
              pointHoverRadius: 3,
              pointHoverBackgroundColor: PRICE_COLOR,
              fill: false,
              spanGaps: true,
              tension: 0
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          scales: {
            x: {
              type: 'time',
              time: { unit: xAxisUnit },
              afterBuildTicks: (scale) => {
                scale.ticks = utcTickValues(scale.min, scale.max, xAxisUnit).map(value => ({ value }));
              },
              ticks: {
                color: TICK_MUTED,
                font: { family: "'JetBrains Mono', monospace", size: 10 },
                maxRotation: 0,
                autoSkip: true,
                autoSkipPadding: 16,
                maxTicksLimit: 10,
                callback: (value) => utcTickLabel(value, xAxisUnit)
              },
              grid: { color: GRID_COLOR },
              title: {
                display: true,
                text: 'Time (UTC)',
                color: TICK_MUTED,
                font: { family: "'JetBrains Mono', monospace", size: 10, weight: '400' }
              }
            },
            yRate: {
              position: 'left',
              ticks: {
                color: TICK_INK,
                font: { family: "'JetBrains Mono', monospace", size: 10 },
                callback: (v, _index, ticks) => rateTickLabel(v, ticks)
              },
              grid: { color: GRID_COLOR },
              title: {
                display: true,
                text: 'Funding rate / hour',
                color: TICK_MUTED,
                font: { family: "'JetBrains Mono', monospace", size: 10, weight: '400' }
              }
            },
            yPrice: {
              display: hasPriceLine,
              position: 'right',
              ticks: {
                color: TICK_MUTED,
                font: { family: "'JetBrains Mono', monospace", size: 10 },
                callback: (v) => formatPrice(v)
              },
              grid: { display: false },
              title: {
                display: true,
                text: `${ticker} price`,
                color: TICK_MUTED,
                font: { family: "'JetBrains Mono', monospace", size: 10, weight: '400' }
              }
            }
          },
          plugins: {
            legend: { display: false },
            tooltip: {
              filter: (item) => item.parsed && item.parsed.y != null,
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
                title: (items) => {
                  if (!items || !items.length) return '';
                  const d = new Date(items[0].parsed.x);
                  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
                },
                label: (ctx) => {
                  const v = ctx.parsed && ctx.parsed.y;
                  if (v == null) return '';
                  if (ctx.dataset.yAxisID === 'yRate') {
                    const annualPct = fundingAprPercent(v / window.AppConstants.PERCENT);
                    return [
                      `Funding (1h):  ${formatHourlyRate(v)}`,
                      `Annualized:    ${fmtSignedPct(annualPct, APR_DECIMALS)}`
                    ];
                  }
                  return `Price:         ${formatPrice(v)}`;
                }
              }
            }
          }
        }
      });
      rendered = true;
      showPriceLegend(hasPriceLine);
    } catch (e) {
      console.warn('Failed to render funding-rate chart', e);
    }
    return rendered;
  }

  window.AppCharts = window.AppCharts || {};
  window.AppCharts.fundingRate = {
    render,
    clear,
    _internal: { buildFundingBars, buildPriceLine, pickAxisUnit, rateTickLabel }
  };
})();
