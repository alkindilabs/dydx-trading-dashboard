'use strict';

// The Time Analysis card and the Detected Patterns table
// (src/panels/behavior.js) rendered through renderTimeAnalysis and
// renderDetectedPatterns with the real constants, Format, AppDom and
// RiskMetrics modules. Only the browser DOM is a stand-in
// (test/fake-dom.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { el } = require('./fake-dom');

require('../src/constants.js');
require('../src/format.js');
require('../src/dom.js');
require('../risk-metrics.js');
require('../src/panels/behavior.js');

const Behavior = window.AppPanels.behavior;
const RM = window.RiskMetrics;
const { MS_PER_HOUR, HOURS_PER_DAY, TUNABLES } = window.AppConstants;

// A complete closed position entered at `createdAt` and held one hour.
function closedEntry(createdAt, profit) {
  const openMs = Date.parse(createdAt);
  return {
    market: 'BTC-USD', side: 'LONG', status: 'CLOSED', createdAt,
    closedAt: new Date(openMs + MS_PER_HOUR).toISOString(),
    profit, complete: true, peakSize: 1, entryVwap: 100,
  };
}

function renderTimeAnalysis(positions, unavailableReason = '') {
  Behavior.renderTimeAnalysis(positions, RM.classifyClosed(positions, unavailableReason));
}

function renderPatterns(positions, unavailableReason = '') {
  Behavior.renderDetectedPatterns(positions, RM.classifyClosed(positions, unavailableReason));
}

// As processData does when the closed-trade list is unknown or short
// (closedTradesGap): the classifier and the panel both get the reason.
function renderWithClosedTradesGap(positions, closedTradesGap) {
  const cls = RM.classifyClosed(positions, closedTradesGap);
  Behavior.renderTimeAnalysis(positions, cls, closedTradesGap);
  Behavior.renderDetectedPatterns(positions, cls, closedTradesGap);
}

const OPEN_FIELDS = { status: 'OPEN', closedAt: undefined };

// As processData does for the entry-based views: every entry is known only
// while both lists are and every position has a valid createdAt
// (RiskMetrics.entryTimeGap); `listGap` stands for the list-level gaps.
function entriesGapOf(positions, listGap = '') {
  return listGap || RM.entryTimeGap(positions);
}

function renderPatternsWithEntriesGap(positions, listGap = '') {
  Behavior.renderDetectedPatterns(positions, RM.classifyClosed(positions), '', entriesGapOf(positions, listGap));
}

// The pattern row whose label starts with `name`, as its cells' text, or
// undefined when the table has no such row.
const COL = { PATTERN: 0, FREQUENCY: 1, SUCCESS_RATE: 2, EXPECTANCY: 3 };
function patternRow(name) {
  return el('patternsBody').children.find(tr => tr.children[COL.PATTERN].textContent.startsWith(name));
}
const DOUBLE_DOWN = 'Post-Loss Double Down';

// A BTC loser held 10:00 → 11:00 at $100 peak notional, and re-entries in
// the hour after it closed: `bigger` clears DOUBLE_DOWN_SIZE_MULT.
const loser = { ...closedEntry('2025-07-02T10:00:00.000Z', -50) };
const AFTER_LOSER = '2025-07-02T11:30:00.000Z';
const BIGGER_PEAK_SIZE = 2 * TUNABLES.DOUBLE_DOWN_SIZE_MULT;
function reentry(side, profit, overrides = {}) {
  return { ...closedEntry(AFTER_LOSER, profit), side, peakSize: BIGGER_PEAK_SIZE, ...overrides };
}

test('Most Active Day names every day tied for the most entries, in UTC', () => {
  // 2025-07-02 is a Wednesday, 2025-07-03 a Thursday, 2025-07-04 a Friday.
  renderTimeAnalysis([
    closedEntry('2025-07-02T10:00:00.000Z', 10),
    closedEntry('2025-07-02T11:00:00.000Z', 10),
    closedEntry('2025-07-03T10:00:00.000Z', -10),
    closedEntry('2025-07-03T11:00:00.000Z', 10),
    closedEntry('2025-07-04T10:00:00.000Z', 10),
  ]);
  assert.equal(el('mostActiveDay').textContent, 'Wednesday / Thursday');
  assert.match(el('mostActiveDay').title, /2 entries each/);
});

test('Most Active Day counts every entry, the OPEN ones included, like the heatmap', () => {
  // 2025-07-07 is a Monday, 2025-07-08 a Tuesday.
  renderTimeAnalysis([
    closedEntry('2025-07-07T10:00:00.000Z', 10),
    closedEntry('2025-07-08T10:00:00.000Z', 10),
    { ...closedEntry('2025-07-08T12:00:00.000Z', 0), ...OPEN_FIELDS },
  ]);
  assert.equal(el('mostActiveDay').textContent, 'Tuesday');
  assert.equal(el('mostActiveDay').title, '2 entries (UTC entry day)');

  renderTimeAnalysis([{ ...closedEntry('2025-07-08T12:00:00.000Z', 0), ...OPEN_FIELDS }]);
  assert.equal(el('mostActiveDay').textContent, 'Tuesday', 'an account with only an open position still has entries');
});

test('a failed CLOSED list keeps the hold-time pattern rows, their FREQUENCY — with the reason', () => {
  const reason = 'Closed positions failed to load';
  renderWithClosedTradesGap([{ ...closedEntry('2025-07-08T12:00:00.000Z', 0), ...OPEN_FIELDS }], reason);
  for (const name of ['Long Hold', 'Quick Flip']) {
    const row = patternRow(name);
    assert.ok(row, `${name} row is kept`);
    assert.equal(row.children[COL.FREQUENCY].textContent, '—', name);
    assert.equal(row.children[COL.FREQUENCY].title, reason, name);
  }
  assert.equal(el('mostActiveDay').textContent, '—');
  assert.equal(el('mostActiveDay').title, reason);
});

test('a short closed-trade list (an unlisted trade) blanks the hold-time counts and Most Active Day', () => {
  const reason = `${RM.INCOMPLETE_CAUSE.UNLISTED_TRADE} in SOL-USD`;
  // Held 25h: a Long Hold trade.
  const longHold = { ...closedEntry('2025-07-02T10:00:00.000Z', 10), closedAt: '2025-07-03T11:00:00.000Z' };
  renderWithClosedTradesGap([longHold, closedEntry('2025-07-03T10:00:00.000Z', 10)], reason);
  const frequency = patternRow('Long Hold').children[COL.FREQUENCY];
  assert.equal(frequency.textContent, '—', 'a count over a short list is a lower bound');
  assert.equal(frequency.title, reason);
  assert.equal(el('mostActiveDay').textContent, '—');
  assert.equal(el('mostActiveDay').title, reason);
});

test('a CLOSED row without a valid entry-to-close window blanks the hold-time rows with the reason', () => {
  // Held 25h: a Long Hold trade.
  const longHold = { ...closedEntry('2025-07-02T10:00:00.000Z', 10), closedAt: '2025-07-03T11:00:00.000Z' };
  const closesBeforeEntry = { ...closedEntry('2025-07-03T10:00:00.000Z', 10), closedAt: '2025-07-03T09:00:00.000Z' };
  renderPatterns([longHold, closesBeforeEntry]);
  const row = patternRow('Long Hold');
  const reason = RM.holdTimeGap([longHold, closesBeforeEntry]);
  assert.notEqual(reason, '');
  for (const column of [COL.FREQUENCY, COL.SUCCESS_RATE, COL.EXPECTANCY]) {
    assert.equal(row.children[column].textContent, '—', `column ${column}`);
    assert.equal(row.children[column].title, reason, `column ${column}`);
  }
});

test('an empty win or loss bucket reads N/A; incomplete inputs read — with the classifier\'s reason', () => {
  const winsOnly = [
    closedEntry('2025-07-02T10:00:00.000Z', 10),
    closedEntry('2025-07-03T10:00:00.000Z', 20),
  ];
  renderTimeAnalysis(winsOnly);
  assert.equal(el('avgHoldWin').textContent, '1h 0m');
  assert.equal(el('avgHoldLoss').textContent, 'N/A');
  assert.equal(el('bestHour').textContent, 'N/A', 'no hour holds enough trades');

  const reason = '1 position missing fill data';
  renderTimeAnalysis(winsOnly, reason);
  for (const id of ['avgHoldWin', 'avgHoldLoss', 'bestHour', 'worstHour']) {
    assert.equal(el(id).textContent, '—', id);
    assert.equal(el(id).title, reason, id);
  }
});

test('an account with no closed position reads N/A for its hold times and hours; — only with the classifier\'s reason', () => {
  const openOnly = [{ ...closedEntry('2025-07-02T10:00:00.000Z', 0), ...OPEN_FIELDS }];
  renderTimeAnalysis(openOnly);
  for (const id of ['avgHoldWin', 'avgHoldLoss', 'bestHour', 'worstHour']) {
    assert.equal(el(id).textContent, 'N/A', id);
    assert.equal(el(id).title, 'No closed positions', id);
  }

  const reason = 'Closed positions failed to load';
  renderTimeAnalysis(openOnly, reason);
  for (const id of ['avgHoldWin', 'avgHoldLoss', 'bestHour', 'worstHour']) {
    assert.equal(el(id).textContent, '—', id);
    assert.equal(el(id).title, reason, id);
  }
});

test('pattern win rate and expectancy carry the classifier\'s reason while its inputs are incomplete', () => {
  // Held 25h: a Long Hold trade.
  const longHold = { ...closedEntry('2025-07-02T10:00:00.000Z', 10), closedAt: '2025-07-03T11:00:00.000Z' };
  const reason = '1 position missing fill data';
  renderPatterns([longHold], reason);
  const row = patternRow(`Long Hold (>${TUNABLES.LONG_HOLD_HOURS}h)`);
  assert.ok(row, 'the hold-time bucket is named for what it measures');
  const winRate = row.children[COL.SUCCESS_RATE];
  const expectancy = row.children[COL.EXPECTANCY];
  assert.equal(row.children[COL.FREQUENCY].textContent, '1', 'a hold-time count needs no profit');
  assert.equal(winRate.textContent, '—');
  assert.equal(winRate.title, reason);
  assert.equal(expectancy.textContent, '—');
  assert.equal(expectancy.title, reason);
});

test('a pattern SUCCESS RATE reads as the Win Rate card does (Format.formatPercent)', () => {
  // 3 wins of 2000 decisive Long Hold trades: 0.15%, the card's 0.2% (toFixed(1) reads 0.1%).
  const DECISIVE = 2000, WINS = 3;
  const heldMs = (TUNABLES.LONG_HOLD_HOURS + 1) * MS_PER_HOUR;
  const startMs = Date.parse('2025-07-01T00:00:00.000Z');
  const longHolds = Array.from({ length: DECISIVE }, (_, i) => {
    const entryMs = startMs + i * MS_PER_HOUR;
    return { ...closedEntry(new Date(entryMs).toISOString(), i < WINS ? 100 : -1),
      closedAt: new Date(entryMs + heldMs).toISOString() };
  });
  renderPatterns(longHolds);
  const successRate = patternRow('Long Hold').children[COL.SUCCESS_RATE].textContent;
  assert.equal(successRate, window.Format.formatPercent((WINS / DECISIVE) * window.AppConstants.PERCENT));
  assert.equal(successRate, '0.2%');
});

// Long Hold trades with these profits, entered an hour apart.
function longHoldsWith(profits) {
  const heldMs = (TUNABLES.LONG_HOLD_HOURS + 1) * MS_PER_HOUR;
  const startMs = Date.parse('2025-07-01T00:00:00.000Z');
  return profits.map((profit, i) => {
    const entryMs = startMs + i * MS_PER_HOUR;
    return { ...closedEntry(new Date(entryMs).toISOString(), profit),
      closedAt: new Date(entryMs + heldMs).toISOString() };
  });
}
const repeated = (count, profit) => new Array(count).fill(profit);
const RECOMMENDATION_COL = 4;
const toneOf = (td) => ['profit', 'loss'].filter(tone => td.className.split(/\s+/).includes(tone));

test('SUCCESS RATE is toned against the set\'s own breakeven win rate, neutral without one', () => {
  // 75.0% wins of +$10 against losses of -$100: breakeven is 90.9%, expectancy negative.
  renderPatterns(longHoldsWith([...repeated(15, 10), ...repeated(5, -100)]));
  let row = patternRow('Long Hold');
  assert.equal(row.children[COL.SUCCESS_RATE].textContent, '75.0%');
  assert.equal(row.children[COL.EXPECTANCY].textContent, '-$18');
  assert.deepEqual(toneOf(row.children[COL.SUCCESS_RATE]), ['loss'], 'below its breakeven, beside a negative expectancy');

  // 40.0% wins of +$100 against losses of -$10: breakeven is 9.1%.
  renderPatterns(longHoldsWith([...repeated(4, 100), ...repeated(6, -10)]));
  row = patternRow('Long Hold');
  assert.equal(row.children[COL.SUCCESS_RATE].textContent, '40.0%');
  assert.deepEqual(toneOf(row.children[COL.SUCCESS_RATE]), ['profit'], 'above its breakeven, beside a positive expectancy');

  // No loss: no payoff, so no breakeven rate to judge 100.0% against.
  renderPatterns(longHoldsWith(repeated(3, 10)));
  row = patternRow('Long Hold');
  assert.equal(row.children[COL.SUCCESS_RATE].textContent, '100.0%');
  assert.deepEqual(toneOf(row.children[COL.SUCCESS_RATE]), []);
});

test('a SUCCESS RATE that displays alike its breakeven rate takes its tone from EXPECTANCY as displayed', () => {
  // 60.0% wins of +$6,655.60 against losses of -$10,000: breakeven 60.04%
  // displays 60.0% too, and the set loses $6.64 a trade.
  renderPatterns(longHoldsWith([...repeated(6, 6655.6), ...repeated(4, -10000)]));
  let row = patternRow('Long Hold');
  assert.equal(row.children[COL.SUCCESS_RATE].textContent, '60.0%');
  assert.equal(row.children[COL.EXPECTANCY].textContent, '-$7');
  assert.deepEqual(toneOf(row.children[COL.SUCCESS_RATE]), ['loss'], 'beside a negative expectancy');

  // Losses of -$15.01 against wins of +$10: breakeven 60.02% displays
  // 60.0%, and an expectancy of -$0.004 displays $0: neutral.
  renderPatterns(longHoldsWith([...repeated(6, 10), ...repeated(4, -15.01)]));
  row = patternRow('Long Hold');
  assert.equal(row.children[COL.SUCCESS_RATE].textContent, '60.0%');
  assert.equal(row.children[COL.EXPECTANCY].textContent, '$0');
  assert.deepEqual(toneOf(row.children[COL.SUCCESS_RATE]), [], 'beside an expectancy that displays $0');
});

test('a pattern EXPECTANCY on an exact half-dollar tie rounds up, and the tone and verdict follow it', () => {
  // Ten trades whose exact sum is $5.00 (float addition leaves $4.99999999998545):
  // an expectancy of exactly $0.50, and a breakeven rate that displays 60.0% like the win rate.
  renderPatterns(longHoldsWith([27904.4, 10028.3, 23100.4, 28703.1, 20756.1, 14916.9,
    -42013.4, -30039.7, -17663.4, -35687.7]));
  const row = patternRow('Long Hold');
  assert.equal(row.children[COL.SUCCESS_RATE].textContent, '60.0%');
  assert.equal(row.children[COL.EXPECTANCY].textContent, '+$1');
  assert.deepEqual(toneOf(row.children[COL.SUCCESS_RATE]), ['profit']);
  assert.equal(row.children[RECOMMENDATION_COL].textContent, 'CONTINUE');
});

test('Long Hold and Quick Flip bucket the hold as DURATION displays it', () => {
  const { MS_PER_SEC } = window.AppConstants;
  const offBoundaryMs = 20 * MS_PER_SEC;
  const entryMs = Date.parse('2025-07-01T00:00:00.000Z');
  const heldFor = (ms, profit) => ({ ...closedEntry(new Date(entryMs).toISOString(), profit),
    closedAt: new Date(entryMs + ms).toISOString() });
  // 4h 0m 20s displays '4h 0m', not more than LONG_HOLD_HOURS; 14m 40s
  // displays '15m', not less than FLIP_HOLD_HOURS. Neither row has a trade.
  const atLongHold = TUNABLES.LONG_HOLD_HOURS * MS_PER_HOUR + offBoundaryMs;
  const atQuickFlip = TUNABLES.FLIP_HOLD_HOURS * MS_PER_HOUR - offBoundaryMs;
  assert.equal(window.Format.formatDuration(atLongHold), '4h 0m');
  assert.equal(window.Format.formatDuration(atQuickFlip), '15m');
  renderPatterns([heldFor(atLongHold, 10), heldFor(atQuickFlip, -10), heldFor(MS_PER_HOUR, 5)]);
  assert.equal(patternRow('Long Hold'), undefined);
  assert.equal(patternRow('Quick Flip'), undefined);
});

test('the pattern verdict is decided on the win rate and expectancy as displayed', () => {
  // 1099 of 2000: 54.95% displays 55.0%, the CONTINUE threshold, beside a positive expectancy.
  renderPatterns(longHoldsWith([...repeated(1099, 20), ...repeated(901, -10)]));
  let row = patternRow('Long Hold');
  assert.equal(row.children[COL.SUCCESS_RATE].textContent, '55.0%');
  assert.equal(row.children[COL.EXPECTANCY].textContent, '+$6');
  assert.equal(row.children[RECOMMENDATION_COL].textContent, 'CONTINUE');

  // 2499 of 5000: 49.98% displays 50.0%, not below the AVOID threshold.
  renderPatterns(longHoldsWith([...repeated(2499, 1), ...repeated(2501, -2)]));
  row = patternRow('Long Hold');
  assert.equal(row.children[COL.SUCCESS_RATE].textContent, '50.0%');
  assert.equal(row.children[RECOMMENDATION_COL].textContent, 'REVIEW');

  // An expectancy of -$0.02 displays $0: not a negative edge to AVOID.
  renderPatterns(longHoldsWith([...repeated(9, 10), ...repeated(10, -8), -10.4]));
  row = patternRow('Long Hold');
  assert.equal(row.children[COL.SUCCESS_RATE].textContent, '45.0%');
  assert.equal(row.children[COL.EXPECTANCY].textContent, '$0');
  assert.equal(row.children[RECOMMENDATION_COL].textContent, 'REVIEW');

  // The same shape with a bigger last loss displays -$1: a negative edge.
  renderPatterns(longHoldsWith([...repeated(9, 10), ...repeated(10, -8), -20]));
  assert.equal(patternRow('Long Hold').children[RECOMMENDATION_COL].textContent, 'AVOID');
});

test('the low-n minimum counts the set\'s decisive closed trades, not its scratches', () => {
  // 10 Long Holds: 8 scratches and 2 wins rest the ratios on 2 trades.
  renderPatterns(longHoldsWith([...repeated(8, 0), ...repeated(2, 100)]));
  const row = patternRow('Long Hold');
  assert.equal(row.children[COL.FREQUENCY].textContent, '10');
  assert.equal(row.children[COL.SUCCESS_RATE].textContent, '100.0%');
  assert.equal(row.children[RECOMMENDATION_COL].textContent, 'REVIEW (low n)');
  assert.match(el('patternVerdictLabel').title, new RegExp(`fewer than ${TUNABLES.PATTERN_MIN_N} decisive closed trades`));
});

test('a pattern set without a closed win or loss reads REVIEW (low n) at any size: it has no decisive trade', () => {
  const entryMs = Date.parse('2025-07-01T00:00:00.000Z');
  const FLIP_MS = (TUNABLES.FLIP_HOLD_HOURS * MS_PER_HOUR) / 3;
  const scratchFlips = (count) => Array.from({ length: count }, (_, i) => {
    const openMs = entryMs + i * MS_PER_HOUR;
    return { ...closedEntry(new Date(openMs).toISOString(), 0), closedAt: new Date(openMs + FLIP_MS).toISOString() };
  });
  renderPatterns(scratchFlips(2));
  let recommendation = patternRow('Quick Flip').children[RECOMMENDATION_COL];
  assert.equal(recommendation.textContent, 'REVIEW (low n)');

  renderPatterns(scratchFlips(TUNABLES.PATTERN_MIN_N));
  recommendation = patternRow('Quick Flip').children[RECOMMENDATION_COL];
  assert.equal(recommendation.textContent, 'REVIEW (low n)');

  // A ratio gap keeps — with its reason, whatever the count.
  const reason = '1 position missing fill data';
  renderPatterns(scratchFlips(2), reason);
  recommendation = patternRow('Quick Flip').children[RECOMMENDATION_COL];
  assert.equal(recommendation.textContent, '—');
  assert.equal(recommendation.title, reason);
});

// ---------------------------------------------------------------------------
// Post-Loss Double Down: same market, same side, next position by entry
// ---------------------------------------------------------------------------

test('a bigger re-entry on the loser\'s side is a double down; one on the other side is not', () => {
  renderPatterns([loser, reentry('SHORT', 30)]);
  assert.equal(patternRow(DOUBLE_DOWN), undefined, 'a reversal into a bigger position is not doubling down');

  renderPatterns([loser, reentry('LONG', 30)]);
  assert.equal(patternRow(DOUBLE_DOWN).children[COL.FREQUENCY].textContent, '1');
});

test('a re-entry at exactly DOUBLE_DOWN_SIZE_MULT × the loser\'s peak notional is a double down, compared as decimals', () => {
  const ENTRY = 1463.06;
  const LOSER_SIZE = 1.5;
  const ethLoser = { ...loser, market: 'ETH-USD', peakSize: LOSER_SIZE, entryVwap: ENTRY };
  const ethReentry = (peakSize) => reentry('LONG', 30, { market: 'ETH-USD', peakSize, entryVwap: ENTRY });
  // 1.8 ETH is exactly 1.2 × 1.5 ETH at the same price; in floating
  // point 1.2 × 2194.59 is 2633.5080000000003, above 1.8 × 1463.06.
  assert.equal(TUNABLES.DOUBLE_DOWN_SIZE_MULT, 1.2);
  assert.ok(RM.peakNotional(ethReentry(1.8)) < TUNABLES.DOUBLE_DOWN_SIZE_MULT * RM.peakNotional(ethLoser));
  renderPatterns([ethLoser, ethReentry(1.8)]);
  assert.equal(patternRow(DOUBLE_DOWN)?.children[COL.FREQUENCY].textContent, '1');

  renderPatterns([ethLoser, ethReentry(1.799)]);
  assert.equal(patternRow(DOUBLE_DOWN), undefined, 'a re-entry below the multiple is not a double down');
});

test('a round trip whose fees cancel its gain (100 → 100.3, fees 0.1 + 0.2), attributed from its fills, is no loser to double down after', () => {
  const position = { market: 'BTC-USD', side: 'LONG', status: 'CLOSED',
    createdAt: loser.createdAt, closedAt: loser.closedAt };
  const fill = (createdAt, side, price, fee) => ({ market: 'BTC-USD', createdAt, side, size: '1', price, fee });
  const breakEven = { ...position, ...RM.attributeFillsToPositions([position], [
    fill(loser.createdAt, 'BUY', '100', '0.1'),
    fill(loser.closedAt, 'SELL', '100.3', '0.2'),
  ]).get(position) };
  renderPatterns([breakEven, reentry('LONG', 20)]);
  assert.equal(patternRow(DOUBLE_DOWN), undefined);
});

test('a close in another market between the loser and its re-entry does not hide the double down', () => {
  const ethClosedBetween = {
    ...closedEntry('2025-07-02T10:10:00.000Z', 5), market: 'ETH-USD', closedAt: '2025-07-02T11:10:00.000Z',
  };
  renderPatterns([loser, ethClosedBetween, reentry('LONG', 30)]);
  assert.equal(patternRow(DOUBLE_DOWN).children[COL.FREQUENCY].textContent, '1');
});

test('a still-open re-entry counts in FREQUENCY but not in the success rate', () => {
  const open = reentry('LONG', 30, { status: 'OPEN', closedAt: undefined });
  renderPatterns([loser, open]);
  const row = patternRow(DOUBLE_DOWN);
  assert.equal(row.children[COL.FREQUENCY].textContent, '1');
  assert.equal(row.children[COL.SUCCESS_RATE].textContent, 'N/A');
  assert.match(row.children[COL.SUCCESS_RATE].title, /closed/);
});

test('the position the loser\'s own reversal opened is skipped for the next one in that market', () => {
  const reversedLoser = { ...loser, closedByFlip: true };
  // Opened by the reversing fill at the loser's close, bigger and a winner.
  const reversalChild = reentry('SHORT', 40, {
    createdAt: loser.closedAt, closedAt: '2025-07-02T11:20:00.000Z', openedByFlip: true,
  });
  const sameSideAfter = reentry('LONG', -20, {
    createdAt: '2025-07-02T11:40:00.000Z', closedAt: '2025-07-02T12:40:00.000Z',
  });
  renderPatterns([reversedLoser, reversalChild, sameSideAfter]);
  const row = patternRow(DOUBLE_DOWN);
  assert.equal(row.children[COL.FREQUENCY].textContent, '1');
  assert.equal(row.children[COL.EXPECTANCY].textContent, '-$20', 'the same-side re-entry, not the reversal');
});

test('while positions are incomplete, double-down FREQUENCY reads — with the classifier\'s reason', () => {
  const incompleteLoser = { ...loser, complete: false };
  const positions = [incompleteLoser, reentry('LONG', 30)];
  renderPatterns(positions);
  const reason = RM.classifyClosed(positions).incompleteReason;
  assert.notEqual(reason, '');
  const frequency = patternRow(DOUBLE_DOWN).children[COL.FREQUENCY];
  assert.equal(frequency.textContent, '—', 'a count over complete pairs only is a lower bound');
  assert.equal(frequency.title, reason);
});

test('an incomplete OPEN position the detector could pair with makes double-down FREQUENCY — with its reason', () => {
  const cause = RM.INCOMPLETE_CAUSE.OPEN_SIZE_MISMATCH;
  const open = reentry('LONG', 0, { ...OPEN_FIELDS, complete: false, incompleteCause: cause });
  renderPatterns([loser, open]);
  const row = patternRow(DOUBLE_DOWN);
  assert.ok(row, 'the row is kept: its count is unknown, not zero');
  const frequency = row.children[COL.FREQUENCY];
  assert.equal(frequency.textContent, '—');
  assert.equal(frequency.title, `1 open position missing fill data (${cause})`);
});

test('an unknown entry (an untimed position or a failed OPEN list) makes double-down FREQUENCY — with the reason', () => {
  const untimedOpen = reentry('LONG', 0, { ...OPEN_FIELDS, createdAt: undefined });
  renderPatternsWithEntriesGap([loser, untimedOpen]);
  const frequency = patternRow(DOUBLE_DOWN).children[COL.FREQUENCY];
  assert.equal(frequency.textContent, '—', 'the untimed position may be the re-entry');
  assert.equal(frequency.title, RM.entryTimeGap([loser, untimedOpen]));

  const reason = 'Open positions failed to load';
  renderPatternsWithEntriesGap([loser], reason);
  const row = patternRow(DOUBLE_DOWN);
  assert.ok(row, 'an OPEN re-entry may be missing from the list');
  assert.equal(row.children[COL.FREQUENCY].textContent, '—');
  assert.equal(row.children[COL.FREQUENCY].title, reason);
});

test('positions entered in one millisecond pair in close order, whichever order the indexer lists them', () => {
  // A (LONG) is reversed at T into B (SHORT), both entered at T; B loses and
  // C re-enters SHORT 15 minutes after B's close at 3x B's peak notional.
  const T = '2025-07-03T10:00:00.000Z';
  const a = { ...closedEntry(T, -10), closedAt: T, closedByFlip: true };
  const b = { ...closedEntry(T, -20), side: 'SHORT', closedAt: '2025-07-03T10:30:00.000Z', openedByFlip: true };
  const c = { ...closedEntry('2025-07-03T10:45:00.000Z', 5), side: 'SHORT', peakSize: 3 };
  const name = new Map([[a, 'A'], [b, 'B'], [c, 'C']]);
  for (const listed of [[a, b, c], [b, a, c], [c, b, a]]) {
    renderPatterns(listed);
    const row = patternRow(DOUBLE_DOWN);
    const order = listed.map(p => name.get(p)).join('');
    assert.ok(row, `listed ${order}`);
    assert.equal(row.children[COL.FREQUENCY].textContent, '1', `listed ${order}`);
  }
});

test('positions entered and closed in one millisecond pair in their closing fills\' chain order, whichever order the indexer lists them', () => {
  // One block at T: BUY 1 opens LONG A, SELL 2 reverses it into SHORT B, BUY 1
  // closes B, both at a loss; SELL 2 at T + 10 minutes opens SHORT C at twice
  // B's peak notional. B, not A, is C's predecessor.
  const T = '2025-07-02T10:00:00.000Z', LATER = '2025-07-02T10:10:00.000Z';
  let height = 0;
  const fill = (side, size, price, createdAt) => {
    height += 1;
    return { id: `f${height}`, market: 'BTC-USD', side, size: String(size), price: String(price), fee: '0',
      createdAt, createdAtHeight: String(height), liquidity: 'TAKER' };
  };
  const fills = [fill('BUY', 1, 100, T), fill('SELL', 2, 99, T), fill('BUY', 1, 100, T), fill('SELL', 2, 100, LATER)];
  const a = { market: 'BTC-USD', side: 'LONG', status: 'CLOSED', createdAt: T, closedAt: T, netFunding: '0' };
  const b = { market: 'BTC-USD', side: 'SHORT', status: 'CLOSED', createdAt: T, closedAt: T, netFunding: '0' };
  const c = { market: 'BTC-USD', side: 'SHORT', status: 'OPEN', createdAt: LATER, size: '-2', netFunding: '0' };
  for (const [listed, order] of [[[a, b, c], 'ABC'], [[b, a, c], 'BAC']]) {
    const attribution = RM.attributeFillsToPositions(listed, fills);
    const positions = listed.map(p => ({ ...p, ...attribution.get(p) }));
    assert.ok(positions.every(p => RM.hasCompleteAttribution(p)), `listed ${order}`);
    Behavior.renderDetectedPatterns(positions, RM.classifyClosed(positions), '', RM.entryTimeGap(positions), fills);
    const row = patternRow(DOUBLE_DOWN);
    assert.ok(row, `listed ${order}`);
    assert.equal(row.children[COL.FREQUENCY].textContent, '1', `listed ${order}`);
  }
});

test('the double-down label states its rule on hover', () => {
  renderPatterns([loser, reentry('LONG', 30)]);
  const { title } = patternRow(DOUBLE_DOWN).children[COL.PATTERN];
  assert.match(title, /same market/);
  assert.match(title, /same side/);
  assert.match(title, /revers/);
  assert.ok(title.includes(`${TUNABLES.DOUBLE_DOWN_GAP_HOURS}h`), title);
  assert.ok(title.includes(`${TUNABLES.DOUBLE_DOWN_SIZE_MULT}×`), title);
});

// ---------------------------------------------------------------------------
// Best / Worst Trading Hour
// ---------------------------------------------------------------------------

// `count` complete trades entered at `hour` UTC on successive days.
function tradesAtHour(hour, count, profit) {
  return Array.from({ length: count }, (_, day) => closedEntry(
    `2025-07-${String(day + 1).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`, profit));
}

test('an hour needs HOUR_MIN_SAMPLE entries; Worst reads — when only one hour qualifies', () => {
  renderTimeAnalysis([
    ...tradesAtHour(10, TUNABLES.HOUR_MIN_SAMPLE - 1, -500),
    ...tradesAtHour(14, TUNABLES.HOUR_MIN_SAMPLE, 100),
  ]);
  assert.equal(el('bestHour').textContent, '14:00 UTC');
  assert.equal(el('worstHour').textContent, '—', 'the best hour is not also the worst');
  assert.match(el('worstHour').title, /one entry hour/);
});

test('with two qualifying hours Best and Worst are their mean-profit extremes', () => {
  renderTimeAnalysis([
    ...tradesAtHour(10, TUNABLES.HOUR_MIN_SAMPLE, -500),
    ...tradesAtHour(14, TUNABLES.HOUR_MIN_SAMPLE, 100),
  ]);
  assert.equal(el('bestHour').textContent, '14:00 UTC');
  assert.equal(el('worstHour').textContent, '10:00 UTC');
});

test('hours tied for the highest or lowest mean are all named, with the tie on hover', () => {
  renderTimeAnalysis([
    ...tradesAtHour(9, TUNABLES.HOUR_MIN_SAMPLE, 100),
    ...tradesAtHour(14, TUNABLES.HOUR_MIN_SAMPLE, 100),
    ...tradesAtHour(16, TUNABLES.HOUR_MIN_SAMPLE, -50),
    ...tradesAtHour(20, TUNABLES.HOUR_MIN_SAMPLE, -50),
    ...tradesAtHour(22, TUNABLES.HOUR_MIN_SAMPLE, 10),
  ]);
  assert.equal(el('bestHour').textContent, '09:00 / 14:00 UTC');
  assert.match(el('bestHour').title, /2 entry hours tie/);
  assert.equal(el('worstHour').textContent, '16:00 / 20:00 UTC');
  assert.match(el('worstHour').title, /2 entry hours tie/);
});

test('when every qualifying hour ties, Best lists them and Worst reads —', () => {
  renderTimeAnalysis([
    ...tradesAtHour(9, TUNABLES.HOUR_MIN_SAMPLE, 100),
    ...tradesAtHour(14, TUNABLES.HOUR_MIN_SAMPLE, 100),
  ]);
  assert.equal(el('bestHour').textContent, '09:00 / 14:00 UTC');
  assert.equal(el('worstHour').textContent, '—');
  assert.match(el('worstHour').title, /same mean/);
});

test('hours whose mean profits are equal in cents tie, whatever float residue their sums carry', () => {
  // Both means are $0.66; summed in floating point they are 0.66 and 0.6599999999999999.
  const nineProfits = [1, 1, 1, 0.1, 0.2], fourteenProfits = [1, 1, 1, 0.3, 0];
  assert.equal(nineProfits.length, TUNABLES.HOUR_MIN_SAMPLE);
  const at = (hour, profits) => profits.map((profit, day) => closedEntry(
    `2025-07-${String(day + 1).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`, profit));
  renderTimeAnalysis([...at(9, nineProfits), ...at(14, fourteenProfits)]);
  assert.equal(el('bestHour').textContent, '09:00 / 14:00 UTC');
  assert.match(el('bestHour').title, /2 entry hours tie at the highest mean profit/);
  assert.equal(el('worstHour').textContent, '—', 'the worst hour would be the best');
  assert.match(el('worstHour').title, /same mean/);
});

test('hour means tie at cents rounded half away from zero as the decimal, like every cent figure (RiskMetrics.wholeCents)', () => {
  // A mean of exactly $1.005 is 101 cents, the same as $1.01.
  renderTimeAnalysis([
    ...tradesAtHour(9, TUNABLES.HOUR_MIN_SAMPLE, 1.005),
    ...tradesAtHour(14, TUNABLES.HOUR_MIN_SAMPLE, 1.01),
  ]);
  assert.equal(RM.wholeCents(1.005), RM.wholeCents(1.01));
  assert.equal(el('bestHour').textContent, '09:00 / 14:00 UTC');
  assert.equal(el('worstHour').textContent, '—');
  assert.match(el('worstHour').title, /same mean/);
});

test('an hour\'s mean is rounded to cents once from the exact quotient (RiskMetrics.quotientCents), never through a micro first', () => {
  // Hour 09: $5.024999 over 5 trades is $1.0049998, which is $1.00; taken
  // first to the nearest micro it would be $1.005000 and round to $1.01.
  const nineProfits = [1.004999, 1.005, 1.005, 1.005, 1.005];
  assert.equal(nineProfits.length, TUNABLES.HOUR_MIN_SAMPLE);
  const at = (hour, profits) => profits.map((profit, day) => closedEntry(
    `2025-07-${String(day + 1).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`, profit));
  renderTimeAnalysis([...at(9, nineProfits), ...tradesAtHour(14, TUNABLES.HOUR_MIN_SAMPLE, 1.01)]);
  assert.equal(RM.quotientCents(RM.exactSum(nineProfits), nineProfits.length), 100);
  assert.equal(el('bestHour').textContent, '14:00 UTC');
  assert.equal(el('bestHour').title, '');
  assert.equal(el('worstHour').textContent, '09:00 UTC');
});

test('the Best and Worst Trading Hour labels state the rule', () => {
  renderTimeAnalysis(tradesAtHour(14, 1, 100));
  for (const id of ['bestHourLabel', 'worstHourLabel']) {
    const { title } = el(id);
    assert.match(title, /entry hour/i, id);
    assert.match(title, /UTC/, id);
    assert.match(title, /mean/i, id);
    assert.ok(title.includes(`≥${TUNABLES.HOUR_MIN_SAMPLE}`), `${id}: ${title}`);
  }
});

// ---------------------------------------------------------------------------
// Activity heatmap: one entry per position, OPEN included
// ---------------------------------------------------------------------------

test('the heatmap counts every position\'s entry once, the open one included', () => {
  // 2025-07-06 is a Sunday.
  const closed = closedEntry('2025-07-06T17:05:00.000Z', 10);
  const open = { ...closedEntry('2025-07-06T17:50:00.000Z', 0), status: 'OPEN', closedAt: undefined };
  Behavior.renderActivityHeatmap([closed, open]);
  const cells = el('activityHeatmap').children;
  const SUNDAY = 0, HOUR = 17;
  assert.match(cells[SUNDAY * HOURS_PER_DAY + HOUR].title, /^Sun 17:00 UTC — 2 entries$/);
  const total = cells.reduce((sum, c) => sum + Number(c.title.match(/— (\d+) entr/)[1]), 0);
  assert.equal(total, 2, 'each position is one entry');
});

test('a position without a valid entry time leaves the heatmap and Most Active Day with the reason, not a lower count', () => {
  const positions = [
    closedEntry('2025-07-02T10:00:00.000Z', 10),
    { ...closedEntry('2025-07-02T12:00:00.000Z', 0), ...OPEN_FIELDS, createdAt: undefined },
  ];
  const entriesGap = entriesGapOf(positions);
  assert.equal(entriesGap, '1 position without a valid entry time');
  Behavior.renderTimeAnalysis(positions, RM.classifyClosed(positions), entriesGap);
  Behavior.renderActivityHeatmap(positions, entriesGap);
  assert.equal(el('mostActiveDay').textContent, '—');
  assert.equal(el('mostActiveDay').title, entriesGap);
  const [note, ...cells] = el('activityHeatmap').children;
  assert.equal(note.textContent, entriesGap);
  assert.equal(cells.length, 0, 'no cell counts the entries that are known');
  assert.equal(RM.entryTimeGap([positions[0]]), '', 'every entry known');
  assert.equal(RM.entryTimeGap([positions[1], positions[1]]), '2 positions without a valid entry time');
});

// ---------------------------------------------------------------------------
// Labels in index.html
// ---------------------------------------------------------------------------

test('the patterns table calls its average EXPECTANCY and the heatmap names what it counts', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const header = html.match(/<th([^>]*)>EXPECTANCY<\/th>/);
  assert.ok(header, 'the patterns table has an EXPECTANCY column');
  assert.match(header[1], /title="[^"]*per decisive trade, net of fees, excluding funding/);
  assert.ok(!/>AVG PROFIT<\/th>\s*<th>RECOMMENDATION/.test(html), 'no AVG PROFIT column beside RECOMMENDATION');
  assert.match(html, /<div class="table-title">Position entries by hour and weekday \(UTC\)<\/div>/);
});

test('the SUCCESS RATE header names its breakeven tone; the RECOMMENDATION header states the verdict rule', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const successRate = html.match(/<th([^>]*)>SUCCESS RATE<\/th>/);
  assert.ok(successRate, 'the patterns table has a SUCCESS RATE column');
  assert.match(successRate[1], /title="[^"]*breakeven win rate/);

  renderPatterns(longHoldsWith(repeated(3, 10)));
  const { title } = el('patternVerdictLabel');
  assert.match(title, /CONTINUE: positive expectancy and a win rate of at least \d+%/);
  assert.match(title, /AVOID: negative expectancy and a win rate below \d+%/);
  assert.match(title, /as displayed/);
  assert.ok(title.includes(`REVIEW (low n) with fewer than ${TUNABLES.PATTERN_MIN_N} decisive closed trades`), title);
});
