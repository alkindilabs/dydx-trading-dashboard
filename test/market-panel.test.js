'use strict';

// The Market tab panel (src/panels/market.js) rendered through its public
// entry, market.render(payments, marketsMap, gaps, fills, snapshotAtMs), with the real
// constants, RiskMetrics, Format, AppDom and funding-chart modules. Only the browser
// DOM (a minimal element shim), the clock and the indexer (DydxApi's
// network calls) are stand-ins.

const test = require('node:test');
const assert = require('node:assert/strict');

class FakeElement {
  constructor(tag, id) {
    this.tagName = String(tag).toUpperCase();
    this.id = id || '';
    this.children = [];
    this.textContent = '';
    this.title = '';
    this.className = '';
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.style = {};
    this.attributes = {};
  }
  get classList() {
    const el = this;
    const list = () => el.className.split(/\s+/).filter(Boolean);
    const set = (names) => { el.className = names.join(' '); };
    return {
      add: (...names) => set([...new Set([...list(), ...names])]),
      remove: (...names) => set(list().filter(n => !names.includes(n))),
      toggle: (name, on) => {
        const want = on === undefined ? !list().includes(name) : on;
        if (want) set([...new Set([...list(), name])]);
        else set(list().filter(n => n !== name));
      },
      contains: (name) => list().includes(name),
    };
  }
  appendChild(child) { this.children.push(child); return child; }
  set innerHTML(_) { this.children = []; }
  get innerHTML() { return ''; }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  hasAttribute(k) { return k in this.attributes; }
  closest() { return null; }
  querySelectorAll() { return []; }
  addEventListener() {}
  getContext() { return {}; }
}

const elements = new Map();
function el(id) {
  if (!elements.has(id)) elements.set(id, new FakeElement('div', id));
  return elements.get(id);
}

globalThis.window = globalThis;
globalThis.document = {
  getElementById: el,
  createElement: (tag) => new FakeElement(tag),
  querySelector: () => null,
  querySelectorAll: () => [],
};
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
};
globalThis.Chart = function () { this.destroy = () => {}; };

require('../src/constants.js');
require('../risk-metrics.js');
require('../src/format.js');
require('../src/dom.js');
require('../src/charts/funding-rate-chart.js');
require('../src/panels/market.js');

const { MS_PER_HOUR, HOURS_PER_YEAR, PERCENT } = window.AppConstants;
const Format = window.Format;
const Market = window.AppPanels.market;

const NOW = Date.parse('2026-11-14T08:01:00.000Z');
Date.now = () => NOW;
// Settlements land a fraction of a second after the hour.
const SETTLEMENT_LAG_MS = 144;
const LATEST_SETTLEMENT = Math.floor(NOW / MS_PER_HOUR) * MS_PER_HOUR + SETTLEMENT_LAG_MS;

// The indexer: every request DydxApi would send is answered here.
const indexerCalls = [];
let answerIndexer = () => Promise.resolve({ historicalFunding: [] });
// /historicalFunding walks (DydxApi.fetchHistoricalFunding): { ticker, maxRows }.
const historyCalls = [];
let answerHistory = () => Promise.resolve({ historicalFunding: [] });
window.DydxApi = {
  BASE: 'https://indexer.example/v4',
  fetchJsonWithRetry: (url) => { indexerCalls.push(url); return answerIndexer(url); },
  fetchHistoricalFunding: (ticker, opts) => {
    historyCalls.push({ ticker, maxRows: opts && opts.maxRows });
    return answerHistory(ticker, opts);
  },
  fetchCandles: () => Promise.resolve({ candles: [] }),
};

const flush = () => new Promise(resolve => setImmediate(resolve));

// market.render with a snapshot fetched at the clock's time, as after a
// fresh load; a test of an older snapshot passes its own time.
function render(payments, marketsMap, gaps, fills, snapshotAtMs = Date.now()) {
  Market.render(payments, marketsMap, gaps, fills, snapshotAtMs);
}

function payment(ticker, hoursAgo, amount, size, price) {
  return {
    ticker,
    createdAt: new Date(LATEST_SETTLEMENT - hoursAgo * MS_PER_HOUR).toISOString(),
    payment: String(amount),
    size: String(size),
    oraclePrice: String(price),
  };
}

// A fill `hoursAgo` hours before the latest settlement.
function fill(ticker, hoursAgo, side, size, price) {
  return {
    market: ticker,
    side,
    size: String(size),
    price: String(price),
    createdAt: new Date(LATEST_SETTLEMENT - hoursAgo * MS_PER_HOUR).toISOString(),
  };
}

// A /historicalFunding row: the market-wide settlement `hoursAgo` hours
// before the latest one, with its oracle price.
function settlement(ticker, hoursAgo, price) {
  return {
    ticker, rate: '0', price: String(price),
    effectiveAt: new Date(LATEST_SETTLEMENT - hoursAgo * MS_PER_HOUR).toISOString(),
  };
}

// Answers every /historicalFunding walk with the settlements of the last
// `hours` hours, each at priceAt(ticker, hoursAgo).
function historyOf(hours, priceAt) {
  return (ticker) => Promise.resolve({ historicalFunding:
    Array.from({ length: hours + 1 }, (_, h) => settlement(ticker, h, priceAt(ticker, h))) });
}

// Renders on the open Market tab and waits for the settlement walks: a
// position opened inside an hour without a payment row needs that hour's
// settlement (listed `hours` back, at priceAt) before its priced figures.
async function renderWithSettlements(pays, fills, hours, priceAt) {
  answerHistory = historyOf(hours, priceAt);
  setMarketTabActive(true);
  render(pays, DEFAULT_MARKETS, NO_GAPS, fills);
  await flush();
}

function market(ticker, nextFundingRate = '0') {
  return { ticker, nextFundingRate, defaultFundingRate1H: '0.0000125' };
}

const DEFAULT_MARKETS = {
  'BTC-USD': market('BTC-USD'), 'ETH-USD': market('ETH-USD'), 'SOL-USD': market('SOL-USD'),
};
const NO_GAPS = { payments: '', markets: '', fills: '' };

function useWindow(days) { store.set('fundingWindow', days); }
function setMarketTabActive(active) { el('market').classList.toggle('active', active); }

function tableRows() {
  return el('fundingAnalysisBody').children.map(tr => ({
    ticker: tr.children[0].textContent,
    cells: tr.children,
    text: tr.children.map(td => td.textContent),
  }));
}
const COL = { CURRENT: 1, PREDICTED: 2, RECEIVED: 3, PAID: 4, NET: 5, STATUS: 6 };

// '+$5.25' / '-$5,000.00' / '$0.00' → number.
function dollars(text) {
  const n = Number(text.replace(/[$+,]/g, ''));
  assert.ok(Number.isFinite(n), `not a dollar figure: ${text}`);
  return n;
}

test.beforeEach(() => {
  setMarketTabActive(false);
  indexerCalls.length = 0;
  answerIndexer = () => Promise.resolve({ historicalFunding: [] });
  historyCalls.length = 0;
  answerHistory = () => Promise.resolve({ historicalFunding: [] });
  Market.invalidateLiveCache();
});

// ---------------------------------------------------------------------------
// Hero: hours deployed, avg notional, time in market (two markets settling
// in the same hours are one deployed hour, not two)
// ---------------------------------------------------------------------------

test('two markets open through the same hours count each settlement hour once', async () => {
  useWindow('7');
  const HOURS_IN_WINDOW = 7 * 24;
  const settledHours = HOURS_IN_WINDOW - 1; // the oldest settlement falls before the cutoff
  const pays = [];
  for (let h = 0; h < settledHours; h++) {
    pays.push(payment('BTC-USD', h, -1, 1, 100000));
    pays.push(payment('ETH-USD', h, -1, 25, 4000));
  }
  const opened = settledHours - 0.5;
  const fills = [fill('BTC-USD', opened, 'BUY', 1, 100000), fill('ETH-USD', opened, 'BUY', 25, 4000)];
  await renderWithSettlements(pays, fills, HOURS_IN_WINDOW, ticker => (ticker === 'BTC-USD' ? 100000 : 4000));
  assert.equal(el('fundingHoursDeployed').textContent, `${settledHours} / ${HOURS_IN_WINDOW} h`);
  // $100k in each market every hour: the account held $200k per deployed hour.
  assert.equal(el('fundingAvgNotional').textContent, '$200,000');
  assert.equal(el('fundingTimeInMarket').textContent,
    Format.formatPercent(settledHours / HOURS_IN_WINDOW * 100));
});

test('time in market is the share of the window with a position, as a percent', () => {
  useWindow('7');
  const pays = [];
  for (let h = 0; h < 42; h++) pays.push(payment('BTC-USD', h, 1, 1, 100000));
  render(pays, DEFAULT_MARKETS, NO_GAPS, [fill('BTC-USD', 41.5, 'BUY', 1, 100000)]);
  assert.equal(el('fundingTimeInMarket').textContent, '25.0%');
});

const HOURS_IN_7D = 7 * 24;
const HERO_IDS = ['fundingApr', 'fundingPeriod', 'fundingAvgNotional',
  'fundingHoursDeployed', 'fundingHourlyRate', 'fundingTimeInMarket'];

test('a position held through settlements that moved no funding still counts those hours, at each settlement\'s oracle price', async () => {
  useWindow('7');
  const NOTIONAL = 100000;
  // The indexer writes no row for a settlement that moved no funding:
  // rows on every other hour only. The hours between are priced from
  // /historicalFunding, which lists every settlement.
  const pays = [];
  for (let h = 0; h <= HOURS_IN_7D; h += 2) pays.push(payment('BTC-USD', h, -1, 1, NOTIONAL));
  const opened = fill('BTC-USD', HOURS_IN_7D + 1.5, 'BUY', 1, 90000);
  answerHistory = historyOf(HOURS_IN_7D + 1, () => NOTIONAL);
  setMarketTabActive(true);
  render(pays, DEFAULT_MARKETS, NO_GAPS, [opened]);
  await flush();

  assert.equal(el('fundingHoursDeployed').textContent, `${HOURS_IN_7D} / ${HOURS_IN_7D} h`);
  assert.equal(el('fundingTimeInMarket').textContent, '100.0%');
  assert.equal(el('fundingAvgNotional').textContent, '$100,000');
  // −$84 (the 84 rows in the window) on $100k held for 168 hours.
  const rowsInWindow = HOURS_IN_7D / 2;
  const hourly = -rowsInWindow / (NOTIONAL * HOURS_IN_7D);
  assert.equal(Number((hourly * HOURS_PER_YEAR * PERCENT).toFixed(2)), -4.38);
  assert.equal(el('fundingApr').textContent, '-4.38%');
  assert.equal(el('fundingHourlyRate').textContent, '-0.0005%');
});

test('hours held without a funding row are priced at their settlement\'s oracle price, and hours after the position closes are not deployed', async () => {
  useWindow('30');
  const ORACLE = 3100;
  const fills = [fill('ETH-USD', 10.5, 'BUY', 2, 3000), fill('ETH-USD', 4.5, 'SELL', 2, 3200)];
  answerHistory = historyOf(20, () => ORACLE);
  setMarketTabActive(true);
  render([], DEFAULT_MARKETS, NO_GAPS, fills);
  await flush();
  // Settlements 10 … 5 hours ago fall inside the position: 2 ETH at the
  // oracle price, neither fill's.
  assert.equal(el('fundingHoursDeployed').textContent, '6 / 720 h');
  assert.equal(el('fundingAvgNotional').textContent, '$6,200');
  assert.equal(el('fundingApr').textContent, '0.00%');
  assert.equal(el('fundingTimeInMarket').textContent, '0.8%');
});

test('a reopened position is priced at its own settlements, never at a payment row an earlier position left', async () => {
  useWindow('7');
  // A 1 ETH position at $2,000 closed 500 hours ago; a new 1 ETH LONG
  // opened at $4,000 5.5 hours ago, paid -$1 in the last hour only.
  const fills = [fill('ETH-USD', 500.5, 'BUY', 1, 2000), fill('ETH-USD', 499.5, 'SELL', 1, 2000),
    fill('ETH-USD', 5.5, 'BUY', 1, 4000)];
  const pays = [payment('ETH-USD', 500, -1, 1, 2000), payment('ETH-USD', 0, -1, 1, 4000)];
  answerHistory = historyOf(10, () => 4000);
  setMarketTabActive(true);
  render(pays, DEFAULT_MARKETS, NO_GAPS, fills);
  await flush();
  assert.equal(el('fundingHoursDeployed').textContent, `6 / ${HOURS_IN_7D} h`);
  assert.equal(el('fundingAvgNotional').textContent, '$4,000');
  // −$1 on $4,000 held for 6 hours.
  assert.equal(el('fundingApr').textContent, Format.fmtSignedPct(-1 / (4000 * 6) * HOURS_PER_YEAR * PERCENT, 2));
  assert.equal(el('fundingApr').textContent, '-36.50%');
});

const ORACLE_PRICE_PATTERNS = {
  idle: /oracle prices load while this tab is open/i,
  loading: /fetching settlement oracle prices/i,
  failed: /oracle prices failed to load/i,
};

function heldWithoutRows() {
  return { pays: [payment('BTC-USD', 0, -1, 1, 100000)], fills: [fill('BTC-USD', 3.5, 'BUY', 1, 100000)] };
}

test('settlement oracle prices load only while the Market tab is open; until then the priced hero figures read — with the reason', () => {
  useWindow('7');
  const { pays, fills } = heldWithoutRows();
  render(pays, DEFAULT_MARKETS, NO_GAPS, fills);
  assert.equal(historyCalls.length, 0);
  for (const id of ['fundingApr', 'fundingAvgNotional', 'fundingHourlyRate']) assert.equal(el(id).textContent, '—', id);
  assert.match(el('fundingCaption').textContent, ORACLE_PRICE_PATTERNS.idle);
  assert.equal(el('fundingHoursDeployed').textContent, `4 / ${HOURS_IN_7D} h`);
});

test('while settlement oracle prices load, and after they fail, the priced hero figures read — with the reason', async () => {
  useWindow('7');
  const { pays, fills } = heldWithoutRows();
  let fail;
  answerHistory = () => new Promise((_, reject) => { fail = reject; });
  setMarketTabActive(true);
  render(pays, DEFAULT_MARKETS, NO_GAPS, fills);
  assert.ok(historyCalls.some(c => c.ticker === 'BTC-USD'), JSON.stringify(historyCalls));
  assert.equal(el('fundingApr').textContent, '—');
  assert.match(el('fundingCaption').textContent, ORACLE_PRICE_PATTERNS.loading);
  fail(new Error('HTTP 503'));
  await flush();
  assert.equal(el('fundingApr').textContent, '—');
  assert.match(el('fundingCaption').textContent, ORACLE_PRICE_PATTERNS.failed);
  assert.equal(el('fundingHoursDeployed').textContent, `4 / ${HOURS_IN_7D} h`);
});

test('a held hour /historicalFunding lists no settlement in was not settled, so it is not deployed', async () => {
  useWindow('7');
  const { pays, fills } = heldWithoutRows();
  // The chain settled nothing two hours ago (a halt); the hour before
  // that settled at a higher price, and the hour the position opened in
  // settled before it opened.
  answerHistory = (ticker) => Promise.resolve({ historicalFunding:
    [settlement(ticker, 0, 100000), settlement(ticker, 1, 100000), settlement(ticker, 3, 130000),
     settlement(ticker, 4, 130000)] });
  setMarketTabActive(true);
  render(pays, DEFAULT_MARKETS, NO_GAPS, fills);
  await flush();
  assert.equal(el('fundingHoursDeployed').textContent, `3 / ${HOURS_IN_7D} h`);
  assert.equal(el('fundingAvgNotional').textContent, '$110,000');
});

test('a held hour its market\'s loaded walk lists no settlement in stays out of the exposure while another market\'s walk fails', async () => {
  useWindow('7');
  // BTC is held at the settlements 10 to 1 hours ago, but its walk lists
  // none 5 hours ago (a halt): 9 held. ETH is held at the 3 settlements
  // 30 to 28 hours ago, and its walk fails.
  const UNSETTLED_HOURS_AGO = 5;
  const fills = [fill('BTC-USD', 10.5, 'BUY', 1, 60000), fill('BTC-USD', 0.5, 'SELL', 1, 60000),
    fill('ETH-USD', 30.5, 'BUY', 1, 3000), fill('ETH-USD', 27.5, 'SELL', 1, 3000)];
  const BTC_HELD = 9;
  const ETH_HELD = 3;
  answerHistory = (ticker) => (ticker === 'ETH-USD'
    ? Promise.reject(new Error('HTTP 503'))
    : historyOf(200, () => 60000)(ticker).then(page => ({ historicalFunding:
      page.historicalFunding.filter(r => r.effectiveAt !== settlement(ticker, UNSETTLED_HOURS_AGO, 0).effectiveAt) })));
  setMarketTabActive(true);
  render([], DEFAULT_MARKETS, NO_GAPS, fills);
  await flush();
  await flush();
  assert.match(el('fundingCaption').textContent, ORACLE_PRICE_PATTERNS.failed);
  assert.equal(el('fundingHoursDeployed').textContent, `${BTC_HELD + ETH_HELD} / ${HOURS_IN_7D} h`);
  assert.equal(el('fundingTimeInMarket').textContent, Format.formatPercent((BTC_HELD + ETH_HELD) / HOURS_IN_7D * PERCENT));
});

// A chain halt: the settlements due 5 and 4 hours ago land, one second
// apart, after the one 3 hours ago, inside its hour; every other
// settlement since 29 hours ago lands on its own hour. A BTC LONG of 1,
// opened 10.5 hours ago, is held through all 11 of them, in 9 distinct
// hours. Every settlement is at $100,000 unless `haltedPrices` gives the
// two halted ones prices of their own.
const CATCH_UP = { HALTED_HOURS_AGO: [5, 4], LANDED_HOURS_AGO: 3, SETTLEMENTS: 11, HOURS: 9, PRICE: 100000,
  DISTINCT_HALTED_PRICES: [90000, 80000] };
const CONSTANT_HALTED_PRICES = CATCH_UP.HALTED_HOURS_AGO.map(() => CATCH_UP.PRICE);
function catchUpInstant(hoursAgo) {
  const halted = CATCH_UP.HALTED_HOURS_AGO.indexOf(hoursAgo);
  return halted < 0 ? LATEST_SETTLEMENT - hoursAgo * MS_PER_HOUR
    : LATEST_SETTLEMENT - CATCH_UP.LANDED_HOURS_AGO * MS_PER_HOUR + (halted + 1) * window.AppConstants.MS_PER_SEC;
}
function catchUpPrice(hoursAgo, haltedPrices) {
  const halted = CATCH_UP.HALTED_HOURS_AGO.indexOf(hoursAgo);
  return halted < 0 ? CATCH_UP.PRICE : haltedPrices[halted];
}
function catchUpRow(hoursAgo, amount, lagMs = 0, haltedPrices = CONSTANT_HALTED_PRICES) {
  return { ...payment('BTC-USD', 0, amount, 1, catchUpPrice(hoursAgo, haltedPrices)),
    createdAt: new Date(catchUpInstant(hoursAgo) + lagMs).toISOString() };
}
async function renderCatchUp(pays, haltedPrices = CONSTANT_HALTED_PRICES) {
  useWindow('7');
  answerHistory = (ticker) => Promise.resolve({ historicalFunding: Array.from({ length: 30 }, (_, h) => (
    { ...settlement(ticker, h, catchUpPrice(h, haltedPrices)), effectiveAt: new Date(catchUpInstant(h)).toISOString() })) });
  setMarketTabActive(true);
  render(pays, DEFAULT_MARKETS, NO_GAPS, [fill('BTC-USD', 10.5, 'BUY', 1, CATCH_UP.PRICE)]);
  await flush();
}
function assertCatchUpHero(net, haltedPrices = CONSTANT_HALTED_PRICES) {
  const onTheHour = CATCH_UP.SETTLEMENTS - haltedPrices.length;
  const notionalHours = onTheHour * CATCH_UP.PRICE + haltedPrices.reduce((a, b) => a + b, 0);
  assert.equal(el('fundingHoursDeployed').textContent, `${CATCH_UP.HOURS} / ${HOURS_IN_7D} h`);
  assert.equal(el('fundingAvgNotional').textContent, Format.fmtNotional(notionalHours / CATCH_UP.SETTLEMENTS));
  assert.equal(el('fundingCaption').textContent,
    `-$${-net}.00 net on ${notionalHours.toLocaleString('en-US')} dollar·hours`);
  assert.equal(el('fundingApr').textContent, Format.fmtSignedPct(net / notionalHours * HOURS_PER_YEAR * PERCENT, 2));
}

test('settlements that land in one hour after a halt each count as exposure, without rows', async () => {
  await renderCatchUp([payment('BTC-USD', 1, -10, 1, CATCH_UP.PRICE)]);
  assertCatchUpHero(-10);
  assert.equal(el('fundingAvgNotional').textContent, '$100,000');
  assert.equal(el('fundingCaption').textContent, '-$10.00 net on 1,100,000 dollar·hours');
  assert.equal(el('fundingApr').textContent, '-7.96%');
});

test('settlements that land in one hour after a halt weigh alike with a row each: a constant position reads its own notional', async () => {
  // Each row written a moment after its settlement, later than the next
  // settlement: every row still pays a settlement of its own.
  const ROW_LAG_MS = 1500;
  const halted = [...CATCH_UP.HALTED_HOURS_AGO, CATCH_UP.LANDED_HOURS_AGO].map(h => catchUpRow(h, -10, ROW_LAG_MS));
  await renderCatchUp(halted.concat([payment('BTC-USD', 1, -10, 1, CATCH_UP.PRICE)]));
  assertCatchUpHero(-40);
  assert.equal(el('fundingAvgNotional').textContent, '$100,000');
});

// The halted settlements carry prices of their own, so the hero tells
// which one a row paid: the row's settlement leaves the fills' exposure
// and the other keeps its own price, whichever of the two the row is for.
for (const rowHoursAgo of CATCH_UP.HALTED_HOURS_AGO) {
  test(`a row for the settlement due ${rowHoursAgo} hours ago, landing in one hour with another, leaves the other priced at its own settlement`, async () => {
    const prices = CATCH_UP.DISTINCT_HALTED_PRICES;
    await renderCatchUp([catchUpRow(rowHoursAgo, -10, 0, prices), payment('BTC-USD', 1, -10, 1, CATCH_UP.PRICE)], prices);
    assertCatchUpHero(-20, prices);
  });
}

// A BTC LONG of 1 opened 10.5 hours ago, paying -$1 at the settlements 0
// and 1 hours ago only; every settlement since 19 hours ago is listed at
// $100,000 except the one `pricelessHoursAgo`, which has no price.
async function renderWithPricelessSettlement(pricelessHoursAgo, pricelessPrice = '') {
  useWindow('7');
  const pays = [payment('BTC-USD', 0, -1, 1, 100000), payment('BTC-USD', 1, -1, 1, 100000)];
  answerHistory = (ticker) => Promise.resolve({ historicalFunding: Array.from({ length: 20 }, (_, h) => {
    const row = settlement(ticker, h, 100000);
    if (h === pricelessHoursAgo) row.price = pricelessPrice;
    return row;
  }) });
  setMarketTabActive(true);
  render(pays, DEFAULT_MARKETS, NO_GAPS, [fill('BTC-USD', 10.5, 'BUY', 1, 100000)]);
  await flush();
}
const HELD_SETTLEMENTS = 11;

test('a held hour without a payment row whose listed settlement has no price stays deployed, its priced figures — with the reason', async () => {
  const PRICELESS_HOURS_AGO = 5;
  await renderWithPricelessSettlement(PRICELESS_HOURS_AGO);
  assert.equal(el('fundingHoursDeployed').textContent, `${HELD_SETTLEMENTS} / ${HOURS_IN_7D} h`);
  assert.equal(el('fundingTimeInMarket').textContent, Format.formatPercent(HELD_SETTLEMENTS / HOURS_IN_7D * PERCENT));
  for (const id of ['fundingApr', 'fundingAvgNotional', 'fundingHourlyRate']) assert.equal(el(id).textContent, '—', id);
  const hour = Math.floor((LATEST_SETTLEMENT - PRICELESS_HOURS_AGO * MS_PER_HOUR) / MS_PER_HOUR) * MS_PER_HOUR;
  assert.equal(el('fundingCaption').textContent,
    `BTC-USD settlement at ${Format.fmtDateTimeUTC(hour)} UTC has no oracle price`);
});

test('a settlement price that is not wholly numeric is no oracle price, never its leading digits', async () => {
  const PARTLY_NUMERIC_HOURS_AGO = 5;
  await renderWithPricelessSettlement(PARTLY_NUMERIC_HOURS_AGO, '100000zz');
  assert.equal(el('fundingHoursDeployed').textContent, `${HELD_SETTLEMENTS} / ${HOURS_IN_7D} h`);
  for (const id of ['fundingApr', 'fundingAvgNotional', 'fundingHourlyRate']) assert.equal(el(id).textContent, '—', id);
  const hour = Math.floor((LATEST_SETTLEMENT - PARTLY_NUMERIC_HOURS_AGO * MS_PER_HOUR) / MS_PER_HOUR) * MS_PER_HOUR;
  assert.equal(el('fundingCaption').textContent,
    `BTC-USD settlement at ${Format.fmtDateTimeUTC(hour)} UTC has no oracle price`);
});

test('a newest settlement without a price still ends the window at its hour', async () => {
  await renderWithPricelessSettlement(0);
  // The hour has a payment row, priced by the row itself.
  assert.equal(el('fundingHoursDeployed').textContent, `${HELD_SETTLEMENTS} / ${HOURS_IN_7D} h`);
  assert.equal(el('fundingNet').textContent, '-$2.00');
  assert.equal(el('fundingApr').textContent,
    Format.fmtSignedPct(-2 / (100000 * HELD_SETTLEMENTS) * HOURS_PER_YEAR * PERCENT, 2));
});

test('the hero and the chart share one /historicalFunding walk per market', async () => {
  useWindow('7');
  const { pays, fills } = heldWithoutRows();
  answerHistory = historyOf(10, () => 120000);
  setMarketTabActive(true);
  render(pays, DEFAULT_MARKETS, NO_GAPS, fills);
  await flush();
  assert.equal(historyCalls.filter(c => c.ticker === 'BTC-USD').length, 1, JSON.stringify(historyCalls));
  // The row's hour at its own $100,000; the three hours without a row at
  // the $120,000 settlements.
  assert.equal(el('fundingAvgNotional').textContent, '$115,000');
});

test('a settlement walk that stops short of the first held hour leaves the priced figures — with the reason, every held hour still deployed', async () => {
  useWindow('7');
  const { pays, fills } = heldWithoutRows();
  // Held through the settlements 3, 2 and 1 hours ago without a row; the
  // walk returned nothing older than an hour ago (it hit its page cap).
  answerHistory = (ticker) => Promise.resolve({ historicalFunding:
    [settlement(ticker, 0, 100000), settlement(ticker, 1, 100000)] });
  setMarketTabActive(true);
  render(pays, DEFAULT_MARKETS, NO_GAPS, fills);
  await flush();
  for (const id of ['fundingApr', 'fundingAvgNotional', 'fundingHourlyRate']) assert.equal(el(id).textContent, '—', id);
  assert.match(el('fundingCaption').textContent, /BTC-USD settlement history does not reach back to/);
  assert.equal(el('fundingHoursDeployed').textContent, `4 / ${HOURS_IN_7D} h`);
});

// A BTC LONG opened 10.5 hours ago and paying funding every hour since;
// `closed` adds the SELL that closed it 4.5 hours ago.
function btcLong({ closed }) {
  const pays = [];
  for (let h = closed ? 5 : 0; h <= 10; h++) pays.push(payment('BTC-USD', h, -1, 1, 100000));
  const fills = [fill('BTC-USD', 10.5, 'BUY', 1, 100000)];
  if (closed) fills.push(fill('BTC-USD', 4.5, 'SELL', 1, 100000));
  return { pays, fills };
}

test('a fill gap in a market the hero covers leaves every hero figure — with that reason', () => {
  useWindow('30');
  const reason = window.RiskMetrics.INCOMPLETE_CAUSE.OPEN_SIZE_MISMATCH;
  // The closing SELL is missing, so the fills hold BTC open to now.
  const { fills } = btcLong({ closed: false });
  const { pays } = btcLong({ closed: true });
  render(pays, DEFAULT_MARKETS, { ...NO_GAPS, fillsByMarket: new Map([['BTC-USD', reason]]) }, fills);
  for (const id of HERO_IDS) assert.equal(el(id).textContent, '—', id);
  assert.equal(el('fundingCaption').textContent, reason);
  assert.equal(el('fundingNet').textContent, '-$6.00', 'the cards still sum the payments');
});

test('a fill gap in a market the hero does not cover leaves the hero as it is', async () => {
  useWindow('30');
  const { pays, fills } = btcLong({ closed: true });
  const gaps = { ...NO_GAPS, fillsByMarket: new Map([['SOL-USD', 'Unlisted closed trade in SOL-USD']]) };
  answerHistory = historyOf(20, () => 100000);
  setMarketTabActive(true);
  render(pays, DEFAULT_MARKETS, gaps, fills);
  await flush();
  assert.equal(el('fundingHoursDeployed').textContent, '6 / 720 h');
  assert.equal(el('fundingAvgNotional').textContent, '$100,000');
});

// An incomplete position's window as processData passes it
// (gaps.incompleteWindows): open-ended while toMs is null.
function incompleteWindow(ticker, fromHoursAgo, toHoursAgo) {
  const at = hoursAgo => (hoursAgo === null ? null : LATEST_SETTLEMENT - hoursAgo * MS_PER_HOUR);
  return { market: ticker, fromMs: at(fromHoursAgo), toMs: at(toHoursAgo) };
}

test('an incomplete position whose window overlaps the hero\'s makes its market\'s fill gap count, though its fills show no hour held', () => {
  useWindow('7');
  const reason = 'No matching fills in BTC-USD';
  // A BTC LONG held 100 to 60 hours ago whose fills are missing, beside an
  // intact ETH position.
  const { pays, fills } = heldWithoutRows();
  const ethFills = fills.map(f => ({ ...f, market: 'ETH-USD' }));
  const ethPays = pays.map(p => ({ ...p, ticker: 'ETH-USD' }));
  const gaps = { ...NO_GAPS, fillsByMarket: new Map([['BTC-USD', reason]]),
    incompleteWindows: [incompleteWindow('BTC-USD', 100.5, 60.5)] };
  render(ethPays, DEFAULT_MARKETS, gaps, ethFills);
  for (const id of HERO_IDS) assert.equal(el(id).textContent, '—', id);
  assert.equal(el('fundingCaption').textContent, reason);

  // The same position closed before the window opened says nothing about
  // the hours in it.
  const before = { ...gaps, incompleteWindows: [incompleteWindow('BTC-USD', 400.5, 300.5)] };
  render(ethPays, DEFAULT_MARKETS, before, ethFills);
  assert.equal(el('fundingHoursDeployed').textContent, `4 / ${HOURS_IN_7D} h`);
});

// /historicalFunding settlements 0 … 10 hours ago, the one `driftHoursAgo`
// hours ago landing `driftMinutes` past its hour.
function historyWithDrift(driftHoursAgo, driftMinutes, price) {
  return (ticker) => Promise.resolve({ historicalFunding: Array.from({ length: 11 }, (_, h) => {
    const row = settlement(ticker, h, price);
    if (h !== driftHoursAgo) return row;
    return { ...row, effectiveAt: new Date(Date.parse(row.effectiveAt)
      + driftMinutes * window.AppConstants.MS_PER_MIN).toISOString() };
  }) });
}

// A fill at `minutes` past the hour `hoursAgo` hours before the latest
// settlement's hour.
function fillAt(ticker, hoursAgo, minutes, side, size, price) {
  return { ...fill(ticker, hoursAgo, side, size, price),
    createdAt: new Date(Math.floor(LATEST_SETTLEMENT / MS_PER_HOUR) * MS_PER_HOUR - hoursAgo * MS_PER_HOUR
      + minutes * window.AppConstants.MS_PER_MIN).toISOString() };
}

test('a held hour without a payment row is judged at its own settlement once the settlements load, not at the hour', async () => {
  useWindow('7');
  const DRIFT_MINUTES = 40;
  // A market the funding chart cannot select (it is not in the markets
  // map), so only the hero's own walk can price it.
  const TICKER = 'LINK-USD';
  answerHistory = historyWithDrift(5, DRIFT_MINUTES, 100000);
  setMarketTabActive(true);
  // Closed at :20 of the hour whose settlement came at :40: not held there.
  const closedBefore = [fillAt(TICKER, 8, 30, 'BUY', 1, 100000), fillAt(TICKER, 5, 20, 'SELL', 1, 100000)];
  render([], DEFAULT_MARKETS, NO_GAPS, closedBefore);
  assert.equal(el('fundingHoursDeployed').textContent, `3 / ${HOURS_IN_7D} h`, 'at the hour, before the settlements load');
  await flush();
  assert.equal(el('fundingHoursDeployed').textContent, `2 / ${HOURS_IN_7D} h`);
  assert.equal(el('fundingAvgNotional').textContent, '$100,000');

  // Opened at :10 of that hour: held at its :40 settlement and the next.
  Market.invalidateLiveCache();
  const openedBefore = [fillAt(TICKER, 5, 10, 'BUY', 1, 100000), fillAt(TICKER, 4, 30, 'SELL', 1, 100000)];
  render([], DEFAULT_MARKETS, NO_GAPS, openedBefore);
  assert.equal(el('fundingHoursDeployed').textContent, `1 / ${HOURS_IN_7D} h`, 'at the hour, before the settlements load');
  await flush();
  assert.equal(el('fundingHoursDeployed').textContent, `2 / ${HOURS_IN_7D} h`);
  assert.equal(el('fundingAvgNotional').textContent, '$100,000');
});

test('a window the account held nothing in reads 0 hours and 0.0% in the market, its rates — with the reason', () => {
  useWindow('7');
  const fills = [fill('BTC-USD', 400.5, 'BUY', 1, 100000), fill('BTC-USD', 399.5, 'SELL', 1, 100000)];
  render([payment('BTC-USD', 400, -1, 1, 100000)], DEFAULT_MARKETS, NO_GAPS, fills);
  assert.equal(el('fundingHoursDeployed').textContent, `0 / ${HOURS_IN_7D} h`);
  assert.equal(el('fundingTimeInMarket').textContent, '0.0%');
  for (const id of ['fundingApr', 'fundingAvgNotional', 'fundingHourlyRate', 'fundingPeriod']) {
    assert.equal(el(id).textContent, '—', id);
  }
  assert.equal(el('fundingCaption').textContent, 'No position held in the window');
});

test('the All window of an account that never held a position reads — with the reason', () => {
  useWindow('all');
  render([], DEFAULT_MARKETS, NO_GAPS, []);
  for (const id of HERO_IDS) assert.equal(el(id).textContent, '—', id);
  assert.equal(el('fundingCaption').textContent, 'No position held in the window');
});

test('the hero groups its dollar·hours and hour counts in thousands, like its dollar figures', async () => {
  useWindow('90');
  const HOURS_IN_90D = 90 * 24;
  const settledHours = HOURS_IN_90D - 1;
  const pays = [];
  for (let h = 0; h < settledHours; h++) pays.push(payment('BTC-USD', h, -1, 1, 100000));
  await renderWithSettlements(pays, [fill('BTC-USD', settledHours - 0.5, 'BUY', 1, 100000)], HOURS_IN_90D, () => 100000);
  assert.equal(el('fundingHoursDeployed').textContent, '2,159 / 2,160 h');
  assert.equal(el('fundingCaption').textContent, '-$2,159.00 net on 215,900,000 dollar·hours');
});

test('the hero caption reads its net at cents, as the Net Funding card does', async () => {
  useWindow('7');
  await renderWithSettlements([payment('BTC-USD', 0, -0.35, 12.5, 1.16)], [fill('BTC-USD', 0.5, 'BUY', 12.5, 1.16)],
    1, () => 1.16);
  assert.equal(el('fundingNet').textContent, '-$0.35');
  assert.equal(el('fundingCaption').textContent, '-$0.35 net on 15 dollar·hours');
});

test('the hero caption reads the Net Funding card\'s cents when several markets have funding', async () => {
  useWindow('7');
  // Each market's +$0.005 is +$0.01 at cents, so the card reads +$0.02;
  // the account's exact +$0.01 rounded once would read a cent short of it.
  const HALF_CENT = 0.005;
  const pays = [payment('BTC-USD', 0, HALF_CENT, 1, 100), payment('ETH-USD', 0, HALF_CENT, 1, 100)];
  const fills = [fill('BTC-USD', 0.5, 'BUY', 1, 100), fill('ETH-USD', 0.5, 'BUY', 1, 100)];
  await renderWithSettlements(pays, fills, 1, () => 100);
  assert.equal(el('fundingNet').textContent, '+$0.02');
  assert.equal(el('fundingCaption').textContent, '+$0.02 net on 200 dollar·hours');
});

test('the dollar·hours caption rounds as the Avg Notional beside it does', async () => {
  useWindow('7');
  // 12.5 × $1.16 is $14.50 for the one hour held; its float product sits
  // just below that.
  await renderWithSettlements([payment('BTC-USD', 0, -1, 12.5, 1.16)], [fill('BTC-USD', 0.5, 'BUY', 12.5, 1.16)],
    1, () => 1.16);
  assert.equal(el('fundingAvgNotional').textContent, '$15');
  assert.equal(el('fundingCaption').textContent, '-$1.00 net on 15 dollar·hours');
});

test('each held hour without a funding row is priced at its own settlement\'s oracle price', async () => {
  useWindow('30');
  const fills = [fill('ETH-USD', 10.5, 'BUY', 2, 3000), fill('ETH-USD', 4.5, 'SELL', 2, 3200)];
  answerHistory = historyOf(20, (_ticker, hoursAgo) => 3000 + 100 * hoursAgo);
  setMarketTabActive(true);
  render([], DEFAULT_MARKETS, NO_GAPS, fills);
  await flush();
  // 2 ETH through the settlements 10 … 5 hours ago, at $4,000 … $3,500:
  // 2 × $22,500 over 6 hours.
  assert.equal(el('fundingHoursDeployed').textContent, '6 / 720 h');
  assert.equal(el('fundingAvgNotional').textContent, '$7,500');
});

test('the All window counts the settlement hours from an hour before its first held one to the last, at any minute', () => {
  useWindow('all');
  const savedNow = Date.now;
  const pays = [payment('BTC-USD', 1, -1, 1, 100000), payment('BTC-USD', 0, -1, 1, 100000)];
  const fills = [fill('BTC-USD', 1.5, 'BUY', 1, 100000)];
  // Held at both settlements since it opened; the clock just after the
  // last one and just before the next.
  const MINUTES_PAST_SETTLEMENT = [1, 30, 59];
  try {
    for (const minutes of MINUTES_PAST_SETTLEMENT) {
      Date.now = () => Math.floor(NOW / MS_PER_HOUR) * MS_PER_HOUR + minutes * window.AppConstants.MS_PER_MIN;
      render(pays, DEFAULT_MARKETS, NO_GAPS, fills);
      assert.equal(el('fundingHoursDeployed').textContent, '2 / 2 h', `${minutes} min past the hour`);
      assert.equal(el('fundingTimeInMarket').textContent, '100.0%', `${minutes} min past the hour`);
    }
  } finally {
    Date.now = savedNow;
  }
});

test('time in market never reads above 100%', () => {
  useWindow('7');
  const savedNow = Date.now;
  // The cutoff lands between an hour's start and its settlement row, so
  // that row's hour sits in the window beside a full window of hours.
  const ROW_LAG_MS = 900;
  const CUTOFF_LAG_MS = 500;
  const firstHour = Math.floor(NOW / MS_PER_HOUR) * MS_PER_HOUR - HOURS_IN_7D * MS_PER_HOUR;
  const now = firstHour + CUTOFF_LAG_MS + HOURS_IN_7D * MS_PER_HOUR;
  Date.now = () => now;
  try {
    const pays = [];
    for (let h = 0; h < HOURS_IN_7D; h++) {
      pays.push({ ticker: 'BTC-USD', createdAt: new Date(firstHour + h * MS_PER_HOUR + ROW_LAG_MS).toISOString(),
                  payment: '-1', size: '1', oraclePrice: '100000' });
    }
    const opened = { market: 'BTC-USD', side: 'BUY', size: '1', price: '100000',
                     createdAt: new Date(firstHour - MS_PER_HOUR).toISOString() };
    render(pays, DEFAULT_MARKETS, NO_GAPS, [opened]);
    assert.equal(el('fundingTimeInMarket').textContent, '100.0%');
  } finally {
    Date.now = savedNow;
  }
});

// ---------------------------------------------------------------------------
// Window bounds: the snapshot's time, settlement hours by hour index
// ---------------------------------------------------------------------------

// A BTC LONG of 1 at $100,000 opened long before the 7D window.
const HELD_ALL_WEEK = [fill('BTC-USD', 400.5, 'BUY', 1, 100000)];
const BTC_NOTIONAL = 100000;

test('every window ends at the snapshot time, not at the clock: a snapshot 48 hours old reads the week it covers', async () => {
  useWindow('7');
  const SNAPSHOT_AGE_HOURS = 48;
  const savedNow = Date.now;
  // −$1 at every settlement up to the snapshot; the live settlement walk
  // lists every settlement up to the clock, 48 hours later.
  const pays = [];
  for (let h = 0; h <= HOURS_IN_7D + 50; h++) pays.push(payment('BTC-USD', h, -1, 1, BTC_NOTIONAL));
  answerHistory = (ticker) => Promise.resolve({ historicalFunding: Array.from(
    { length: SNAPSHOT_AGE_HOURS + HOURS_IN_7D + 100 },
    (_, i) => settlement(ticker, i - SNAPSHOT_AGE_HOURS, BTC_NOTIONAL)) });
  Date.now = () => NOW + SNAPSHOT_AGE_HOURS * MS_PER_HOUR;
  try {
    setMarketTabActive(true);
    render(pays, DEFAULT_MARKETS, NO_GAPS, HELD_ALL_WEEK, NOW);
    await flush();
    assert.equal(el('fundingHoursDeployed').textContent, `${HOURS_IN_7D} / ${HOURS_IN_7D} h`);
    assert.equal(el('fundingTimeInMarket').textContent, '100.0%');
    // −$168 on $100k held for 168 hours.
    assert.equal(el('fundingCaption').textContent, '-$168.00 net on 16,800,000 dollar·hours');
    assert.equal(el('fundingApr').textContent, '-8.76%');
    assert.equal(el('fundingNet').textContent, '-$168.00');
  } finally {
    Date.now = savedNow;
  }
});

test('a payment row whose settlement drifted past the cutoff belongs to the hour before the window, so held hours never exceed the window', () => {
  useWindow('7');
  const DRIFT_MS = 30 * window.AppConstants.MS_PER_MIN;
  // Rows at every settlement of the week, plus the settlement of the hour
  // the cutoff (08:01) falls in, which landed at 08:30, after the cutoff.
  const pays = [];
  for (let h = 0; h < HOURS_IN_7D; h++) pays.push(payment('BTC-USD', h, -1, 1, BTC_NOTIONAL));
  const drifted = payment('BTC-USD', HOURS_IN_7D, -1, 1, BTC_NOTIONAL);
  drifted.createdAt = new Date(Date.parse(drifted.createdAt) + DRIFT_MS).toISOString();
  pays.push(drifted);
  render(pays, DEFAULT_MARKETS, NO_GAPS, HELD_ALL_WEEK, NOW);
  assert.equal(el('fundingHoursDeployed').textContent, `${HOURS_IN_7D} / ${HOURS_IN_7D} h`);
  assert.equal(el('fundingTimeInMarket').textContent, '100.0%');
  // The cards and the table count the same rows the hero does.
  assert.equal(el('fundingNet').textContent, `-$${HOURS_IN_7D}.00`);
  assert.equal(tableRows().find(r => r.ticker === 'BTC-USD').cells[COL.NET].textContent, `-$${HOURS_IN_7D}.00`);
});

test('the window ends at the last settlement at or before the snapshot, so a position held at every settlement reads 100%', async () => {
  useWindow('7');
  const savedNow = Date.now;
  // The snapshot (and the clock) at 08:20; the 08:00 settlement has not
  // happened yet, so the walk lists none in that hour.
  const MINUTES_PAST_HOUR = 20;
  const snapshot = Math.floor(NOW / MS_PER_HOUR) * MS_PER_HOUR + MINUTES_PAST_HOUR * window.AppConstants.MS_PER_MIN;
  const pays = [];
  for (let h = 1; h < HOURS_IN_7D; h++) pays.push(payment('BTC-USD', h, -1, 1, BTC_NOTIONAL));
  answerHistory = (ticker) => Promise.resolve({ historicalFunding: Array.from(
    { length: HOURS_IN_7D }, (_, i) => settlement(ticker, i + 1, BTC_NOTIONAL)) });
  Date.now = () => snapshot;
  try {
    setMarketTabActive(true);
    render(pays, DEFAULT_MARKETS, NO_GAPS, HELD_ALL_WEEK, snapshot);
    await flush();
    // The window is the 168 settlement hours ending at 07:00: 167 with a
    // row and the oldest held without one, priced at its settlement.
    assert.equal(el('fundingHoursDeployed').textContent, `${HOURS_IN_7D} / ${HOURS_IN_7D} h`);
    assert.equal(el('fundingTimeInMarket').textContent, '100.0%');
  } finally {
    Date.now = savedNow;
  }
});

test('a fixed window holds its full span of settlement hours when the snapshot falls between an hour and its settlement', async () => {
  useWindow('7');
  const savedNow = Date.now;
  // The snapshot (and the clock) at 08:00:00.050, before the 08:00
  // settlement at 08:00:00.144: the window's last settlement is 07:00's,
  // and its first the one 7 days before that, though it landed 94 ms
  // after the snapshot's time 7 days earlier.
  const SNAPSHOT_PAST_HOUR_MS = 50;
  const snapshot = Math.floor(NOW / MS_PER_HOUR) * MS_PER_HOUR + SNAPSHOT_PAST_HOUR_MS;
  const ROW_PAYMENT = -0.01;
  const pays = [];
  for (let h = 1; h <= HOURS_IN_7D; h++) pays.push(payment('BTC-USD', h, ROW_PAYMENT, 1, BTC_NOTIONAL));
  answerHistory = (ticker) => Promise.resolve({ historicalFunding: Array.from(
    { length: HOURS_IN_7D + 1 }, (_, i) => settlement(ticker, i + 1, BTC_NOTIONAL)) });
  Date.now = () => snapshot;
  try {
    setMarketTabActive(true);
    render(pays, DEFAULT_MARKETS, NO_GAPS, HELD_ALL_WEEK, snapshot);
    await flush();
    assert.equal(el('fundingHoursDeployed').textContent, `${HOURS_IN_7D} / ${HOURS_IN_7D} h`);
    assert.equal(el('fundingPaid').textContent, '-$1.68');
    assert.equal(tableRows().find(r => r.ticker === 'BTC-USD').cells[COL.NET].textContent, '-$1.68');
  } finally {
    Date.now = savedNow;
  }
});

// A cache hydrate whose snapshot is 30 minutes into the hour before the
// latest settlement, its settlement walk requested 10 seconds before that
// settlement (so it lists none in the latest hour), then the fresh data,
// fetched 30 seconds after the settlement, holding its payment.
const HOUR_MARK = Math.floor(NOW / MS_PER_HOUR) * MS_PER_HOUR;
const ACROSS_HOUR_MARK = {
  HYDRATE_SNAPSHOT: HOUR_MARK - 30 * window.AppConstants.MS_PER_MIN,
  WALK_REQUESTED: HOUR_MARK - 10 * window.AppConstants.MS_PER_SEC,
  FRESH_SNAPSHOT: HOUR_MARK + 30 * window.AppConstants.MS_PER_SEC,
  NEWEST_PAYMENT: -100,
};
// Answers every walk with the settlements from `newestHoursAgo` back.
function settlementsFrom(newestHoursAgo) {
  return (ticker) => Promise.resolve({ historicalFunding: Array.from(
    { length: HOURS_IN_7D + 50 }, (_, i) => settlement(ticker, newestHoursAgo + i, BTC_NOTIONAL)) });
}

async function renderAcrossHourMark(olderPays) {
  const savedNow = Date.now;
  useWindow('7');
  setMarketTabActive(true);
  try {
    Date.now = () => ACROSS_HOUR_MARK.WALK_REQUESTED;
    answerHistory = settlementsFrom(1);
    render(olderPays, DEFAULT_MARKETS, NO_GAPS, HELD_ALL_WEEK, ACROSS_HOUR_MARK.HYDRATE_SNAPSHOT);
    await flush();
    const hydrateNet = el('fundingNet').textContent;
    Date.now = () => ACROSS_HOUR_MARK.FRESH_SNAPSHOT;
    answerHistory = settlementsFrom(0);
    const pays = [payment('BTC-USD', 0, ACROSS_HOUR_MARK.NEWEST_PAYMENT, 1, BTC_NOTIONAL), ...olderPays];
    render(pays, DEFAULT_MARKETS, NO_GAPS, HELD_ALL_WEEK, ACROSS_HOUR_MARK.FRESH_SNAPSHOT);
    await flush();
    return hydrateNet;
  } finally {
    Date.now = savedNow;
  }
}

test('a settlement walk requested before the snapshot never shows the snapshot\'s hour unsettled: the window ends at its settlement', async () => {
  // −$1 at every settlement of the week before the hour mark.
  const olderPays = [];
  for (let h = 1; h <= HOURS_IN_7D; h++) olderPays.push(payment('BTC-USD', h, -1, 1, BTC_NOTIONAL));
  const hydrateNet = await renderAcrossHourMark(olderPays);
  assert.equal(hydrateNet, Format.formatCents(-HOURS_IN_7D));
  // The window's 168 hours end at the latest settlement: its payment and
  // the 167 before it.
  const net = ACROSS_HOUR_MARK.NEWEST_PAYMENT - (HOURS_IN_7D - 1);
  assert.equal(el('fundingNet').textContent, Format.formatCents(net));
  assert.equal(el('fundingCaption').textContent,
    `${Format.formatCents(net)} net on 16,800,000 dollar·hours`);
  assert.equal(el('fundingHoursDeployed').textContent, `${HOURS_IN_7D} / ${HOURS_IN_7D} h`);
  assert.equal(tableRows().find(r => r.ticker === 'BTC-USD').cells[COL.NET].textContent, Format.formatCents(net));
});

test('the hero refetches a settlement walk requested before the snapshot rather than reuse it', async () => {
  // No row at the oldest settlement of the fresh window, so the hero
  // needs that hour's settlement from the walk.
  const olderPays = [];
  for (let h = 1; h < HOURS_IN_7D - 1; h++) olderPays.push(payment('BTC-USD', h, -1, 1, BTC_NOTIONAL));
  await renderAcrossHourMark(olderPays);
  const freshWalks = historyCalls.filter(c => c.ticker === 'BTC-USD');
  assert.ok(freshWalks.length >= 2, JSON.stringify(historyCalls));
  assert.equal(el('fundingHoursDeployed').textContent, `${HOURS_IN_7D} / ${HOURS_IN_7D} h`);
  const net = ACROSS_HOUR_MARK.NEWEST_PAYMENT - (HOURS_IN_7D - 2);
  assert.equal(el('fundingCaption').textContent,
    `${Format.formatCents(net)} net on 16,800,000 dollar·hours`);
});

test('a settlement walk requested before the snapshot that lands after a newer one never replaces it', async () => {
  const savedNow = Date.now;
  useWindow('7');
  setMarketTabActive(true);
  const olderPays = [];
  for (let h = 1; h < HOURS_IN_7D - 1; h++) olderPays.push(payment('BTC-USD', h, -1, 1, BTC_NOTIONAL));
  let landOlderWalk;
  try {
    Date.now = () => ACROSS_HOUR_MARK.WALK_REQUESTED;
    answerHistory = (ticker) => new Promise(resolve => { landOlderWalk = () => resolve(settlementsFrom(1)(ticker)); });
    render(olderPays, DEFAULT_MARKETS, NO_GAPS, HELD_ALL_WEEK, ACROSS_HOUR_MARK.HYDRATE_SNAPSHOT);
    Date.now = () => ACROSS_HOUR_MARK.FRESH_SNAPSHOT;
    answerHistory = settlementsFrom(0);
    const pays = [payment('BTC-USD', 0, ACROSS_HOUR_MARK.NEWEST_PAYMENT, 1, BTC_NOTIONAL), ...olderPays];
    render(pays, DEFAULT_MARKETS, NO_GAPS, HELD_ALL_WEEK, ACROSS_HOUR_MARK.FRESH_SNAPSHOT);
    await flush();
    landOlderWalk();
    await flush();
    const net = ACROSS_HOUR_MARK.NEWEST_PAYMENT - (HOURS_IN_7D - 2);
    assert.equal(el('fundingCaption').textContent,
      `${Format.formatCents(net)} net on 16,800,000 dollar·hours`);
  } finally {
    Date.now = savedNow;
  }
});

test('on a closed Market tab a settlement walk requested before the snapshot leaves the priced figures waiting for the tab, not an hour dropped', async () => {
  const savedNow = Date.now;
  useWindow('7');
  setMarketTabActive(true);
  // Rows at every settlement but the latest, which moved no funding.
  const pays = [];
  for (let h = 1; h < HOURS_IN_7D; h++) pays.push(payment('BTC-USD', h, -1, 1, BTC_NOTIONAL));
  try {
    Date.now = () => ACROSS_HOUR_MARK.WALK_REQUESTED;
    answerHistory = settlementsFrom(1);
    render(pays, DEFAULT_MARKETS, NO_GAPS, HELD_ALL_WEEK, ACROSS_HOUR_MARK.HYDRATE_SNAPSHOT);
    await flush();
    setMarketTabActive(false);
    Date.now = () => ACROSS_HOUR_MARK.FRESH_SNAPSHOT;
    answerHistory = settlementsFrom(0);
    render(pays, DEFAULT_MARKETS, NO_GAPS, HELD_ALL_WEEK, ACROSS_HOUR_MARK.FRESH_SNAPSHOT);
    await flush();
    assert.equal(el('fundingHoursDeployed').textContent, `${HOURS_IN_7D} / ${HOURS_IN_7D} h`);
    assert.equal(el('fundingApr').textContent, '—');
    assert.match(el('fundingCaption').textContent, ORACLE_PRICE_PATTERNS.idle);
    setMarketTabActive(true);
    Market.ensureLiveDataLoaded();
    await flush();
    assert.equal(el('fundingCaption').textContent,
      `${Format.formatCents(-(HOURS_IN_7D - 1))} net on 16,800,000 dollar·hours`);
  } finally {
    Date.now = savedNow;
  }
});

test('a position opened and closed inside one hour is judged at that hour\'s drifted settlement, its market\'s walk fetched for it', async () => {
  useWindow('7');
  const DRIFT_MINUTES = 40;
  const ORACLE = 4000;
  // A market the funding chart cannot select, so only the hero's own walk
  // can place the settlement: open at :10, settled at :40, closed at :50.
  const TICKER = 'LINK-USD';
  answerHistory = historyWithDrift(5, DRIFT_MINUTES, ORACLE);
  setMarketTabActive(true);
  const fills = [fillAt(TICKER, 5, 10, 'BUY', 1, ORACLE), fillAt(TICKER, 5, 50, 'SELL', 1, ORACLE)];
  render([], DEFAULT_MARKETS, NO_GAPS, fills, NOW);
  assert.ok(historyCalls.some(c => c.ticker === TICKER), JSON.stringify(historyCalls));
  await flush();
  assert.equal(el('fundingHoursDeployed').textContent, `1 / ${HOURS_IN_7D} h`);
  assert.equal(el('fundingAvgNotional').textContent, '$4,000');
});

test('a funding payment without a valid time is unknown funding in every window: its market, the cards and the hero\'s rates read — with the reason', () => {
  const reason = '1 funding payment without a valid time';
  const pays = [payment('BTC-USD', 0, -5, 1, BTC_NOTIONAL),
    { ...payment('BTC-USD', 1, -100, 1, BTC_NOTIONAL), createdAt: 'not a date' },
    payment('ETH-USD', 0, -2, 1, 4000)];
  const fills = [fill('BTC-USD', 0.5, 'BUY', 1, BTC_NOTIONAL), fill('ETH-USD', 0.5, 'BUY', 1, 4000)];
  for (const days of ['7', 'all']) {
    useWindow(days);
    render(pays, DEFAULT_MARKETS, NO_GAPS, fills, NOW);
    for (const id of ['fundingCaptured', 'fundingPaid', 'fundingNet']) assert.equal(el(id).textContent, '—', `${days}: ${id}`);
    for (const id of ['fundingCapturedWindow', 'fundingPaidWindow', 'fundingNetPct']) {
      assert.equal(el(id).textContent, reason, `${days}: ${id}`);
    }
    for (const id of ['fundingApr', 'fundingAvgNotional', 'fundingHourlyRate']) assert.equal(el(id).textContent, '—', `${days}: ${id}`);
    assert.equal(el('fundingCaption').textContent, reason, days);
    assert.notEqual(el('fundingHoursDeployed').textContent, '—', days);
    const btc = tableRows().find(r => r.ticker === 'BTC-USD');
    for (const col of [COL.RECEIVED, COL.PAID, COL.NET, COL.STATUS]) {
      assert.equal(btc.cells[col].textContent, '—', `${days}: column ${col}`);
      assert.equal(btc.cells[col].title, reason, `${days}: column ${col}`);
    }
    assert.equal(tableRows().find(r => r.ticker === 'ETH-USD').cells[COL.NET].textContent, '-$2.00', days);
  }
});

test('a funding row without a size or oracle price leaves the APR — with the reason, never a rate on part of the rows', () => {
  useWindow('7');
  const unpriced = payment('BTC-USD', 0, -1000, 1, 100000);
  delete unpriced.oraclePrice;
  const pays = [payment('BTC-USD', 1, -10, 1, 100000), unpriced];
  render(pays, DEFAULT_MARKETS, NO_GAPS, [fill('BTC-USD', 1.5, 'BUY', 1, 100000)]);
  for (const id of ['fundingApr', 'fundingHourlyRate', 'fundingAvgNotional']) {
    assert.equal(el(id).textContent, '—', id);
  }
  assert.match(el('fundingCaption').textContent, /size or oracle price/);
  assert.equal(el('fundingHoursDeployed').textContent, `2 / ${HOURS_IN_7D} h`);
  assert.ok(!/profit|loss/.test(el('fundingApr').className), el('fundingApr').className);
});

for (const [field, value] of [['size', '1x'], ['oraclePrice', '100000abc']]) {
  test(`a funding row whose ${field} is not wholly numeric ('${value}') leaves the APR — with the reason, never a rate on its leading digits`, () => {
    useWindow('7');
    const partlyNumeric = { ...payment('BTC-USD', 0, -1000, 1, 100000), [field]: value };
    const pays = [payment('BTC-USD', 1, -10, 1, 100000), partlyNumeric];
    render(pays, DEFAULT_MARKETS, NO_GAPS, [fill('BTC-USD', 1.5, 'BUY', 1, 100000)]);
    for (const id of ['fundingApr', 'fundingHourlyRate', 'fundingAvgNotional']) {
      assert.equal(el(id).textContent, '—', id);
    }
    assert.match(el('fundingCaption').textContent, /size or oracle price/);
    assert.equal(el('fundingHoursDeployed').textContent, `2 / ${HOURS_IN_7D} h`);
  });
}

test('a funding row of size 0 has no notional: it leaves the APR — with the reason, never a payment over no notional', () => {
  useWindow('7');
  const sizeless = { ...payment('BTC-USD', 0, -1000, 1, 100000), size: '0' };
  const pays = [payment('BTC-USD', 1, -10, 1, 100000), sizeless];
  render(pays, DEFAULT_MARKETS, NO_GAPS, [fill('BTC-USD', 1.5, 'BUY', 1, 100000)]);
  for (const id of ['fundingApr', 'fundingHourlyRate', 'fundingAvgNotional']) {
    assert.equal(el(id).textContent, '—', id);
  }
  assert.match(el('fundingCaption').textContent, /size or oracle price/);
  assert.equal(el('fundingHoursDeployed').textContent, `2 / ${HOURS_IN_7D} h`);
});

test('fills that did not load leave the hero — with the reason, while the cards still sum the payments', () => {
  useWindow('7');
  const reason = 'Fills failed to load';
  render([payment('BTC-USD', 1, -10, 1, 100000)], DEFAULT_MARKETS, { ...NO_GAPS, fills: reason }, null);
  for (const id of HERO_IDS) assert.equal(el(id).textContent, '—', id);
  assert.equal(el('fundingCaption').textContent, reason);
  assert.equal(el('fundingNet').textContent, '-$10.00');
});

test('a hero APR that displays as 0.00% is neutral, whatever its raw sign', async () => {
  useWindow('7');
  // −$0.0004 on $100k for one hour: about −0.0035% a year.
  await renderWithSettlements([payment('BTC-USD', 0, -0.0004, 1, 100000)], [fill('BTC-USD', 0.5, 'BUY', 1, 100000)],
    1, () => 100000);
  assert.equal(el('fundingApr').textContent, '0.00%');
  assert.ok(!/profit|loss/.test(el('fundingApr').className), el('fundingApr').className);
});

// ---------------------------------------------------------------------------
// Hero: period label
// ---------------------------------------------------------------------------

test('a funding period crossing a year boundary names both years, in UTC', () => {
  const tz = process.env.TZ;
  // UTC+14: a local-time label would read Jan 1 → Jan 3.
  process.env.TZ = 'Pacific/Kiritimati';
  try {
    useWindow('all');
    const start = Date.parse('2025-12-31T23:00:00.250Z');
    const end = Date.parse('2026-01-02T10:00:00.250Z');
    const at = (ms) => ({ ticker: 'BTC-USD', createdAt: new Date(ms).toISOString(), payment: '-1', size: '1', oraclePrice: '100000' });
    render([at(start), at(end)], DEFAULT_MARKETS, NO_GAPS);
    assert.equal(el('fundingPeriod').textContent, 'Dec 31, 2025 → Jan 2, 2026');
  } finally {
    if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz;
  }
});

test('a funding period inside one year leaves the year out', () => {
  useWindow('all');
  const at = (iso) => ({ ticker: 'BTC-USD', createdAt: iso, payment: '-1', size: '1', oraclePrice: '100000' });
  render([at('2026-06-15T10:00:00.250Z'), at('2026-09-28T11:00:00.250Z')], DEFAULT_MARKETS, NO_GAPS);
  assert.equal(el('fundingPeriod').textContent, 'Jun 15 → Sep 28');
});

// ---------------------------------------------------------------------------
// Hero: the APR's denominator is position notional, not account capital
// ---------------------------------------------------------------------------

test('the hero APR is labelled as a rate on position notional, with its definition on hover', () => {
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'index.html'), 'utf8');
  const suffix = html.match(/<div class="funding-hero__apr-suffix"([^>]*)>([^<]*)<\/div>/);
  assert.ok(suffix, 'the hero has an APR suffix');
  const [, attributes, text] = suffix;
  assert.equal(text, 'APR on position notional');
  assert.match(attributes, /title="[^"]*notional[^"]*"/);
});

// ---------------------------------------------------------------------------
// KPI cards: tone from the displayed value
// ---------------------------------------------------------------------------

test('funding cards take their tone from the value they display', () => {
  useWindow('30');
  render([payment('BTC-USD', 1, -40, 1, 100000)], DEFAULT_MARKETS, NO_GAPS);
  assert.equal(el('fundingNet').textContent, '-$40.00');
  assert.ok(el('fundingNet').classList.contains('loss'), el('fundingNet').className);
  assert.equal(el('fundingCaptured').textContent, '$0.00');
  assert.ok(el('fundingCaptured').classList.contains('zero'), el('fundingCaptured').className);
  assert.ok(!el('fundingCaptured').classList.contains('profit'), el('fundingCaptured').className);
  assert.ok(el('fundingPaid').classList.contains('loss'), el('fundingPaid').className);
});

// ---------------------------------------------------------------------------
// Missing /fundingPayments
// ---------------------------------------------------------------------------

test('funding payments that did not load read — with the reason, never $0', () => {
  useWindow('30');
  const reason = 'Funding payments failed to load';
  render(null, DEFAULT_MARKETS, { payments: reason, markets: '' });
  for (const id of ['fundingCaptured', 'fundingPaid', 'fundingNet']) {
    assert.equal(el(id).textContent, '—', id);
    assert.ok(!/profit|loss|zero/.test(el(id).className), `${id}: ${el(id).className}`);
  }
  for (const id of ['fundingCapturedWindow', 'fundingPaidWindow', 'fundingNetPct', 'fundingCaption']) {
    assert.equal(el(id).textContent, reason, id);
  }
  assert.equal(el('fundingApr').textContent, '—');
  const rows = tableRows();
  assert.ok(rows.length > 0);
  for (const row of rows) {
    for (const col of [COL.RECEIVED, COL.PAID, COL.NET, COL.STATUS]) {
      assert.equal(row.cells[col].textContent, '—', `${row.ticker} column ${col}`);
    }
    assert.equal(row.cells[COL.NET].title, reason);
  }
});

test('funding payments without a parseable amount are unknown, never $0: their market, the cards and the hero read — with the reason', () => {
  useWindow('7');
  const reason = '2 funding payments in the window without a parseable amount';
  const unparsed = (hoursAgo, amount) => ({ ...payment('BTC-USD', hoursAgo, 0, 1, 100000), payment: amount });
  const pays = [payment('BTC-USD', 2, 5, 1, 100000), unparsed(1, ''), unparsed(0, 'NaN'),
    payment('ETH-USD', 0, -2, 1, 4000)];
  render(pays, DEFAULT_MARKETS, NO_GAPS, [fill('BTC-USD', 2.5, 'BUY', 1, 100000), fill('ETH-USD', 0.5, 'BUY', 1, 4000)]);
  for (const id of ['fundingCaptured', 'fundingPaid', 'fundingNet']) assert.equal(el(id).textContent, '—', id);
  for (const id of ['fundingCapturedWindow', 'fundingPaidWindow', 'fundingNetPct']) assert.equal(el(id).textContent, reason, id);
  for (const id of ['fundingApr', 'fundingAvgNotional', 'fundingHourlyRate']) assert.equal(el(id).textContent, '—', id);
  assert.equal(el('fundingCaption').textContent, reason);
  assert.equal(el('fundingHoursDeployed').textContent, `3 / ${HOURS_IN_7D} h`);
  const btc = tableRows().find(r => r.ticker === 'BTC-USD');
  for (const col of [COL.RECEIVED, COL.PAID, COL.NET, COL.STATUS]) {
    assert.equal(btc.cells[col].textContent, '—', `column ${col}`);
    assert.equal(btc.cells[col].title, reason, `column ${col}`);
  }
  assert.equal(tableRows().find(r => r.ticker === 'ETH-USD').cells[COL.NET].textContent, '-$2.00');
});

// ---------------------------------------------------------------------------
// Funding table: every funded market, largest first, totals reconcile
// ---------------------------------------------------------------------------

test('the funding table lists funded markets by |net|, keeps unlisted ones, and reconciles to the card', () => {
  useWindow('30');
  const marketsMap = { ...DEFAULT_MARKETS };
  const pays = [];
  const FUNDED_MARKETS = 20;
  for (let i = 0; i < FUNDED_MARKETS; i++) {
    const t = `M${String(i).padStart(2, '0')}-USD`;
    marketsMap[t] = market(t);
    pays.push(payment(t, 5, -(i + 1), 1, 100));
  }
  // The largest loss sits in the last /perpetualMarkets key.
  marketsMap['ZZZ-USD'] = market('ZZZ-USD');
  pays.push(payment('ZZZ-USD', 5, -5000, 10, 1000));
  // A funded market /perpetualMarkets does not list.
  pays.push(payment('GONE-USD', 6, -700, 1, 100));
  render(pays, marketsMap, NO_GAPS);

  const rows = tableRows();
  assert.equal(rows[0].ticker, 'ZZZ-USD');
  assert.equal(rows[1].ticker, 'GONE-USD');
  const nets = rows.map(r => Math.abs(dollars(r.cells[COL.NET].textContent)));
  const fundedNets = nets.slice(0, rows.findIndex(r => /more markets/.test(r.ticker)));
  assert.deepEqual(fundedNets, [...fundedNets].sort((a, b) => b - a));

  const gone = rows.find(r => r.ticker === 'GONE-USD');
  assert.equal(gone.cells[COL.PREDICTED].textContent, '—');
  assert.match(gone.cells[COL.PREDICTED].title, /not listed/);

  const more = rows.find(r => /more markets/.test(r.ticker));
  assert.ok(more, `rows: ${rows.map(r => r.ticker).join(', ')}`);
  const tableNet = rows.reduce((s, r) => s + dollars(r.cells[COL.NET].textContent), 0);
  assert.equal(tableNet, dollars(el('fundingNet').textContent));
  const tableReceived = rows.reduce((s, r) => s + dollars(r.cells[COL.RECEIVED].textContent), 0);
  assert.equal(tableReceived, dollars(el('fundingCaptured').textContent));
});

test('the funding table shows cents, each row foots, and the columns sum to the cards as displayed', () => {
  useWindow('30');
  const pays = [
    payment('BTC-USD', 3, 10.506, 1, 100000),  // received $10.51
    payment('BTC-USD', 2, -20.004, 1, 100000), // paid $20.00: the raw net −9.498 would read −$9.50
    payment('ETH-USD', 2, -0.006, 1, 4000),
    payment('ETH-USD', 1, -0.006, 1, 4000),    // paid $0.01: the raw total paid 20.016 would read −$20.02
  ];
  render(pays, DEFAULT_MARKETS, NO_GAPS);
  const cents = (text) => Math.round(dollars(text) * 100);
  const rows = tableRows();
  const btc = rows.find(r => r.ticker === 'BTC-USD');
  // NET is the exact net −9.498 at cents; PAID is what foots to it.
  assert.deepEqual([COL.RECEIVED, COL.PAID, COL.NET].map(c => btc.cells[c].textContent),
    ['+$10.51', '-$20.01', '-$9.50']);
  for (const r of rows) {
    assert.equal(cents(r.cells[COL.RECEIVED].textContent) + cents(r.cells[COL.PAID].textContent),
      cents(r.cells[COL.NET].textContent), r.ticker);
  }
  const column = (col) => rows.reduce((s, r) => s + cents(r.cells[col].textContent), 0);
  assert.equal(column(COL.RECEIVED), cents(el('fundingCaptured').textContent));
  assert.equal(column(COL.PAID), cents(el('fundingPaid').textContent));
  assert.equal(column(COL.NET), cents(el('fundingNet').textContent));
  assert.equal(el('fundingPaid').textContent, '-$20.02');
  assert.equal(el('fundingNet').textContent, '-$9.51');
});

test('a market\'s NET is its exact net at cents, half away from zero, with PAID footing to it', () => {
  useWindow('30');
  // Exact received 1.005 and paid 2.005: net −1.000.
  render([payment('BTC-USD', 2, 1.005, 1, 100000), payment('BTC-USD', 1, -2.005, 1, 100000)],
    DEFAULT_MARKETS, NO_GAPS);
  const btc = tableRows().find(r => r.ticker === 'BTC-USD');
  assert.deepEqual([COL.RECEIVED, COL.PAID, COL.NET].map(c => btc.cells[c].textContent),
    ['+$1.01', '-$2.01', '-$1.00']);
  assert.deepEqual(['fundingCaptured', 'fundingPaid', 'fundingNet'].map(id => el(id).textContent),
    ['+$1.01', '-$2.01', '-$1.00']);
});

test('a market\'s funding NET reads the cent the profit ledger shows for the same funding', () => {
  useWindow('all');
  const RM = window.RiskMetrics;
  const amounts = [['BTC-USD', ['0.006', '-0.004']], ['ETH-USD', ['-0.125']], ['SOL-USD', ['0.013', '0.017', '0.975']]];
  const pays = [];
  const positions = [];
  amounts.forEach(([ticker, list]) => list.forEach((amount, i) => {
    pays.push(payment(ticker, i + 1, amount, 1, 100));
    positions.push({ market: ticker, status: 'CLOSED', realizedPnl: '0', netFunding: amount });
  }));
  render(pays, DEFAULT_MARKETS, NO_GAPS);
  const ledger = RM.profitLedger(RM.marketPnL(positions));
  for (const [ticker] of amounts) {
    const row = tableRows().find(r => r.ticker === ticker);
    assert.equal(row.cells[COL.NET].textContent, Format.formatCents(ledger.byMarket[ticker].netFunding), ticker);
  }
  assert.deepEqual(tableRows().filter(r => amounts.some(([t]) => t === r.ticker)).map(r => r.cells[COL.NET].textContent).sort(),
    ['$0.00', '+$1.01', '-$0.13'].sort());
  assert.equal(el('fundingNet').textContent, Format.formatCents(ledger.funding));
});

test('markets that did not load leave every funded row with its reason in the predicted column', () => {
  useWindow('30');
  const reason = 'Markets failed to load';
  render([payment('BTC-USD', 1, -3, 1, 100000)], {}, { payments: '', markets: reason });
  const btc = tableRows().find(r => r.ticker === 'BTC-USD');
  assert.ok(btc);
  assert.equal(btc.cells[COL.PREDICTED].textContent, '—');
  assert.equal(btc.cells[COL.PREDICTED].title, reason);
  assert.equal(btc.cells[COL.NET].textContent, '-$3.00');
});

for (const nextFundingRate of ['abc', '0.0000125xyz']) {
  test(`a predicted rate that is not wholly numeric ('${nextFundingRate}') reads — with the reason, never a hyphen or its leading digits`, () => {
    useWindow('30');
    render([payment('BTC-USD', 1, -3, 1, 100000)], { 'BTC-USD': market('BTC-USD', nextFundingRate) }, NO_GAPS);
    const cell = tableRows().find(r => r.ticker === 'BTC-USD').cells[COL.PREDICTED];
    assert.equal(cell.textContent, '—');
    assert.equal(cell.title, 'Predicted rate is not a number');
    assert.ok(!/profit|loss|zero/.test(cell.className), cell.className);
  });
}

// ---------------------------------------------------------------------------
// CURRENT (last settled) and PREDICTED (next) funding rates
// ---------------------------------------------------------------------------

const HISTORICAL_FUNDING_URL = /\/historicalFunding\/BTC-USD\?/;

test('PREDICTED is the indexer\'s next funding rate and CURRENT the last settled one', async () => {
  useWindow('30');
  const SETTLED_RATE = '0.00001';
  answerIndexer = (url) => Promise.resolve(HISTORICAL_FUNDING_URL.test(url)
    ? { historicalFunding: [
      { ticker: 'BTC-USD', rate: SETTLED_RATE, effectiveAt: new Date(LATEST_SETTLEMENT).toISOString() },
    ] }
    : { historicalFunding: [] });
  const NEXT_RATE = '-0.00000025';
  setMarketTabActive(true);
  render([], { 'BTC-USD': market('BTC-USD', NEXT_RATE) }, NO_GAPS);
  await flush();

  const btc = tableRows().find(r => r.ticker === 'BTC-USD');
  assert.equal(btc.cells[COL.PREDICTED].textContent, Format.formatFundingApr(NEXT_RATE));
  assert.ok(btc.cells[COL.PREDICTED].classList.contains('loss'), btc.cells[COL.PREDICTED].className);
  assert.equal(btc.cells[COL.CURRENT].textContent, Format.formatFundingApr(SETTLED_RATE));
  assert.ok(btc.cells[COL.CURRENT].classList.contains('profit'), btc.cells[COL.CURRENT].className);
  assert.ok(btc.cells[COL.CURRENT].title.includes(new Date(LATEST_SETTLEMENT).toISOString().slice(0, 16).replace('T', ' ')),
    btc.cells[COL.CURRENT].title);
});

test('the last settled rate is fetched only while the Market tab is open', async () => {
  useWindow('30');
  render([], DEFAULT_MARKETS, NO_GAPS);
  await flush();
  assert.equal(indexerCalls.length, 0);
  const btc = tableRows().find(r => r.ticker === 'BTC-USD');
  assert.equal(btc.cells[COL.CURRENT].textContent, '—');

  setMarketTabActive(true);
  answerIndexer = () => Promise.resolve({ historicalFunding: [
    { rate: '0.000002', effectiveAt: new Date(LATEST_SETTLEMENT).toISOString() },
  ] });
  Market.ensureLiveDataLoaded();
  await flush();
  assert.ok(indexerCalls.some(u => HISTORICAL_FUNDING_URL.test(u)), indexerCalls.join('\n'));
  const after = tableRows().find(r => r.ticker === 'BTC-USD');
  assert.equal(after.cells[COL.CURRENT].textContent, Format.formatFundingApr('0.000002'));
});

test('a last settled rate that fails to load reads — with the reason', async () => {
  useWindow('30');
  answerIndexer = () => Promise.reject(new Error('HTTP 503'));
  setMarketTabActive(true);
  render([], DEFAULT_MARKETS, NO_GAPS);
  await flush();
  const btc = tableRows().find(r => r.ticker === 'BTC-USD');
  assert.equal(btc.cells[COL.CURRENT].textContent, '—');
  assert.match(btc.cells[COL.CURRENT].title, /failed to load/);
});

test('the last settled rate is the newest settlement the indexer returns', async () => {
  useWindow('30');
  const older = new Date(LATEST_SETTLEMENT - MS_PER_HOUR).toISOString();
  const newest = new Date(LATEST_SETTLEMENT).toISOString();
  answerIndexer = () => Promise.resolve({ historicalFunding: [
    { rate: '-0.00003', effectiveAt: older },
    { rate: '0.00002', effectiveAt: newest },
  ] });
  setMarketTabActive(true);
  render([], DEFAULT_MARKETS, NO_GAPS);
  await flush();
  const btc = tableRows().find(r => r.ticker === 'BTC-USD');
  assert.equal(btc.cells[COL.CURRENT].textContent, Format.formatFundingApr('0.00002'));
});

test('a last settled rate that is not wholly numeric reads — with the reason, never its leading digits', async () => {
  useWindow('30');
  answerIndexer = () => Promise.resolve({ historicalFunding: [
    { rate: '0.0000125junk', effectiveAt: new Date(LATEST_SETTLEMENT).toISOString() },
  ] });
  setMarketTabActive(true);
  render([], DEFAULT_MARKETS, NO_GAPS);
  await flush();
  const cell = tableRows().find(r => r.ticker === 'BTC-USD').cells[COL.CURRENT];
  assert.equal(cell.textContent, '—');
  assert.equal(cell.title, 'Last settled rate is not a number');
});
