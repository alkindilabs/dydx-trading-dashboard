// Funding rate · price history chart for the Market Structure tab.
// Mixed dataset: signed bars for hourly funding rate (green/red by
// sign) + thin price line on a secondary y-axis. Closure-scoped
// singleton; destroy-before-recreate pattern mirrors pnl-chart.js.
//
// Inputs (passed to render):
//   ticker        — market symbol (display only; data is pre-filtered)
//   fundingRows   — [{ rate, price, effectiveAt }, ...]  raw from indexer
//   candleRows    — [{ startedAt, close }, ...]          raw from indexer
//   cutoffMs      — epoch ms; rows older than this are dropped
//
// Depends on: Chart (CDN), window.Format (formatCurrency, fmtSignedPct).

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
      const rate = parseFloat(r.rate);
      if (!isFinite(rate)) continue;
      out.push({ x: t, y: rate * 100 }); // display as percent
    }
    out.sort((a, b) => a.x - b.x);
    return out;
  }

  function buildPriceLine(rows, cutoffMs) {
    const out = [];
    for (const r of rows || []) {
      const t = toEpoch(r.startedAt);
      if (t == null || t < cutoffMs) continue;
      const close = parseFloat(r.close);
      if (!isFinite(close)) continue;
      out.push({ x: t, y: close });
    }
    out.sort((a, b) => a.x - b.x);
    return out;
  }

  function pickAxisUnit(spanMs) {
    const MS_PER_DAY = window.AppConstants.MS_PER_DAY;
    const days = spanMs / MS_PER_DAY;
    if (days > 60) return 'week';
    if (days > 10) return 'day';
    return 'hour';
  }

  function clear() {
    if (instance) { instance.destroy(); instance = null; }
  }

  function render(input) {
    const el = document.getElementById('fundingRateChart');
    if (!el) return;
    const { ticker, fundingRows, candleRows, cutoffMs } = input || {};
    const cutoff = (typeof cutoffMs === 'number' && cutoffMs > 0) ? cutoffMs : 0;

    const bars = buildFundingBars(fundingRows, cutoff);
    const line = buildPriceLine(candleRows, cutoff);

    // Early exit: no funding data is the load-bearing signal. Price-only
    // would be off-topic for the panel.
    if (bars.length < 2) { clear(); return; }

    const formatCurrency = window.Format.formatCurrency;
    const fmtSignedPct = window.Format.fmtSignedPct;

    const allXs = bars.map(b => b.x).concat(line.map(p => p.x));
    const spanMs = Math.max(...allXs) - Math.min(...allXs);
    const xAxisUnit = pickAxisUnit(spanMs);

    clear();
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
              time: {
                unit: xAxisUnit,
                tooltipFormat: 'yyyy-MM-dd HH:mm',
                displayFormats: {
                  hour: 'MMM d, HH:mm',
                  day: 'MMM d',
                  week: 'MMM d'
                }
              },
              ticks: {
                color: TICK_MUTED,
                font: { family: "'JetBrains Mono', monospace", size: 10 },
                maxRotation: 0,
                autoSkip: true,
                autoSkipPadding: 16,
                maxTicksLimit: 10
              },
              grid: { color: GRID_COLOR }
            },
            yRate: {
              position: 'left',
              ticks: {
                color: TICK_INK,
                font: { family: "'JetBrains Mono', monospace", size: 10 },
                callback: (v) => (Math.abs(v) < 0.001 ? '0%' : `${v.toFixed(3)}%`)
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
              position: 'right',
              ticks: {
                color: TICK_MUTED,
                font: { family: "'JetBrains Mono', monospace", size: 10 },
                callback: (v) => formatCurrency(v)
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
                    const annualPct = v * 8760;
                    return [
                      `Funding (1h):  ${fmtSignedPct(v, 4)}`,
                      `Annualized:    ${fmtSignedPct(annualPct, 2)}`
                    ];
                  }
                  return `Price:         ${formatCurrency(v)}`;
                }
              }
            }
          }
        }
      });
    } catch (e) {
      console.warn('Failed to render funding-rate chart', e);
    }
  }

  window.AppCharts = window.AppCharts || {};
  window.AppCharts.fundingRate = {
    render,
    clear,
    _internal: { buildFundingBars, buildPriceLine, pickAxisUnit }
  };
})();
