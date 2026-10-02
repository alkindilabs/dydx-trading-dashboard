'use strict';

// The Overview's Trading Activity doughnut (src/charts/market-chart.js)
// rendered with the real constants and Format modules. The DOM
// (test/fake-dom.js) and Chart.js (a CDN library, stubbed to capture the
// config it is given) are stand-ins.

const test = require('node:test');
const assert = require('node:assert/strict');
const { el } = require('./fake-dom');

let chartConfig = null;
globalThis.Chart = function (_ctx, config) {
  chartConfig = config;
  this.destroy = () => {};
};

require('../src/constants.js');
require('../src/format.js');
require('../src/charts/market-chart.js');

const { TOP_MARKETS } = window.AppConstants.TUNABLES;

function market(tradeCount) {
  return { tradeCount, openCount: 0, openCountGap: '', totalPnL: 0, totalPnLGap: '' };
}

const legendTexts = () => el('marketDistributionLegend').children
  .map(item => item.children.map(c => c.textContent).join('').trim());
const tooltipLines = (dataIndex) => chartConfig.options.plugins.tooltip.callbacks.label({ dataIndex });

test('legend and tooltip shares are of all trading activity, not of the markets shown', () => {
  // One market more than the chart shows: each holds 1/6 of the trades.
  const markets = {};
  for (let i = 0; i <= TOP_MARKETS; i++) markets[`M${i}-USD`] = market(10);
  window.AppCharts.market.render(markets);

  const legend = legendTexts();
  assert.equal(legend.length, TOP_MARKETS);
  legend.forEach(text => assert.match(text, / 16\.7%$/, text));
  assert.ok(tooltipLines(0).includes('Closed Positions: 10 (16.7% of all closed)'),
    tooltipLines(0).join(' | '));
});

test('a market with only open positions takes no slice; the legend lists its open count and profit', () => {
  const openOnly = { ...market(0), openCount: 1, totalPnL: -250 };
  window.AppCharts.market.render({ 'BTC-USD': market(4), 'SOL-USD': openOnly });

  assert.deepEqual(chartConfig.data.datasets[0].data, [4]);
  assert.equal(chartConfig.data.labels.length, 1);
  const legend = legendTexts();
  assert.equal(legend.length, 2);
  assert.match(legend[0], /^BTC-USD 100\.0%$/);
  assert.match(legend[1], /^SOL-USD/);
  assert.match(legend[1], /1 open/);
  assert.match(legend[1], /-\$250/);
});

test('an open-only market whose open count or profit is unknown reads — with the reasons on hover', () => {
  const unknown = {
    tradeCount: 0, openCount: null, openCountGap: 'Open positions failed to load',
    totalPnL: null, totalPnLGap: 'No oracle price for SOL-USD',
  };
  window.AppCharts.market.render({ 'SOL-USD': unknown });
  const [item] = el('marketDistributionLegend').children;
  const text = item.children.map(c => c.textContent).join('');
  assert.match(text, /— open/);
  assert.match(item.title, /Open positions failed to load/);
  assert.match(item.title, /No oracle price for SOL-USD/);
});

test('while the closed counts are unknown the chart draws no slice and the legend reads — with the reason', () => {
  const reason = 'Closed positions failed to load';
  // As processData builds them with the CLOSED list failed: every closed count reads 0.
  const openOnly = { ...market(0), openCount: 1, totalPnL: 120 };
  for (const markets of [{ 'BTC-USD': openOnly, 'ETH-USD': market(0) }, {}]) {
    chartConfig = null;
    window.AppCharts.market.render(markets, reason);
    assert.equal(chartConfig, null, 'no slice is drawn on an unknown count');
    const items = el('marketDistributionLegend').children;
    assert.equal(items.length, 1, legendTexts().join(' | '));
    const text = legendTexts()[0];
    assert.match(text, /^—/);
    assert.ok(text.includes(reason), text);
    assert.doesNotMatch(text, /no closed/);
    assert.equal(items[0].title, reason);
  }
});

test('a market\'s share rounds like every percent on screen: 3 of 2000 closed positions are 0.2%', () => {
  window.AppCharts.market.render({ 'BTC-USD': market(1997), 'ETH-USD': market(3) });
  assert.match(legendTexts()[1], /^ETH-USD 0\.2%$/);
  assert.ok(tooltipLines(1).includes('Closed Positions: 3 (0.2% of all closed)'), tooltipLines(1).join(' | '));
});
