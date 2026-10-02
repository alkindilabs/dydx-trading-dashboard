'use strict';

// The Risk tab panel (src/panels/risk.js) rendered through its public
// entries with the real constants, Format, AppDom and RiskMetrics modules.
// Only the browser DOM is a stand-in (a minimal element shim).

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
  closest() { return null; }
  querySelectorAll() { return []; }
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
};

require('../src/constants.js');
require('../src/format.js');
require('../src/dom.js');
require('../risk-metrics.js');
require('../src/panels/risk.js');

const Risk = window.AppPanels.risk;
const { MS_PER_HOUR } = window.AppConstants;

const rowTexts = (bodyId) => el(bodyId).children.map(tr => tr.children.map(td => td.textContent));
const cell = (bodyId, row, column) => el(bodyId).children[row].children[column];

// ---------------------------------------------------------------------------
// VaR / Expected Shortfall cards.
// ---------------------------------------------------------------------------

const HOURLY = { label: 'hourly', ppy: 8766 };
const DAILY = { label: 'daily', ppy: 365.25 };

test('VaR and ES name the sampling horizon and read as losses at current equity', () => {
  // 5th-percentile return -0.005, worst-5% mean -0.008 (see historicalVaR).
  const returns = Array.from({ length: 100 }, (_, i) => (i - 10) / 1000);
  Risk.renderFromHistorical(returns, { equity: '200000' }, DAILY);

  assert.equal(el('var95').textContent, '-$1,000');
  assert.ok(el('var95').classList.contains('loss'));
  assert.equal(el('expectedShortfall').textContent, '-$1,600');
  assert.match(el('var95Detail').textContent, /^Daily\b/);
  assert.match(el('expectedShortfallDetail').textContent, /^Daily\b/);
  assert.match(el('var95').title, /daily/);
});

test('the VaR and ES tooltips state the band of sampling periods the sample keeps, both ways', () => {
  const returns = Array.from({ length: 100 }, (_, i) => (i - 10) / 1000);
  Risk.renderFromHistorical(returns, { equity: '200000' }, DAILY);
  const multiple = window.RiskMetrics.VAR_MAX_INTERVAL_MULTIPLE;
  const band = `Only returns over 1 ÷ ${multiple} to ${multiple} sampling periods are kept: a return over a longer gap or a shorter step is not a one-period outcome.`;
  for (const id of ['var95', 'expectedShortfall']) {
    assert.ok(el(id).title.endsWith(band), `${id}: ${el(id).title}`);
  }
});

test('a 5th-percentile gain reads as a $0 loss with a note, never as a green profit', () => {
  const returns = Array.from({ length: 40 }, (_, i) => (i + 1) / 1000);
  Risk.renderFromHistorical(returns, { equity: '100000' }, DAILY);

  for (const id of ['var95', 'expectedShortfall']) {
    assert.equal(el(id).textContent, '$0', id);
    assert.ok(!el(id).classList.contains('profit'), `${id} is not styled as a gain`);
  }
  assert.match(el('var95Detail').textContent, /no loss/i);
  assert.match(el('expectedShortfallDetail').textContent, /no loss/i);
});

test('a tail loss that displays as $0 takes the "no loss" caption its $0 card shows', () => {
  // The worst 5% average -0.003 on $100 of equity: a $0.30 loss, shown as $0.
  const returns = [...Array(5).fill(-0.003), ...Array(95).fill(0.001)];
  Risk.renderFromHistorical(returns, { equity: '100' }, DAILY);

  assert.equal(el('expectedShortfall').textContent, '$0');
  assert.equal(el('expectedShortfallDetail').textContent, 'Daily · no loss in worst 5%');
});

test('negative equity leaves VaR and ES — with the reason, never a sign-flipped gain', () => {
  const returns = Array.from({ length: 40 }, (_, i) => (i - 20) / 1000);
  Risk.renderFromHistorical(returns, { equity: '-50000' }, HOURLY);

  for (const id of ['var95', 'expectedShortfall']) {
    assert.equal(el(id).textContent, '—', id);
    assert.equal(el(id).title, 'Equity unavailable', id);
  }
});

test('VaR and ES read — with the span reason when 31 hourly one-period returns cover only about 31 hours', () => {
  const HOURS_IN_SAMPLE = 31;
  const returns = Array.from({ length: HOURS_IN_SAMPLE }, (_, i) => (i - 10) / 1000);
  Risk.renderFromHistorical(returns, { equity: '100000' }, HOURLY);

  for (const id of ['var95', 'expectedShortfall']) {
    assert.equal(el(id).textContent, '—', id);
    assert.equal(el(id).title, 'Need ≥1 month of valid data (have 0.0 months)', id);
  }
});

test('VaR and ES read — with the count when few returns span one sampling period, though the gate passes on all returns', () => {
  // 800 hourly rows on an empty account, then 800 daily rows on a funded
  // one losing 5% every 7th day: the median interval is an hour, so only
  // the one funded return over an hour is a one-period outcome.
  const RM = window.RiskMetrics;
  const EMPTY_HOURS = 800, FUNDED_DAYS = 800, LOSS_EVERY = 7, LOSS = -0.05, GAIN = 0.01;
  const rows = [];
  let t = Date.UTC(2024, 0, 1);
  for (let i = 0; i < EMPTY_HOURS; i++, t += MS_PER_HOUR) {
    rows.push({ createdAt: new Date(t).toISOString(), equity: '0', totalPnl: '0', netTransfers: '0' });
  }
  let equity = 100000, pnl = 0;
  for (let i = 0; i < FUNDED_DAYS; i++, t += 24 * MS_PER_HOUR) {
    if (i > 0) {
      const r = i % LOSS_EVERY === 0 ? LOSS : GAIN;
      pnl += equity * r;
      equity *= 1 + r;
    }
    rows.push({ createdAt: new Date(t).toISOString(), equity: String(equity), totalPnl: String(pnl),
      netTransfers: i === 0 ? String(equity) : '0' });
  }
  const all = RM.computeTimeWeightedReturnsFromHist(rows);
  assert.ok(RM.assessAdequacy(all, rows.map(r => r.createdAt), rows.length).adequate, 'the Sharpe gate passes');

  Risk.renderFromHistorical(RM.varSampleReturns(rows), { equity: String(equity) }, HOURLY);

  for (const id of ['var95', 'expectedShortfall']) {
    assert.equal(el(id).textContent, '—', id);
    assert.equal(el(id).title, 'Only 1 return spans one sampling period (need ≥30)', id);
  }
});

test('VaR and ES read — with the count when the rows turn from daily to hourly: an hour inside daily sampling is no one-period outcome', () => {
  // 29 daily rows then 27 hourly ones after a funded start: the median
  // interval is a day, and only the 29 daily returns span about one.
  const RM = window.RiskMetrics;
  const DAILY_ROWS = 29, HOURLY_ROWS = 27, EQUITY = 100000, DAILY_MOVE = 3000, HOURLY_MOVE = 100;
  const MS_PER_DAY = 24 * MS_PER_HOUR;
  let t = Date.UTC(2025, 0, 1), pnl = 0;
  const row = (netTransfers = '0') => ({ createdAt: new Date(t).toISOString(), equity: String(EQUITY + pnl),
    totalPnl: String(pnl), netTransfers });
  const rows = [row(String(EQUITY))];
  for (let i = 1; i <= DAILY_ROWS; i++) {
    t += MS_PER_DAY;
    pnl += i % 2 ? -DAILY_MOVE : DAILY_MOVE;
    rows.push(row());
  }
  for (let i = 1; i <= HOURLY_ROWS; i++) {
    t += MS_PER_HOUR;
    pnl += i % 2 ? -HOURLY_MOVE : HOURLY_MOVE;
    rows.push(row());
  }
  const all = RM.computeTimeWeightedReturnsFromHist(rows);
  const adequacy = RM.assessAdequacy(all, rows.map(r => r.createdAt), rows.length);
  assert.ok(adequacy.adequate, 'the Sharpe gate passes on all returns');
  assert.equal(Math.round(adequacy.ppy), Math.round(DAILY.ppy), 'the rows are sampled daily');

  Risk.renderFromHistorical(RM.varSampleReturns(rows), { equity: String(EQUITY) }, DAILY);

  for (const id of ['var95', 'expectedShortfall']) {
    assert.equal(el(id).textContent, '—', id);
    assert.equal(el(id).title, `Only ${DAILY_ROWS} returns span one sampling period (need ≥30)`, id);
  }
});

// ---------------------------------------------------------------------------
// Drawdown Periods table.
// ---------------------------------------------------------------------------

const hourly = (hour, totalPnl) => ({
  createdAt: new Date(Date.UTC(2025, 0, 1) + hour * MS_PER_HOUR).toISOString(),
  totalPnl: String(totalPnl),
  equity: '0',
  netTransfers: '0',
});

const DD = { DURATION: 2, TO_TROUGH: 3, RECOVERY: 4 };

// The Drawdown Periods title as index.html writes it, the text the panel
// counts its rows after.
const PERIODS_TITLE = require('node:fs')
  .readFileSync(require('node:path').join(__dirname, '..', 'index.html'), 'utf8')
  .match(/id="drawdownPeriodsTitle">([^<]*)</)[1];
el('drawdownPeriodsTitle').textContent = PERIODS_TITLE;

test('Drawdown Periods: DURATION is time under water, TO TROUGH peak to trough with its date, RECOVERY trough to recovery, sub-day in hours', () => {
  // Peak 100 at 01:00 → trough 40 at 12:00 (11h) → back to 100 at 16:00 (4h).
  const hist = [hourly(0, 0), hourly(1, 100), hourly(12, 40), hourly(16, 100)];
  Risk.renderDrawdownPeriods([], hist);

  const [row] = rowTexts('drawdownPeriodsBody');
  assert.equal(row[DD.DURATION], '15h 0m', 'DURATION');
  assert.equal(row[DD.TO_TROUGH], '11h 0m · 2025-01-01', 'TO TROUGH');
  assert.equal(row[DD.RECOVERY], '4h 0m', 'RECOVERY');
});

test('an ongoing drawdown\'s DURATION runs from the peak to the live point, as Current Drawdown\'s days do', () => {
  // Peak 100 at 01:00 → trough 40 at 12:00 → live 50 at 06:00 the next day.
  const hist = [hourly(0, 0), hourly(1, 100), hourly(12, 40)];
  const live = { t: new Date(Date.UTC(2025, 0, 1) + 30 * MS_PER_HOUR).toISOString(), c: 50 };
  Risk.renderDrawdownPeriods([], hist, live);

  const [row] = rowTexts('drawdownPeriodsBody');
  assert.match(row[0], /→ ongoing$/);
  assert.equal(row[DD.DURATION], '1d 5h');
  assert.equal(row[DD.TO_TROUGH], '11h 0m · 2025-01-01');
  assert.equal(row[DD.RECOVERY], '—');
});

test('a drawdown that displays as $0 is not listed as a period', () => {
  const hist = [hourly(0, 0), hourly(1, 100), hourly(2, 99.7), hourly(3, 150), hourly(4, 90)];
  Risk.renderDrawdownPeriods([], hist);

  const rows = rowTexts('drawdownPeriodsBody');
  assert.equal(rows.length, 1, JSON.stringify(rows));
  assert.equal(rows[0][1], '-$60');
});

test('a row\'s DEPTH is its PEAK less its TROUGH as they display, so the row foots', () => {
  const hist = [hourly(0, 0), hourly(1, 12345.4), hourly(2, 2345.6), hourly(3, 20000)];
  Risk.renderDrawdownPeriods([], hist);

  const [row] = rowTexts('drawdownPeriodsBody');
  assert.deepEqual([row[1], row[5], row[6]], ['-$9,999', '+$12,345', '+$2,346']);
});

test('Drawdown Periods list and sort events by the depth they display: one that foots to $0 is not listed', () => {
  // Raw depths 10.8, 10.6 and 0.8 display as $10, $11 and $0.
  const hist = [hourly(0, 0), hourly(1, 100.4), hourly(2, 89.6), hourly(3, 200.6), hourly(4, 190),
    hourly(5, 300.4), hourly(6, 299.6), hourly(7, 400)];
  Risk.renderDrawdownPeriods([], hist);

  assert.deepEqual(rowTexts('drawdownPeriodsBody').map(r => [r[1], r[5], r[6]]),
    [['-$11', '+$201', '+$190'], ['-$10', '+$100', '+$90']]);
});

test('a /historical-pnl curve that never draws down lists no period, even when closed trades did', () => {
  const closed = (closedAt, profit) => ({ status: 'CLOSED', closedAt, profit: String(profit), complete: true });
  const positions = [closed('2025-01-01T02:00:00Z', 300), closed('2025-01-01T03:00:00Z', -200)];
  Risk.renderDrawdownPeriods(positions, [hourly(0, 0), hourly(5, 500)]);

  assert.deepEqual(rowTexts('drawdownPeriodsBody'), []);
});

test('a drawdown series with a gap lists no period, only the reason', () => {
  const CUT = 'Historical profit before 2025-01-01 not in cached snapshot';
  Risk.renderDrawdownPeriods([], [hourly(0, 0), hourly(1, 100), hourly(2, 40)], null, CUT);

  assert.deepEqual(rowTexts('drawdownPeriodsBody'), [[CUT]]);
});

// ---------------------------------------------------------------------------
// Liquidation Risk Analysis table and Leverage card.
// ---------------------------------------------------------------------------

const MARKETS = {
  'BTC-USD': { oraclePrice: '80000', maintenanceMarginFraction: '0.012' },
  'ETH-USD': { oraclePrice: '2000', maintenanceMarginFraction: '0.05' },
};
const SIZE = 1, LIQ_PRICE = 5, DISTANCE = 6, RISK_SCORE = 7;
// The Leverage card's markup tooltip, in place before any render as in the page.
const LEVERAGE_MARKUP_TITLE = 'Total notional ÷ subaccount equity.';
el('leverageUtilCard').title = LEVERAGE_MARKUP_TITLE;

test('Liquidation SIZE keeps full precision and a position past its liq price reads BREACHED', () => {
  // 1.5 BTC needs 1.5·80000·0.012 = $1440 of margin; $1000 of equity is short.
  const btc = { market: 'BTC-USD', side: 'LONG', size: '1.5', status: 'OPEN', entryPrice: '79000' };
  Risk.renderLiquidationTable([btc], MARKETS, { equity: '1000' }, '');

  const [row] = rowTexts('liquidationRiskBody');
  assert.equal(row[SIZE], '1.5 BTC');
  assert.match(row[DISTANCE], /^-\d+\.\d%$/, `signed distance, got ${row[DISTANCE]}`);
  assert.equal(row[RISK_SCORE], 'BREACHED');
  assert.ok(cell('liquidationRiskBody', 0, RISK_SCORE).classList.contains('loss'));
});

test('a distance that displays as 0.0% is unsigned, even with the oracle just past the liq price', () => {
  // liq = (80000 - 952.096) / 0.988 = 80008: 0.01% past the oracle.
  const btc = { market: 'BTC-USD', side: 'LONG', size: '1', status: 'OPEN', entryPrice: '79000' };
  Risk.renderLiquidationTable([btc], MARKETS, { equity: '952.096' }, '');

  const [row] = rowTexts('liquidationRiskBody');
  assert.equal(row[LIQ_PRICE], '$80,008');
  assert.equal(row[DISTANCE], '0.0%');
});

test('each Liquidation row carries the other open positions\' maintenance margin', () => {
  const btc = { market: 'BTC-USD', side: 'LONG', size: '10', status: 'OPEN', entryPrice: '79000' };
  const eth = { market: 'ETH-USD', side: 'SHORT', size: '-100', status: 'OPEN', entryPrice: '2100' };
  Risk.renderLiquidationTable([btc, eth], MARKETS, { equity: '300000' }, '');

  const rows = rowTexts('liquidationRiskBody');
  // See crossMarginLiqPrice: 51619.43 and 4670.48 with the other position's
  // requirement; 50607.29 and 4761.90 without it.
  assert.equal(rows[0][LIQ_PRICE], '$51,619.4');
  assert.equal(rows[1][LIQ_PRICE], '$4,670.48');
});

test('a SHORT below maintenance margin at every price reads LIQ PRICE — with why, DISTANCE —, and BREACHED', () => {
  // See risk-metrics.test.js: the ETH LONG's $120000 requirement exceeds
  // the $50000 equity plus anything the BTC SHORT could earn.
  const markets = {
    'BTC-USD': { oraclePrice: '100000', maintenanceMarginFraction: '0.03' },
    'ETH-USD': { oraclePrice: '4000', maintenanceMarginFraction: '0.03' },
  };
  const short = { market: 'BTC-USD', side: 'SHORT', size: '-0.01', status: 'OPEN', entryPrice: '100000' };
  const long = { market: 'ETH-USD', side: 'LONG', size: '1000', status: 'OPEN', entryPrice: '4000' };
  Risk.renderLiquidationTable([short, long], markets, { equity: '50000' }, '');

  const [row] = rowTexts('liquidationRiskBody');
  assert.equal(row[LIQ_PRICE], '—');
  assert.equal(cell('liquidationRiskBody', 0, LIQ_PRICE).title, 'Below maintenance margin at every price');
  assert.equal(row[DISTANCE], '—');
  assert.equal(row[RISK_SCORE], 'BREACHED');
  assert.ok(cell('liquidationRiskBody', 0, RISK_SCORE).classList.contains('loss'));
});

test('a LONG that no price above $0 can liquidate reads LIQ PRICE — with why, never $0', () => {
  const btc = { market: 'BTC-USD', side: 'LONG', size: '0.001', status: 'OPEN', entryPrice: '80000' };
  Risk.renderLiquidationTable([btc], MARKETS, { equity: '1000000' }, '');

  const [row] = rowTexts('liquidationRiskBody');
  assert.equal(row[LIQ_PRICE], '—');
  assert.match(cell('liquidationRiskBody', 0, LIQ_PRICE).title, /^No liquidation price: /);
  assert.equal(row[DISTANCE], '+100.0%');
  assert.equal(row[RISK_SCORE], 'LOW');
});

test('a row whose liquidation is unknown says why on LIQ PRICE, DISTANCE and RISK SCORE: another position\'s margin, or its own input', () => {
  const markets = { 'BTC-USD': { oraclePrice: '100000', maintenanceMarginFraction: '0.03' } };
  const btc = { market: 'BTC-USD', side: 'SHORT', size: '-3', status: 'OPEN', entryPrice: '100000' };
  const sol = { market: 'SOL-USD', side: 'LONG', size: '3', status: 'OPEN', entryPrice: '100' };
  const reasonsOf = (row) => [LIQ_PRICE, DISTANCE, RISK_SCORE].map(c => {
    assert.equal(cell('liquidationRiskBody', row, c).textContent, '—');
    return cell('liquidationRiskBody', row, c).title;
  });

  // SOL-USD is missing from /perpetualMarkets: the BTC row's own inputs are
  // all there, but its liquidation needs SOL's maintenance margin.
  Risk.renderLiquidationTable([btc, sol], markets, { equity: '50000' }, '');
  const otherMargin = 'No oracle price for SOL-USD: its maintenance margin is unknown';
  assert.deepEqual(reasonsOf(0), [otherMargin, otherMargin, otherMargin]);
  const ownOracle = 'No oracle price for SOL-USD';
  assert.deepEqual(reasonsOf(1), [ownOracle, ownOracle, ownOracle]);

  // The markets endpoint failed: its reason, on every row.
  const marketsGap = 'Markets failed to load';
  Risk.renderLiquidationTable([btc, sol], {}, { equity: '50000' }, '', marketsGap);
  assert.deepEqual(reasonsOf(0), [marketsGap, marketsGap, marketsGap]);
  assert.deepEqual(reasonsOf(1), [marketsGap, marketsGap, marketsGap]);

  // No usable equity.
  Risk.renderLiquidationTable([btc], markets, null, '');
  assert.deepEqual(reasonsOf(0), Array(3).fill('Equity unavailable'));
});

test('a row beside an open position without a size reads — with that size as the reason', () => {
  const markets = {
    'BTC-USD': { oraclePrice: '60000', maintenanceMarginFraction: '0.03' },
    'ETH-USD': { oraclePrice: '3000', maintenanceMarginFraction: '0.05' }
  };
  const btc = { market: 'BTC-USD', side: 'LONG', size: '2', status: 'OPEN', entryPrice: '60000' };
  const eth = { market: 'ETH-USD', side: 'SHORT', size: '', status: 'OPEN', entryPrice: '3000' };
  Risk.renderLiquidationTable([btc, eth], markets, { equity: '30000' }, '');
  const reason = 'No open position size for ETH-USD: its maintenance margin is unknown';
  for (const column of [LIQ_PRICE, DISTANCE, RISK_SCORE]) {
    assert.equal(cell('liquidationRiskBody', 0, column).textContent, '—');
    assert.equal(cell('liquidationRiskBody', 0, column).title, reason);
  }
});

test('an open position without an oracle price leaves the Leverage card — with the caller\'s reason', () => {
  const btc = { market: 'BTC-USD', side: 'LONG', size: '1', status: 'OPEN', entryPrice: '79000' };
  const sol = { market: 'SOL-USD', side: 'LONG', size: '10', status: 'OPEN', entryPrice: '100' };
  const reason = 'No oracle price for SOL-USD';
  Risk.renderLeverageUtilization([btc, sol], { equity: '100000' }, MARKETS, '', reason);

  assert.equal(el('leverageUtil').textContent, '—');
  assert.equal(el('leverageUtilDetail').textContent, reason);
});

// One unit of a $100 market with a 5% maintenance fraction: a LONG's liq
// price is (100 - equity) / 0.95.
const UNIT_MARKET = { 'X-USD': { oraclePrice: '100', maintenanceMarginFraction: '0.05' } };
const unitLong = { market: 'X-USD', side: 'LONG', size: '1', status: 'OPEN', entryPrice: '100' };

test('RISK SCORE classifies the DISTANCE the row shows, and a signed DISTANCE never reads 0.0% beside BREACHED', () => {
  // Liq $90.04: 9.96% of room, which reads +10.0%, so MEDIUM (HIGH is below 10%).
  Risk.renderLiquidationTable([unitLong], UNIT_MARKET, { equity: '14.462' }, '');
  let [row] = rowTexts('liquidationRiskBody');
  assert.equal(row[DISTANCE], '+10.0%');
  assert.equal(row[RISK_SCORE], 'MEDIUM');

  // Liq $100.04: 0.04% past the oracle, which reads 0.0%: not shown as breached.
  Risk.renderLiquidationTable([unitLong], UNIT_MARKET, { equity: '4.962' }, '');
  [row] = rowTexts('liquidationRiskBody');
  assert.equal(row[DISTANCE], '0.0%');
  assert.equal(row[RISK_SCORE], 'HIGH');

  // Liq $100.09: 0.09% past it, which reads -0.1%: BREACHED.
  Risk.renderLiquidationTable([unitLong], UNIT_MARKET, { equity: '4.9145' }, '');
  [row] = rowTexts('liquidationRiskBody');
  assert.equal(row[DISTANCE], '-0.1%');
  assert.equal(row[RISK_SCORE], 'BREACHED');
});

test('the Leverage card\'s tier follows the leverage it shows', () => {
  // $100 of notional over $50.01 of equity is 1.9996x, which reads 2.00x: not conservative.
  Risk.renderLeverageUtilization([unitLong], { equity: '50.01' }, UNIT_MARKET, '', '');
  assert.equal(el('leverageUtil').textContent, '2.00x');
  assert.ok(el('leverageUtil').classList.contains('warning'), el('leverageUtil').className);

  // 4.996x reads 5.00x: high.
  Risk.renderLeverageUtilization([unitLong], { equity: '20.016' }, UNIT_MARKET, '', '');
  assert.equal(el('leverageUtil').textContent, '5.00x');
  assert.ok(el('leverageUtil').classList.contains('loss'), el('leverageUtil').className);
});

test('the Leverage card\'s tooltip states the tiers it applies: at 5.00x high, at 2.00x elevated', () => {
  Risk.renderLeverageUtilization([unitLong], { equity: '50' }, UNIT_MARKET, '', '');
  const title = el('leverageUtilCard').title;
  assert.ok(title.startsWith(LEVERAGE_MARKUP_TITLE), title);
  assert.match(title, /5x or more = high; 2x or more = elevated; below 2x = conservative/);
  assert.doesNotMatch(title, /above \dx/i);

  // A re-render keeps one copy of the tiers.
  Risk.renderLeverageUtilization([unitLong], { equity: '50' }, UNIT_MARKET, '', '');
  assert.equal(el('leverageUtilCard').title, title);
});

test('an ongoing drawdown whose remaining gap displays as $0 reads recovered, as Current Drawdown reads at peak', () => {
  // Peak 1000 at 01:00 → 0 at 02:00 → live 999.70 at 03:00: $0.30 short.
  const hist = [hourly(0, 0), hourly(1, 1000), hourly(2, 0)];
  const live = { t: new Date(Date.UTC(2025, 0, 1) + 3 * MS_PER_HOUR).toISOString(), c: 999.7 };
  Risk.renderDrawdownPeriods([], hist, live);

  const [row] = rowTexts('drawdownPeriodsBody');
  assert.equal(row[0], '2025-01-01 → 2025-01-01');
  assert.equal(row[DD.DURATION], '2h 0m');
  assert.equal(row[DD.RECOVERY], '1h 0m');
});

test('an ongoing drawdown reads recovered once its peak and the live point display alike, though the raw gap rounds to $1', () => {
  // Peak +$100.40 → +$50 → live +$99.60: both ends show +$100 (a raw $0.80),
  // so Current Drawdown reads at peak and the row reads recovered.
  const hist = [hourly(0, 0), hourly(1, 100.4), hourly(2, 50)];
  const live = { t: new Date(Date.UTC(2025, 0, 1) + 3 * MS_PER_HOUR).toISOString(), c: 99.6 };
  Risk.renderDrawdownPeriods([], hist, live);

  const [row] = rowTexts('drawdownPeriodsBody');
  assert.equal(row[0], '2025-01-01 → 2025-01-01');
  assert.equal(row[DD.RECOVERY], '1h 0m');
});

test('Drawdown Periods lists every drawdown, deepest first, and its title counts them', () => {
  // Seven drawdowns of $10 … $70 from successive new peaks.
  const DEPTHS = [30, 10, 70, 20, 60, 40, 50];
  const hist = [hourly(0, 0)];
  let peak = 0;
  DEPTHS.forEach((depth, i) => {
    peak += 100;
    hist.push(hourly(3 * i + 1, peak), hourly(3 * i + 2, peak - depth));
  });
  hist.push(hourly(3 * DEPTHS.length + 1, peak + 100));
  Risk.renderDrawdownPeriods([], hist);

  const depths = rowTexts('drawdownPeriodsBody').map(r => r[1]);
  assert.deepEqual(depths, ['-$70', '-$60', '-$50', '-$40', '-$30', '-$20', '-$10']);
  assert.equal(el('drawdownPeriodsTitle').textContent, `${PERIODS_TITLE} (7, deepest first)`);
  assert.equal(PERIODS_TITLE, 'Historical Drawdown Periods');
});

test('on the closed-trade fallback an ongoing drawdown\'s DURATION runs to now, not to the last close', () => {
  const closedAt = (h) => new Date(Date.UTC(2025, 0, 1) + h * MS_PER_HOUR).toISOString();
  const positions = [
    { status: 'CLOSED', closedAt: closedAt(1), profit: '300', complete: true },
    { status: 'CLOSED', closedAt: closedAt(2), profit: '-100', complete: true },
  ];
  Risk.renderDrawdownPeriods(positions, [], null, '', { nowMs: Date.UTC(2025, 0, 4, 1) });

  const [row] = rowTexts('drawdownPeriodsBody');
  assert.match(row[0], /→ ongoing$/);
  assert.equal(row[DD.DURATION], '3d 0h');
});
