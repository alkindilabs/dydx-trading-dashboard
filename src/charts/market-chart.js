// Market distribution doughnut chart for the Overview tab. Closure-scoped
// Chart.js instance + HTML legend (Chart.js native legend was clipped /
// low-contrast against the dark palette).
//
// Depends on: Chart (CDN), window.AppConstants (TUNABLES.TOP_MARKETS),
// window.Format (formatCurrency).

(function () {
  'use strict';

  let instance = null;

  const BACKGROUND_COLORS = [
    '#D7AC60', // gold
    '#8FAA72', // sage
    '#708FB6', // ink-blue
    '#CB5C50', // coral
    '#CA9555'  // amber
  ];

  function render(marketDistribution) {
    const ctx = document.getElementById('marketDistributionChart');
    if (!ctx) return;

    const TOP_MARKETS = window.AppConstants.TUNABLES.TOP_MARKETS;
    const formatCurrency = window.Format.formatCurrency;

    if (instance) instance.destroy();

    const sortedMarkets = Object.entries(marketDistribution)
      .sort((a, b) => b[1].tradeCount - a[1].tradeCount)
      .slice(0, TOP_MARKETS);

    if (sortedMarkets.length === 0) return;

    const labels = sortedMarkets.map(([market, data]) => {
      const openSuffix = data.openCount ? ` + ${data.openCount} open` : '';
      return `${market} (${data.tradeCount} closed${openSuffix})`;
    });
    const data = sortedMarkets.map(([_, d]) => d.tradeCount);

    instance = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels,
        datasets: [{
          data,
          backgroundColor: BACKGROUND_COLORS,
          borderColor: 'rgba(14,12,9,0.85)',
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '62%',
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'rgba(14,12,9,0.97)',
            titleColor: 'rgba(239,229,210,0.95)',
            bodyColor: 'rgba(176,161,135,0.95)',
            borderColor: 'rgba(74,62,44,0.9)',
            borderWidth: 1,
            padding: 14,
            cornerRadius: 0,
            titleFont: { family: "'Fraunces', serif", style: 'italic', size: 13, weight: '400' },
            bodyFont: { family: "'JetBrains Mono', monospace", size: 11 },
            callbacks: {
              label: function (context) {
                const [, md] = sortedMarkets[context.dataIndex];
                const lines = [`Closed Positions: ${md.tradeCount}`];
                if (md.openCount) lines.push(`Open Positions: ${md.openCount}`);
                lines.push(`Profit (incl. funding − fees): ${formatCurrency(md.totalPnL)}`);
                return lines;
              }
            }
          }
        }
      }
    });

    // HTML legend below the canvas. textContent everywhere so an indexer-
    // supplied market label can never reach innerHTML.
    const legendEl = document.getElementById('marketDistributionLegend');
    if (legendEl) {
      legendEl.innerHTML = '';
      const total = data.reduce((a, b) => a + b, 0);
      sortedMarkets.forEach(([market, md], i) => {
        const pct = total > 0 ? ((md.tradeCount / total) * 100).toFixed(1) : '0.0';
        const item = document.createElement('span');
        item.className = 'market-legend-item';
        const swatch = document.createElement('span');
        swatch.className = 'market-legend-swatch';
        swatch.style.background = BACKGROUND_COLORS[i];
        item.appendChild(swatch);
        item.appendChild(document.createTextNode(` ${market} ${pct}%`));
        legendEl.appendChild(item);
      });
    }
  }

  window.AppCharts = window.AppCharts || {};
  window.AppCharts.market = { render };
})();
