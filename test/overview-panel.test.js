'use strict';

// The Overview tab's Strategy Edge panel (src/panels/overview.js) rendered
// through renderStrategyEdge with the real constants and Format modules.
// Only the browser DOM is a stand-in (test/fake-dom.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const { el } = require('./fake-dom');

require('../src/constants.js');
require('../src/format.js');
require('../src/dom.js');
require('../risk-metrics.js');
require('../src/panels/overview.js');

const Overview = window.AppPanels.overview;
const RM = window.RiskMetrics;
const { MS_PER_HOUR } = window.AppConstants;

test('a profit factor below one between the win-rate archetypes reads as a negative edge, never a marginal one', () => {
  for (const [winRate, profitFactor] of [[58, 0.9], [50, 0.3]]) {
    Overview.renderStrategyEdge(winRate, profitFactor, 0.6, '');
    assert.equal(el('seVerdictName').textContent, 'Transitional');
    const desc = el('seVerdictDesc').textContent;
    assert.match(desc, /^Negative edge/, `WR ${winRate}, PF ${profitFactor}: ${desc}`);
    assert.doesNotMatch(desc, /marginal/i);
  }
});

test('a profitable system between the archetypes keeps its verdict', () => {
  Overview.renderStrategyEdge(50, 1.2, 1.2, '');
  assert.match(el('seVerdictDesc').textContent, /^Profitable/);
});

test('an empty win or loss bucket reads N/A on the panel; missing inputs read — ', () => {
  // Wins only: win rate 100%, no profit factor or payoff.
  Overview.renderStrategyEdge(100, null, null, '');
  assert.equal(el('seWinRateOut').textContent, '100.0%');
  assert.equal(el('seProfitFactorOut').textContent, 'N/A');
  assert.equal(el('seImpliedRR').textContent, 'N/A');

  Overview.renderStrategyEdge(null, null, null, '3 positions missing fill data');
  assert.equal(el('seWinRateOut').textContent, '—');
  assert.equal(el('seProfitFactorOut').textContent, '—');
  assert.equal(el('seImpliedRR').textContent, '—');
});

test('the Strategy Edge verdict classifies the win rate and profit factor it displays', () => {
  // 59.96% reads 60.0% and 1.596 reads 1.60: the verdict is Excellent.
  Overview.renderStrategyEdge(59.96, 1.596, 1.1, '');
  assert.equal(el('seWinRateOut').textContent, '60.0%');
  assert.equal(el('seProfitFactorOut').textContent, '1.60');
  assert.equal(el('seVerdictName').textContent, 'Excellent');

  // 0.996 reads 1.00, so the description never says "below one" beside it.
  Overview.renderStrategyEdge(50, 0.996, 1, '');
  assert.equal(el('seProfitFactorOut').textContent, '1.00');
  assert.doesNotMatch(el('seVerdictDesc').textContent, /below one/);
});

test('the Strategy Edge profit factor reads as Format.fmtRatio does (the monthly column), decimal ties included', () => {
  // $1,990 / $2,000 is 0.995 and $2,230 / $2,000 is 1.115: each a decimal
  // tie that toFixed would round down by its binary noise.
  Overview.renderStrategyEdge(50, 1990 / 2000, 1, '');
  assert.equal(el('seProfitFactorOut').textContent, window.Format.fmtRatio(1990 / 2000));
  assert.equal(el('seProfitFactorOut').textContent, '1.00');
  assert.doesNotMatch(el('seVerdictDesc').textContent, /below one/);
  Overview.renderStrategyEdge(50, 2230 / 2000, 1, '');
  assert.equal(el('seProfitFactorOut').textContent, '1.12');
});

test('a profit factor that reads 1.00 is break-even, never profitable', () => {
  for (const [winRate, profitFactor] of [[50, 0.996], [60, 0.996], [45, 1.0]]) {
    Overview.renderStrategyEdge(winRate, profitFactor, 1, '');
    assert.equal(el('seProfitFactorOut').textContent, '1.00');
    assert.equal(el('seVerdictName').textContent, 'Transitional');
    const desc = el('seVerdictDesc').textContent;
    assert.match(desc, /^Break-even/, `WR ${winRate}, PF ${profitFactor}: ${desc}`);
    assert.doesNotMatch(desc, /Profitable|below one/, `WR ${winRate}, PF ${profitFactor}: ${desc}`);
  }
});

test('the Strategy Edge win rate reads as the Win Rate card does (Format.formatPercent)', () => {
  // 3 wins of 2000 decisive trades: 0.15%, the card's 0.2% (toFixed(1) reads 0.1%).
  const winRate = (3 / 2000) * window.AppConstants.PERCENT;
  Overview.renderStrategyEdge(winRate, 0.5, 0.5, '');
  assert.equal(el('seWinRateOut').textContent, window.Format.formatPercent(winRate));
  assert.equal(el('seWinRateOut').textContent, '0.2%');
});

// ---------------------------------------------------------------------------
// Max Drawdown and Current Drawdown cards.
// ---------------------------------------------------------------------------

const atHour = (h) => new Date(Date.UTC(2025, 0, 1) + h * MS_PER_HOUR).toISOString();
const row = (h, totalPnl) => ({ createdAt: atHour(h), totalPnl: String(totalPnl), equity: '0', netTransfers: '0' });
const HIST = { source: 'hist', hasLive: true, gap: '', closedCount: 0, seriesStart: atHour(0) };
// The cards' markup tooltips, in place before any render as in the page.
const MARKUP = {
  maxDrawdownCard: 'Worst peak-to-trough of the cumulative totalPnl curve',
  currentDrawdownCard: 'Current Drawdown on totalPnl',
  recoveryFactorLabel: 'Recovery Factor on the Total Profit headline',
};
Object.entries(MARKUP).forEach(([id, text]) => { el(id).title = text; });

function renderCards(rows, live, opts = {}) {
  Overview.renderDrawdownCards(RM.histPnlDrawdown(rows, live), RM.histPnlCurrentDrawdown(rows, live), { ...HIST, ...opts });
}

test('Current Drawdown counts its time below peak in Format.formatDuration units, like the ongoing Drawdown Periods row', () => {
  // Peak at hour 1, now 2.6 days later: 2d 14h, never rounded up to 3d.
  const live = { t: atHour(1 + 2.6 * 24), c: 40 };
  renderCards([row(0, 0), row(1, 100), row(2, 60)], live);
  assert.equal(el('currentDrawdown').textContent, '-$60');
  assert.match(el('currentDrawdownDetail').textContent, /^2d 14h below peak \(since 2025-01-01\)/);
});

test('a drawdown that displays as $0 is none: Max Drawdown $0 neutral, Current Drawdown $0 green at peak', () => {
  const live = { t: atHour(3), c: 99.7 };
  renderCards([row(0, 0), row(1, 100), row(2, 100)], live);
  assert.equal(el('maxDrawdown').textContent, '$0');
  assert.ok(el('maxDrawdown').classList.contains('zero'), el('maxDrawdown').className);
  assert.match(el('maxDrawdownDetail').textContent, /^No drawdown recorded/);
  assert.equal(el('currentDrawdown').textContent, '$0');
  assert.ok(el('currentDrawdown').classList.contains('profit'), el('currentDrawdown').className);
  assert.match(el('currentDrawdownDetail').textContent, /^At peak/);
});

test('Max Drawdown is its caption\'s peak less its trough as they display', () => {
  renderCards([row(0, 0), row(1, 12345.4), row(2, 2345.6)], { t: atHour(3), c: 20000 });
  assert.equal(el('maxDrawdown').textContent, '-$9,999');
  assert.match(el('maxDrawdownDetail').textContent, /^Peak \+\$12,345 \(2025-01-01\) → trough \+\$2,346 \(2025-01-01\)/);
});

test('a drawdown whose peak and trough display alike is none, though the raw drop rounds to $1', () => {
  renderCards([row(0, 0), row(1, 100.4), row(2, 99.6)], { t: atHour(3), c: 200 });
  assert.equal(el('maxDrawdown').textContent, '$0');
  assert.match(el('maxDrawdownDetail').textContent, /^No drawdown recorded/);
});

test('a drawdown series with a gap reads — with the reason on both cards, on either path', () => {
  const CUT = 'Historical profit before 2025-01-01 not in cached snapshot';
  renderCards([row(0, 0), row(1, 100), row(2, 60)], null, { gap: CUT });
  for (const id of ['maxDrawdown', 'currentDrawdown']) {
    assert.equal(el(id).textContent, '—', id);
    assert.equal(el(`${id}Detail`).textContent, CUT, id);
  }
});

test('without a live point the Current Drawdown caption names the last hourly row and why', () => {
  renderCards([row(0, 0), row(1, 100), row(2, 60)], null, { hasLive: false });
  assert.match(el('currentDrawdownDetail').textContent,
    / · as of 2025-01-01 02:00 UTC, last hourly row \(Total Profit unavailable\)$/);
});

test('without a live point the Recovery Factor tooltip names the last hourly row as its numerator and why; with it the markup text returns', () => {
  renderCards([row(0, 0), row(1, 100), row(2, 60)], null, { hasLive: false });
  assert.match(el('recoveryFactorLabel').title, /last hourly totalPnl row/);
  assert.match(el('recoveryFactorLabel').title, /Total Profit (headline )?(is )?unavailable/);
  assert.doesNotMatch(el('recoveryFactorLabel').title, /live point/);

  renderCards([row(0, 0), row(1, 100), row(2, 60)], { t: atHour(3), c: 60 });
  assert.equal(el('recoveryFactorLabel').title, MARKUP.recoveryFactorLabel);
});

test('on the closed-trade fallback a series that never drew down reads Max Drawdown $0, neutral, not —', () => {
  const closed = (h, profit) => ({ status: 'CLOSED', closedAt: atHour(h), profit, complete: true });
  const positions = [closed(24, 10), closed(48, 20)];
  Overview.renderDrawdownCards(RM.tradeSystemDrawdown(positions), RM.tradeSystemCurrentDrawdown(positions),
    { source: 'trade', hasLive: false, gap: '', closedCount: positions.length, seriesStart: null });
  assert.equal(el('maxDrawdown').textContent, '$0');
  assert.ok(el('maxDrawdown').classList.contains('zero'), el('maxDrawdown').className);
  assert.equal(el('maxDrawdownDetail').textContent, 'No drawdown recorded');

  Overview.renderDrawdownCards(RM.tradeSystemDrawdown([]), RM.tradeSystemCurrentDrawdown([]),
    { source: 'trade', hasLive: false, gap: '', closedCount: 0, seriesStart: null });
  assert.equal(el('maxDrawdown').textContent, '—');
  assert.equal(el('maxDrawdownDetail').textContent, 'No closed trades');
});

test('Current Drawdown gives no percent of a peak that displays as $0', () => {
  // Peak +$0.30 (shown as $0 on Max Drawdown), now -$1,000.
  const live = { t: atHour(3), c: -1000 };
  renderCards([row(0, 0), row(1, 0.3), row(2, -1000)], live);
  assert.equal(el('currentDrawdown').textContent, '-$1,000');
  assert.doesNotMatch(el('currentDrawdownDetail').textContent, /of peak/);

  // A peak that displays as +$1 keeps it.
  renderCards([row(0, 0), row(1, 0.5), row(2, -1000)], { t: atHour(3), c: -1000 });
  assert.match(el('currentDrawdownDetail').textContent, / · \d[\d,.]*% of peak$/);
});

test('Current Drawdown\'s percent of peak is the depth it shows over the peak as it displays', () => {
  // [rows, live, Current Drawdown, percent]: raw 1.8 / 1.4 would read
  // 128.6%, raw 5.8 / 10.4 55.8%.
  const cases = [
    [[row(0, 0), row(1, 1.4)], -0.4, '-$1', '100.0%'],
    [[row(0, 0), row(1, 10.4)], 4.6, '-$5', '50.0%'],
  ];
  for (const [rows, liveValue, shown, pct] of cases) {
    renderCards(rows, { t: atHour(rows.length), c: liveValue });
    assert.equal(el('currentDrawdown').textContent, shown);
    assert.match(el('currentDrawdownDetail').textContent, new RegExp(` · ${pct.replace('.', '\\.')} of peak$`));
  }
});

test('on the closed-trade fallback the drawdown and Recovery Factor tooltips describe closed-trade profit; on /historical-pnl the markup text returns', () => {
  const closed = (h, profit) => ({ status: 'CLOSED', closedAt: atHour(h), profit, complete: true });
  const positions = [closed(24, 100), closed(48, -60)];
  Overview.renderDrawdownCards(RM.tradeSystemDrawdown(positions), RM.tradeSystemCurrentDrawdown(positions),
    { source: 'trade', hasLive: false, gap: '', closedCount: positions.length, seriesStart: null });
  for (const id of Object.keys(MARKUP)) {
    assert.match(el(id).title, /closed-trade profit/, id);
    assert.doesNotMatch(el(id).title, /live point/, id);
  }
  assert.match(el('currentDrawdownDetail').textContent, /^Closed-trade profit · /);

  renderCards([row(0, 0), row(1, 100), row(2, 60)], { t: atHour(3), c: 60 });
  Object.entries(MARKUP).forEach(([id, text]) => assert.equal(el(id).title, text, id));
  assert.doesNotMatch(el('currentDrawdownDetail').textContent, /Closed-trade/);
});

// One drawdown, one figure: the displayed peak less the displayed trough
// (Format.drawdownAsDisplayed), on Max Drawdown and on Current Drawdown
// (peak less the displayed current value), whose test for a drawdown reads
// that same value. Rows and live points are synthetic.
test('Current Drawdown is the displayed peak less the displayed current value, never beyond Max Drawdown', () => {
  const cases = [
    // [rows, live, Max Drawdown, Current Drawdown]
    // Raw 200.8 would read -$201 beside a -$200 Max Drawdown.
    [[row(0, 0), row(1, 100.4), row(2, 50)], -100.4, '-$200', '-$200'],
    // Peak and now both display as +$100: no drawdown on either card.
    [[row(0, 0), row(1, 100.4)], 99.6, '$0', '$0'],
    // Peak +$1, now $0: the raw 0.2 would read at peak beside a -$1 Max Drawdown.
    [[row(0, 0), row(1, 0.6)], 0.4, '-$1', '-$1'],
    // Peak +$100, now the trough +$51: raw 49.8 would read -$50.
    [[row(0, 50), row(1, 100.4), row(2, 80)], 50.6, '-$49', '-$49'],
    // Peak +$101, now the trough $0: raw 100.1 would read -$100.
    [[row(0, 0), row(1, 100.5), row(2, 50)], 0.4, '-$101', '-$101'],
  ];
  for (const [rows, liveValue, maxShown, currentShown] of cases) {
    renderCards(rows, { t: atHour(rows.length), c: liveValue });
    const label = `live ${liveValue}`;
    assert.equal(el('maxDrawdown').textContent, maxShown, label);
    assert.equal(el('currentDrawdown').textContent, currentShown, label);
    const atPeak = currentShown === '$0';
    assert.ok(el('currentDrawdown').classList.contains(atPeak ? 'profit' : 'loss'), `${label}: ${el('currentDrawdown').className}`);
    assert.match(el('currentDrawdownDetail').textContent, atPeak ? /^At peak/ : /below peak/, label);
  }
});

test('Max Drawdown is the deepest event as displayed, the raw depth breaking ties, on either path', () => {
  // Raw depths 10.4 (+$1 → -$10, shown $11) and 10.6 (+$20 → +$10, shown $10).
  const rows = [0.6, -9.8, 0.6, 20.4, 9.8].map((v, h) => row(h, v));
  renderCards(rows, { t: atHour(rows.length), c: 20.4 });
  assert.equal(el('maxDrawdown').textContent, '-$11');
  assert.match(el('maxDrawdownDetail').textContent, /^Peak \+\$1 \(2025-01-01\) → trough -\$10 /);

  // The same cumulative profits on the closed-trade fallback.
  const closed = (h, profit) => ({ status: 'CLOSED', closedAt: atHour(h), profit, complete: true });
  const positions = [closed(1, 0.6), closed(2, -10.4), closed(3, 10.4), closed(4, 19.8), closed(5, -10.6), closed(6, 10.6)];
  Overview.renderDrawdownCards(RM.tradeSystemDrawdown(positions), RM.tradeSystemCurrentDrawdown(positions),
    { source: 'trade', hasLive: false, gap: '', closedCount: positions.length, seriesStart: null });
  assert.equal(el('maxDrawdown').textContent, '-$11');
});

test('the closed-trade fallback sums its profits exactly, so a cumulative half dollar rounds as the decimal it is', () => {
  // +64.302905 then -63.802905: the exact cumulative 0.5 displays as +$1
  // (the float sum 0.4999999999999929 would read $0, the drawdown -$64).
  const closed = (h, profit) => ({ status: 'CLOSED', closedAt: atHour(h), profit, complete: true });
  const positions = [closed(1, 64.302905), closed(2, -63.802905)];
  const cdd = RM.tradeSystemCurrentDrawdown(positions);
  assert.equal(cdd.currentValue, 0.5);
  Overview.renderDrawdownCards(RM.tradeSystemDrawdown(positions), cdd,
    { source: 'trade', hasLive: false, gap: '', closedCount: positions.length, seriesStart: null });
  assert.equal(el('maxDrawdown').textContent, '-$63');
  assert.equal(el('currentDrawdown').textContent, '-$63');
});
