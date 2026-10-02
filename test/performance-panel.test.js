'use strict';

// The Performance tab panel (src/panels/performance.js) rendered through
// its public entries, renderMetrics and renderTables, with the real
// constants, Format, AppDom and RiskMetrics modules. Only the browser DOM
// is a stand-in (test/fake-dom.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const { el, rowTexts } = require('./fake-dom');

require('../src/constants.js');
require('../src/format.js');
require('../src/dom.js');
require('../risk-metrics.js');
require('../src/panels/performance.js');

const Performance = window.AppPanels.performance;
const RM = window.RiskMetrics;
const { MS_PER_HOUR } = window.AppConstants;

const START_MS = Date.parse('2025-07-01T00:00:00.000Z');

// The Sharpe and Sortino cards' markup tooltips, in place before any
// render as in the page.
const RATIO_CARD_MARKUP = { sharpeCard: 'Sharpe on time-weighted hourly returns, computed on /historical-pnl',
  sortinoCard: 'Sortino on time-weighted hourly returns' };
Object.entries(RATIO_CARD_MARKUP).forEach(([id, text]) => { el(id).title = text; });

// A closed position with complete fill attribution, closed `hoursIn`
// hours after START_MS and held for one hour.
function closedTrade(hoursIn, profit, fields = {}) {
  const closedMs = START_MS + hoursIn * MS_PER_HOUR;
  return {
    market: 'BTC-USD', side: 'LONG', status: 'CLOSED',
    createdAt: new Date(closedMs - MS_PER_HOUR).toISOString(),
    closedAt: new Date(closedMs).toISOString(),
    profit, complete: true, peakSize: 1, entryVwap: 100000,
    ...fields,
  };
}

// Closed trades with these profits, one per hour, in this order.
function tradesInOrder(profits) {
  return profits.map((profit, i) => closedTrade(i + 1, profit));
}

function renderMetrics(positions, closedGap) {
  Performance.renderMetrics(positions, RM.classifyClosed(positions, closedGap), closedGap);
}

// Column positions in the Monthly Performance Breakdown.
const MONTH = { LABEL: 0, PROFIT: 1, WIN_RATE: 2, TRADES: 3, AVG_WIN: 4, AVG_LOSS: 5, PROFIT_FACTOR: 6, MAX_DD: 7, SHARPE: 8 };
const monthlyRows = () => el('monthlyPerformanceBody').children;
const monthlyRow = (label) => monthlyRows().find(tr => tr.children[MONTH.LABEL].textContent === label);

// Hourly /historical-pnl rows from `fromIso` on constant equity, with a
// totalPnl that alternates up and down so the returns have a spread.
function hourlyHistory(fromIso, count) {
  const start = Date.parse(fromIso);
  return Array.from({ length: count }, (_, i) => ({
    createdAt: new Date(start + i * MS_PER_HOUR).toISOString(),
    equity: '100000',
    totalPnl: String(i % 2 ? 100 + i : i),
    netTransfers: '0',
  }));
}

// Runs `fn` with the process in timezone `tz`, restoring it afterwards.
function inTimezone(tz, fn) {
  const saved = process.env.TZ;
  process.env.TZ = tz;
  try { return fn(); } finally {
    if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
  }
}

// ---------------------------------------------------------------------------
// Max Consec. Wins / Losses.
// ---------------------------------------------------------------------------

test('the streak detail is the $ of the record streak, not of a shorter, larger one', () => {
  renderMetrics(tradesInOrder([1000, 1000, -1, 1, 1, 1, 1, 1]));
  assert.equal(el('maxConsecWins').textContent, '5');
  assert.equal(el('maxConsecWinsDetail').textContent, '+$5');

  renderMetrics(tradesInOrder([-1000, -1000, 1, -1, -1, -1]));
  assert.equal(el('maxConsecLosses').textContent, '3');
  assert.equal(el('maxConsecLossesDetail').textContent, '-$3');
});

test('of record streaks of equal length, the detail is the one with the larger $, whichever came first', () => {
  renderMetrics(tradesInOrder([30, 30, -1, 10, 10]));
  assert.equal(el('maxConsecWins').textContent, '2');
  assert.equal(el('maxConsecWinsDetail').textContent, '+$60');

  renderMetrics(tradesInOrder([-5, -5, 1, -40, -40, 1, -5, -5]));
  assert.equal(el('maxConsecLosses').textContent, '2');
  assert.equal(el('maxConsecLossesDetail').textContent, '-$80');
});

test('the streak detail sums the run exactly, so a decimal half dollar rounds up rather than by the float just below it', () => {
  // Added as floats these 24 wins come to 9886706.499999994; as decimals
  // they are exactly 9886706.5, which rounds half away from zero.
  const wins = [499048.8349, 586309.409509, 741506.345916, 252823.681224, 51916.298947, 51666.438139,
    990635.357328, 959333.537594, 989193.160083, 343030.310397, 416113.108591, 195864.762272,
    587939.571864, 431073.399462, 344065.400002, 380923.433408, 555053.975227, 10438.130243,
    858984.912681, 60719.975765, 13950.11694, 386094.757071, 180018.520068, 3.062369];
  renderMetrics(tradesInOrder(wins));
  assert.equal(el('maxConsecWins').textContent, String(wins.length));
  assert.equal(el('maxConsecWinsDetail').textContent, '+$9,886,707');
});

test('a streak caption takes its tone from the $ it shows; a reason caption has none', () => {
  // The markup ships both captions toned, wins green and losses red.
  const seedMarkupTones = () => {
    el('maxConsecWinsDetail').className = 'metric-change mono profit';
    el('maxConsecLossesDetail').className = 'metric-change mono loss';
  };
  seedMarkupTones();
  renderMetrics(tradesInOrder([0.2, 0.2, -0.3, -0.1]));
  assert.equal(el('maxConsecWinsDetail').textContent, '$0');
  assert.equal(el('maxConsecWinsDetail').className, 'metric-change mono zero');
  assert.equal(el('maxConsecLossesDetail').textContent, '$0');
  assert.equal(el('maxConsecLossesDetail').className, 'metric-change mono zero');

  renderMetrics(tradesInOrder([5, -3]));
  assert.equal(el('maxConsecWinsDetail').className, 'metric-change mono profit');
  assert.equal(el('maxConsecLossesDetail').className, 'metric-change mono loss');

  const reason = 'Closed positions failed to load';
  seedMarkupTones();
  renderMetrics([], reason);
  ['maxConsecWinsDetail', 'maxConsecLossesDetail'].forEach(id => {
    assert.equal(el(id).textContent, reason);
    assert.equal(el(id).className, 'metric-change mono', id);
  });
});

test('a scratch neither extends nor breaks a streak', () => {
  renderMetrics(tradesInOrder([10, 10, 0, 10, 10]));
  assert.equal(el('maxConsecWins').textContent, '4');
  assert.equal(el('maxConsecWinsDetail').textContent, '+$40');
});

// Closed trades with these profits in this chain order: the first closes
// at hour 1, the rest together one block (one millisecond) later. Each
// carries its closing fill, and `fills` lists them in chain order.
function closesInOneBlockAfterOne(profits) {
  const fills = [];
  const positions = profits.map((profit, i) => {
    const closedAt = closedTrade(i === 0 ? 1 : 2, 0).closedAt;
    const fill = { market: 'BTC-USD', createdAt: closedAt, createdAtHeight: String(i === 0 ? 1 : 2) };
    fills.push(fill);
    return closedTrade(i === 0 ? 1 : 2, profit, { portions: [{ fill }] });
  });
  return { positions, fills };
}

function renderMetricsWithFills(positions, fills) {
  Performance.renderMetrics(positions, RM.classifyClosed(positions), '', fills);
}

test('closes in one millisecond enter the streaks in their closing fills\' chain order, whatever the listing order', () => {
  // Chain: +100, then -10, +100, +100 in one block: the longest win run is 2.
  const { positions, fills } = closesInOneBlockAfterOne([100, -10, 100, 100]);
  const [first, loss, win2, win3] = positions;
  [[first, loss, win2, win3], [first, win2, win3, loss], [win3, loss, first, win2]].forEach(listed => {
    renderMetricsWithFills(listed, fills);
    assert.equal(el('maxConsecWins').textContent, '2', `listed ${listed.map(p => p.profit)}`);
    assert.equal(el('maxConsecWinsDetail').textContent, '+$200');
  });
});

test('the win rate trend takes closes in one millisecond in chain order, not wins before losses', () => {
  // A win, then L, W, W, L, L in one block: the last 3 decisive are W, L, L.
  const { positions, fills } = closesInOneBlockAfterOne([100, -100, 100, 100, -100, -100]);
  [positions, positions.slice().reverse()].forEach(listed => {
    renderMetricsWithFills(listed, fills);
    assert.equal(el('winRateTrend').textContent, '↓ 33.3%');
    assert.equal(el('winRateTrendDetail').textContent, 'Last 3 decisive (vs 50.0% all-time)');
    assert.equal(el('maxConsecLosses').textContent, '2');
  });
});

// ---------------------------------------------------------------------------
// Win Rate Trend.
// ---------------------------------------------------------------------------

test('the win rate trend compares a recent window smaller than the history', () => {
  // 30 wins then 10 losses: the last half holds 10 of the wins.
  const profits = [...Array(30).fill(100), ...Array(10).fill(-100)];
  renderMetrics(tradesInOrder(profits));
  assert.equal(el('winRateTrendDetail').textContent, 'Last 20 decisive (vs 75.0% all-time)');
  assert.equal(el('winRateTrend').textContent, '↓ 50.0%');
});

test('every win rate on the tab reads as the Win Rate card does: 3 wins of 2000 decisive trades are 0.2%', () => {
  // 0.15%, which Format.formatPercent (the Win Rate card's formatter)
  // reads 0.2% and toFixed(1) 0.1%. One trade a minute: all in July 2025.
  const DECISIVE = 2000, WINS = 3, MINUTES_PER_HOUR = 60;
  const trades = Array.from({ length: DECISIVE },
    (_, i) => closedTrade(1 + i / MINUTES_PER_HOUR, i < WINS ? 100 : -1));
  const cardText = window.Format.formatPercent((WINS / DECISIVE) * window.AppConstants.PERCENT);
  assert.equal(cardText, '0.2%');

  renderMetrics(trades);
  assert.match(el('winRateTrendDetail').textContent, /\(vs 0\.2% all-time\)$/);
  assert.match(el('avgRRRDetail').textContent, /^WR 0\.2% vs /);

  Performance.renderTables(trades, []);
  const ASSET_WIN_RATE = 5;
  assert.equal(monthlyRow('July 2025').children[MONTH.WIN_RATE].textContent, cardText);
  assert.equal(el('assetPerformanceBody').children[0].children[ASSET_WIN_RATE].textContent, cardText);
});

test('Monthly AVG WIN on an exact half-dollar mean rounds up: the mean is the exact quotient', () => {
  // Nineteen wins summing exactly to $175,341.50, a mean of $9,228.50
  // (float addition leaves 9228.499999999995).
  const trades = tradesInOrder([4944.465945, 17218.083112, 12540.0395, 33.972375, 11702.436775, 8859.716455,
    10188.269984, 10890.73597, 4920.29401, 11853.752973, 15861.757724, 11153.349634, 17775.272937, 1253.918992,
    8595.695135, 13225.937074, 8199.33873, 547.462436, 5577.000239]);
  Performance.renderTables(trades, []);
  assert.equal(monthlyRow('July 2025').children[MONTH.AVG_WIN].textContent, '+$9,229');
});

test('a Payoff caption whose win rate displays alike its breakeven rate takes the tone of the expectancy', () => {
  // 4 wins of +$7,496 and 12 losses of -$2,504: WR 25.0% vs breakeven 25.04%, expectancy -$4.
  const trades = tradesInOrder([...Array(4).fill(7496), ...Array(12).fill(-2504)]);
  renderMetrics(trades);
  assert.equal(el('avgRRRDetail').textContent, 'WR 25.0% vs 25.0% breakeven');
  assert.match(el('avgRRRDetail').className, /\bloss\b/);
});

test('the Payoff card reads N/A naming the empty bucket, as the Overview card does; — only with a classifier gap', () => {
  [
    [[10, 20, 30, 40], 'No losses recorded'],
    [[-10, -20, -30, -40], 'No wins recorded'],
    [[0, 0, 0, 0], 'No decisive trades'],
  ].forEach(([profits, caption]) => {
    renderMetrics(tradesInOrder(profits));
    assert.equal(el('avgRRR').textContent, 'N/A', caption);
    assert.equal(el('avgRRRDetail').textContent, caption);
  });

  const reason = 'Closed positions failed to load';
  renderMetrics([], reason);
  assert.equal(el('avgRRR').textContent, '—');
  assert.equal(el('avgRRRDetail').textContent, reason);
});

// `earlier` decisive trades with `earlierWins` wins (first), then the
// RECENT_DECISIVE_CAP recent ones with `recentWins` wins.
function trendTrades(earlier, earlierWins, recentWins) {
  const recent = window.AppConstants.TUNABLES.RECENT_DECISIVE_CAP;
  const outcomes = (n, wins) => Array.from({ length: n }, (_, i) => (i < wins ? 100 : -100));
  return tradesInOrder([...outcomes(earlier, earlierWins), ...outcomes(recent, recentWins)]);
}

test('the win rate trend takes its arrow and tone from the rates as displayed', () => {
  // Both read '60.0%' against '59.0% all-time' (59/100 raw, 69/117 =
  // 58.97% raw), so both get the same flat arrow and no tone.
  [trendTrades(50, 29, 30), trendTrades(67, 39, 30)].forEach(trades => {
    renderMetrics(trades);
    assert.equal(el('winRateTrendDetail').textContent, 'Last 50 decisive (vs 59.0% all-time)');
    assert.equal(el('winRateTrend').textContent, '→ 60.0%');
    assert.equal(el('winRateTrend').className.trim(), 'metric-value mono');
  });
  // 31/50 = 62.0% against 60/100 = 60.0%: up, green.
  renderMetrics(trendTrades(50, 29, 31));
  assert.equal(el('winRateTrend').textContent, '↑ 62.0%');
  assert.match(el('winRateTrend').className, /\bprofit\b/);
});

test('too few decisive trades for a window smaller than the history read — with the reason', () => {
  renderMetrics(tradesInOrder([100, -100, 100]));
  assert.equal(el('winRateTrend').textContent, '—');
  assert.match(el('winRateTrendDetail').textContent, /^Needs ≥4 decisive trades/);
});

// ---------------------------------------------------------------------------
// Position Size and Hold Time distributions.
// ---------------------------------------------------------------------------

const histogramLabels = (id) => el(id).children
  .filter(c => c.className.includes('distribution-label'))
  .map(c => c.textContent);
const histogramCounts = (id) => el(id).children
  .filter(c => c.className.includes('distribution-count'))
  .map(c => Number(c.textContent));

test('equal notionals render one bin labelled with that notional', () => {
  renderMetrics(tradesInOrder([100, -50, 20]));
  assert.deepEqual(histogramLabels('sizeDistribution'), ['$100.00K']);
  assert.deepEqual(histogramCounts('sizeDistribution'), [3]);
});

test('size bins whose edges would print alike are merged until every label is distinct', () => {
  const positions = [100000, 100002, 100003].map((entryVwap, i) => closedTrade(i + 1, 10, { entryVwap }));
  renderMetrics(positions);
  const labels = histogramLabels('sizeDistribution');
  assert.equal(new Set(labels).size, labels.length, `labels ${labels.join(' | ')}`);
  assert.equal(histogramCounts('sizeDistribution').reduce((a, b) => a + b, 0), 3);
});

test('a notional exactly at a size bin edge lands in the bin that edge opens, whatever the float noise', () => {
  // 0.1, 0.6 and 1.1 at $3,000: $300, $1,800 and $3,300 (as 3300.0000000000005),
  // so the middle trade's offset over the step is 1.9999999999999998 in binary
  // although it sits exactly on the edge that opens '$1.80K–$2.55K'.
  const positions = [0.1, 0.6, 1.1].map((peakSize, i) => closedTrade(i + 1, 10, { peakSize, entryVwap: 3000 }));
  renderMetrics(positions);
  assert.deepEqual(histogramLabels('sizeDistribution'),
    ['$300.00–$1.05K', '$1.05K–$1.80K', '$1.80K–$2.55K', '$2.55K–∞']);
  assert.deepEqual(histogramCounts('sizeDistribution'), [1, 0, 1, 1]);
});

test('a notional that prints as a size bin edge lands in the bin that label opens', () => {
  // $300, $1,799 and $3,300: the edges are $300, $1,050, $1,800 and $2,550,
  // and $1,799 prints as '$1.80K', the label that opens the third bin,
  // although it lies $1 below that edge.
  const positions = [300, 1799, 3300].map((entryVwap, i) => closedTrade(i + 1, 10, { entryVwap }));
  renderMetrics(positions);
  assert.equal(`$${window.Format.formatShortNumber(1799)}`, '$1.80K');
  assert.deepEqual(histogramLabels('sizeDistribution'),
    ['$300.00–$1.05K', '$1.05K–$1.80K', '$1.80K–$2.55K', '$2.55K–∞']);
  assert.deepEqual(histogramCounts('sizeDistribution'), [1, 0, 1, 1]);
});

test('a CLOSED list that failed to load leaves the hold-time histogram with the reason, not zero counts', () => {
  const reason = 'Closed positions failed to load';
  const open = { market: 'BTC-USD', side: 'LONG', status: 'OPEN', createdAt: '2025-07-01T00:00:00.000Z' };
  renderMetrics([open], reason);
  const children = el('holdTimeDistribution').children;
  assert.equal(children.length, 1);
  assert.equal(children[0].textContent, reason);
});

test('a CLOSED row without a valid entry-to-close window leaves the hold-time histogram with the reason', () => {
  const valid = closedTrade(1, 10);
  const noClose = closedTrade(2, 10, { closedAt: null });
  const closesBeforeEntry = closedTrade(3, 10, { createdAt: closedTrade(4, 0).closedAt });
  const positions = [valid, noClose, closesBeforeEntry];
  renderMetrics(positions, '');
  const reason = RM.holdTimeGap(positions);
  assert.match(reason, /^2 closed positions/);
  const children = el('holdTimeDistribution').children;
  assert.equal(children.length, 1);
  assert.equal(children[0].textContent, reason);
});

test('a position closed at the instant it opened is a valid zero hold, counted in the first bin', () => {
  const zeroHold = closedTrade(1, 10, { createdAt: closedTrade(1, 0).closedAt });
  renderMetrics([zeroHold], '');
  const counts = histogramCounts('holdTimeDistribution');
  assert.equal(counts[0], 1);
  assert.equal(counts.reduce((a, b) => a + b, 0), 1);
});

test('the hold-time histogram bins each hold as its DURATION displays it', () => {
  const { MS_PER_MIN } = window.AppConstants;
  const closeMs = Date.parse(closedTrade(1000, 0).closedAt);
  const heldFor = (ms) => closedTrade(1000, 10, { createdAt: new Date(closeMs - ms).toISOString() });
  // DURATION '1h 0m', '4h 0m', '1d 0h', '3d 0h' and '7d 0h': each on the
  // lower edge of the next bin up.
  const holds = [
    MS_PER_HOUR - 300,
    4 * MS_PER_HOUR - 200,
    24 * MS_PER_HOUR - 300,
    71 * MS_PER_HOUR + 40 * MS_PER_MIN,
    167 * MS_PER_HOUR + 40 * MS_PER_MIN,
  ];
  assert.deepEqual(holds.map(ms => window.Format.formatDuration(ms)), ['1h 0m', '4h 0m', '1d 0h', '3d 0h', '7d 0h']);
  renderMetrics(holds.map(heldFor), '');
  // Each bin is [lo, hi) on the displayed hold, so the open-ended last bin
  // holds a trade whose DURATION reads exactly '7d 0h': its label says ≥.
  assert.deepEqual(histogramLabels('holdTimeDistribution'), ['0–1h', '1–4h', '4–12h', '12–24h', '1–3d', '3–7d', '≥7d']);
  assert.deepEqual(histogramCounts('holdTimeDistribution'), [0, 1, 1, 0, 1, 1, 1]);
});

test('the Win/Loss Distribution bins each return as the board\'s PROFIT % displays it', () => {
  // -1400 on $10,000 is exactly -14% (-14.000000000000002 in binary) and
  // 1728.3 on $12,345 exactly +14% (13.999999999999998): the bins whose
  // lower edge they sit on.
  const trades = [
    closedTrade(1, -1400, { peakSize: 1, entryVwap: 10000 }),
    closedTrade(2, 1728.3, { peakSize: 1, entryVwap: 12345 }),
  ];
  renderMetrics(trades, '');
  const counts = histogramCounts('winLossDistribution');
  const countOf = label => counts[histogramLabels('winLossDistribution').indexOf(label)];
  assert.equal(countOf('-14% to -12%'), 1);
  assert.equal(countOf('14% to 16%'), 1);
  assert.equal(counts.reduce((a, b) => a + b, 0), 2);
});

test('a decisive trade whose return displays as 0.00% stays on its own side of the 0 edge', () => {
  // -$40 on $1M of peak notional is -0.004%, which PROFIT % shows as 0.00%:
  // still a loss on the Win Rate card, so it bins below 0.
  const ON_A_MILLION = { peakSize: 10, entryVwap: 100000 };
  const trades = [
    closedTrade(1, -40, ON_A_MILLION),
    closedTrade(2, 5000, ON_A_MILLION),
    closedTrade(3, -3000, ON_A_MILLION),
  ];
  renderMetrics(trades, '');
  const counts = histogramCounts('winLossDistribution');
  const countOf = label => counts[histogramLabels('winLossDistribution').indexOf(label)];
  assert.equal(countOf('-2% to 0%'), 2);
  assert.equal(countOf('0% to 2%'), 1);
});

// ---------------------------------------------------------------------------
// Monthly Performance Breakdown.
// ---------------------------------------------------------------------------

test('a trade closing on a month\'s last UTC evening counts in that UTC month in any viewer timezone', () => {
  inTimezone('Asia/Tokyo', () => {
    const trade = closedTrade(0, 100, { closedAt: '2025-08-31T20:00:00.000Z', createdAt: '2025-08-31T19:00:00.000Z' });
    Performance.renderTables([trade], []);
    assert.deepEqual(monthlyRows().map(tr => tr.children[MONTH.LABEL].textContent), ['August 2025']);
  });
});

test('months sort newest first on an engine that cannot parse "September 2025"', () => {
  // JavaScriptCore (Safari) returns an invalid Date for 'Month YYYY'.
  const RealDate = Date;
  const ISO_PREFIX = /^\d{4}-\d{2}-\d{2}/;
  class IsoOnlyDate extends RealDate {
    constructor(...args) {
      const unparseable = args.length === 1 && typeof args[0] === 'string' && !ISO_PREFIX.test(args[0]);
      if (unparseable) super(NaN); else super(...args);
    }
  }
  const trades = [
    closedTrade(0, 100, { closedAt: '2025-07-10T00:00:00.000Z', createdAt: '2025-07-09T00:00:00.000Z' }),
    closedTrade(0, 100, { closedAt: '2025-09-10T00:00:00.000Z', createdAt: '2025-09-09T00:00:00.000Z' }),
  ];
  const history = [
    { createdAt: '2025-07-31T00:00:00.000Z', equity: '1000', totalPnl: '1', netTransfers: '0' },
    { createdAt: '2025-08-15T00:00:00.000Z', equity: '1000', totalPnl: '2', netTransfers: '0' },
    { createdAt: '2025-09-30T00:00:00.000Z', equity: '1000', totalPnl: '3', netTransfers: '0' },
  ];
  globalThis.Date = IsoOnlyDate;
  try {
    Performance.renderTables(trades, history);
  } finally {
    globalThis.Date = RealDate;
  }
  assert.deepEqual(monthlyRows().map(tr => tr.children[MONTH.LABEL].textContent),
    ['September 2025', 'August 2025', 'July 2025']);
});

test('a complete 30-day month shows its Sharpe; a sparse month reads — with the gate\'s reason', () => {
  const HOURS_IN_SEPTEMBER = 30 * 24;
  const SPARSE_ROWS = 84;
  const history = [
    ...hourlyHistory('2025-09-01T00:00:00.000Z', HOURS_IN_SEPTEMBER),
    ...hourlyHistory('2025-10-01T00:00:00.000Z', SPARSE_ROWS),
  ];
  Performance.renderTables([], history);
  const september = monthlyRow('September 2025').children[MONTH.SHARPE];
  assert.match(september.textContent, /^-?\d+\.\d{2}$/);
  const october = monthlyRow('October 2025').children[MONTH.SHARPE];
  assert.equal(october.textContent, '—');
  assert.match(october.title, /of the month/);
});

// September 2025 rows of one hourly return process (Park–Miller LCG,
// Box–Muller normals) on $100000: every hour, or every `sparseStep` hours
// through the first `sparseHours` hours and hourly after.
function septemberProcessRows(hourlyReturns, sparseHours, sparseStep) {
  const startMs = Date.parse('2025-09-01T00:00:00.000Z');
  const equity0 = 100000;
  let pnl = 0;
  const rows = [{ createdAt: new Date(startMs).toISOString(), totalPnl: '0', equity: String(equity0), netTransfers: '0' }];
  hourlyReturns.forEach((r, i) => {
    pnl += r * (equity0 + pnl);
    const hour = i + 1;
    if (hour > sparseHours || hour % sparseStep === 0) {
      rows.push({ createdAt: new Date(startMs + hour * MS_PER_HOUR).toISOString(), totalPnl: String(pnl), equity: String(equity0 + pnl), netTransfers: '0' });
    }
  });
  return rows;
}

test('a month\'s SHARPE reads one process alike whether its first days arrive in 6-hour or hourly rows', () => {
  const HOURS_IN_SEPTEMBER = 30 * 24;
  const SPARSE_HOURS = 10 * 24;
  const SPARSE_STEP = 6;
  let seed = 1;
  const uniform = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const returns = Array.from({ length: HOURS_IN_SEPTEMBER - 1 },
    () => 0.0002 + 0.002 * Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform()));
  const septemberSharpe = (rows) => {
    Performance.renderTables([], rows);
    return Number(monthlyRow('September 2025').children[MONTH.SHARPE].textContent);
  };
  const hourly = septemberSharpe(septemberProcessRows(returns, 0, SPARSE_STEP));
  const mixed = septemberSharpe(septemberProcessRows(returns, SPARSE_HOURS, SPARSE_STEP));
  // Counted as one hour each, the 6-hour returns read about 15% higher.
  const SAMPLING_TOLERANCE = 0.05;
  assert.ok(Math.abs(mixed / hourly - 1) < SAMPLING_TOLERANCE, `hourly ${hourly}, partly 6-hourly ${mixed}`);
});

test('a month that passes the gate with returns that never move reads SHARPE — with "Returns have no spread"', () => {
  // Every hour of July on idle funded equity: 743 returns of exactly 0.
  const HOURS_IN_JULY = 31 * 24;
  const idle = Array.from({ length: HOURS_IN_JULY }, (_, i) => ({
    createdAt: new Date(Date.parse('2025-07-01T00:00:00.000Z') + i * MS_PER_HOUR).toISOString(),
    equity: '100000', totalPnl: '0', netTransfers: '0',
  }));
  Performance.renderTables([], idle);
  const cell = monthlyRow('July 2025').children[MONTH.SHARPE];
  assert.equal(cell.textContent, '—');
  assert.equal(cell.title, 'Returns have no spread');
});

test('a month with no /historical-pnl rows reads — and the next month\'s PROFIT is not credited with its change', () => {
  const history = [
    { createdAt: '2025-01-31T00:00:00.000Z', equity: '1000', totalPnl: '100', netTransfers: '0' },
    { createdAt: '2025-03-10T00:00:00.000Z', equity: '1000', totalPnl: '600', netTransfers: '0' },
    { createdAt: '2025-03-31T00:00:00.000Z', equity: '1000', totalPnl: '650', netTransfers: '0' },
  ];
  Performance.renderTables([], history);
  assert.deepEqual(monthlyRows().map(tr => tr.children[MONTH.LABEL].textContent),
    ['March 2025', 'February 2025', 'January 2025']);
  const february = monthlyRow('February 2025').children[MONTH.PROFIT];
  assert.equal(february.textContent, '—');
  assert.match(february.title, /no \/historical-pnl rows/i);
  const march = monthlyRow('March 2025').children[MONTH.PROFIT];
  assert.equal(march.textContent, '—');
  assert.match(march.title, /February 2025/);
  assert.equal(monthlyRow('January 2025').children[MONTH.PROFIT].textContent, '+$100');
});

test('monthly PROFIT cells difference the month-end totals at whole dollars, so the column sums to the headline as displayed', () => {
  // Month-ends +$0.50, +$1.00 and the live +$1.50: shown +$1, +$1, +$2,
  // so the months read +$1, $0, +$1 and add up to the +$2 headline (each
  // month's own $0.50 change, rounded alone, would read +$1 three times).
  const rows = [
    { createdAt: '2025-01-31T00:00:00.000Z', equity: '1000', totalPnl: '0.5', netTransfers: '0' },
    { createdAt: '2025-02-28T00:00:00.000Z', equity: '1000', totalPnl: '1.0', netTransfers: '0' },
    { createdAt: '2025-03-15T00:00:00.000Z', equity: '1000', totalPnl: '1.2', netTransfers: '0' },
  ];
  const live = RM.livePnlPoint(rows, 1.5, Date.parse('2025-03-31T00:00:00.000Z'));
  Performance.renderTables([], rows, null, {}, live);
  const profit = (label) => monthlyRow(label).children[MONTH.PROFIT];
  assert.deepEqual(['January 2025', 'February 2025', 'March 2025'].map(m => profit(m).textContent),
    ['+$1', '$0', '+$1']);
  assert.ok(profit('February 2025').classList.contains('zero'), profit('February 2025').className);
  assert.ok(profit('March 2025').classList.contains('profit'), profit('March 2025').className);
});

test('the PROFIT header says the column adds up to the headline rounded to whole dollars, not as the card displays it', () => {
  // The Total Profit card shows cents; the column telescopes at whole dollars.
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'index.html'), 'utf8');
  const header = html.match(/<th title="([^"]*)">PROFIT<\/th>/);
  assert.ok(header, 'the monthly table has a PROFIT header with a title');
  assert.match(header[1], /adds up to the Total Profit headline rounded to whole dollars/);
  assert.doesNotMatch(header[1], /as displayed|as the headline shows it/);
});

test('a month-end total on a decimal half dollar rounds half away from zero in the PROFIT column', () => {
  // Month-ends -$54.886431 and -$156.50: shown -$55 and -$157 (-$156 if
  // the half dollar rounded toward +∞, as Math.round does), so February
  // reads -$102.
  Performance.renderTables([], [
    { createdAt: '2025-01-31T00:00:00.000Z', equity: '1000', totalPnl: '-54.886431', netTransfers: '0' },
    { createdAt: '2025-02-28T00:00:00.000Z', equity: '1000', totalPnl: '-156.5', netTransfers: '0' },
  ]);
  assert.equal(monthlyRow('February 2025').children[MONTH.PROFIT].textContent, '-$102');
});

test('the monthly table still lists each month\'s trades with the classifier', () => {
  const trades = [
    closedTrade(0, 100, { closedAt: '2025-07-10T00:00:00.000Z', createdAt: '2025-07-09T00:00:00.000Z' }),
    closedTrade(0, -50, { closedAt: '2025-07-20T00:00:00.000Z', createdAt: '2025-07-19T00:00:00.000Z' }),
  ];
  Performance.renderTables(trades, []);
  const [row] = rowTexts('monthlyPerformanceBody');
  assert.equal(row[MONTH.LABEL], 'July 2025');
  assert.equal(row[MONTH.WIN_RATE], '50.0%');
  assert.equal(row[MONTH.PROFIT], '—');
});

test('a CLOSED trade without a valid close time blanks every month\'s classifier cells with the reason, never moving to its open month', () => {
  const july = [
    closedTrade(0, 10, { closedAt: '2025-07-10T00:00:00.000Z', createdAt: '2025-07-09T00:00:00.000Z' }),
    closedTrade(0, -5, { closedAt: '2025-07-20T00:00:00.000Z', createdAt: '2025-07-19T00:00:00.000Z' }),
  ];
  const classifierColumns = [MONTH.WIN_RATE, MONTH.TRADES, MONTH.AVG_WIN, MONTH.AVG_LOSS, MONTH.PROFIT_FACTOR];
  [undefined, 'not-a-date'].forEach(closedAt => {
    const untimed = closedTrade(0, -1000, { closedAt, createdAt: '2025-06-15T00:00:00.000Z' });
    Performance.renderTables([...july, untimed], []);
    const rows = monthlyRows();
    assert.deepEqual(rows.map(tr => tr.children[MONTH.LABEL].textContent), ['July 2025'], `closedAt ${closedAt}`);
    classifierColumns.forEach(col => {
      const cell = rows[0].children[col];
      assert.equal(cell.textContent, '—', `column ${col}, closedAt ${closedAt}`);
      assert.equal(cell.title, '1 closed position without a valid close time');
    });
  });
});


test('the current month\'s PROFIT and MAX DD run to the live point', () => {
  const history = [
    { createdAt: '2025-08-31T00:00:00.000Z', equity: '1000', totalPnl: '0', netTransfers: '0' },
    { createdAt: '2025-09-01T00:00:00.000Z', equity: '1000', totalPnl: '100', netTransfers: '0' },
    { createdAt: '2025-09-02T00:00:00.000Z', equity: '1000', totalPnl: '200', netTransfers: '0' },
    { createdAt: '2025-09-03T00:00:00.000Z', equity: '1000', totalPnl: '150', netTransfers: '0' },
  ];
  const live = { t: '2025-09-04T00:00:00.000Z', c: 90 };
  Performance.renderTables([], history, null, {}, live);
  const september = monthlyRow('September 2025').children;
  assert.equal(september[MONTH.PROFIT].textContent, '+$90');
  assert.equal(september[MONTH.MAX_DD].textContent, '-$110');
});

test('a month\'s MAX DD is its deepest drawdown as displayed: the displayed peak less the displayed trough', () => {
  const at = (day, totalPnl) => ({ createdAt: `2025-09-0${day}T00:00:00.000Z`, equity: '1000', totalPnl: String(totalPnl), netTransfers: '0' });
  // +$101 → the live $0: the raw 100.1 would read -$100 beside the Max Drawdown card's -$101.
  Performance.renderTables([], [at(1, 0), at(2, 100.5), at(3, 50)], null, {}, { t: '2025-09-04T00:00:00.000Z', c: 0.4 });
  assert.equal(monthlyRow('September 2025').children[MONTH.MAX_DD].textContent, '-$101');

  // Raw 10.4 (+$1 → -$10, shown $11) against raw 10.6 (+$20 → +$10, shown $10).
  Performance.renderTables([], [0.6, -9.8, 0.6, 20.4, 9.8, 20.4].map((v, i) => at(i + 1, v)));
  assert.equal(monthlyRow('September 2025').children[MONTH.MAX_DD].textContent, '-$11');

  // Peak and trough both show +$100 (a raw $0.80): no drawdown, $0 neutral.
  Performance.renderTables([], [at(1, 0), at(2, 100.4), at(3, 99.6), at(4, 100.2)]);
  const cell = monthlyRow('September 2025').children[MONTH.MAX_DD];
  assert.equal(cell.textContent, '$0');
  assert.ok(cell.classList.contains('zero'), cell.className);
});

// ---------------------------------------------------------------------------
// Performance by Asset SHARPE: per-trade return on equity at open.
// ---------------------------------------------------------------------------

const ASSET_SHARPE = 9;
const HOURS_PER_MONTH = 30 * 24;
// One /historical-pnl row before every trade: $1M of equity at each open.
const EQUITY_AT_OPEN = [{ createdAt: '2025-06-01T00:00:00.000Z', equity: '1000000', totalPnl: '0', netTransfers: '0' }];
const assetRow = () => el('assetPerformanceBody').children[0].children;

test('an asset that lost money shows a negative SHARPE even when its small trades won big on notional', () => {
  // Winners on $10K of notional (+14%, +7.4%, +0.24%), losers on $100K
  // (−3.54%, −2.69%, −0.62%): +2.5% a trade on notional, −$4686 in dollars.
  const trades = [[1400, 0.1], [-3540, 1], [740, 0.1], [-2690, 1], [24, 0.1], [-620, 1]]
    .map(([profit, peakSize], i) => closedTrade((i + 1) * HOURS_PER_MONTH, profit, { peakSize }));
  Performance.renderTables(trades, EQUITY_AT_OPEN);
  assert.match(assetRow()[ASSET_SHARPE].textContent, /^-\d+\.\d{2}$/);
});

test('AVG PROFIT, BEST and WORST round at cents through the one cent rule (RiskMetrics.wholeCents)', () => {
  // A FIFO 0.015 whose binary difference is 0.014999999999986358
  // (1000.115 − 1000.1): the attribution sums it exactly, and wholeCents
  // rounds that half cent away from zero to 2 cents.
  const AVG = 6, BEST = 7, WORST = 8;
  const attributedTrade = (open, close) => {
    const trade = closedTrade(1, null);
    const fill = (createdAt, side, price) => ({ market: trade.market, createdAt, side, size: '1', price, fee: '0' });
    const fills = [fill(trade.createdAt, open, '1000.1'), fill(trade.closedAt, close, '1000.115')];
    const side = open === 'BUY' ? 'LONG' : 'SHORT';
    const position = { ...trade, side };
    return { ...position, ...RM.attributeFillsToPositions([position], fills).get(position) };
  };
  Performance.renderTables([attributedTrade('BUY', 'SELL')], []);
  assert.deepEqual([AVG, BEST].map(i => assetRow()[i].textContent), ['+$0.02', '+$0.02']);
  assert.match(assetRow()[BEST].className, /\bprofit\b/);
  Performance.renderTables([attributedTrade('SELL', 'BUY')], []);
  assert.deepEqual([AVG, WORST].map(i => assetRow()[i].textContent), ['-$0.02', '-$0.02']);
});

test('AVG PROFIT is the exact mean rounded to cents once (RiskMetrics.quotientCents), never through a micro first', () => {
  // (0.010000 − 0.000001) ÷ 2 = 0.0049995: under half a cent, so $0.00,
  // neutral; taken to the micro first it is 0.005000 and reads +$0.01.
  const AVG = 6;
  Performance.renderTables([closedTrade(1, 0.01), closedTrade(2, -0.000001)], []);
  assert.equal(assetRow()[AVG].textContent, '$0.00');
  assert.ok(assetRow()[AVG].classList.contains('zero'), assetRow()[AVG].className);
  Performance.renderTables([closedTrade(1, -0.01), closedTrade(2, 0.000001)], []);
  assert.equal(assetRow()[AVG].textContent, '$0.00');
});

test('AVG PROFIT, BEST and WORST read — with the classifier\'s reason while a position is incomplete; an empty bucket stays a bare —', () => {
  const AVG = 6, BEST = 7, WORST = 8;
  const trades = [closedTrade(1, 10), closedTrade(2, -5), closedTrade(3, 4),
    closedTrade(4, 1, { complete: false, incompleteCause: 'Unusable fill' })];
  const reason = RM.classifyClosed(trades).incompleteReason;
  assert.notEqual(reason, '');
  Performance.renderTables(trades, [], null, { classifier: reason });
  [AVG, BEST, WORST].forEach(i => {
    assert.equal(assetRow()[i].textContent, '—', `column ${i}`);
    assert.equal(assetRow()[i].title, reason, `column ${i}`);
  });
  Performance.renderTables([closedTrade(1, 10)], []);
  assert.equal(assetRow()[WORST].textContent, '—');
  assert.equal(assetRow()[WORST].title, '');
});

test('an asset whose trades closed within an hour reads SHARPE — with the reason, not an extrapolated value', () => {
  const MINUTES_APART = 10;
  const trades = [100, -50, 100, -50, 100]
    .map((profit, i) => closedTrade(1 + (i * MINUTES_APART) / 60, profit));
  Performance.renderTables(trades, EQUITY_AT_OPEN);
  const cell = assetRow()[ASSET_SHARPE];
  assert.equal(cell.textContent, '—');
  assert.match(cell.title, /month/);
});

test('the per-trade fallback ratios read unavailable with the reason when every trade closed at one instant', () => {
  const trades = [100, -50, 100].map(profit => closedTrade(1, profit));
  const tm = Performance.computeTradeBasedMetrics(RM.classifyClosed(trades), EQUITY_AT_OPEN);
  assert.equal(tm.ok, false);
  assert.match(tm.reason, /month/);
});

test('a decisive trade without a valid close time leaves the per-trade ratios unavailable, naming it', () => {
  const trades = [1000, -500, 800, -300].map((profit, i) => closedTrade((i + 1) * HOURS_PER_MONTH, profit));
  trades[2].closedAt = 'not-a-date';
  const tm = Performance.computeTradeBasedMetrics(RM.classifyClosed(trades), EQUITY_AT_OPEN);
  assert.equal(tm.ok, false);
  assert.equal(tm.reason, '1 of 4 trades without a valid close time');
});

// ---------------------------------------------------------------------------
// Monthly SHARPE and MAX DD measure from the prior month-end, like PROFIT.
// ---------------------------------------------------------------------------

// Hourly rows on $100000 of equity from `fromIso`: totalPnl `start`, then
// rising by `step`, ±`noise` on alternate rows.
function grindingHistory(fromIso, count, start, step, noise) {
  const startMs = Date.parse(fromIso);
  return Array.from({ length: count }, (_, i) => ({
    createdAt: new Date(startMs + i * MS_PER_HOUR).toISOString(),
    equity: '100000',
    totalPnl: String(start + i * step + (i % 2 ? noise : -noise)),
    netTransfers: '0',
  }));
}

test('a month that opens far below the prior month-end and grinds up shows a negative SHARPE beside its loss', () => {
  const HOURS_IN_AUGUST = 31 * 24;
  const HOURS_IN_SEPTEMBER = 30 * 24;
  const history = [
    ...grindingHistory('2025-08-01T00:00:00.000Z', HOURS_IN_AUGUST, 20000, 0, 5),
    ...grindingHistory('2025-09-01T00:00:00.000Z', HOURS_IN_SEPTEMBER, 0, 10, 5),
  ];
  Performance.renderTables([], history);
  const september = monthlyRow('September 2025').children;
  assert.match(september[MONTH.PROFIT].textContent, /^-\$/);
  assert.match(september[MONTH.SHARPE].textContent, /^-\d+\.\d{2}$/, september[MONTH.SHARPE].title);
});

test('a month\'s MAX DD runs from the prior month-end, so a gap down at the boundary counts', () => {
  const history = [
    { createdAt: '2025-08-01T00:00:00.000Z', equity: '100000', totalPnl: '10000', netTransfers: '0' },
    { createdAt: '2025-08-31T23:00:00.000Z', equity: '100000', totalPnl: '10000', netTransfers: '0' },
    { createdAt: '2025-09-01T00:00:00.000Z', equity: '100000', totalPnl: '2000', netTransfers: '0' },
    { createdAt: '2025-09-20T00:00:00.000Z', equity: '100000', totalPnl: '5595', netTransfers: '0' },
  ];
  Performance.renderTables([], history);
  const september = monthlyRow('September 2025').children;
  assert.equal(september[MONTH.PROFIT].textContent, '-$4,405');
  assert.equal(september[MONTH.MAX_DD].textContent, '-$8,000');
});

test('a month with data that never drew down reads $0, neutral; one whose drawdown displays as $0 too', () => {
  const history = [
    { createdAt: '2025-08-01T00:00:00.000Z', equity: '100000', totalPnl: '0', netTransfers: '0' },
    { createdAt: '2025-08-15T00:00:00.000Z', equity: '100000', totalPnl: '100', netTransfers: '0' },
    { createdAt: '2025-08-31T00:00:00.000Z', equity: '100000', totalPnl: '100', netTransfers: '0' },
    { createdAt: '2025-09-10T00:00:00.000Z', equity: '100000', totalPnl: '99.7', netTransfers: '0' },
    { createdAt: '2025-09-20T00:00:00.000Z', equity: '100000', totalPnl: '150', netTransfers: '0' },
  ];
  Performance.renderTables([], history);
  for (const label of ['August 2025', 'September 2025']) {
    const cell = monthlyRow(label).children[MONTH.MAX_DD];
    assert.equal(cell.textContent, '$0', label);
    assert.ok(cell.classList.contains('zero'), `${label}: ${cell.className}`);
  }
});

test('a month with one row and the prior month-end, or one row and the live point, has a MAX DD', () => {
  const history = [
    { createdAt: '2025-09-30T23:00:00.000Z', equity: '100000', totalPnl: '1000', netTransfers: '0' },
    { createdAt: '2025-10-01T00:30:00.000Z', equity: '100000', totalPnl: '600', netTransfers: '0' },
  ];
  Performance.renderTables([], history, null, {}, { t: '2025-10-01T00:59:00.000Z', c: 560 });
  assert.equal(monthlyRow('October 2025').children[MONTH.MAX_DD].textContent, '-$440');
});

test('a MAX DD cell that stays — says why', () => {
  const trade = closedTrade(0, 100, { closedAt: '2025-07-10T00:00:00.000Z', createdAt: '2025-07-09T00:00:00.000Z' });
  Performance.renderTables([trade], [{ createdAt: '2025-08-10T00:00:00.000Z', equity: '1000', totalPnl: '0', netTransfers: '0' }]);
  const july = monthlyRow('July 2025').children[MONTH.MAX_DD];
  assert.equal(july.textContent, '—');
  assert.equal(july.title, RM.NO_MONTH_ROWS_REASON);
});

test('an asset whose first trade opened minutes after a deposit onto an empty account still shows its SHARPE', () => {
  // The 10:00 row holds $0; $100000 lands at 10:05 and shows on the 11:00
  // row's netTransfers; the first trade opens at 10:20.
  const funding = [
    { createdAt: '2025-07-01T10:00:00.000Z', equity: '0', totalPnl: '0', netTransfers: '0' },
    { createdAt: '2025-07-01T11:00:00.000Z', equity: '100000', totalPnl: '0', netTransfers: '100000' },
  ];
  const trades = [1000, -500, 800, -300, 600].map((profit, i) => closedTrade((i + 1) * HOURS_PER_MONTH, profit,
    i === 0 ? { createdAt: '2025-07-01T10:20:00.000Z' } : {}));
  Performance.renderTables(trades, funding);
  const cell = assetRow()[ASSET_SHARPE];
  assert.match(cell.textContent, /^-?\d+\.\d{2}$/, cell.title);
});

test('the per-trade Calmar caption names the drawdown it divides by', () => {
  // +1%, then −5% on $1M at open: the compounded curve's drawdown is 5%.
  const trades = [10000, -50000, 8000].map((profit, i) => closedTrade((i + 1) * HOURS_PER_MONTH, profit));
  const tm = Performance.computeTradeBasedMetrics(RM.classifyClosed(trades), EQUITY_AT_OPEN);
  Performance.renderTradeBasedRatios(tm, 'test');
  assert.equal(el('calmarDetail').textContent, 'CAGR ÷ max DD of compounded trade returns (5.0%)');
});

test('per-trade returns that are all alike read Sharpe and Sortino — with "Returns have no spread" as caption and tooltip', () => {
  // Three +1% trades on $1M at open: no standard or downside deviation.
  const trades = [10000, 10000, 10000].map((profit, i) => closedTrade((i + 1) * HOURS_PER_MONTH, profit));
  const tm = Performance.computeTradeBasedMetrics(RM.classifyClosed(trades), EQUITY_AT_OPEN);
  assert.equal(tm.ok, true, tm.reason);
  Performance.renderTradeBasedRatios(tm, 'test');
  for (const [value, meta] of [['sharpeRatio', 'sharpeMeta'], ['sortinoRatio', 'sortinoMeta']]) {
    assert.equal(el(value).textContent, '—', value);
    assert.equal(el(meta).textContent, `${Performance.NO_SPREAD_REASON} ⓘ`, meta);
    assert.equal(el(meta).title, Performance.NO_SPREAD_REASON, meta);
  }

  // Returns with a spread keep the per-trade caption.
  const spread = [10000, -50000, 8000].map((profit, i) => closedTrade((i + 1) * HOURS_PER_MONTH, profit));
  Performance.renderTradeBasedRatios(Performance.computeTradeBasedMetrics(RM.classifyClosed(spread), EQUITY_AT_OPEN), 'test');
  assert.match(el('sharpeMeta').textContent, /^Per-trade · n=3 · compounded /);
  assert.match(el('sharpeMeta').title, /Denominator: standard deviation of trade returns/);
});

test('the per-trade fallback describes trade returns in the Sharpe and Sortino card tooltips; the time-series path restores the markup', () => {
  const trades = [10000, -50000, 8000].map((profit, i) => closedTrade((i + 1) * HOURS_PER_MONTH, profit));
  const tm = Performance.computeTradeBasedMetrics(RM.classifyClosed(trades), EQUITY_AT_OPEN);
  Performance.renderTradeBasedRatios(tm, 'test');
  for (const id of Object.keys(RATIO_CARD_MARKUP)) {
    assert.match(el(id).title, /per-trade returns \(profit ÷ account equity at the position's open\)/, id);
    assert.doesNotMatch(el(id).title, /time-weighted hourly/, id);
  }
  Performance.renderRatioCardTitles('hist');
  Object.entries(RATIO_CARD_MARKUP).forEach(([id, text]) => assert.equal(el(id).title, text, id));
});

test('a Calmar with no value reads the reason it is given, in its caption and on hover', () => {
  const CUT = 'Historical profit before 2025-01-01 00:00 UTC not in cached snapshot';
  Performance.renderCalmar(null, '', CUT);
  assert.equal(el('calmarRatio').textContent, '—');
  assert.equal(el('calmarDetail').textContent, CUT);
  assert.equal(el('calmarDetail').title, CUT);
  Performance.renderCalmar({ calmar: 1.5, maxDrawdownPct: 5 }, 'compounded TWR');
  assert.equal(el('calmarDetail').textContent, 'CAGR ÷ max DD of compounded TWR (5.0%)');
  assert.equal(el('calmarDetail').title, '');
});

test('a compounded drawdown that displays as 0.0% is no drawdown: Calmar reads — with "No drawdown recorded"', () => {
  Performance.renderCalmar(RM.compoundReturns([0.01, 0.02, -1e-9, 0.03], 1), 'compounded TWR');
  assert.equal(el('calmarRatio').textContent, '—');
  assert.equal(el('calmarDetail').textContent, 'No drawdown recorded');
  assert.equal(el('calmarDetail').title, 'No drawdown recorded');
});

// ---------------------------------------------------------------------------
// /historical-pnl that failed to load, or that the cache cut short.
// ---------------------------------------------------------------------------

test('a /historical-pnl that failed to load gives the monthly and asset cells the failure, not "no rows"', () => {
  const FAILED = 'Historical profit failed to load';
  const trades = [1000, -500, 800, -300, 600].map((profit, i) => closedTrade((i + 1) * HOURS_PER_MONTH, profit));
  Performance.renderTables(trades, [], null, { historicalPnl: FAILED });
  for (const tr of monthlyRows()) {
    for (const column of ['PROFIT', 'MAX_DD', 'SHARPE']) {
      const cell = tr.children[MONTH[column]];
      assert.equal(cell.textContent, '—', column);
      assert.equal(cell.title, FAILED, `${tr.children[MONTH.LABEL].textContent} ${column}`);
    }
  }
  assert.ok(monthlyRows().length > 0);
  const sharpe = assetRow()[ASSET_SHARPE];
  assert.equal(sharpe.textContent, '—');
  assert.equal(sharpe.title, FAILED);
});

test('the months a cached /historical-pnl cuts read — with the cut reason; the later months keep their values', () => {
  const CUT = 'Historical profit before 2025-09-10 not in cached snapshot';
  const HOURS_TO_OCTOBER_END = (21 + 31) * 24;
  // Trades closed in July, before the kept rows, and in October.
  const trades = [-500, 800, -300].map((profit, i) => closedTrade((i + 1) * 24, profit))
    .concat([1000, -200, 600].map((profit, i) => closedTrade((100 + i) * 24, profit)));
  Performance.renderTables(trades, hourlyHistory('2025-09-10T00:00:00.000Z', HOURS_TO_OCTOBER_END), null, { historyCut: CUT });
  for (const label of ['July 2025', 'September 2025']) {
    const cut = monthlyRow(label).children;
    for (const column of ['PROFIT', 'MAX_DD', 'SHARPE']) {
      assert.equal(cut[MONTH[column]].textContent, '—', `${label} ${column}`);
      assert.equal(cut[MONTH[column]].title, CUT, `${label} ${column}`);
    }
  }
  const october = monthlyRow('October 2025').children;
  assert.notEqual(october[MONTH.PROFIT].textContent, '—');
  assert.notEqual(october[MONTH.MAX_DD].textContent, '—');
  assert.match(october[MONTH.SHARPE].textContent, /^-?\d+\.\d{2}$/);
  // Trades opened before the kept rows have no equity at open in the snapshot.
  const sharpe = assetRow()[ASSET_SHARPE];
  assert.equal(sharpe.textContent, '—');
  assert.equal(sharpe.title, CUT);
});

test('the first kept row is the first in time, whatever offset its timestamp is written in', () => {
  const CUT = 'Historical profit before 2025-09-10 not in cached snapshot';
  const HOURS_TO_OCTOBER_END = (21 + 31) * 24;
  const FIRST_ROW_AT_PLUS_TWO = '2025-09-10T02:00:00.000+02:00';
  const history = hourlyHistory('2025-09-10T00:00:00.000Z', HOURS_TO_OCTOBER_END);
  // The first row at its own instant, written at UTC+2: as text it sorts
  // after the 01:00Z row, so a text sort would start the rows an hour late.
  history[0] = { ...history[0], createdAt: FIRST_ROW_AT_PLUS_TWO };
  const openedAfterFirstRow = {
    createdAt: '2025-09-10T00:30:00.000Z', closedAt: '2025-09-10T01:30:00.000Z',
  };
  const trades = [closedTrade(0, 700, openedAfterFirstRow)]
    .concat([1000, -200, 600, -400, 900].map((profit, i) => closedTrade((100 + i) * 24, profit)));
  Performance.renderTables(trades, history, null, { historyCut: CUT });
  const sharpe = assetRow()[ASSET_SHARPE];
  assert.notEqual(sharpe.title.split('\n')[0], CUT);
  assert.match(sharpe.textContent, /^-?\d+\.\d{2}$/);
});

// ---------------------------------------------------------------------------
// Every per-row SHARPE carries the row's compounded return: an arithmetic
// mean above 0 does not mean the row made money.
// ---------------------------------------------------------------------------

const SHARPE_CAVEAT = /above 0 does not mean the row made money/;

test('an asset\'s SHARPE cell carries its compounded return on equity and the caveat, even when the asset lost money', () => {
  // +$500 on $1000 of equity at open (+50%), then four −$1000 trades on
  // $100000 (−1% each): the mean return is positive, the dollars −$3500,
  // compounded 1.5 × 0.99⁴ − 1 = +44.1%.
  const equity = [
    { createdAt: '2025-06-01T00:00:00.000Z', equity: '1000', totalPnl: '0', netTransfers: '0' },
    { createdAt: '2025-08-15T00:00:00.000Z', equity: '100000', totalPnl: '500', netTransfers: '0' },
  ];
  const trades = [500, -1000, -1000, -1000, -1000].map((profit, i) => closedTrade((i + 1) * HOURS_PER_MONTH, profit));
  Performance.renderTables(trades, equity);
  const cell = assetRow()[ASSET_SHARPE];
  assert.match(cell.textContent, /^\d+\.\d{2}$/, cell.title);
  assert.match(cell.title, /\+44\.1%/);
  assert.match(cell.title, SHARPE_CAVEAT);
});

test('a month\'s SHARPE cell carries the month\'s compounded return and the caveat', () => {
  // ±1% alternating hourly on constant equity: the mean is positive, while
  // 1.01³⁶⁰ × 0.99³⁵⁹ − 1 compounds to −2.6%.
  const HOURS_IN_SEPTEMBER = 30 * 24;
  const history = Array.from({ length: HOURS_IN_SEPTEMBER }, (_, i) => ({
    createdAt: new Date(Date.parse('2025-09-01T00:00:00.000Z') + i * MS_PER_HOUR).toISOString(),
    equity: '100000',
    totalPnl: i % 2 ? '1000' : '0',
    netTransfers: '0',
  }));
  Performance.renderTables([], history);
  const cell = monthlyRow('September 2025').children[MONTH.SHARPE];
  assert.match(cell.textContent, /^\d+\.\d{2}$/, cell.title);
  assert.match(cell.title, /-2\.6%/);
  assert.match(cell.title, SHARPE_CAVEAT);
});
