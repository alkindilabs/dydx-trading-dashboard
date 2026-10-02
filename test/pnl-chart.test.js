'use strict';

// The Overview cumulative-profit chart (src/charts/pnl-chart.js) rendered
// through its public entry with the real constants, Format and RiskMetrics
// modules. Chart.js is a stand-in that keeps the config it was built with,
// so the tooltip callbacks run exactly as the browser would call them.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

let lastConfig = null;
let liveCharts = 0;
globalThis.window = globalThis;
globalThis.Chart = function (_ctx, config) {
  lastConfig = config;
  liveCharts += 1;
  this.destroy = () => { liveCharts -= 1; };
};
const canvas = { getContext: () => ({}) };
const emptyState = { textContent: '', hidden: true };
const ELEMENTS = { pnlCumulativeChart: canvas, pnlCumulativeChartEmpty: emptyState };
globalThis.document = {
  getElementById: (id) => ELEMENTS[id] || null,
};

require('../src/constants.js');
require('../src/format.js');
require('../risk-metrics.js');
require('../src/charts/pnl-chart.js');

const { MS_PER_HOUR } = window.AppConstants;

const hourly = (hour, totalPnl) => ({
  createdAt: new Date(Date.UTC(2025, 0, 1) + hour * MS_PER_HOUR).toISOString(),
  totalPnl: String(totalPnl),
  equity: '0',
  netTransfers: '0',
});

// The tooltip lines of the candle for the bucket starting at `bucketMs`.
function candleTooltip(bucketMs) {
  const candles = lastConfig.data.datasets[0];
  const raw = candles.data.find(b => b.x === bucketMs);
  assert.ok(raw, `no candle at ${new Date(bucketMs).toISOString()}`);
  return lastConfig.options.plugins.tooltip.callbacks.label({ dataset: candles, raw });
}

test('a series too short to chart clears the previous chart and says why; a drawable one hides the empty state', () => {
  window.AppCharts.pnl.render([hourly(0, 0), hourly(1, 50), hourly(2, 80)]);
  assert.equal(liveCharts, 1);
  assert.equal(emptyState.hidden, true);

  // A first row of 0 adds no inception point: one point is no chart.
  window.AppCharts.pnl.render([hourly(0, 0)]);
  assert.equal(liveCharts, 0);
  assert.equal(emptyState.hidden, false);
  assert.match(emptyState.textContent, /^— Not enough \/historical-pnl rows/);

  // A gap clears the chart whatever rows are passed, and names itself.
  window.AppCharts.pnl.render([hourly(0, 0), hourly(1, 50)]);
  window.AppCharts.pnl.render([hourly(0, 0), hourly(1, 50)], null, '', 'Historical profit failed to load');
  assert.equal(liveCharts, 0);
  assert.equal(emptyState.textContent, '— Historical profit failed to load');
});

test('candle tooltip Below peak is the deepest drop below the running peak inside the bucket', () => {
  // Day 1: 0 → −100 (low) → +1000 (new peak) → +1000. The drop below the
  // running peak was $100; the day's low against its closing peak is not
  // a drawdown the account ever had.
  // Day 2: 1000 → 700 → 900: a $300 drop below the running peak.
  window.AppCharts.pnl.render([
    hourly(0, 0), hourly(1, -100), hourly(2, 1000), hourly(3, 1000),
    hourly(24, 1000), hourly(25, 700), hourly(26, 900),
  ]);

  const day1 = Date.UTC(2025, 0, 1);
  const day2 = Date.UTC(2025, 0, 2);
  assert.ok(candleTooltip(day1).includes('Below peak: -$100'), candleTooltip(day1).join(' | '));
  assert.ok(candleTooltip(day2).includes('Below peak: -$300'), candleTooltip(day2).join(' | '));
});

test('a bucket that only rises shows no Below peak line', () => {
  window.AppCharts.pnl.render([hourly(0, 0), hourly(1, 50), hourly(2, 80)]);

  const lines = candleTooltip(Date.UTC(2025, 0, 1));
  assert.ok(!lines.some(l => l.startsWith('Below peak')), lines.join(' | '));
});

test('the last candle closes at the live point, not at the last hourly row', () => {
  const live = { t: new Date(Date.UTC(2025, 0, 1) + 2.5 * MS_PER_HOUR).toISOString(), c: 20 };
  window.AppCharts.pnl.render([hourly(0, 0), hourly(1, 100), hourly(2, 60)], live);

  const candles = lastConfig.data.datasets[0].data;
  const last = candles[candles.length - 1];
  assert.equal(last.c, 20);
  assert.ok(candleTooltip(Date.UTC(2025, 0, 1)).includes('Below peak: -$80'));
});

test('a candle is coloured by its open and close as displayed: equal whole dollars read unchanged', () => {
  // A candle opens at its day's first point. Day 1 runs from the
  // inception 0 to 0.4 (both $0); day 2 runs 1 → 1000; day 3 runs
  // 900 → 500; day 4 runs 500 → 500 exactly.
  window.AppCharts.pnl.render([
    hourly(1, 0.2), hourly(2, 0.4),
    hourly(24, 1), hourly(25, 1000),
    hourly(48, 900), hourly(49, 500),
    hourly(72, 500), hourly(73, 500),
  ]);
  const candles = lastConfig.data.datasets[0];
  const colours = (dayIndex) => {
    const raw = candles.data[dayIndex];
    const ctx = { raw, dataIndex: dayIndex, dataset: candles };
    const fill = candles.backgroundColors(ctx);
    return { border: candles.borderColors(ctx), fill: [fill.up, fill.down, fill.unchanged] };
  };
  const [shownFlat, up, down, flat] = [0, 1, 2, 3].map(colours);
  assert.equal(candles.data[0].o === candles.data[0].c, false, 'the first candle moves by under a dollar');
  assert.deepEqual(shownFlat, flat, 'a candle whose open and close display alike reads as unchanged');
  assert.notDeepEqual(up, flat);
  assert.notDeepEqual(down, flat);
  assert.notDeepEqual(up, down);
  for (const c of [shownFlat, up, down]) assert.equal(new Set(c.fill).size, 1, 'one fill whatever the plugin compares');
});

test('a bucket whose drawdown displays as $0 shows no Below peak line', () => {
  window.AppCharts.pnl.render([hourly(0, 0), hourly(1, 100), hourly(2, 99.7), hourly(3, 100)]);

  const lines = candleTooltip(Date.UTC(2025, 0, 1));
  assert.ok(!lines.some(l => l.startsWith('Below peak')), lines.join(' | '));
});

test('Below peak is the displayed running peak less the displayed point, as the Max Drawdown card reads it', () => {
  // Peak and point both show +$100 (a raw $0.80): no drawdown.
  window.AppCharts.pnl.render([hourly(0, 0), hourly(1, 100.4), hourly(2, 99.6), hourly(3, 100.2)]);
  const flat = candleTooltip(Date.UTC(2025, 0, 1));
  assert.ok(!flat.some(l => l.startsWith('Below peak')), flat.join(' | '));

  // +$101 → $0: the raw 100.1 would read -$100.
  window.AppCharts.pnl.render([hourly(0, 0), hourly(1, 100.5), hourly(2, 0.4)]);
  assert.ok(candleTooltip(Date.UTC(2025, 0, 1)).includes('Below peak: -$101'));

  // Raw 10.4 (+$1 → -$10, shown $11) against raw 10.6 (+$20 → +$10, shown $10).
  window.AppCharts.pnl.render([0, 0.6, -9.8, 0.6, 20.4, 9.8, 20.4].map((v, h) => hourly(h, v)));
  const lines = candleTooltip(Date.UTC(2025, 0, 1));
  assert.ok(lines.includes('Below peak: -$11'), lines.join(' | '));
});

test('rows that do not reach inception open the chart at their first row, not at 0', () => {
  const rows = [hourly(0, 1000), hourly(1, 1100), hourly(2, 900)];
  window.AppCharts.pnl.render(rows, null, 'Historical profit before 2025-01-01 not in cached snapshot');
  assert.equal(lastConfig.data.datasets[0].data[0].o, 1000);
  window.AppCharts.pnl.render(rows);
  assert.equal(lastConfig.data.datasets[0].data[0].o, 0, 'complete rows open at the inception value');
});

// The tooltip title of the candle for the bucket starting at `bucketMs`.
function candleTitle(bucketMs) {
  return lastConfig.options.plugins.tooltip.callbacks.title([{ parsed: { x: bucketMs } }]);
}

// Daily rows from `fromMs` for `days` days, alternating so candles move.
const dailyRows = (fromMs, days) => Array.from({ length: days }, (_, d) => ({
  createdAt: new Date(fromMs + d * 24 * MS_PER_HOUR).toISOString(),
  totalPnl: String(d % 2),
  equity: '0',
  netTransfers: '0',
}));

test('a candle\'s tooltip title names the period it covers: the month, the week\'s Monday to Sunday, or the day', () => {
  window.AppCharts.pnl.render(dailyRows(Date.UTC(2025, 5, 19), 400));
  assert.equal(candleTitle(Date.UTC(2025, 8, 1)), 'Sep 2025');

  window.AppCharts.pnl.render(dailyRows(Date.UTC(2025, 5, 19), 100));
  assert.equal(candleTitle(Date.UTC(2025, 8, 1)), '2025-09-01 – 2025-09-07');

  window.AppCharts.pnl.render(dailyRows(Date.UTC(2025, 5, 19), 20));
  assert.equal(candleTitle(Date.UTC(2025, 5, 25)), '2025-06-25');
});

// The chart's modules, loaded in a fresh process for the timezone tests.
const CHART_MODULES = ['../src/constants.js', '../src/format.js', '../risk-metrics.js', '../src/charts/pnl-chart.js']
  .map(m => path.join(__dirname, m));

// Renders `rows` in a fresh node process started in timezone `tz`, so the
// module and the date formats it builds at load see that zone from the
// start, as in a viewer's browser. Returns the process's zone, the x-axis
// tick source and the tick labels of `ticksMs`.
function tickLabelsInTimezone(tz, rows, ticksMs) {
  const script = `
    globalThis.window = globalThis;
    let config = null;
    globalThis.Chart = function (_ctx, c) { config = c; this.destroy = () => {}; };
    globalThis.document = { getElementById: () => ({ getContext: () => ({}) }) };
    ${JSON.stringify(CHART_MODULES)}.forEach(m => require(m));
    const { rows, ticksMs } = JSON.parse(process.argv[1]);
    window.AppCharts.pnl.render(rows);
    const ticks = config.options.scales.x.ticks;
    process.stdout.write(JSON.stringify({
      zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      source: ticks.source,
      labels: ticksMs.map(ms => ticks.callback(ms)),
    }));
  `;
  const out = spawnSync(process.execPath, ['-e', script, JSON.stringify({ rows, ticksMs })],
    { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  return JSON.parse(out.stdout);
}

// Zones behind and ahead of UTC: a UTC day's first instant is the prior
// local day in the one, its last instant the next local day in the other.
const VIEWER_TIMEZONES = ['America/Los_Angeles', 'Asia/Tokyo'];
const LAST_MINUTE = { hour: 23, minute: 59 };

test('time-axis ticks sit on the candles and are labelled in UTC, like the tooltips, in any viewer timezone', () => {
  const DAYS = 60;
  const rows = Array.from({ length: DAYS * 24 }, (_, h) => ({
    createdAt: new Date(Date.UTC(2026, 2, 2) + h * MS_PER_HOUR).toISOString(),
    totalPnl: String(h % 2),
    equity: '0',
    netTransfers: '0',
  }));
  const ticksMs = [Date.UTC(2026, 2, 2), Date.UTC(2026, 2, 2, LAST_MINUTE.hour, LAST_MINUTE.minute), Date.UTC(2026, 2, 9)];
  for (const tz of VIEWER_TIMEZONES) {
    const { zone, source, labels } = tickLabelsInTimezone(tz, rows, ticksMs);
    assert.equal(zone, tz);
    assert.equal(source, 'data', 'ticks come from the candles\' UTC bucket starts');
    assert.deepEqual(labels, ['Mar 2', 'Mar 2', 'Mar 9'], tz);
  }
});

test('month ticks read the UTC month in any viewer timezone', () => {
  const rows = Array.from({ length: 400 }, (_, d) => ({
    createdAt: new Date(Date.UTC(2025, 5, 1) + d * 24 * MS_PER_HOUR).toISOString(),
    totalPnl: String(d % 2),
    equity: '0',
    netTransfers: '0',
  }));
  const ticksMs = [Date.UTC(2025, 5, 1), Date.UTC(2025, 5, 30, LAST_MINUTE.hour, LAST_MINUTE.minute)];
  for (const tz of VIEWER_TIMEZONES) {
    const { zone, labels } = tickLabelsInTimezone(tz, rows, ticksMs);
    assert.equal(zone, tz);
    assert.deepEqual(labels, ['Jun 2025', 'Jun 2025'], tz);
  }
});
