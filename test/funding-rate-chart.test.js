'use strict';

// Tests for pure helpers exposed via _internal on the funding-rate
// chart module and the market panel's chart default-ticker picker.
// Both modules attach to window via IIFE; we shim window and minimal
// dependencies so the modules load in node.

const test = require('node:test');
const assert = require('node:assert/strict');

globalThis.window = globalThis;

// Stub the small window.* dependencies the modules touch on load.
globalThis.AppConstants = {
  MS_PER_DAY: 86_400_000,
  MS_PER_HOUR: 3_600_000,
  HOURS_PER_YEAR: 8760,
  FUNDING_CHART_MAX_DAYS: 90,
  TUNABLES: { ALWAYS_SHOW_TICKERS: ['BTC-USD', 'ETH-USD', 'SOL-USD'] }
};
globalThis.window.AppConstants = globalThis.AppConstants;

// Chart, Format, AppDom, DydxApi only used at render/fetch time, NOT at
// module load or in the helpers under test. Stub Chart as a no-op
// constructor just in case Chart.js side-effects ever run.
globalThis.Chart = function () { this.destroy = () => {}; };
globalThis.window.Chart = globalThis.Chart;
globalThis.window.Format = {
  formatCurrency: (v) => `$${Number(v).toFixed(2)}`,
  fmtSignedPct: (v, dp) => `${v >= 0 ? '+' : ''}${Number(v).toFixed(dp || 2)}%`,
  fmtNotional: (v) => `$${v}`,
  fmtDateShort: (t) => new Date(t).toISOString().slice(0, 10),
  formatFundingApr: (v) => `${(v * 100).toFixed(2)}%`,
  formatHourlyDetail: (v) => `${v}/h`
};
globalThis.window.AppDom = {
  updateElement: () => {},
  appendCell: () => ({}),
  tagCells: () => {}
};

// Minimal document shim so the panel module's render entry doesn't
// crash if it ever runs in test; the helpers under test don't touch it.
if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    getElementById: () => null,
    querySelectorAll: () => [],
    querySelector: () => null,
    createElement: () => ({
      appendChild: () => {},
      addEventListener: () => {},
      classList: { add: () => {}, remove: () => {}, toggle: () => {} },
      style: {},
    }),
  };
}
if (typeof globalThis.localStorage === 'undefined') {
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
}

require('../src/charts/funding-rate-chart.js');
require('../src/panels/market.js');

const FundingChart = globalThis.window.AppCharts.fundingRate;
const Market = globalThis.window.AppPanels.market;

// ---------------------------------------------------------------------------
// buildFundingBars
// ---------------------------------------------------------------------------

test('buildFundingBars: converts rate fraction to percent and filters by cutoff', () => {
  const now = Date.now();
  const rows = [
    { effectiveAt: new Date(now - 5 * 86_400_000).toISOString(), rate: '0.0001' },   // in
    { effectiveAt: new Date(now - 50 * 86_400_000).toISOString(), rate: '-0.00005' }, // out (older than 30d cutoff)
    { effectiveAt: new Date(now - 1 * 86_400_000).toISOString(), rate: '0.0002' },    // in
  ];
  const cutoff = now - 30 * 86_400_000;
  const bars = FundingChart._internal.buildFundingBars(rows, cutoff);
  assert.equal(bars.length, 2);
  // Sorted ascending in time
  assert.ok(bars[0].x < bars[1].x);
  // Percent conversion: 0.0001 → 0.01%
  assert.equal(bars[0].y, 0.01);
  assert.equal(bars[1].y, 0.02);
});

test('buildFundingBars: drops invalid rate / timestamps', () => {
  const rows = [
    { effectiveAt: 'not-a-date', rate: '0.001' },
    { effectiveAt: '2024-01-01T00:00:00Z', rate: 'oops' },
    { effectiveAt: '2024-01-02T00:00:00Z', rate: '0.0001' },
  ];
  const bars = FundingChart._internal.buildFundingBars(rows, 0);
  assert.equal(bars.length, 1);
  assert.equal(bars[0].y, 0.01);
});

test('buildFundingBars: empty input returns empty array', () => {
  assert.deepEqual(FundingChart._internal.buildFundingBars(null, 0), []);
  assert.deepEqual(FundingChart._internal.buildFundingBars([], 0), []);
});

// ---------------------------------------------------------------------------
// buildPriceLine
// ---------------------------------------------------------------------------

test('buildPriceLine: parses close as number, sorts ascending', () => {
  const now = Date.now();
  const rows = [
    { startedAt: new Date(now - 2 * 86_400_000).toISOString(), close: '3000.5' },
    { startedAt: new Date(now - 1 * 86_400_000).toISOString(), close: '3050.0' },
    { startedAt: new Date(now - 3 * 86_400_000).toISOString(), close: '2950.0' },
  ];
  const line = FundingChart._internal.buildPriceLine(rows, 0);
  assert.equal(line.length, 3);
  // ascending
  assert.ok(line[0].x < line[1].x && line[1].x < line[2].x);
  assert.equal(line[0].y, 2950);
  assert.equal(line[2].y, 3050);
});

test('buildPriceLine: drops rows older than cutoff and rows with invalid close', () => {
  const now = Date.now();
  const rows = [
    { startedAt: new Date(now - 100 * 86_400_000).toISOString(), close: '100' }, // older than cutoff
    { startedAt: new Date(now - 1 * 86_400_000).toISOString(),   close: 'NaN' }, // bad number
    { startedAt: new Date(now - 1 * 86_400_000).toISOString(),   close: '200' }, // ok
  ];
  const cutoff = now - 30 * 86_400_000;
  const line = FundingChart._internal.buildPriceLine(rows, cutoff);
  assert.equal(line.length, 1);
  assert.equal(line[0].y, 200);
});

// ---------------------------------------------------------------------------
// pickAxisUnit
// ---------------------------------------------------------------------------

test('pickAxisUnit: scales from hour → day → week with span', () => {
  const day = 86_400_000;
  assert.equal(FundingChart._internal.pickAxisUnit(2 * day), 'hour');
  assert.equal(FundingChart._internal.pickAxisUnit(10 * day), 'hour'); // boundary exclusive
  assert.equal(FundingChart._internal.pickAxisUnit(11 * day), 'day');
  assert.equal(FundingChart._internal.pickAxisUnit(60 * day), 'day');
  assert.equal(FundingChart._internal.pickAxisUnit(61 * day), 'week');
});

// ---------------------------------------------------------------------------
// pickDefaultTicker (market panel)
// ---------------------------------------------------------------------------

test('pickDefaultTicker: returns the market with most funding payments', () => {
  const payments = [
    { ticker: 'ETH-USD' }, { ticker: 'ETH-USD' }, { ticker: 'ETH-USD' },
    { ticker: 'BTC-USD' }, { ticker: 'BTC-USD' },
    { ticker: 'SOL-USD' }
  ];
  const marketsMap = { 'ETH-USD': {}, 'BTC-USD': {}, 'SOL-USD': {} };
  assert.equal(Market._internal.pickDefaultTicker(payments, marketsMap), 'ETH-USD');
});

test('pickDefaultTicker: ignores tickers not in marketsMap (delisted)', () => {
  const payments = [
    { ticker: 'OLD-USD' }, { ticker: 'OLD-USD' }, { ticker: 'OLD-USD' },
    { ticker: 'BTC-USD' }
  ];
  const marketsMap = { 'BTC-USD': {} };
  assert.equal(Market._internal.pickDefaultTicker(payments, marketsMap), 'BTC-USD');
});

test('pickDefaultTicker: falls back to ETH-USD when no payments', () => {
  const marketsMap = { 'BTC-USD': {}, 'ETH-USD': {}, 'SOL-USD': {} };
  assert.equal(Market._internal.pickDefaultTicker([], marketsMap), 'ETH-USD');
});

test('pickDefaultTicker: falls back to first key alphabetically when ETH-USD missing', () => {
  const marketsMap = { 'ZRX-USD': {}, 'AVAX-USD': {} };
  assert.equal(Market._internal.pickDefaultTicker([], marketsMap), 'AVAX-USD');
});

test('pickDefaultTicker: returns null on empty marketsMap', () => {
  assert.equal(Market._internal.pickDefaultTicker([], {}), null);
  assert.equal(Market._internal.pickDefaultTicker([], null), null);
});
