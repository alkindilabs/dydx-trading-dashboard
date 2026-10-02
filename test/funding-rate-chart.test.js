'use strict';

// Tests for pure helpers exposed via _internal on the funding-rate
// chart module and the market panel's chart default-ticker picker.
// Both modules attach to window via IIFE; we shim window and minimal
// dependencies so the modules load in node.

const test = require('node:test');
const assert = require('node:assert/strict');

globalThis.window = globalThis;
require('../src/constants.js');
const { MS_PER_DAY, MS_PER_HOUR } = globalThis.window.AppConstants;

// Chart, AppDom, DydxApi only used at render/fetch time, NOT at module
// load or in the helpers under test. Stub Chart as a no-op constructor
// just in case Chart.js side-effects ever run.
globalThis.Chart = function () { this.destroy = () => {}; };
globalThis.window.Chart = globalThis.Chart;
require('../risk-metrics.js');
require('../src/format.js');
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
    { effectiveAt: new Date(now - 5 * MS_PER_DAY).toISOString(), rate: '0.0001' },   // in
    { effectiveAt: new Date(now - 50 * MS_PER_DAY).toISOString(), rate: '-0.00005' }, // out (older than 30d cutoff)
    { effectiveAt: new Date(now - 1 * MS_PER_DAY).toISOString(), rate: '0.0002' },    // in
  ];
  const cutoff = now - 30 * MS_PER_DAY;
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

// A candle's close is the price at the END of its hour, so the candle that
// started an hour before a funding settlement prices that settlement.
const SETTLEMENT_LAG_MS = 250;
function barsAt(hourStarts) {
  return hourStarts.map(h => ({ x: h + SETTLEMENT_LAG_MS, y: 0.001 }));
}
function candleAt(startedAt, close) {
  return { startedAt: new Date(startedAt).toISOString(), close };
}

test('a rate or a candle close that is not wholly numeric draws no bar and no price, never its leading digits', () => {
  const h0 = Date.parse('2025-03-10T14:00:00.000Z');
  const rows = [
    { effectiveAt: new Date(h0).toISOString(), rate: '0.0000125junk' },
    { effectiveAt: new Date(h0 + MS_PER_HOUR).toISOString(), rate: '0.0000125' },
  ];
  const bars = FundingChart._internal.buildFundingBars(rows, h0 - MS_PER_HOUR);
  assert.deepEqual(bars.map(b => b.x), [h0 + MS_PER_HOUR]);
  const line = FundingChart._internal.buildPriceLine([candleAt(h0, '50100zz')], bars);
  assert.deepEqual(line, []);
});

test('buildPriceLine: plots each candle close at the funding bar of the hour it closes', () => {
  const h0 = Date.parse('2025-03-10T14:00:00.000Z');
  const bars = barsAt([h0, h0 + MS_PER_HOUR]);
  const candles = [
    candleAt(h0 - MS_PER_HOUR, '50100'), // 13:00–14:00: the price at 14:00
    candleAt(h0, '49800'),               // 14:00–15:00: the price at 15:00
    candleAt(h0 + MS_PER_HOUR, '50300'), // still open: no settlement to pair with yet
  ];
  const line = FundingChart._internal.buildPriceLine(candles, bars);
  assert.deepEqual(line, [{ x: bars[0].x, y: 50100 }, { x: bars[1].x, y: 49800 }]);
});

test('buildPriceLine: parses close as a number and follows the bars\' order whatever the candle order', () => {
  const h0 = Date.parse('2026-09-01T00:00:00.000Z');
  const bars = barsAt([h0, h0 + MS_PER_HOUR, h0 + 2 * MS_PER_HOUR]);
  const candles = [
    candleAt(h0 + MS_PER_HOUR, '3050.0'),
    candleAt(h0 - MS_PER_HOUR, '2950.0'),
    candleAt(h0, '3000.5'),
  ];
  const line = FundingChart._internal.buildPriceLine(candles, bars);
  assert.deepEqual(line.map(p => p.x), bars.map(b => b.x));
  assert.deepEqual(line.map(p => p.y), [2950, 3000.5, 3050]);
});

test('buildPriceLine: a bar whose candle is missing or has an invalid close gets no price', () => {
  const h0 = Date.parse('2026-09-01T00:00:00.000Z');
  const bars = barsAt([h0, h0 + MS_PER_HOUR, h0 + 2 * MS_PER_HOUR]);
  const candles = [
    candleAt(h0 - MS_PER_HOUR, 'NaN'),
    candleAt(h0 + MS_PER_HOUR, '200'),
    candleAt(h0 - 100 * MS_PER_DAY, '100'), // no bar that old
  ];
  const line = FundingChart._internal.buildPriceLine(candles, bars);
  assert.deepEqual(line.map(p => p.y), [null, null, 200]);
});

test('buildPriceLine: no candle pairs with any bar → no line at all', () => {
  const h0 = Date.parse('2026-09-01T00:00:00.000Z');
  const bars = barsAt([h0, h0 + MS_PER_HOUR]);
  assert.deepEqual(FundingChart._internal.buildPriceLine([], bars), []);
  assert.deepEqual(FundingChart._internal.buildPriceLine([candleAt(h0 - 100 * MS_PER_DAY, '1')], bars), []);
});

// ---------------------------------------------------------------------------
// pickAxisUnit
// ---------------------------------------------------------------------------

test('pickAxisUnit: scales from hour → day → week with span', () => {
  const day = MS_PER_DAY;
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

test('rateTickLabel takes its decimals from the tick step, not from the float noise in it', () => {
    const { rateTickLabel } = window.AppCharts.fundingRate._internal;
    // 0.01 − 0.009000000000000001 is 0.0009999999999999992: read raw, its
    // log10 floors one decade too low and would print a fourth decimal.
    const ticks = [{ value: 0.009000000000000001 }, { value: 0.01 }];
    assert.equal(rateTickLabel(0.01, ticks), '0.010%');
});

// ---------------------------------------------------------------------------
// x axis in UTC (the clock funding settles on, as the tooltip reads)
// ---------------------------------------------------------------------------

// Renders the chart through its public entry with Chart.js stood in by a
// constructor that keeps the config it was given.
function renderedChartConfig(fundingRows) {
  let config = null;
  const realChart = globalThis.Chart;
  const realGetElementById = globalThis.document.getElementById;
  globalThis.Chart = function (_ctx, cfg) { config = cfg; this.destroy = () => {}; };
  globalThis.document.getElementById = (id) => (id === 'fundingRateChart' ? { getContext: () => ({}) } : null);
  try {
    assert.equal(FundingChart.render({ ticker: 'BTC-USD', fundingRows, candleRows: [], cutoffMs: 0 }), true);
  } finally {
    globalThis.Chart = realChart;
    globalThis.document.getElementById = realGetElementById;
    FundingChart.clear();
  }
  return config;
}

function hourlyRows(firstIso, hours) {
  const first = Date.parse(firstIso);
  return Array.from({ length: hours }, (_, i) => ({
    effectiveAt: new Date(first + i * MS_PER_HOUR).toISOString(), rate: '0.0000125',
  }));
}

function inTimezone(tz, fn) {
  const saved = process.env.TZ;
  process.env.TZ = tz;
  try { return fn(); } finally {
    if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
  }
}

test('x-axis labels read UTC whatever the viewer\'s timezone, and the axis says so', () => {
  inTimezone('Asia/Tokyo', () => {
    const x = renderedChartConfig(hourlyRows('2030-03-11T16:00:00.250Z', 7 * 24)).options.scales.x;
    // An hourly axis: 2030-03-11T17:00Z is 02:00 on Mar 12 in Tokyo.
    assert.equal(x.ticks.callback(Date.parse('2030-03-11T17:00:00.000Z')), 'Mar 11, 17:00');
    assert.match(x.title.text, /UTC/);
    assert.equal(x.title.display, true);
  });
});

test('day ticks fall on UTC midnights and are labelled with the UTC date', () => {
  inTimezone('Asia/Tokyo', () => {
    const x = renderedChartConfig(hourlyRows('2026-09-01T00:00:00.250Z', 30 * 24)).options.scales.x;
    const scale = { min: Date.parse('2026-09-01T00:00:00.250Z'), max: Date.parse('2026-09-30T23:00:00.250Z'), ticks: [] };
    x.afterBuildTicks(scale);
    const values = scale.ticks.map(t => t.value);
    assert.ok(values.length > 0);
    for (const v of values) assert.equal(v % MS_PER_DAY, 0, new Date(v).toISOString());
    assert.equal(values[0], Date.parse('2026-09-02T00:00:00.000Z'));
    assert.equal(x.ticks.callback(values[0]), 'Sep 2');
  });
});

test('week ticks fall on UTC Mondays', () => {
  inTimezone('America/Los_Angeles', () => {
    const x = renderedChartConfig(hourlyRows('2026-07-02T00:00:00.250Z', 90 * 24)).options.scales.x;
    const scale = { min: Date.parse('2026-07-02T00:00:00.250Z'), max: Date.parse('2026-09-29T23:00:00.250Z'), ticks: [] };
    x.afterBuildTicks(scale);
    const values = scale.ticks.map(t => t.value);
    assert.ok(values.length > 0);
    const MONDAY = 1;
    for (const v of values) {
      assert.equal(v % MS_PER_DAY, 0, new Date(v).toISOString());
      assert.equal(new Date(v).getUTCDay(), MONDAY, new Date(v).toISOString());
    }
    assert.equal(x.ticks.callback(values[0]), 'Jul 6');
  });
});

test('a rate tick between printable values rounds half away from zero, as fmtFixed does', () => {
  const { rateTickLabel } = window.AppCharts.fundingRate._internal;
  const ticks = [{ value: 0.005 }, { value: 0.006 }];
  assert.equal(rateTickLabel(0.0075, ticks), '0.008%');
  assert.equal(rateTickLabel(-0.0075, ticks), '-0.008%');
});

test('a rate tick that prints as zero reads as the zero hourly rate does', () => {
  const { rateTickLabel } = window.AppCharts.fundingRate._internal;
  const ticks = [{ value: -0.0001 }, { value: 0 }];
  assert.equal(rateTickLabel(0, ticks), window.Format.formatHourlyRate(0));
  assert.equal(rateTickLabel(0, ticks), '0%');
});

// The tooltip's Annualized line and the CURRENT / PREDICTED (APR) cell
// annualize the same rate the same way, so at a tie rate (1.25e-7 steps
// whose APR ends in an exact 5) they print the same digits.
test('the tooltip annualizes a tie rate exactly as the APR cell does', () => {
  const config = renderedChartConfig([
    { effectiveAt: '2026-07-07T19:00:00.000Z', rate: '0.00000875' },
    { effectiveAt: '2026-07-07T20:00:00.000Z', rate: '-0.00001625' },
  ]);
  const label = config.options.plugins.tooltip.callbacks.label;
  const rateDataset = config.data.datasets.find(d => d.yAxisID === 'yRate');
  const annualized = (bar) => label({ dataset: rateDataset, parsed: { x: bar.x, y: bar.y } })[1];
  assert.deepEqual(rateDataset.data.map(annualized), ['Annualized:    +7.67%', 'Annualized:    -14.24%']);
  assert.equal(window.Format.formatFundingApr('0.00000875'), '7.67%');
  assert.equal(window.Format.formatFundingApr('-0.00001625'), '-14.24%');
});
