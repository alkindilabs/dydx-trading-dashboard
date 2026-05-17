// Cumulative profit chart (candlestick + running-peak overlay) for the
// Overview tab. Closure-scoped singleton replaces the previous
// window.pnlChart leak so external scripts can't reach or clobber the
// Chart.js instance.
//
// Depends on: Chart (CDN), chartjs-chart-financial (CDN), window.RiskMetrics
// (buildCumulativeTotalPnlSeries), window.Format (formatCurrency),
// window.AppConstants (MS_PER_DAY).

(function () {
  'use strict';

  let instance = null;

  function render(historicalPnl) {
    const el = document.getElementById('pnlCumulativeChart');
    if (!el) return;
    const cumsRaw = window.RiskMetrics.buildCumulativeTotalPnlSeries(historicalPnl || []);
    if (cumsRaw.length < 2) return;

    const MS_PER_DAY = window.AppConstants.MS_PER_DAY;
    const formatCurrency = window.Format.formatCurrency;

    const spanMs = new Date(cumsRaw[cumsRaw.length - 1].t).getTime() - new Date(cumsRaw[0].t).getTime();
    const spanDays = spanMs / MS_PER_DAY;
    const xAxisUnit = spanDays > 350 ? 'month' : spanDays > 50 ? 'week' : 'day';

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
    const fullPeakByBucket = new Map();
    let peak = -Infinity;
    for (const p of cumsRaw) {
      if (p.c > peak) peak = p.c;
      fullPeakByBucket.set(bucketKey(p.t), peak);
    }
    const peakLine = ohlc.map(b => ({ x: b.x, y: fullPeakByBucket.get(b.x) }));

    try {
      if (instance) instance.destroy();
      instance = new Chart(el.getContext('2d'), {
        type: 'candlestick',
        data: {
          datasets: [{
            type: 'candlestick',
            label: 'Cumulative Profit',
            data: ohlc,
            color: {
              up: 'rgba(143,170,114,0.92)',
              down: 'rgba(203,92,80,0.92)',
              unchanged: 'rgba(215,172,96,0.92)'
            },
            borderColor: {
              up: '#8FAA72',
              down: '#CB5C50',
              unchanged: '#D7AC60'
            }
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
              time: {
                unit: xAxisUnit,
                tooltipFormat: 'yyyy-MM-dd',
                displayFormats: {
                  day: 'MMM d',
                  week: 'MMM d',
                  month: 'MMM yyyy'
                }
              },
              ticks: {
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
                  ? new Date(items[0].parsed.x).toISOString().slice(0, 10)
                  : '',
                label: (ctx) => {
                  if (ctx.dataset.label === 'Running Peak') {
                    return `Peak:  ${formatCurrency(ctx.parsed.y)}`;
                  }
                  const r = ctx.raw;
                  const peakHere = fullPeakByBucket.get(r.x);
                  const dd = peakHere != null ? peakHere - r.l : 0;
                  const lines = [
                    `Open:  ${formatCurrency(r.o)}`,
                    `High:  ${formatCurrency(r.h)}`,
                    `Low:   ${formatCurrency(r.l)}`,
                    `Close: ${formatCurrency(r.c)}`
                  ];
                  if (dd > 0) lines.push(`Drawdown: ${formatCurrency(-dd)}`);
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
