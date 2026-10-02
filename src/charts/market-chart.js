// Market distribution doughnut chart for the Overview tab. Closure-scoped
// Chart.js instance + HTML legend (Chart.js native legend was clipped /
// low-contrast against the dark palette). A slice is a market's closed
// positions, so a market with none takes no slice; one holding open
// positions is listed after the slices with its open count and profit.
// While the closed counts are unknown the chart draws no slice and the
// legend reads '—' with the reason.
//
// Depends on: Chart (CDN), window.AppConstants (TUNABLES.TOP_MARKETS, PERCENT),
// window.Format (formatCurrency, fmtFixed, PERCENT_DECIMALS).

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

  // closedCountGap: '' when every market's closed count is known, else
  // why not (processData's closedTradesGap: the CLOSED list failed, or the
  // fills hold a closed trade no listed position owns). No market is then
  // drawn as a share of the closed positions, nor listed as having none.
  function render(marketDistribution, closedCountGap = '') {
    const ctx = document.getElementById('marketDistributionChart');
    if (!ctx) return;

    const TOP_MARKETS = window.AppConstants.TUNABLES.TOP_MARKETS;
    const formatCurrency = window.Format.formatCurrency;

    if (instance) instance.destroy();
    instance = null;

    if (closedCountGap) {
      renderLegendGap(closedCountGap);
      return;
    }

    const allMarkets = Object.entries(marketDistribution);
    const closedMarkets = allMarkets
      .filter(([, md]) => md.tradeCount > 0)
      .sort((a, b) => b[1].tradeCount - a[1].tradeCount);
    const sortedMarkets = closedMarkets.slice(0, TOP_MARKETS);
    // openCount is null while unknown, so such a market may hold one.
    const openOnlyMarkets = allMarkets.filter(([, md]) => md.tradeCount === 0 && md.openCount !== 0);

    const sharePct = sharePctOf(closedMarkets);
    renderLegend(sortedMarkets, openOnlyMarkets, sharePct);
    if (sortedMarkets.length === 0) return;

    // openCount is null while the OPEN rows are unknown (openCountGap
    // says why): it reads '—', never as no open position.
    const labels = sortedMarkets.map(([market, data]) => {
      const openSuffix = data.openCount === null ? ' + — open'
        : data.openCount ? ` + ${data.openCount} open` : '';
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
                const lines = [`Closed Positions: ${md.tradeCount} (${sharePct(md)}% of all closed)`];
                if (md.openCount === null) lines.push(`Open Positions: — (${md.openCountGap})`);
                else if (md.openCount) lines.push(`Open Positions: ${md.openCount}`);
                const profit = md.totalPnL === null ? `— (${md.totalPnLGap})` : formatCurrency(md.totalPnL);
                lines.push(`Profit (incl. funding − fees): ${profit}`);
                return lines;
              }
            }
          }
        }
      }
    });

  }

  // A market's share of the closed positions of `closedMarkets`, every
  // market with one, including those beyond the TOP_MARKETS the chart shows.
  function sharePctOf(closedMarkets) {
    const totalClosed = closedMarkets.reduce((sum, [, md]) => sum + md.tradeCount, 0);
    const F = window.Format;
    return (md) => F.fmtFixed(totalClosed > 0 ? (md.tradeCount / totalClosed) * window.AppConstants.PERCENT : 0,
      F.PERCENT_DECIMALS);
  }

  // The legend's one item while the closed counts are unknown: '—' and
  // the reason, also on hover.
  function renderLegendGap(reason) {
    const legendEl = document.getElementById('marketDistributionLegend');
    if (!legendEl) return;
    legendEl.innerHTML = '';
    const item = document.createElement('span');
    item.className = 'market-legend-item';
    item.appendChild(document.createTextNode(`— ${reason}`));
    item.title = reason;
    legendEl.appendChild(item);
  }

  // HTML legend below the canvas: each slice's market and share, then
  // each open-only market with its open count and profit ('—' with the
  // reasons on hover while unknown). textContent everywhere so an
  // indexer-supplied market label can never reach innerHTML.
  function renderLegend(sliceMarkets, openOnlyMarkets, sharePct) {
    const legendEl = document.getElementById('marketDistributionLegend');
    if (!legendEl) return;
    legendEl.innerHTML = '';
    const appendItem = (swatchColor, text) => {
      const item = document.createElement('span');
      item.className = 'market-legend-item';
      const swatch = document.createElement('span');
      swatch.className = 'market-legend-swatch';
      if (swatchColor) swatch.style.background = swatchColor;
      else swatch.classList.add('is-open-only');
      item.appendChild(swatch);
      item.appendChild(document.createTextNode(text));
      legendEl.appendChild(item);
      return item;
    };
    sliceMarkets.forEach(([market, md], i) => {
      appendItem(BACKGROUND_COLORS[i], ` ${market} ${sharePct(md)}%`);
    });
    const formatCurrency = window.Format.formatCurrency;
    openOnlyMarkets.forEach(([market, md]) => {
      const open = md.openCount === null ? '—' : String(md.openCount);
      const profit = md.totalPnL === null ? '—' : formatCurrency(md.totalPnL);
      const item = appendItem(null, ` ${market} ${open} open, no closed · profit ${profit}`);
      item.title = ['Open positions only: no slice, which counts closed positions.',
        md.openCount === null ? `Open positions: ${md.openCountGap}.` : '',
        md.totalPnL === null ? `Profit (incl. funding − fees): ${md.totalPnLGap}.`
          : 'Profit (incl. funding − fees).'].filter(Boolean).join(' ');
    });
  }

  window.AppCharts = window.AppCharts || {};
  window.AppCharts.market = { render };
})();
