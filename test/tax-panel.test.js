'use strict';

// The Tax tab panel (src/panels/tax.js) rendered through its public
// entries with the real constants, Format, AppDom, RiskMetrics, TaxReport
// and FxRates modules. Stand-ins only for what is external to the page:
// a minimal DOM, localStorage and the FX provider's HTTP responses.

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
    this.style = {};
    this.attributes = {};
    this.value = '';
    this.selected = false;
  }
  get classList() {
    const el = this;
    const list = () => el.className.split(/\s+/).filter(Boolean);
    return {
      add: (...names) => { el.className = [...new Set([...list(), ...names])].join(' '); },
      contains: (name) => list().includes(name),
    };
  }
  appendChild(child) { this.children.push(child); return child; }
  set innerHTML(_) { this.children = []; }
  get innerHTML() { return ''; }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  hasAttribute(k) { return k in this.attributes; }
  addEventListener() {}
  closest() { return null; }
  querySelectorAll() { return []; }
}

class FakeSelect extends FakeElement {
  get value() {
    const chosen = this.children.find(o => o.selected) || this.children[0];
    return chosen ? chosen.value : '';
  }
  set value(_) {}
}

const elements = new Map();
function el(id) {
  if (!elements.has(id)) {
    elements.set(id, id === 'taxYear' ? new FakeSelect('select', id) : new FakeElement('div', id));
  }
  return elements.get(id);
}

function makeLocalStorage() {
  const map = new Map();
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: k => { map.delete(k); },
    clear: () => map.clear(),
  };
}

// Frankfurter: the range request answers `quotes` (USD per EUR by date);
// every single-date request fails, so a date outside `quotes` stays
// missing.
let quotes = {};
globalThis.fetch = (url) => {
  if (!url.includes('..')) return Promise.reject(new Error('network'));
  const rates = {};
  Object.keys(quotes).forEach(d => { rates[d] = { USD: quotes[d] }; });
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ base: 'EUR', rates }) });
};

globalThis.window = globalThis;
globalThis.localStorage = makeLocalStorage();
globalThis.document = {
  getElementById: el,
  createElement: (tag) => new FakeElement(tag),
  querySelector: () => null,
  querySelectorAll: () => [],
};

require('../src/constants.js');
require('../src/format.js');
require('../src/dom.js');
require('../risk-metrics.js');
require('../fx-rates.js');
require('../tax-report.js');
require('../src/panels/tax.js');

const Tax = window.AppPanels.tax;
el('tax').className = 'tab-content active';

// Each render starts from an empty year select and no stored year, so a
// test sees the default (newest) year unless it names `year`.
async function renderTax(positions, fills, fxQuotes, fundingPayments = [], fundingGap = '', year = null) {
  quotes = fxQuotes;
  localStorage.clear();
  el('taxYear').innerHTML = '';
  if (year !== null) localStorage.setItem('taxSelectedYear', String(year));
  Tax.render(positions, fills, 'dydx1test', { dataGap: '', fundingPayments, fundingGap });
  await Tax.refresh();
}

const text = id => el(id).textContent;
const COLUMN = { CLOSED: 0, ENTRY: 4, FUNDING_USD: 7, NET_USD: 9, NET_EUR: 10 };
const TABLE_COLUMNS = 11;
const cellText = (row, column) => el('taxRowsBody').children[row].children[column].textContent;

function long(openDay, closeDay) {
  return {
    status: 'CLOSED', market: 'ETH-USD', side: 'LONG',
    createdAt: `2025-03-${openDay}T00:00:00Z`, closedAt: `2025-03-${closeDay}T00:00:00Z`
  };
}
const fill = (day, side, size, price, fee) =>
  ({ market: 'ETH-USD', side, createdAt: `2025-03-${day}T00:00:00Z`, size, price, fee });
const payment = (day, amount) =>
  ({ ticker: 'ETH-USD', side: 'LONG', createdAt: `2025-03-${day}T08:00:00Z`, payment: amount });

// A winner opened 03-10, closed 03-11 and a loser opened 03-20, closed
// 03-21, each paying funding on its opening day.
const WIN = long('10', '11');
const LOSS = long('20', '21');
const WIN_LOSS_FILLS = [
  fill('10', 'BUY', '1', '1000', '1'), fill('11', 'SELL', '1', '1100', '1'),
  fill('20', 'BUY', '1', '1000', '1'), fill('21', 'SELL', '1', '950', '1')
];
const WIN_LOSS_PAYMENTS = [payment('10', '-5'), payment('20', '-3')];
const ALL_DATES = { '2025-03-10': 1.25, '2025-03-11': 1.25, '2025-03-20': 1.25, '2025-03-21': 1.25 };

test('every EUR total reads — when one row has no FX rate, with the reason on the Net EUR card', async () => {
  // The range answers only the LOSS dates; the WIN dates precede its
  // first business day and their single-date requests fail.
  await renderTax([WIN, LOSS], WIN_LOSS_FILLS, { '2025-03-20': 1.25, '2025-03-21': 1.25 }, WIN_LOSS_PAYMENTS);

  assert.equal(text('taxGrossGainsUsd'), '+$93.00');
  for (const id of ['taxNetEur', 'taxGrossGainsEur', 'taxGrossLossesEur', 'taxFeesEur', 'taxFundingEur']) {
    assert.equal(text(id), '—', id);
  }
  assert.match(text('taxNetEurDetail'), /1 row missing FX/);
  assert.equal(cellText(0, COLUMN.NET_EUR), '-€44.00', 'the converted row still shows its own EUR');
  assert.equal(cellText(1, COLUMN.NET_EUR), '—');
});

test('the Funding EUR card of a year whose every row converted reads its total, though no row\'s fills are complete', async () => {
  // WIN's closing fill is missing: its attribution is incomplete.
  await renderTax([WIN], WIN_LOSS_FILLS.slice(0, 1), ALL_DATES, [payment('10', '-5')]);
  assert.equal(text('taxFundingEur'), '-€4.00');
});

test('with every rate present, EUR totals convert as USD / ECB quote', async () => {
  await renderTax([WIN, LOSS], WIN_LOSS_FILLS, ALL_DATES, WIN_LOSS_PAYMENTS);

  // Nets +93 and -55 USD at 1.25 USD per EUR.
  assert.equal(text('taxNetEur'), '+€30.40');
  assert.equal(text('taxGrossLossesEur'), '-€44.00');
  assert.equal(text('taxNetEurDetail'), 'ECB daily rate of each event\'s date');
});

test('NET EUR converts each fill and payment at its own date\'s quote, not the close date\'s', async () => {
  // WIN: opening fee 1 and funding -5 on 03-10 at 1.0; realized 100 and
  // fee 1 on 03-11 at 1.25: (-1 - 5) / 1.0 + (100 - 1) / 1.25 = 73.20.
  await renderTax([WIN], WIN_LOSS_FILLS.slice(0, 2), { '2025-03-10': 1.0, '2025-03-11': 1.25 }, [payment('10', '-5')]);

  assert.equal(cellText(0, COLUMN.NET_EUR), '+€73.20');
});

test('the W / L / S split says it buckets by net including funding', async () => {
  await renderTax([WIN, LOSS], WIN_LOSS_FILLS, ALL_DATES, WIN_LOSS_PAYMENTS);

  assert.equal(text('taxTradeBreakdown'), '1W / 1L / 0S by net incl. funding');
});

test('funding payments that failed to load read — for funding, net and the year totals, never $0', async () => {
  await renderTax([WIN, LOSS], WIN_LOSS_FILLS, ALL_DATES, null, 'Funding payments failed to load');

  assert.equal(cellText(0, COLUMN.FUNDING_USD), '—');
  assert.equal(cellText(0, COLUMN.NET_USD), '—');
  assert.match(cellText(0, COLUMN.CLOSED), /†$/);
  assert.match(el('taxRowsBody').children[0].children[COLUMN.CLOSED].title, /Funding payments failed to load/);
  for (const id of ['taxFundingUsd', 'taxNetUsd', 'taxGrossGainsUsd', 'taxGrossLossesUsd', 'taxTradeBreakdown']) {
    assert.equal(text(id), '—', id);
  }
  assert.match(text('taxNetUsdDetail'), /2 rows missing funding/);
  assert.match(text('taxStatus'), /2 rows missing funding/);
});

test('a payment a closed position without a valid close time could hold reads — on every row that could hold it, with why', async () => {
  const undated = { ...WIN, closedAt: '' };
  await renderTax([undated, LOSS], WIN_LOSS_FILLS, ALL_DATES, [payment('20', '-3')]);

  const reason = /A funding payment cannot be placed: a closed position has no valid close time/;
  for (const row of [0, 1]) {
    assert.equal(cellText(row, COLUMN.FUNDING_USD), '—', `row ${row}`);
    assert.match(cellText(row, COLUMN.CLOSED), /†$/, `row ${row}`);
    assert.match(el('taxRowsBody').children[row].children[COLUMN.CLOSED].title, reason, `row ${row}`);
  }
  assert.match(text('taxWarningStrip'), reason);
  assert.doesNotMatch(text('taxWarningStrip'), /no parseable amount/);
});

test('an open position with a partial close in the year reads open in the CLOSED column', async () => {
  const open = { status: 'OPEN', market: 'ETH-USD', side: 'LONG', size: '1', createdAt: '2025-03-10T00:00:00Z', closedAt: null };
  const fills = [fill('10', 'BUY', '2', '1000', '0'), fill('11', 'SELL', '1', '1100', '0')];
  await renderTax([open], fills, { '2025-03-10': 1.25, '2025-03-11': 1.25 });

  assert.equal(cellText(0, COLUMN.CLOSED), 'open');
  assert.equal(cellText(0, COLUMN.NET_USD), '+$100.00');
  assert.equal(text('taxStatus'), 'Year 2025 · 0 closed positions · 1 open position');
});

test('a row of a position spanning years says its SIZE, ENTRY, EXIT and CLOSED are the whole position\'s, as an audit hint without a †', async () => {
  // LONG 2 opened 2025-12-30, half sold 2025-12-31, the rest 2026-01-02.
  const p = { status: 'CLOSED', market: 'ETH-USD', side: 'LONG', createdAt: '2025-12-30T00:00:00Z', closedAt: '2026-01-02T00:00:00Z' };
  const at = (date, side, size, price) => ({ market: 'ETH-USD', side, createdAt: `${date}T00:00:00Z`, size, price, fee: '0' });
  const fills = [at('2025-12-30', 'BUY', '2', '100'), at('2025-12-31', 'SELL', '1', '120'), at('2026-01-02', 'SELL', '1', '130')];
  await renderTax([p], fills, { '2025-12-30': 1.25, '2025-12-31': 1.25, '2026-01-02': 1.25 }, [], '', 2025);

  const dateCell = el('taxRowsBody').children[0].children[COLUMN.CLOSED];
  assert.equal(dateCell.textContent, '2026-01-02', 'an audit hint adds no †');
  assert.equal(el('taxYear').value, '2025');
  assert.equal(dateCell.title, "Position spans 2025–2026: SIZE (PEAK), ENTRY, EXIT and CLOSED are the whole position's; REALIZED, FEES and FUNDING hold only 2025's events.");
  assert.match(dateCell.attributes['aria-label'], /note: Position spans 2025–2026/);

  await renderTax([WIN], WIN_LOSS_FILLS.slice(0, 2), ALL_DATES);
  assert.equal(el('taxRowsBody').children[0].children[COLUMN.CLOSED].title, '', 'a one-year position carries no hint');
});

test('the CLOSED, SIZE (PEAK), ENTRY and EXIT headers say they are the whole position\'s across every year', () => {
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'index.html'), 'utf8');
  const tableEnd = html.indexOf('<tbody id="taxRowsBody">');
  const header = html.slice(html.lastIndexOf('<thead>', tableEnd), tableEnd);
  for (const label of ['CLOSED \\(UTC\\)', 'SIZE \\(PEAK\\)', 'ENTRY', 'EXIT']) {
    const th = header.match(new RegExp(`<th([^>]*)>${label}</th>`));
    assert.ok(th, label);
    assert.match(th[1], /title="[^"]*the whole position's[^"]*across every year/, label);
  }
});

test('the one classification is Categoria G derivatives, with the accountant note and no holding-days column', async () => {
  await renderTax([WIN], WIN_LOSS_FILLS.slice(0, 2), ALL_DATES, [payment('10', '-5')]);

  assert.equal(text('taxClassificationLabel'),
    'Categoria G — mais-valias, operações com instrumentos derivados (art. 10.º n.º 1 e) CIRS)');
  assert.equal(text('taxClassificationNote'), 'Flat rate (PT) · Confirm the classification with an accountant.');
  assert.equal(el('taxRowsBody').children[0].children.length, TABLE_COLUMNS);
});

test('ENTRY rounds a VWAP sitting on a 4-decimal tie half up, as the export carries it', async () => {
  // VWAP of 64012.1234 and 64012.1235 is 64012.12345; the double lies
  // just below it, so float toFixed(4) shows .1234.
  const p = { ...long('10', '11'), market: 'BTC-USD' };
  const btc = (day, side, size, price) => ({ ...fill(day, side, size, price, '0'), market: 'BTC-USD' });
  const fills = [btc('10', 'BUY', '1', '64012.1234'), btc('10', 'BUY', '1', '64012.1235'), btc('11', 'SELL', '2', '65000')];
  await renderTax([p], fills, { '2025-03-10': 1.25, '2025-03-11': 1.25 });

  assert.equal(cellText(0, COLUMN.ENTRY), '$64,012.1235');
});

// A LONG bought at 1000 with a 1500 fee and sold at 5000, paying 5 of
// funding: net 4000 − 1500 − 5 = +2495 USD, or +1996 EUR at 1.25.
const BIG_WIN_FILLS = [fill('10', 'BUY', '1', '1000', '1500'), fill('11', 'SELL', '1', '5000', '0')];
const COLUMN_FEES_USD = 8;

test('Tax money groups thousands at cents in USD and EUR, cells and cards alike', async () => {
  await renderTax([WIN], BIG_WIN_FILLS, ALL_DATES, [payment('10', '-5')]);

  assert.equal(cellText(0, COLUMN.NET_USD), '+$2,495.00');
  assert.equal(cellText(0, COLUMN.NET_EUR), '+€1,996.00');
  assert.equal(text('taxNetUsd'), '+$2,495.00');
  assert.equal(text('taxNetEur'), '+€1,996.00');
  assert.equal(text('taxGrossGainsEur'), '+€1,996.00');
});

test('Fees paid read unsigned (a cost), grouped, and a rebate keeps its minus sign', async () => {
  await renderTax([WIN], BIG_WIN_FILLS, ALL_DATES, [payment('10', '-5')]);
  assert.equal(cellText(0, COLUMN_FEES_USD), '$1,500.00');
  assert.equal(text('taxFeesUsd'), '$1,500.00');
  assert.equal(text('taxFeesEur'), '€1,200.00');

  const rebate = [fill('10', 'BUY', '1', '1000', '-2.5'), fill('11', 'SELL', '1', '1000', '0')];
  await renderTax([WIN], rebate, ALL_DATES, []);
  assert.equal(cellText(0, COLUMN_FEES_USD), '-$2.50');
  assert.equal(text('taxFeesUsd'), '-$2.50');
});

test('the signed cards take their colour from the sign they show at cents', async () => {
  await renderTax([WIN], BIG_WIN_FILLS, ALL_DATES, [payment('10', '-5')]);

  const tone = id => el(id).className.split(/\s+/).filter(c => ['profit', 'loss', 'zero'].includes(c)).join(' ');
  assert.equal(tone('taxNetUsd'), 'profit');
  assert.equal(tone('taxNetEur'), 'profit');
  assert.equal(tone('taxGrossGainsUsd'), 'profit');
  assert.equal(tone('taxGrossLossesUsd'), 'zero');
  assert.equal(tone('taxFundingUsd'), 'loss');
  assert.equal(tone('taxFeesUsd'), '', 'fees paid are a cost, not a signed figure');
});

async function atClock(iso, fn) {
  const realNow = Date.now;
  Date.now = () => Date.parse(iso);
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}

test('the current UTC year is marked year to date on the status line and the Net cards', async () => {
  await atClock('2025-06-01T00:00:00Z', () => renderTax([WIN, LOSS], WIN_LOSS_FILLS, ALL_DATES, WIN_LOSS_PAYMENTS));

  assert.match(text('taxStatus'), /^Year 2025 \(year to date\) · 2 closed positions/);
  assert.match(text('taxNetUsdDetail'), /year to date/);
  assert.match(text('taxNetEurDetail'), /year to date/);
});

test('a December snapshot shown after New Year still marks its year to date: the mark follows the snapshot, not the clock', async () => {
  await atClock('2026-01-05T00:00:00Z', async () => {
    quotes = ALL_DATES;
    localStorage.clear();
    el('taxYear').innerHTML = '';
    Tax.render([WIN, LOSS], WIN_LOSS_FILLS, 'dydx1test', {
      dataGap: '', fundingPayments: WIN_LOSS_PAYMENTS, fundingGap: '',
      snapshotAtMs: Date.parse('2025-12-20T00:00:00Z')
    });
    await Tax.refresh();
  });

  assert.match(text('taxStatus'), /^Year 2025 \(year to date\) · 2 closed positions/);
  assert.match(text('taxNetUsdDetail'), /year to date/);
  assert.match(text('taxNetEurDetail'), /year to date/);
});

test('a finished year carries no year-to-date mark', async () => {
  await atClock('2026-01-01T00:00:00Z', () => renderTax([WIN, LOSS], WIN_LOSS_FILLS, ALL_DATES, WIN_LOSS_PAYMENTS));

  assert.match(text('taxStatus'), /^Year 2025 · 2 closed positions/);
  assert.doesNotMatch(text('taxNetUsdDetail'), /year to date/);
  assert.doesNotMatch(text('taxNetEurDetail'), /year to date/);
});
