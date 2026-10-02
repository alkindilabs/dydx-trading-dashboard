'use strict';

// The Positions tab panel (src/panels/positions.js) rendered through its
// public entry, positions.render(positions, fills, context), with the
// real constants, Format, AppDom and RiskMetrics modules. Only the
// browser DOM is a stand-in (test/fake-dom.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const { el, rowTexts } = require('./fake-dom');

require('../src/constants.js');
require('../src/format.js');
require('../src/dom.js');
require('../risk-metrics.js');
require('../src/panels/positions.js');

const Positions = window.AppPanels.positions;

// Columns of the Recent Position History.
const COLUMN = { CLOSED: 0, SIZE: 3, ENTRY: 4, EXIT: 5, PROFIT: 6, PROFIT_PCT: 7, DURATION: 8, FUNDING: 9 };

function closedPosition(fields = {}) {
  return {
    market: 'BTC-USD', side: 'LONG', status: 'CLOSED',
    createdAt: '2025-07-01T00:00:00.000Z', closedAt: '2025-07-01T01:00:00.000Z',
    profit: 25, complete: true, incompleteCause: null, peakSize: 1, entryVwap: 100, exitVwap: 125,
    netFunding: '-3',
    ...fields,
  };
}

const FILLS = [{ liquidity: 'TAKER' }, { liquidity: 'MAKER' }];

function render(positions, context = {}, fills = FILLS) {
  Positions.render(positions, fills, { marketsMap: {}, openPositionsGap: '', openNotionalGap: '', ...context });
}

test('FUNDING reads — when the position carries no netFunding, and $0 for a real zero', () => {
  render([
    closedPosition({ closedAt: '2025-07-03T00:00:00.000Z', netFunding: undefined }),
    closedPosition({ closedAt: '2025-07-02T00:00:00.000Z', netFunding: 'n/a' }),
    closedPosition({ closedAt: '2025-07-01T00:00:00.000Z', netFunding: '0' }),
  ]);
  const funding = rowTexts('positionsHistoryBody').map(row => row[COLUMN.FUNDING]);
  assert.deepEqual(funding, ['—', '—', '$0']);
  const reasons = el('positionsHistoryBody').children.map(tr => tr.children[COLUMN.FUNDING].title);
  assert.deepEqual(reasons, [window.RiskMetrics.NO_NET_FUNDING, window.RiskMetrics.NO_NET_FUNDING, '']);
});

test('rows newest first; a row without a parseable close time sorts last, its DURATION —', () => {
  render([
    closedPosition({ closedAt: '2025-07-02T00:00:00.000Z', profit: 1 }),
    closedPosition({ closedAt: 'not a time', profit: 2 }),
    closedPosition({ closedAt: '2025-07-03T00:00:00.000Z', profit: 3 }),
    closedPosition({ closedAt: undefined, profit: 4 }),
    closedPosition({ closedAt: '2025-07-01T12:00:00.000Z', profit: 5 }),
  ]);
  const rows = rowTexts('positionsHistoryBody');
  assert.deepEqual(rows.map(row => row[COLUMN.PROFIT]), ['+$3', '+$1', '+$5', '+$2', '+$4']);
  assert.deepEqual(rows.slice(-2).map(row => row[COLUMN.CLOSED]), ['—', '—']);
  assert.deepEqual(rows.slice(-2).map(row => row[COLUMN.DURATION]), ['—', '—']);
});

test('a CLOSED list that failed to load fills the history table with the reason, not an empty table', () => {
  const reason = 'Closed positions failed to load';
  render([], { closedGap: reason });
  const rows = el('positionsHistoryBody').children;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].children[0].textContent, reason);
});

test('fills holding a closed trade no listed position owns put the reason above the listed rows', () => {
  const reason = `${window.RiskMetrics.INCOMPLETE_CAUSE.UNLISTED_TRADE} in SOL-USD`;
  render([closedPosition()], { unlistedTradeGap: reason });
  const rows = el('positionsHistoryBody').children;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].children[0].textContent, reason);
  assert.equal(rows[1].children[COLUMN.PROFIT].textContent, '+$25', 'a listed row keeps its own figures');
});

test('without fills, Taker Share and the blanked board cells carry the fills reason', () => {
  const reason = 'Fills failed to load';
  render([closedPosition({ complete: false, incompleteCause: 'No matching fills' })], { fillsGap: reason }, []);
  assert.equal(el('positionsTakerShare').textContent, '—');
  assert.equal(el('positionsTakerShareDetail').textContent, reason);
  const [row] = el('positionsHistoryBody').children;
  for (const column of [COLUMN.SIZE, COLUMN.ENTRY, COLUMN.EXIT, COLUMN.PROFIT]) {
    assert.equal(row.children[column].textContent, '—');
    assert.equal(row.children[column].title, reason);
  }
});

test('an incomplete row names its own cause on the blanked cells', () => {
  const cause = window.RiskMetrics.INCOMPLETE_CAUSE.UNLISTED_TRADE;
  render([closedPosition({ complete: false, incompleteCause: cause })]);
  const [row] = el('positionsHistoryBody').children;
  assert.equal(row.children[COLUMN.PROFIT].textContent, '—');
  assert.equal(row.children[COLUMN.PROFIT].title, cause);
  assert.equal(el('positionsTakerShare').textContent, '50.0%');
  assert.equal(el('positionsTakerShareDetail').textContent, 'Taker fills ÷ all fills, by count');
});

test('Taker Share rounds like every percent on screen: 3 taker fills of 2000 are 0.2%', () => {
  const TOTAL = 2000, TAKER = 3;
  const fills = Array.from({ length: TOTAL }, (_, i) => ({ liquidity: i < TAKER ? 'TAKER' : 'MAKER' }));
  render([closedPosition()], {}, fills);
  assert.equal(el('positionsTakerShare').textContent, window.Format.formatPercent((TAKER / TOTAL) * 100));
  assert.equal(el('positionsTakerShare').textContent, '0.2%');
});

test('Taker Share reads — while a fill has no TAKER or MAKER liquidity flag, never counting it as a maker fill', () => {
  render([closedPosition()], {}, [{ liquidity: 'TAKER' }, { liquidity: undefined }, {}, { liquidity: 'MAKER' }]);
  assert.equal(el('positionsTakerShare').textContent, '—');
  assert.equal(el('positionsTakerShareDetail').textContent, '2 fills without a liquidity flag');
  render([closedPosition()], {}, [{ liquidity: 'TAKER' }, { liquidity: 'taker' }]);
  assert.equal(el('positionsTakerShare').textContent, '—');
  assert.equal(el('positionsTakerShareDetail').textContent, '1 fill without a liquidity flag');
});

test('a 9.80 gain less 0.30 of fees reads +$10 on the board: the decimal tie survives the attribution and the formatter together', () => {
  const position = {
    market: 'ETH-USD', side: 'LONG', status: 'CLOSED',
    createdAt: '2025-03-01T00:00:00.000Z', closedAt: '2025-03-01T02:00:00.000Z', netFunding: '0',
  };
  const fill = (createdAt, side, price, fee) => ({
    market: 'ETH-USD', createdAt, side, size: '1', price, fee, liquidity: 'TAKER',
  });
  const fills = [
    fill('2025-03-01T00:00:00.000Z', 'BUY', '100', '0.2'),
    fill('2025-03-01T02:00:00.000Z', 'SELL', '109.8', '0.1'),
  ];
  const attributed = { ...position, ...window.RiskMetrics.attributeFillsToPositions([position], fills).get(position) };
  render([attributed], {}, fills);
  assert.equal(rowTexts('positionsHistoryBody')[0][COLUMN.PROFIT], '+$10');
});

test('PROFIT % and SIZE read the exact peak held: 10000 fills of 0.0003 BTC are 3 BTC, and 3.015 on $300 is +1.01%', () => {
  const FILL_COUNT = 10000;
  const position = {
    market: 'BTC-USD', side: 'LONG', status: 'CLOSED',
    createdAt: '2025-03-01T00:00:00.000Z', closedAt: '2025-03-01T02:00:00.000Z', netFunding: '0',
  };
  const fill = (createdAt, side, size, price) => ({
    market: 'BTC-USD', createdAt, side, size, price, fee: '0', liquidity: 'TAKER',
  });
  const fills = Array.from({ length: FILL_COUNT }, () => fill('2025-03-01T00:00:00.000Z', 'BUY', '0.0003', '100'));
  fills.push(fill('2025-03-01T02:00:00.000Z', 'SELL', '3', '101.005'));
  const attributed = { ...position, ...window.RiskMetrics.attributeFillsToPositions([position], fills).get(position) };
  render([attributed], {}, fills);
  const [row] = rowTexts('positionsHistoryBody');
  assert.equal(row[COLUMN.SIZE], '3 BTC');
  assert.equal(row[COLUMN.PROFIT_PCT], '+1.01%');
});

// Positions with their fill attribution, as processData hands them to the board.
function attributed(positions, fills) {
  const attribution = window.RiskMetrics.attributeFillsToPositions(positions, fills);
  return positions.map(p => ({ ...p, ...attribution.get(p) }));
}

const chainFill = (market, createdAt, height, side, size, price) => ({
  market, createdAt, createdAtHeight: String(height), side, size: String(size), price: String(price), fee: '0', liquidity: 'TAKER',
});

test('closes in one millisecond list newest first in chain order, whatever order the indexer lists them in', () => {
  const OPEN_BTC = '2025-07-01T00:00:00.000Z', OPEN_ETH = '2025-07-01T01:00:00.000Z', CLOSE = '2025-07-01T02:00:00.000Z';
  // Cross-market: in the closing block ETH's close comes first and BTC's last.
  const crossFills = [
    chainFill('BTC-USD', OPEN_BTC, 10, 'BUY', 1, 100),
    chainFill('ETH-USD', OPEN_ETH, 20, 'BUY', 1, 50),
    chainFill('ETH-USD', CLOSE, 30, 'SELL', 1, 40),
    chainFill('BTC-USD', CLOSE, 30, 'SELL', 1, 120),
  ];
  const btc = { market: 'BTC-USD', side: 'LONG', status: 'CLOSED', createdAt: OPEN_BTC, closedAt: CLOSE, netFunding: '0' };
  const eth = { market: 'ETH-USD', side: 'LONG', status: 'CLOSED', createdAt: OPEN_ETH, closedAt: CLOSE, netFunding: '0' };
  [[eth, btc], [btc, eth]].forEach(listed => {
    render(attributed(listed, crossFills), {}, crossFills);
    assert.deepEqual(rowTexts('positionsHistoryBody').map(row => row[COLUMN.PROFIT]), ['+$20', '-$10'],
      `listed ${listed.map(p => p.market)}`);
  });

  // A reversal pair: LONG reversed by a SELL 2 at CLOSE, the SHORT it opens closed by a BUY 1 at CLOSE.
  const flipFills = [
    chainFill('BTC-USD', OPEN_BTC, 10, 'BUY', 1, 100),
    chainFill('BTC-USD', CLOSE, 30, 'SELL', 2, 110),
    chainFill('BTC-USD', CLOSE, 30, 'BUY', 1, 105),
  ];
  const long = { market: 'BTC-USD', side: 'LONG', status: 'CLOSED', createdAt: OPEN_BTC, closedAt: CLOSE, netFunding: '0' };
  const short = { market: 'BTC-USD', side: 'SHORT', status: 'CLOSED', createdAt: CLOSE, closedAt: CLOSE, netFunding: '0' };
  [[long, short], [short, long]].forEach(listed => {
    render(attributed(listed, flipFills), {}, flipFills);
    assert.deepEqual(rowTexts('positionsHistoryBody').map(row => row[COLUMN.PROFIT]), ['+$5', '+$10'],
      `listed ${listed.map(p => p.side)}`);
  });
});
