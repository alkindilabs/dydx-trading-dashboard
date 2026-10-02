'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Tax module is browser-targeted and depends on window.RiskMetrics
// (attributeFillsToPositions) and, for its money and price cells,
// window.Format. Shim window onto globalThis, load constants and
// risk-metrics first, then tax-report and format.
globalThis.window = globalThis;
require('../src/constants.js');
require('../risk-metrics.js');
require('../tax-report.js');
require('../src/format.js');
const TR = globalThis.TaxReport;

const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

// ---------------------------------------------------------------------------
// yearUTC — UTC boundary correctness (not local time).
// ---------------------------------------------------------------------------

test('yearUTC: 2024-12-31T23:59:59Z classifies as 2024', () => {
    assert.equal(TR.yearUTC('2024-12-31T23:59:59Z'), 2024);
});

test('yearUTC: 2025-01-01T00:00:00Z classifies as 2025', () => {
    assert.equal(TR.yearUTC('2025-01-01T00:00:00Z'), 2025);
});

test('yearUTC: missing/invalid returns null', () => {
    assert.equal(TR.yearUTC(undefined), null);
    assert.equal(TR.yearUTC('not-a-date'), null);
    assert.equal(TR.yearUTC(null), null);
});

// ---------------------------------------------------------------------------
// availableYears — every UTC year holding a fill, a funding payment or a
// close, deduped and newest first.
// ---------------------------------------------------------------------------

test('availableYears: years of fills, funding payments and closes, deduped and sorted desc', () => {
    const positions = [
        { status: 'CLOSED', closedAt: '2024-03-15T00:00:00Z' },
        { status: 'CLOSED', closedAt: '2024-08-20T00:00:00Z' },
        { status: 'OPEN',   closedAt: null }
    ];
    const fills = [{ market: 'ETH-USD', createdAt: '2022-01-10T00:00:00Z' }];
    const payments = [{ ticker: 'ETH-USD', createdAt: '2023-06-30T00:00:00Z', payment: '1' }];
    assert.deepEqual(TR.availableYears(positions, fills, payments), [2024, 2023, 2022]);
});

test('availableYears: every year an incomplete position\'s window spans is selectable, its opening year without a fill included', () => {
    // Opened in 2024 with its opening fill missing, closed in 2026: its
    // attribution is incomplete, so its row reads — in 2024, 2025 and 2026.
    const p = {
        status: 'CLOSED', market: 'ETH-USD', side: 'LONG',
        createdAt: '2024-12-01T00:00:00Z', closedAt: '2026-02-01T00:00:00Z'
    };
    const fills = [{ market: 'ETH-USD', side: 'SELL', size: '1', price: '120', fee: '0',
                     createdAt: '2026-02-01T00:00:00Z' }];
    assert.deepEqual(TR.availableYears([p], fills, []), [2026, 2025, 2024]);
    const r2024 = TR.buildYearReport([p], fills, [], 2024, null);
    assert.equal(r2024.rows.length, 1);
    assert.equal(r2024.rows[0].realizedPnlUSD, null);
    assert.equal(r2024.rows[0]._attributionIncomplete, true);
});

// ---------------------------------------------------------------------------
// Realization by event date (CIRS art. 10 n.º 3): each closing fill's FIFO
// realized P&L and every fill's fee count in the UTC year of that fill, and
// each funding payment in the UTC year it was paid, for CLOSED and OPEN
// positions alike. A row shows only its position's events of that year.
// ---------------------------------------------------------------------------

const ethFill = (createdAt, side, size, price, fee) =>
    ({ market: 'ETH-USD', side, createdAt, size, price, fee });
const ethPayment = (createdAt, payment, side = 'LONG') =>
    ({ ticker: 'ETH-USD', side, createdAt, payment });

// toCsv's records after the UTF-8 BOM the file opens with (asserted
// here): the header, then one record per row.
function csvRecords(rows) {
    const csv = TR.toCsv(rows);
    assert.equal(csv[0], '\uFEFF', 'the CSV opens with a UTF-8 BOM');
    return csv.slice(1).split('\r\n');
}

// LONG 2 opened 2025-12-30, half closed 2025-12-31 (+50), the rest closed
// 2026-01-02 (+60); funding paid on either side of New Year.
const NEW_YEAR_LONG = {
    status: 'CLOSED', market: 'ETH-USD', side: 'LONG',
    createdAt: '2025-12-30T10:00:00Z', closedAt: '2026-01-02T10:00:00Z'
};
const NEW_YEAR_FILLS = [
    ethFill('2025-12-30T10:00:00Z', 'BUY',  '2', '100', '0.4'),
    ethFill('2025-12-31T10:00:00Z', 'SELL', '1', '150', '1'),
    ethFill('2026-01-02T10:00:00Z', 'SELL', '1', '160', '2')
];
const NEW_YEAR_PAYMENTS = [
    ethPayment('2025-12-31T08:00:00Z', '-1.5'),
    ethPayment('2026-01-01T08:00:00Z', '-2.5')
];

test('buildYearReport: a partial close in December counts in that year, the final close in January in the next', () => {
    const r2025 = TR.buildYearReport([NEW_YEAR_LONG], NEW_YEAR_FILLS, NEW_YEAR_PAYMENTS, 2025, null);
    assert.equal(r2025.rows.length, 1);
    const dec = r2025.rows[0];
    assert.ok(close(dec.realizedPnlUSD, 50), `2025 realized ${dec.realizedPnlUSD}`);
    assert.ok(close(dec.feesUSD, 1.4), `2025 fees ${dec.feesUSD}`);
    assert.ok(close(dec.netFundingUSD, -1.5), `2025 funding ${dec.netFundingUSD}`);
    assert.ok(close(dec.netUSD, 47.1), `2025 net ${dec.netUSD}`);
    assert.equal(dec.status, 'closed');
    assert.equal(dec.closedDateUTC, '2026-01-02', 'the row still names the position\'s own close');
    assert.equal(dec.fillCount, 2, 'only the fills dated in 2025');

    const jan = TR.buildYearReport([NEW_YEAR_LONG], NEW_YEAR_FILLS, NEW_YEAR_PAYMENTS, 2026, null).rows[0];
    assert.ok(close(jan.realizedPnlUSD, 60), `2026 realized ${jan.realizedPnlUSD}`);
    assert.ok(close(jan.feesUSD, 2), `2026 fees ${jan.feesUSD}`);
    assert.ok(close(jan.netFundingUSD, -2.5), `2026 funding ${jan.netFundingUSD}`);
    assert.deepEqual(TR.availableYears([NEW_YEAR_LONG], NEW_YEAR_FILLS, NEW_YEAR_PAYMENTS), [2026, 2025],
        'a year whose only realization is a partial close is selectable');
});

test('buildYearReport: a row names the UTC years its whole position\'s events span, and the exports leave it out', () => {
    const dec = TR.buildYearReport([NEW_YEAR_LONG], NEW_YEAR_FILLS, NEW_YEAR_PAYMENTS, 2025, null);
    assert.deepEqual(dec.rows[0]._eventYears, { first: 2025, last: 2026 });
    const json = JSON.parse(TR.toJson(dec.rows, dec.totals, 2025));
    assert.ok(!('_eventYears' in json.rows[0]), 'no export schema change');

    const oneYear = [ethFill('2025-03-01T00:00:00Z', 'BUY', '1', '100', '0'), ethFill('2025-03-02T00:00:00Z', 'SELL', '1', '110', '0')];
    const p = { status: 'CLOSED', market: 'ETH-USD', side: 'LONG', createdAt: '2025-03-01T00:00:00Z', closedAt: '2025-03-02T00:00:00Z' };
    assert.deepEqual(TR.buildYearReport([p], oneYear, [], 2025, null).rows[0]._eventYears, { first: 2025, last: 2025 });
    // A funding payment is an event of the position too.
    const paidInNewYear = [ethPayment('2026-01-01T08:00:00Z', '-1')];
    assert.deepEqual(TR.buildYearReport([{ ...p, closedAt: '2026-01-02T00:00:00Z' }], oneYear, paidInNewYear, 2025, null)
        .rows[0]._eventYears, { first: 2025, last: 2026 });
});

test('buildYearReport: a fill without a fee leaves its row incomplete and the year\'s fee, net and gross totals unknown, never $0', () => {
    const p = { status: 'CLOSED', market: 'ETH-USD', side: 'LONG', createdAt: '2025-03-01T00:00:00Z', closedAt: '2025-03-02T00:00:00Z' };
    const fills = [
        ethFill('2025-03-01T00:00:00Z', 'BUY',  '1', '100', undefined),
        ethFill('2025-03-02T00:00:00Z', 'SELL', '1', '110', 'abc')
    ];
    const r = TR.buildYearReport([p], fills, [ethPayment('2025-03-01T08:00:00Z', '-1')], 2025, null);
    const row = r.rows[0];
    assert.deepEqual([row.realizedPnlUSD, row.feesUSD, row.netUSD], [null, null, null]);
    assert.equal(row._attributionIncomplete, true);
    assert.equal(row._realizedFillError, 'attribution-incomplete');
    assert.equal(row.netFundingUSD, -1, 'funding stays known');
    assert.equal(r.warnings.incompleteAttributionCount, 1);
    assert.equal(r.totals.feesUSD, undefined);
    assert.equal(r.totals.netUSD, undefined);
    assert.equal(r.totals.grossGainsUSD, undefined);
});

test('buildYearReport: an open position\'s partial close appears in its year, marked open', () => {
    const open = {
        status: 'OPEN', market: 'ETH-USD', side: 'LONG', size: '1',
        createdAt: '2026-03-01T00:00:00Z', closedAt: null
    };
    const fills = [
        ethFill('2026-03-01T00:00:00Z', 'BUY',  '2', '100', '0.2'),
        ethFill('2026-04-01T00:00:00Z', 'SELL', '1', '130', '0.5')
    ];
    const r = TR.buildYearReport([open], fills, [ethPayment('2026-03-15T08:00:00Z', '-0.7')], 2026, null);
    assert.equal(r.rows.length, 1);
    const row = r.rows[0];
    assert.equal(row.status, 'open');
    assert.equal(row.closedDateUTC, null);
    assert.ok(close(row.realizedPnlUSD, 30), `realized ${row.realizedPnlUSD}`);
    assert.ok(close(row.feesUSD, 0.7), `fees ${row.feesUSD}`);
    assert.ok(close(row.netFundingUSD, -0.7), `funding ${row.netFundingUSD}`);
    assert.ok(close(r.totals.netUSD, 28.6), `year net ${r.totals.netUSD}`);
});

test('buildYearReport: funding counts in the year it was paid, a fill-less year included', () => {
    // Opened in 2024 and closed in 2026: 2025 holds only a funding payment.
    const p = {
        status: 'CLOSED', market: 'ETH-USD', side: 'LONG',
        createdAt: '2024-12-20T00:00:00Z', closedAt: '2026-01-05T00:00:00Z'
    };
    const fills = [
        ethFill('2024-12-20T00:00:00Z', 'BUY',  '1', '100', '0'),
        ethFill('2026-01-05T00:00:00Z', 'SELL', '1', '120', '0')
    ];
    const payments = [ethPayment('2025-06-01T08:00:00Z', '3'), ethPayment('2026-01-01T08:00:00Z', '-1')];
    assert.deepEqual(TR.availableYears([p], fills, payments), [2026, 2025, 2024]);
    const row = TR.buildYearReport([p], fills, payments, 2025, null).rows[0];
    assert.equal(row.realizedPnlUSD, 0);
    assert.equal(row.feesUSD, 0);
    assert.equal(row.netFundingUSD, 3);
    assert.equal(row.netUSD, 3);
    const r2026 = TR.buildYearReport([p], fills, payments, 2026, null);
    assert.equal(r2026.rows[0].netFundingUSD, -1);
    assert.equal(r2026.rows[0].realizedPnlUSD, 20);
});

test('buildYearReport: year totals reconcile to the year\'s fills and funding payments', () => {
    // ETH: a LONG reversed on 2025-12-31 by SELL 5 into a SHORT closed in
    // 2026. BTC: a SHORT still open, partly covered in 2025.
    const ethLong = {
        status: 'CLOSED', market: 'ETH-USD', side: 'LONG',
        createdAt: '2025-03-01T00:00:00Z', closedAt: '2025-12-31T12:00:00Z'
    };
    const ethShort = {
        status: 'CLOSED', market: 'ETH-USD', side: 'SHORT',
        createdAt: '2025-12-31T12:00:00Z', closedAt: '2026-01-03T00:00:00Z'
    };
    const btcShort = {
        status: 'OPEN', market: 'BTC-USD', side: 'SHORT', size: '-1',
        createdAt: '2025-06-01T00:00:00Z', closedAt: null
    };
    const btcFill = (createdAt, side, size, price, fee) => ({ ...ethFill(createdAt, side, size, price, fee), market: 'BTC-USD' });
    const fills = [
        ethFill('2025-03-01T00:00:00Z', 'BUY',  '2', '100', '1'),
        ethFill('2025-12-31T12:00:00Z', 'SELL', '5', '150', '5'),
        ethFill('2026-01-03T00:00:00Z', 'BUY',  '3', '120', '0.6'),
        btcFill('2025-06-01T00:00:00Z', 'SELL', '2', '1000', '2'),
        btcFill('2025-11-01T00:00:00Z', 'BUY',  '1', '900', '1')
    ];
    const payments = [
        ethPayment('2025-06-01T08:00:00Z', '-4'),
        ethPayment('2025-12-31T20:00:00Z', '1', 'SHORT'),
        { ticker: 'BTC-USD', side: 'SHORT', createdAt: '2025-09-01T08:00:00Z', payment: '2.5' },
        ethPayment('2026-01-02T08:00:00Z', '0.5', 'SHORT')
    ];
    const positions = [ethLong, ethShort, btcShort];

    // 2025: realized ETH (150-100)×2 + BTC (1000-900)×1; fees of every
    // 2025 fill, the reversing SELL's whole fee included; 2025 payments.
    const r2025 = TR.buildYearReport(positions, fills, payments, 2025, null);
    assert.equal(r2025.rows.length, 3);
    const sum = key => r2025.rows.reduce((s, row) => s + row[key], 0);
    assert.ok(close(sum('realizedPnlUSD'), 200));
    assert.ok(close(r2025.totals.feesUSD, 1 + 5 + 2 + 1), `fees ${r2025.totals.feesUSD}`);
    assert.ok(close(r2025.totals.fundingUSD, -4 + 1 + 2.5), `funding ${r2025.totals.fundingUSD}`);
    assert.ok(close(r2025.totals.netUSD, 200 - 9 - 0.5), `net ${r2025.totals.netUSD}`);

    // 2026: the SHORT's (150-120)×3, the one 2026 fill's fee and payment.
    const r2026 = TR.buildYearReport(positions, fills, payments, 2026, null);
    assert.equal(r2026.rows.length, 1);
    assert.ok(close(r2026.totals.netUSD, 90 - 0.6 + 0.5), `net ${r2026.totals.netUSD}`);
});

test('buildYearReport: a payment at a reversal\'s instant goes to the position on its side', () => {
    // The SELL 3 at 08:00 closes the LONG and opens the SHORT; both windows
    // hold 08:00, and the payment names the SHORT.
    const long = {
        status: 'CLOSED', market: 'ETH-USD', side: 'LONG',
        createdAt: '2025-06-01T00:00:00Z', closedAt: '2025-06-01T08:00:00Z'
    };
    const short = {
        status: 'CLOSED', market: 'ETH-USD', side: 'SHORT',
        createdAt: '2025-06-01T08:00:00Z', closedAt: '2025-06-02T00:00:00Z'
    };
    const fills = [
        ethFill('2025-06-01T00:00:00Z', 'BUY',  '1', '100', '0'),
        ethFill('2025-06-01T08:00:00Z', 'SELL', '3', '110', '0'),
        ethFill('2025-06-02T00:00:00Z', 'BUY',  '2', '105', '0')
    ];
    const r = TR.buildYearReport([long, short], fills, [ethPayment('2025-06-01T08:00:00Z', '-4', 'SHORT')], 2025, null);
    assert.equal(r.rows.find(row => row.side === 'SHORT').netFundingUSD, -4);
    assert.equal(r.rows.find(row => row.side === 'LONG').netFundingUSD, 0);
});

test('buildYearReport: a funding payment no listed position held blanks the funding-derived totals', () => {
    const payments = [...NEW_YEAR_PAYMENTS, ethPayment('2025-02-01T08:00:00Z', '7')];
    const r = TR.buildYearReport([NEW_YEAR_LONG], NEW_YEAR_FILLS, payments, 2025, null);
    assert.equal(r.warnings.unattributedFundingCount, 1);
    for (const key of ['fundingUSD', 'netUSD', 'grossGainsUSD', 'grossLossesUSD']) {
        assert.equal(r.totals[key], undefined, key);
    }
    assert.ok(close(r.totals.feesUSD, 1.4), 'fees do not depend on funding');
    assert.ok(close(r.rows[0].netFundingUSD, -1.5), 'the row keeps its own payments');
});

const UNPLACEABLE_FUNDING = 'A funding payment cannot be placed: a closed position has no valid close time';
const FUNDING_DERIVED_TOTALS = ['fundingUSD', 'netUSD', 'grossGainsUSD', 'grossLossesUSD'];

function assertFundingUnknown(row, label) {
    assert.equal(row._fundingMissing, true, label);
    assert.equal(row._fundingMissingReason, UNPLACEABLE_FUNDING, label);
    assert.equal(row.netFundingUSD, null, label);
    assert.equal(row.netUSD, null, label);
}

test('buildYearReport: a payment a closed position without a valid close time could hold is unplaced, never on the earlier row', () => {
    for (const closedAt of ['', null, 'not-a-date']) {
        const undated = { status: 'CLOSED', market: 'ETH-USD', side: 'LONG', createdAt: '2025-12-01T00:00:00Z', closedAt };
        const open = { status: 'OPEN', market: 'ETH-USD', side: 'LONG', size: '1', createdAt: '2026-02-05T00:00:00Z' };
        const fills = [
            ethFill('2025-12-01T00:00:00Z', 'BUY',  '1', '100', '0'),
            ethFill('2025-12-02T00:00:00Z', 'SELL', '1', '110', '0'),
            ethFill('2026-02-05T00:00:00Z', 'BUY',  '1', '100', '0')
        ];
        const r = TR.buildYearReport([undated, open], fills, [ethPayment('2026-02-06T00:00:00Z', '-40')], 2026, null);
        const label = `closedAt ${JSON.stringify(closedAt)}`;
        assert.equal(r.warnings.unattributedFundingCount, 1, label);
        for (const key of FUNDING_DERIVED_TOTALS) assert.equal(r.totals[key], undefined, `${label} ${key}`);
        assert.equal(r.rows.length, 2, `${label}: both candidates appear in the payment's year`);
        r.rows.forEach(row => assertFundingUnknown(row, `${label} ${row.status}`));
    }
});

test('buildYearReport: in one year, a later same-side position\'s payment is unplaced while an earlier closed position has no valid close time', () => {
    const undated = { status: 'CLOSED', market: 'ETH-USD', side: 'LONG', createdAt: '2025-03-02T00:00:00Z', closedAt: 'not-a-date' };
    const later = { status: 'CLOSED', market: 'ETH-USD', side: 'LONG', createdAt: '2025-03-05T00:00:00Z', closedAt: '2025-03-07T00:00:00Z' };
    const fills = [
        ethFill('2025-03-02T00:00:00Z', 'BUY',  '1', '100', '0'),
        ethFill('2025-03-03T00:00:00Z', 'SELL', '1', '110', '0'),
        ethFill('2025-03-05T00:00:00Z', 'BUY',  '1', '100', '0.1'),
        ethFill('2025-03-07T00:00:00Z', 'SELL', '1', '105', '0.1')
    ];
    const r = TR.buildYearReport([undated, later], fills, [ethPayment('2025-03-06T00:00:00Z', '-5')], 2025, null);
    assert.equal(r.warnings.unattributedFundingCount, 1);
    for (const key of FUNDING_DERIVED_TOTALS) assert.equal(r.totals[key], undefined, key);
    r.rows.forEach(row => assertFundingUnknown(row, row.createdAtISO));
    assert.ok(close(r.totals.feesUSD, 0.2), 'fees do not depend on funding');
});

test('buildYearReport: an unusable fill inside a listed position\'s window is that row\'s gap, not a fill of no listed position', () => {
    const long = { market: 'BTC-USD', status: 'CLOSED', side: 'LONG',
        createdAt: '2025-05-01T00:00:00Z', closedAt: '2025-05-03T00:00:00Z' };
    const fills = [
        { market: 'BTC-USD', side: 'BUY',  createdAt: '2025-05-01T00:00:00Z', size: '1',   price: '100', fee: '0' },
        { market: 'BTC-USD', side: 'BUY',  createdAt: '2025-05-02T00:00:00Z', size: 'abc', price: '100', fee: '0' },
        { market: 'BTC-USD', side: 'SELL', createdAt: '2025-05-03T00:00:00Z', size: '1',   price: '150', fee: '0' }
    ];
    const r = TR.buildYearReport([long], fills, [], 2025, null);
    assert.equal(r.warnings.incompleteAttributionCount, 1);
    assert.equal(r.rows[0]._realizedFillError, 'invalid-fill-in-slice');
    assert.equal(r.warnings.unattributedFillCount, 0);
    const undated = { ...fills[1], createdAt: undefined };
    const u = TR.buildYearReport([long], [fills[0], undated, fills[2]], [], 2025, null);
    assert.equal(u.warnings.incompleteAttributionCount, 1, 'an undated fill lies in every window of its market');
    assert.equal(u.warnings.unattributedFillCount, 0);
});

test('buildYearReport: an unusable fill no listed position\'s window holds is a fill of no listed position', () => {
    const outside = { market: 'BTC-USD', side: 'BUY', createdAt: '2025-06-01T00:00:00Z', size: 'abc', price: '100', fee: '0' };
    const r = TR.buildYearReport([NEW_YEAR_LONG], [...NEW_YEAR_FILLS, outside], NEW_YEAR_PAYMENTS, 2025, null);
    assert.equal(r.warnings.unattributedFillCount, 1);
});

test('buildYearReport: a row\'s fees are the exact sum of its fee shares, rounded once at cents', () => {
    // The SHORT holds 5/6 of a 0.013 fee and 5/6 of a -0.007 rebate:
    // exactly 0.005, $0.01; summed from the shares at 15 significant
    // digits it is 0.00499999999999997, $0.00.
    const btc = (createdAt, side, size, fee) => ({ market: 'BTC-USD', side, createdAt, size, price: '100', fee });
    const fills = [
        btc('2025-05-01T00:00:00Z', 'BUY', '1', '0'),
        btc('2025-05-02T00:00:00Z', 'SELL', '6', '0.013'),
        btc('2025-05-03T00:00:00Z', 'BUY', '6', '-0.007'),
        btc('2025-05-04T00:00:00Z', 'SELL', '1', '0')
    ];
    const position = (side, createdAt, closedAt) => ({ market: 'BTC-USD', status: 'CLOSED', side, createdAt, closedAt });
    const positions = [
        position('LONG', '2025-05-01T00:00:00Z', '2025-05-02T00:00:00Z'),
        position('SHORT', '2025-05-02T00:00:00Z', '2025-05-03T00:00:00Z'),
        position('LONG', '2025-05-03T00:00:00Z', '2025-05-04T00:00:00Z')
    ];
    const r = TR.buildYearReport(positions, fills, [], 2025, null);
    assert.equal(r.rows.find(row => row.side === 'SHORT').feesUSD, 0.01);
});

test('buildYearReport: a date\'s fees are the exact sum of its fee shares, rounded once at cents', () => {
    // The same round trip within one UTC date: the SHORT's one
    // eventsByDate entry, which its EUR fee converts from, holds the
    // exact 0.005 at cents, $0.01, like the row.
    const btc = (createdAt, side, size, fee) => ({ market: 'BTC-USD', side, createdAt, size, price: '100', fee });
    const fills = [
        btc('2025-05-01T01:00:00Z', 'BUY', '1', '0'),
        btc('2025-05-01T02:00:00Z', 'SELL', '6', '0.013'),
        btc('2025-05-01T03:00:00Z', 'BUY', '6', '-0.007'),
        btc('2025-05-01T04:00:00Z', 'SELL', '1', '0')
    ];
    const position = (side, createdAt, closedAt) => ({ market: 'BTC-USD', status: 'CLOSED', side, createdAt, closedAt });
    const positions = [
        position('LONG', '2025-05-01T01:00:00Z', '2025-05-01T02:00:00Z'),
        position('SHORT', '2025-05-01T02:00:00Z', '2025-05-01T03:00:00Z'),
        position('LONG', '2025-05-01T03:00:00Z', '2025-05-01T04:00:00Z')
    ];
    const short = TR.buildYearReport(positions, fills, [], 2025, null).rows.find(row => row.side === 'SHORT');
    assert.equal(short.eventsByDate.length, 1);
    assert.equal(short.eventsByDate[0].feesUSD, 0.01);
    assert.equal(short.feesUSD, 0.01);
});

test('buildYearReport: a fill no listed position owns blanks the fills-derived totals', () => {
    const btcRoundTrip = [
        { market: 'BTC-USD', side: 'BUY',  createdAt: '2025-05-01T00:00:00Z', size: '1', price: '100', fee: '1' },
        { market: 'BTC-USD', side: 'SELL', createdAt: '2025-05-02T00:00:00Z', size: '1', price: '110', fee: '1' }
    ];
    const r = TR.buildYearReport([NEW_YEAR_LONG], [...NEW_YEAR_FILLS, ...btcRoundTrip], NEW_YEAR_PAYMENTS, 2025, null);
    assert.equal(r.warnings.unattributedFillCount, 2);
    for (const key of ['netUSD', 'feesUSD', 'grossGainsUSD', 'grossLossesUSD']) {
        assert.equal(r.totals[key], undefined, key);
    }
    assert.ok(close(r.totals.fundingUSD, -1.5), 'funding does not depend on fills');
});

test('buildYearReport: funding payments that did not load read unknown funding, never $0', () => {
    const r = TR.buildYearReport([NEW_YEAR_LONG], NEW_YEAR_FILLS, null, 2025, null);
    const row = r.rows[0];
    assert.equal(row._fundingMissing, true);
    assert.equal(row.netFundingUSD, null);
    assert.equal(row.netUSD, null);
    assert.ok(close(row.realizedPnlUSD, 50), 'realized does not depend on funding');
    assert.equal(r.totals.fundingMissingCount, 1);
    for (const key of ['fundingUSD', 'netUSD', 'grossGainsUSD', 'grossLossesUSD']) {
        assert.equal(r.totals[key], undefined, key);
    }
    assert.ok(close(r.totals.feesUSD, 1.4));
});

test('buildYearReport: a funding payment with no parseable amount leaves its row\'s funding unknown', () => {
    const payments = [ethPayment('2025-12-31T08:00:00Z', 'n/a')];
    const row = TR.buildYearReport([NEW_YEAR_LONG], NEW_YEAR_FILLS, payments, 2025, null).rows[0];
    assert.equal(row._fundingMissing, true);
    assert.equal(row.netFundingUSD, null);
});

test('convertRowsToEur: each fill and payment converts at the ECB quote of its own UTC date', () => {
    // 2025: BUY fee 0.4 on 12-30 at 1.25; realized 50, fee 1 and funding
    // -1.5 on 12-31 at 1.0. The close date (2026-01-02) plays no part.
    const quotes = { '2025-12-30': 1.25, '2025-12-31': 1.0 };
    const r = TR.buildYearReport([NEW_YEAR_LONG], NEW_YEAR_FILLS, NEW_YEAR_PAYMENTS, 2025, quotes);
    const row = r.rows[0];
    assert.deepEqual(TR.fxDates(r.rows), ['2025-12-30', '2025-12-31']);
    assert.equal(row._fxMissing, false);
    assert.ok(close(row.realizedPnlEUR, 50));
    assert.ok(close(row.feesEUR, 0.32 + 1), `fees EUR ${row.feesEUR}`);
    assert.ok(close(row.netFundingEUR, -1.5));
    assert.ok(close(row.netEUR, 50 - 1.5 - 1.32), `net EUR ${row.netEUR}`);
    assert.ok(close(r.totals.netEUR, 47.18));
});

test('convertRowsToEur: a row missing the quote of any event date has no EUR figures', () => {
    const r = TR.buildYearReport([NEW_YEAR_LONG], NEW_YEAR_FILLS, NEW_YEAR_PAYMENTS, 2025, { '2025-12-31': 1.0, '2026-01-02': 1.1 });
    const row = r.rows[0];
    assert.equal(row._fxMissing, true);
    assert.equal(row.netEUR, undefined);
    assert.equal(row.realizedPnlEUR, undefined);
    assert.deepEqual(r.warnings.missingFxDates, ['2025-12-30']);
    assert.equal(r.totals.netEUR, undefined);
});

// ---------------------------------------------------------------------------
// buildYearReport row flags — _attributionIncomplete / _realizedFillError
// and warnings.incompleteAttributionCount follow the fill attribution's
// completeness (RiskMetrics.hasCompleteAttribution); the same-market
// overlap flag is a separate audit hint.
// ---------------------------------------------------------------------------

test('buildYearReport: invalid-price fill in the window → invalid-fill-in-slice + incomplete counter', () => {
    // The sizes net flat (BUY 1 + BUY 1 + SELL 2), but the FIFO walk
    // skips the NaN-price fill, so the attribution cannot vouch for the
    // position.
    const p = {
        status: 'CLOSED', market: 'BTC-USD', side: 'LONG',
        createdAt: '2024-01-10T00:00:00Z', closedAt: '2024-01-15T00:00:00Z',
        maxSize: '2'
    };
    const fills = [
        { market: 'BTC-USD', createdAt: '2024-01-11T00:00:00Z', side: 'BUY',  size: '1', price: '100', fee: '0' },
        { market: 'BTC-USD', createdAt: '2024-01-12T00:00:00Z', side: 'BUY',  size: '1', price: 'NaN', fee: '0' },
        { market: 'BTC-USD', createdAt: '2024-01-13T00:00:00Z', side: 'SELL', size: '2', price: '150', fee: '0' }
    ];
    const r = TR.buildYearReport([p], fills, [], 2024, {});
    assert.equal(r.rows[0]._attributionIncomplete, true);
    assert.equal(r.rows[0]._realizedFillError, 'invalid-fill-in-slice');
    assert.equal(r.rows[0]._hasInvalidFill, true);
    assert.equal(r.warnings.incompleteAttributionCount, 1);
});

test('buildYearReport: a window holding only an unparseable fill reports invalid-fill-in-slice', () => {
    // The only fill in the window has a NaN price: the FIFO walk skips it,
    // so no fill ties to the position. The unparseable fill is the more
    // specific reason than a bare incomplete attribution.
    const p = {
        status: 'CLOSED', market: 'BTC-USD', side: 'LONG',
        createdAt: '2024-01-10T00:00:00Z', closedAt: '2024-01-15T00:00:00Z',
        maxSize: '1'
    };
    const fills = [
        { market: 'BTC-USD', createdAt: '2024-01-11T00:00:00Z', side: 'BUY', size: '1', price: 'NaN', fee: '0' }
    ];
    const r = TR.buildYearReport([p], fills, [], 2024, {});
    assert.equal(r.rows[0]._attributionIncomplete, true);
    assert.equal(r.rows[0]._realizedFillError, 'invalid-fill-in-slice');
    assert.equal(r.rows[0]._hasInvalidFill, true);
    assert.equal(r.warnings.incompleteAttributionCount, 1);
});

test('buildYearReport: a complete reversal pair is from fills, with only the overlap audit hint', () => {
    // The reversing SELL lies whole in both rows' indexer windows, so
    // neither window nets flat on its own; the attribution still ties
    // each row to exactly its own fills (the SELL split by size).
    const long = {
        status: 'CLOSED', market: 'ETH-USD', side: 'LONG',
        createdAt: '2024-01-10T00:00:00Z', closedAt: '2024-01-11T00:00:00Z'
    };
    const short = {
        status: 'CLOSED', market: 'ETH-USD', side: 'SHORT',
        createdAt: '2024-01-11T00:00:00Z', closedAt: '2024-01-12T00:00:00Z'
    };
    const fills = [
        { market: 'ETH-USD', side: 'BUY',  createdAt: '2024-01-10T00:00:00Z', createdAtHeight: '1', size: '2', price: '100', fee: '1' },
        { market: 'ETH-USD', side: 'SELL', createdAt: '2024-01-11T00:00:00Z', createdAtHeight: '2', size: '5', price: '150', fee: '5' },
        { market: 'ETH-USD', side: 'BUY',  createdAt: '2024-01-12T00:00:00Z', createdAtHeight: '3', size: '3', price: '120', fee: '0.6' }
    ];
    const r = TR.buildYearReport([long, short], fills, [], 2024, {});
    r.rows.forEach(row => {
        assert.equal(row._realizedFillError, null, `${row.side} has no fill error`);
        assert.equal(row._attributionIncomplete, false);
        assert.equal(row._feeAttributionWarning, true, `${row.side} keeps the overlap audit hint`);
    });
    assert.equal(r.warnings.incompleteAttributionCount, 0);
    assert.equal(r.warnings.feeAttributionAmbiguousCount, 2);
});

test('buildYearReport: a reversal into a still-open position flags both rows with the overlap hint', () => {
    // The reversing SELL 3 closes the LONG and opens a SHORT that is still
    // OPEN: its window runs on, so it touches the LONG's at the reversal.
    const long = {
        status: 'CLOSED', market: 'ETH-USD', side: 'LONG',
        createdAt: '2024-01-10T00:00:00Z', closedAt: '2024-01-11T00:00:00Z'
    };
    const openShort = {
        status: 'OPEN', market: 'ETH-USD', side: 'SHORT', size: '-2',
        createdAt: '2024-01-11T00:00:00Z', closedAt: null
    };
    const fills = [
        { market: 'ETH-USD', side: 'BUY',  createdAt: '2024-01-10T00:00:00Z', createdAtHeight: '1', size: '1', price: '100', fee: '0' },
        { market: 'ETH-USD', side: 'SELL', createdAt: '2024-01-11T00:00:00Z', createdAtHeight: '2', size: '3', price: '150', fee: '0' }
    ];
    const r = TR.buildYearReport([long, openShort], fills, [], 2024, {});
    assert.equal(r.rows.length, 2);
    r.rows.forEach(row => {
        assert.equal(row._attributionIncomplete, false, `${row.side} is complete`);
        assert.equal(row._feeAttributionWarning, true, `${row.side} carries the overlap hint`);
    });
    assert.equal(r.warnings.feeAttributionAmbiguousCount, 2);
});

test('buildYearReport: an open position does not flag a closed one that ended before it opened', () => {
    const long = {
        status: 'CLOSED', market: 'ETH-USD', side: 'LONG',
        createdAt: '2024-01-10T00:00:00Z', closedAt: '2024-01-11T00:00:00Z'
    };
    const laterOpen = {
        status: 'OPEN', market: 'ETH-USD', side: 'LONG', size: '1',
        createdAt: '2024-02-01T00:00:00Z', closedAt: null
    };
    const fills = [
        { market: 'ETH-USD', side: 'BUY',  createdAt: '2024-01-10T00:00:00Z', size: '1', price: '100', fee: '0' },
        { market: 'ETH-USD', side: 'SELL', createdAt: '2024-01-11T00:00:00Z', size: '1', price: '110', fee: '0' },
        { market: 'ETH-USD', side: 'BUY',  createdAt: '2024-02-01T00:00:00Z', size: '1', price: '120', fee: '0' }
    ];
    const r = TR.buildYearReport([long, laterOpen], fills, [], 2024, {});
    assert.equal(r.warnings.feeAttributionAmbiguousCount, 0);
});

test('buildYearReport: a window whose fills net flat but do not tie to the position is not from fills', () => {
    // Two flat round trips inside one indexer position: the sizes in the
    // window net flat, but the fills saw a flat moment the indexer did
    // not, so the attribution is incomplete.
    const merged = {
        status: 'CLOSED', market: 'BTC-USD', side: 'LONG',
        createdAt: '2024-01-10T00:00:00Z', closedAt: '2024-01-13T00:00:00Z'
    };
    const fills = [
        { market: 'BTC-USD', side: 'BUY',  createdAt: '2024-01-10T00:00:00Z', size: '1', price: '100', fee: '0' },
        { market: 'BTC-USD', side: 'SELL', createdAt: '2024-01-11T00:00:00Z', size: '1', price: '110', fee: '0' },
        { market: 'BTC-USD', side: 'BUY',  createdAt: '2024-01-12T00:00:00Z', size: '1', price: '100', fee: '0' },
        { market: 'BTC-USD', side: 'SELL', createdAt: '2024-01-13T00:00:00Z', size: '1', price: '110', fee: '0' }
    ];
    const r = TR.buildYearReport([merged], fills, [], 2024, {});
    assert.equal(r.rows[0]._attributionIncomplete, true);
    assert.equal(r.rows[0]._realizedFillError, 'attribution-incomplete');
    assert.equal(r.warnings.incompleteAttributionCount, 1);
});

test('buildYearReport: fill_count counts the position\'s own BUY and SELL fills, not other markets\' or those outside it', () => {
    // /v4/fills sides are BUY/SELL while positions are LONG/SHORT, and
    // both sides belong to a position's lifecycle: the attribution holds
    // the opening BUY and the closing SELL at the window's two ends.
    const p = {
        status: 'CLOSED', market: 'ETH-USD', side: 'LONG',
        createdAt: '2024-01-10T00:00:00Z', closedAt: '2024-01-15T00:00:00Z'
    };
    const fills = [
        { market: 'ETH-USD', side: 'SELL', createdAt: '2024-01-08T00:00:00Z', size: '1', price: '90', fee: '0' },
        { market: 'ETH-USD', side: 'BUY',  createdAt: '2024-01-09T23:59:59Z', size: '1', price: '95', fee: '0' },
        { market: 'ETH-USD', side: 'BUY',  createdAt: '2024-01-10T00:00:00Z', size: '1', price: '100', fee: '0' },
        { market: 'BTC-USD', side: 'BUY',  createdAt: '2024-01-12T00:00:00Z', size: '1', price: '50000', fee: '0' },
        { market: 'ETH-USD', side: 'SELL', createdAt: '2024-01-15T00:00:00Z', size: '1', price: '110', fee: '0' },
        { market: 'ETH-USD', side: 'BUY',  createdAt: '2024-01-15T00:00:01Z', size: '1', price: '111', fee: '0' }
    ];
    assert.equal(TR.buildYearReport([p], fills, [], 2024, {}).rows[0].fillCount, 2);
});

test('buildYearReport: at a reversal instant shared by several fills, each row counts only the fills it holds', () => {
    // Three SELLs in one millisecond: the first reduces the LONG, the
    // second closes it and opens the SHORT (it belongs to both rows), the
    // third adds to the SHORT. Both indexer windows hold all three.
    const reversal = '2024-01-11T00:00:00Z';
    const long = { status: 'CLOSED', market: 'ETH-USD', side: 'LONG', createdAt: '2024-01-10T00:00:00Z', closedAt: reversal };
    const short = { status: 'CLOSED', market: 'ETH-USD', side: 'SHORT', createdAt: reversal, closedAt: '2024-01-12T00:00:00Z' };
    const fills = [
        { market: 'ETH-USD', side: 'BUY',  createdAt: '2024-01-10T00:00:00Z', createdAtHeight: '1', size: '2', price: '100', fee: '0' },
        { market: 'ETH-USD', side: 'SELL', createdAt: reversal, createdAtHeight: '2', size: '1', price: '110', fee: '0' },
        { market: 'ETH-USD', side: 'SELL', createdAt: reversal, createdAtHeight: '2', size: '2', price: '110', fee: '0' },
        { market: 'ETH-USD', side: 'SELL', createdAt: reversal, createdAtHeight: '2', size: '1', price: '110', fee: '0' },
        { market: 'ETH-USD', side: 'BUY',  createdAt: '2024-01-12T00:00:00Z', createdAtHeight: '3', size: '2', price: '105', fee: '0' }
    ];
    const r = TR.buildYearReport([long, short], fills, [], 2024, {});
    const bySide = Object.fromEntries(r.rows.map(row => [row.side, row]));
    assert.equal(bySide.LONG._attributionIncomplete, false);
    assert.equal(bySide.SHORT._attributionIncomplete, false);
    assert.equal(bySide.LONG.fillCount, 3, 'the opening BUY, the reducing SELL and the reversing SELL');
    assert.equal(bySide.SHORT.fillCount, 3, 'the reversing SELL, the adding SELL and the closing BUY');
});

test('buildYearReport: dense overlap (all positions overlap each other) marks all', () => {
    // Stress the sweep: N positions whose windows all intersect at the
    // same instant. With the unmarkedActive sub-list in
    // sweepOverlapsPerMarket this should still mark every position even
    // though the inner walk only runs once.
    const positions = [];
    for (let i = 0; i < 8; i++) {
        positions.push({
            status: 'CLOSED', market: 'ETH-USD', side: 'LONG',
            createdAt: `2024-01-${String(10 + i).padStart(2, '0')}T00:00:00Z`,
            closedAt:  `2024-02-${String(10 + i).padStart(2, '0')}T00:00:00Z`,
            maxSize: '1'
        });
    }
    const r = TR.buildYearReport(positions, [], [], 2024, {});
    assert.equal(r.rows.length, 8);
    assert.equal(r.rows.every(row => row._feeAttributionWarning), true,
        'every overlapping position must be marked');
    assert.equal(r.warnings.feeAttributionAmbiguousCount, 8);
});

// ---------------------------------------------------------------------------
// netRealizedPnl — realized + funding − fees.
// ---------------------------------------------------------------------------

test('netRealizedPnl: realized + funding − fees', () => {
    assert.ok(close(TR.netRealizedPnl(100, 5, 3), 102));
});

test('netRealizedPnl: loss + paid funding + fees', () => {
    assert.ok(close(TR.netRealizedPnl(-50, -2, 1), -53));
});

test('netRealizedPnl: an unknown part makes the net unknown, never $0', () => {
    assert.equal(TR.netRealizedPnl('abc', null, undefined), null);
    assert.equal(TR.netRealizedPnl(null, 5, 1), null);
    assert.equal(TR.netRealizedPnl(100, null, 1), null);
    assert.equal(TR.netRealizedPnl(100, 5, NaN), null);
    assert.equal(TR.netRealizedPnl(100, 5, Infinity), null);
});

// ---------------------------------------------------------------------------
// buildYearReport — FIFO-derived realized, side-agnostic fee attribution.
// ---------------------------------------------------------------------------

test('buildYearReport: each position\'s fills count in their own UTC year', () => {
    const positions = [
        { status: 'CLOSED', market: 'ETH-USD', side: 'LONG',
          createdAt: '2024-12-30T00:00:00Z', closedAt: '2024-12-31T23:59:59Z',
          realizedPnl: '0', entryPrice: '3000', exitPrice: '3100', maxSize: '1' },
        { status: 'CLOSED', market: 'ETH-USD', side: 'LONG',
          createdAt: '2025-01-01T00:00:00Z', closedAt: '2025-01-02T00:00:00Z',
          realizedPnl: '0', entryPrice: '3100', exitPrice: '3150', maxSize: '1' }
    ];
    const fills = [
        { market: 'ETH-USD', side: 'BUY',  createdAt: '2024-12-30T00:00:00Z', size: '1', price: '3000', fee: '0' },
        { market: 'ETH-USD', side: 'SELL', createdAt: '2024-12-31T23:59:59Z', size: '1', price: '3100', fee: '0' },
        { market: 'ETH-USD', side: 'BUY',  createdAt: '2025-01-01T00:00:00Z', size: '1', price: '3100', fee: '0' },
        { market: 'ETH-USD', side: 'SELL', createdAt: '2025-01-02T00:00:00Z', size: '1', price: '3150', fee: '0' }
    ];
    const r2024 = TR.buildYearReport(positions, fills, [], 2024, {});
    assert.equal(r2024.rows.length, 1);
    assert.equal(r2024.rows[0].closedAtISO, '2024-12-31T23:59:59Z');
    assert.ok(close(r2024.rows[0].realizedPnlUSD, 100));
    const r2025 = TR.buildYearReport(positions, fills, [], 2025, {});
    assert.equal(r2025.rows.length, 1);
    assert.ok(close(r2025.rows[0].realizedPnlUSD, 50));
});

test('buildYearReport: netUSD = FIFO realized + funding payments − fees', () => {
    const p = {
        status: 'CLOSED', market: 'ETH-USD', side: 'LONG',
        createdAt: '2024-03-10T00:00:00Z', closedAt: '2024-03-12T00:00:00Z',
        maxSize: '1', entryPrice: '3000', exitPrice: '3100'
    };
    const fills = [
        { market: 'ETH-USD', side: 'BUY',  createdAt: '2024-03-10T00:00:00Z', size: '1', price: '3000', fee: '0.50' },
        { market: 'ETH-USD', side: 'SELL', createdAt: '2024-03-12T00:00:00Z', size: '1', price: '3100', fee: '0.75' }
    ];
    const payments = [{ ticker: 'ETH-USD', side: 'LONG', createdAt: '2024-03-11T08:00:00Z', payment: '-2' }];
    const r = TR.buildYearReport([p], fills, payments, 2024, {});
    const row = r.rows[0];
    assert.ok(close(row.realizedPnlUSD, 100), `realized: ${row.realizedPnlUSD}`);
    assert.ok(close(row.feesUSD, 1.25), `fees: ${row.feesUSD}`);
    assert.ok(close(row.netUSD, 96.75), `net: ${row.netUSD}`);
    assert.equal(row._attributionIncomplete, false);
});

test('buildYearReport: no fills in window flags the row incomplete with reason no-fills-in-window', () => {
    const p = {
        status: 'CLOSED', market: 'BTC-USD', side: 'LONG',
        createdAt: '2024-05-01T00:00:00Z', closedAt: '2024-05-05T00:00:00Z',
        maxSize: '1'
    };
    // Fills exist for the market but all OUTSIDE the window
    const fills = [
        { market: 'BTC-USD', side: 'BUY',  createdAt: '2024-04-01T00:00:00Z', size: '1', price: '100', fee: '0' },
        { market: 'BTC-USD', side: 'SELL', createdAt: '2024-06-01T00:00:00Z', size: '1', price: '200', fee: '0' }
    ];
    const r = TR.buildYearReport([p], fills, [], 2024, {});
    const row = r.rows[0];
    // No fills tie to the position, so its profit is unknown, not $0.
    assert.equal(row.realizedPnlUSD, null);
    assert.equal(row._attributionIncomplete, true);
    assert.equal(row._realizedFillError, 'no-fills-in-window');
    assert.equal(row.fillCount, 0);
    assert.equal(r.warnings.incompleteAttributionCount, 1);
});

test('buildYearReport: SIZE / ENTRY / EXIT come from the fill attribution, not the indexer fields', () => {
    // The indexer's maxSize on a SHORT is the least-negative signed size
    // (-0.5 here) and its entryPrice is not the VWAP of a scaled entry.
    const p = {
        status: 'CLOSED', market: 'ETH-USD', side: 'SHORT',
        createdAt: '2024-05-01T00:00:00Z', closedAt: '2024-05-03T00:00:00Z',
        maxSize: '-0.5', entryPrice: '3000', exitPrice: '2950'
    };
    const fills = [
        { market: 'ETH-USD', side: 'SELL', createdAt: '2024-05-01T00:00:00Z', size: '2', price: '3000', fee: '0' },
        { market: 'ETH-USD', side: 'SELL', createdAt: '2024-05-02T00:00:00Z', size: '4', price: '3100', fee: '0' },
        { market: 'ETH-USD', side: 'BUY',  createdAt: '2024-05-03T00:00:00Z', size: '6', price: '2900', fee: '0' }
    ];
    const row = TR.buildYearReport([p], fills, [], 2024, {}).rows[0];
    assert.equal(row.peakSize, 6);
    assert.ok(close(row.entryPrice, (2 * 3000 + 4 * 3100) / 6), `entry ${row.entryPrice}`);
    assert.equal(row.exitPrice, 2900);
});

test('buildYearReport: SIZE / ENTRY / EXIT are null when the fill attribution is incomplete', () => {
    // No fills: the attribution cannot size or price the position, and the
    // indexer fields are not used as a substitute.
    const p = {
        status: 'CLOSED', market: 'ETH-USD', side: 'SHORT',
        createdAt: '2024-05-01T00:00:00Z', closedAt: '2024-05-03T00:00:00Z',
        maxSize: '-0.5', entryPrice: '3000', exitPrice: '2950'
    };
    const row = TR.buildYearReport([p], [], [], 2024, {}).rows[0];
    assert.equal(row.peakSize, null);
    assert.equal(row.entryPrice, null);
    assert.equal(row.exitPrice, null);
});

test('buildYearReport: an incomplete row with fill segments does not leak their SIZE / ENTRY / EXIT', () => {
    // The SELL 3 flips the LONG into a SHORT missing from the position
    // list, so the orphaned SHORT segment lands on the LONG: the
    // attribution holds a peak size and VWAPs, but they mix both segments.
    const long = {
        status: 'CLOSED', market: 'ETH-USD', side: 'LONG',
        createdAt: '2025-01-01T00:00:00Z', closedAt: '2025-01-10T00:00:00Z'
    };
    const fills = [
        { market: 'ETH-USD', side: 'BUY',  createdAt: '2025-01-01T00:00:00Z', createdAtHeight: '1', size: '1', price: '100', fee: '0' },
        { market: 'ETH-USD', side: 'SELL', createdAt: '2025-01-10T00:00:00Z', createdAtHeight: '2', size: '3', price: '110', fee: '0' },
        { market: 'ETH-USD', side: 'BUY',  createdAt: '2026-02-01T00:00:00Z', createdAtHeight: '3', size: '2', price: '50',  fee: '0' }
    ];
    const attribution = window.RiskMetrics.attributeFillsToPositions([long], fills).get(long);
    assert.equal(window.RiskMetrics.hasCompleteAttribution(attribution), false);
    assert.ok(attribution.peakSize > 0 && attribution.entryVwap > 0 && attribution.exitVwap > 0,
        'precondition: the incomplete attribution carries segment values');
    const row = TR.buildYearReport([long], fills, [], 2025, {}).rows[0];
    assert.equal(row.peakSize, null);
    assert.equal(row.entryPrice, null);
    assert.equal(row.exitPrice, null);
    const lines = csvRecords([row]);
    const header = lines[0].split(',');
    const cells = lines[1].split(',');
    assert.equal(cells[header.indexOf('peak_size')], '');
    assert.equal(cells[header.indexOf('entry_price')], '');
    assert.equal(cells[header.indexOf('exit_price')], '');
});

test('toCsv / toJson: SIZE / ENTRY / EXIT drop the float noise of summed fills', () => {
    // 0.1 + 0.2 sums to 0.30000000000000004 and the entry VWAP to
    // 100.16666666666667; the exports carry the size precision the
    // Positions board shows.
    const p = {
        status: 'CLOSED', market: 'ETH-USD', side: 'LONG',
        createdAt: '2024-05-01T00:00:00Z', closedAt: '2024-05-03T00:00:00Z'
    };
    const fills = [
        { market: 'ETH-USD', side: 'BUY',  createdAt: '2024-05-01T00:00:00Z', size: '0.1', price: '100',    fee: '0' },
        { market: 'ETH-USD', side: 'BUY',  createdAt: '2024-05-02T00:00:00Z', size: '0.2', price: '100.25', fee: '0' },
        { market: 'ETH-USD', side: 'SELL', createdAt: '2024-05-03T00:00:00Z', size: '0.1', price: '101',    fee: '0' },
        { market: 'ETH-USD', side: 'SELL', createdAt: '2024-05-03T00:00:00Z', size: '0.2', price: '101',    fee: '0' }
    ];
    const report = TR.buildYearReport([p], fills, [], 2024, {});
    const lines = csvRecords(report.rows);
    const header = lines[0].split(',');
    const cells = lines[1].split(',');
    assert.equal(cells[header.indexOf('peak_size')], '0.3');
    assert.equal(cells[header.indexOf('entry_price')], '100.166666667');
    assert.equal(cells[header.indexOf('exit_price')], '101');
    const jsonRow = JSON.parse(TR.toJson(report.rows, report.totals, 2024)).rows[0];
    assert.equal(jsonRow.peakSize, 0.3);
    assert.equal(jsonRow.entryPrice, 100.166666667);
    assert.equal(jsonRow.exitPrice, 101);
});

test('toCsv / toJson: a price rounds once, from the decimal it stands for, to the size precision', () => {
    // 64012.12345675 is stored just below its 13th-digit tie, so toPrecision reads ...4567.
    const row = { status: 'closed', closedAtISO: '2024-03-12T00:00:00Z', createdAtISO: '2024-03-10T00:00:00Z',
        market: 'BTC-USD', side: 'LONG', entryPrice: 64012.12345675, exitPrice: 64012.12345675 };
    const lines = csvRecords([row]);
    const header = lines[0].split(',');
    assert.equal(lines[1].split(',')[header.indexOf('entry_price')], '64012.1234568');
    assert.equal(JSON.parse(TR.toJson([row], {}, 2024)).rows[0].exitPrice, 64012.1234568);
});

test('buildYearReport: a row with incomplete fill attribution reads null profit and blanks the year totals', () => {
    // The SELL 3 flips the LONG into a SHORT that is missing from the
    // position list (its endpoint failed). The orphaned SHORT segment,
    // including its 2026 close, would otherwise land in the 2025 LONG row.
    const long = {
        status: 'CLOSED', market: 'ETH-USD', side: 'LONG',
        createdAt: '2025-01-01T00:00:00Z', closedAt: '2025-01-10T00:00:00Z'
    };
    const fills = [
        { market: 'ETH-USD', side: 'BUY',  createdAt: '2025-01-01T00:00:00Z', createdAtHeight: '1', size: '1', price: '100', fee: '1' },
        { market: 'ETH-USD', side: 'SELL', createdAt: '2025-01-10T00:00:00Z', createdAtHeight: '2', size: '3', price: '110', fee: '3' },
        { market: 'ETH-USD', side: 'BUY',  createdAt: '2026-02-01T00:00:00Z', createdAtHeight: '3', size: '1', price: '50',  fee: '10' }
    ];
    const payments = [{ ticker: 'ETH-USD', side: 'LONG', createdAt: '2025-01-05T08:00:00Z', payment: '-2' }];
    const r = TR.buildYearReport([long], fills, payments, 2025, { '2025-01-05': 1.25 });
    const row = r.rows[0];
    assert.equal(row._attributionIncomplete, true);
    assert.equal(row.realizedPnlUSD, null);
    assert.equal(row.feesUSD, null);
    assert.equal(row.netUSD, null);
    assert.equal(row.netEUR, undefined);
    assert.ok(close(row.netFundingEUR, -1.6), 'funding does not depend on fills and still converts');
    assert.equal(r.warnings.incompleteAttributionCount, 1);
    assert.equal(r.totals.incompleteCount, 1);
    assert.equal(r.totals.netUSD, undefined);
    assert.equal(r.totals.feesUSD, undefined);
    assert.equal(r.totals.grossGainsUSD, undefined);
    assert.equal(r.totals.netEUR, undefined);
    assert.equal(r.totals.fundingUSD, -2);
});

test('toCsv / toJson: schema 9 exports peak_size and flags incomplete rows with empty profit cells', () => {
    const row = {
        status: 'closed', closedAtISO: '2025-01-10T00:00:00Z', market: 'ETH-USD', side: 'LONG',
        peakSize: null, entryPrice: null, exitPrice: null,
        realizedPnlUSD: null, netFundingUSD: -2, feesUSD: null, netUSD: null,
        fillCount: 2, _attributionIncomplete: true
    };
    const lines = csvRecords([row]);
    const header = lines[0].split(',');
    const cells = lines[1].split(',');
    assert.ok(header.includes('peak_size') && !header.includes('max_size'));
    assert.equal(cells[header.indexOf('attribution_incomplete')], 'true');
    assert.equal(cells[header.indexOf('realized_pnl_usd')], '');
    assert.equal(cells[header.indexOf('fees_usd')], '');
    assert.equal(cells[header.indexOf('net_usd')], '');
    assert.equal(cells[header.indexOf('net_funding_usd')], '-2.00');
    const json = JSON.parse(TR.toJson([row], TR.summarize([row]), 2025));
    assert.equal(json.meta.schemaVersion, 9);
});

test('toJson: meta.asOf dates the figures at the snapshot they were read from, beside generatedAt', () => {
    const snapshotAt = '2025-12-20T09:30:00.000Z';
    const json = JSON.parse(TR.toJson([], TR.summarize([]), 2025, Date.parse(snapshotAt)));
    assert.equal(json.meta.asOf, snapshotAt);
    assert.ok(Date.parse(json.meta.generatedAt) > Date.parse(snapshotAt), 'generatedAt stays the export time');
});

test('toCsv: schema 5 marks each row open or closed and drops the holding-days and single-rate columns', () => {
    const r = TR.buildYearReport([NEW_YEAR_LONG], NEW_YEAR_FILLS, NEW_YEAR_PAYMENTS, 2025, { '2025-12-30': 1.25, '2025-12-31': 1.0 });
    const lines = csvRecords(r.rows);
    const header = lines[0].split(',');
    const cells = lines[1].split(',');
    assert.equal(cells[header.indexOf('status')], 'closed');
    assert.equal(cells[header.indexOf('net_eur')], '47.18');
    for (const retired of ['holding_days', 'fx_usd_per_eur']) {
        assert.ok(!header.includes(retired), retired);
    }
});

test('buildYearReport / toCsv / toJson: schema 3 carries attribution incompleteness once, with its reason', () => {
    // realized_from_fills was always the inverse of attribution_incomplete,
    // and the without-FIFO counter always equalled the incomplete counter:
    // schema 3 keeps only attribution_incomplete and its reason.
    const p = {
        status: 'CLOSED', market: 'BTC-USD', side: 'LONG',
        createdAt: '2024-05-01T00:00:00Z', closedAt: '2024-05-05T00:00:00Z'
    };
    const r = TR.buildYearReport([p], [], [], 2024, {});
    assert.deepEqual(Object.keys(r.warnings).sort(),
        ['feeAttributionAmbiguousCount', 'incompleteAttributionCount', 'missingFxDates',
            'unattributedFillCount', 'unattributedFundingCount']);
    assert.equal(r.warnings.incompleteAttributionCount, 1);
    assert.ok(!('_realizedFromFills' in r.rows[0]), 'row must not carry the redundant flag');

    const lines = csvRecords(r.rows);
    const header = lines[0].split(',');
    const cells = lines[1].split(',');
    assert.ok(!header.includes('realized_from_fills'), 'CSV must drop realized_from_fills');
    assert.equal(cells[header.indexOf('attribution_incomplete')], 'true');
    assert.equal(cells[header.indexOf('realized_fill_error')], 'no-fills-in-window');

    const json = JSON.parse(TR.toJson(r.rows, r.totals, 2024));
    assert.ok(!('_realizedFromFills' in json.rows[0]), 'JSON rows must drop _realizedFromFills');
    assert.equal(json.rows[0]._attributionIncomplete, true);
    assert.equal(json.rows[0]._realizedFillError, 'no-fills-in-window');
});

test('buildYearReport: a position whose closing fill is missing is not from fills', () => {
    // Only the opening BUY arrived: the fills never return to flat, so the
    // attribution is incomplete and the row reads null, not a misleading $0.
    const p = {
        status: 'CLOSED', market: 'BTC-USD', side: 'LONG',
        createdAt: '2024-02-01T00:00:00Z', closedAt: '2024-02-05T00:00:00Z',
        maxSize: '1'
    };
    const fills = [
        { market: 'BTC-USD', side: 'BUY', createdAt: '2024-02-01T00:00:00Z', size: '1', price: '100', fee: '0' }
        // SELL missing — net = +1
    ];
    const r = TR.buildYearReport([p], fills, [], 2024, {});
    assert.equal(r.rows[0]._realizedFillError, 'attribution-incomplete');
    assert.equal(r.rows[0].realizedPnlUSD, null);
    assert.equal(r.rows[0]._attributionIncomplete, true);
    assert.equal(r.warnings.incompleteAttributionCount, 1);
});

test('buildYearReport: a position whose opening fill is missing is not from fills', () => {
    // Symmetric case: closing SELL present but opening BUY absent.
    const p = {
        status: 'CLOSED', market: 'BTC-USD', side: 'LONG',
        createdAt: '2024-03-01T00:00:00Z', closedAt: '2024-03-05T00:00:00Z',
        maxSize: '1'
    };
    const fills = [
        { market: 'BTC-USD', side: 'SELL', createdAt: '2024-03-05T00:00:00Z', size: '1', price: '120', fee: '0' }
    ];
    const r = TR.buildYearReport([p], fills, [], 2024, {});
    assert.equal(r.rows[0]._attributionIncomplete, true);
    assert.equal(r.warnings.incompleteAttributionCount, 1);
});

test('buildYearReport: chained overlaps mark every member of the chain', () => {
    // A overlaps B, B overlaps C, A does not overlap C. The naive
    // short-circuit scan (skip i if already in set, break inner loop
    // on first match) would visit A, mark A and B, then skip B's own
    // scan because B is already in the set — leaving C unmarked even
    // though C overlaps B.
    const a = { status: 'CLOSED', market: 'ETH-USD', side: 'LONG',
        createdAt: '2024-01-10T00:00:00Z', closedAt: '2024-01-20T00:00:00Z',
        maxSize: '1' };
    const b = { status: 'CLOSED', market: 'ETH-USD', side: 'LONG',
        createdAt: '2024-01-15T00:00:00Z', closedAt: '2024-02-05T00:00:00Z',
        maxSize: '1' };
    const c = { status: 'CLOSED', market: 'ETH-USD', side: 'LONG',
        createdAt: '2024-01-25T00:00:00Z', closedAt: '2024-02-10T00:00:00Z',
        maxSize: '1' };
    const r = TR.buildYearReport([a, b, c], [], [], 2024, {});
    // All three rows must be flagged. Naive scan would miss C.
    assert.equal(r.rows.length, 3);
    assert.equal(r.rows.every(row => row._feeAttributionWarning), true,
        'all chained positions must carry the overlap flag');
    assert.equal(r.warnings.feeAttributionAmbiguousCount, 3);
});

test('buildYearReport: boundary fill attributed to closer, not double-counted', () => {
    // Two positions whose windows touch at a single timestamp T:
    //   A: open 10:00, close 11:00
    //   B: open 11:00, close 12:00
    // The 11:00 fills land in BOTH windows under inclusive [open, close]
    // semantics. Old per-window code summed each fill's fee into both
    // positions. Segment attribution gives each fill to exactly one
    // position: the 11:00 SELL closes A's segment, and the 11:00 BUY
    // starts the segment whose first fill matches B's createdAt.
    const a = {
        status: 'CLOSED', market: 'BTC-USD', side: 'LONG',
        createdAt: '2024-01-10T10:00:00Z', closedAt: '2024-01-10T11:00:00Z',
        maxSize: '1'
    };
    const b = {
        status: 'CLOSED', market: 'BTC-USD', side: 'LONG',
        createdAt: '2024-01-10T11:00:00Z', closedAt: '2024-01-10T12:00:00Z',
        maxSize: '1'
    };
    // BUY 1@100 opens A. SELL 1@110 closes A. BUY 1@110 opens B.
    // SELL 1@120 closes B.
    const fills = [
        { market: 'BTC-USD', side: 'BUY',  createdAt: '2024-01-10T10:00:00Z', size: '1', price: '100', fee: '0.10' },
        { market: 'BTC-USD', side: 'SELL', createdAt: '2024-01-10T11:00:00Z', size: '1', price: '110', fee: '0.20' },
        { market: 'BTC-USD', side: 'BUY',  createdAt: '2024-01-10T11:00:00Z', size: '1', price: '110', fee: '0.20' },
        { market: 'BTC-USD', side: 'SELL', createdAt: '2024-01-10T12:00:00Z', size: '1', price: '120', fee: '0.10' }
    ];
    const r = TR.buildYearReport([a, b], fills, [], 2024, {});
    // Total realized = (110-100)*1 + (120-110)*1 = 20. Total fees over
    // all 4 fills = 0.60. Net = 20 - 0.60 = 19.40. Old code would either
    // gate-zero the rows (slice not flat in isolation) or double-count
    // boundary fees.
    const sumRealized = r.rows.reduce((s, row) => s + row.realizedPnlUSD, 0);
    const sumFees = r.rows.reduce((s, row) => s + row.feesUSD, 0);
    const sumNet = r.rows.reduce((s, row) => s + row.netUSD, 0);
    assert.ok(close(sumRealized, 20), `realized sum: ${sumRealized}`);
    assert.ok(close(sumFees, 0.60), `fees sum: ${sumFees}`);
    assert.ok(close(sumNet, 19.40), `net sum: ${sumNet}`);
});

test('buildYearReport: a segment that returns to flat after its position closed leaves both rows incomplete', () => {
    // The indexer closes A at 11:00 and opens B at 10:30, but the fills
    // hold one segment: BUY 2 at A's createdAt, SELL 2 at 12:00 (B's
    // closedAt). The SELL cannot be A's closing fill, since A was already
    // closed, and B has no opening fill, so neither row ties to its own
    // fills: both read null and the year's fills-derived totals are
    // undefined rather than crediting A with the SELL's 120.
    const a = {
        status: 'CLOSED', market: 'BTC-USD', side: 'LONG',
        createdAt: '2024-01-10T10:00:00Z', closedAt: '2024-01-10T11:00:00Z',
        maxSize: '2'
    };
    const b = {
        status: 'CLOSED', market: 'BTC-USD', side: 'LONG',
        createdAt: '2024-01-10T10:30:00Z', closedAt: '2024-01-10T12:00:00Z',
        maxSize: '2'
    };
    const fills = [
        { market: 'BTC-USD', side: 'BUY',  createdAt: '2024-01-10T10:00:00Z', size: '2', price: '100', fee: '0' },
        { market: 'BTC-USD', side: 'SELL', createdAt: '2024-01-10T12:00:00Z', size: '2', price: '160', fee: '0' }
    ];
    const r = TR.buildYearReport([a, b], fills, [], 2024, {});
    const rowA = r.rows.find(row => row.createdAtISO === a.createdAt);
    const rowB = r.rows.find(row => row.createdAtISO === b.createdAt);
    assert.equal(rowA.realizedPnlUSD, null);
    assert.equal(rowA._attributionIncomplete, true);
    assert.equal(rowB.realizedPnlUSD, null);
    assert.equal(rowB._attributionIncomplete, true);
    assert.equal(r.totals.netUSD, undefined);
    assert.equal(r.totals.incompleteCount, 2);
});

test('buildYearReport: flip fill fee split pro-rata between the closed LONG and the SHORT it opens', () => {
    // SELL 5 @150 closes the 2-unit LONG and opens a 3-unit SHORT in one
    // fill. Its $5 fee is split by size: 2/5 to the LONG row, 3/5 to the
    // SHORT row. The year's fee total is unchanged by the split.
    const long = {
        status: 'CLOSED', market: 'ETH-USD', side: 'LONG',
        createdAt: '2024-01-10T00:00:00Z', closedAt: '2024-01-11T00:00:00Z'
    };
    const short = {
        status: 'CLOSED', market: 'ETH-USD', side: 'SHORT',
        createdAt: '2024-01-11T00:00:00Z', closedAt: '2024-01-12T00:00:00Z'
    };
    const fills = [
        { market: 'ETH-USD', side: 'BUY',  createdAt: '2024-01-10T00:00:00Z', createdAtHeight: '1', size: '2', price: '100', fee: '1' },
        { market: 'ETH-USD', side: 'SELL', createdAt: '2024-01-11T00:00:00Z', createdAtHeight: '2', size: '5', price: '150', fee: '5' },
        { market: 'ETH-USD', side: 'BUY',  createdAt: '2024-01-12T00:00:00Z', createdAtHeight: '3', size: '3', price: '120', fee: '0.6' }
    ];
    const r = TR.buildYearReport([long, short], fills, [], 2024, {});
    const longRow = r.rows.find(row => row.side === 'LONG');
    const shortRow = r.rows.find(row => row.side === 'SHORT');
    assert.ok(close(longRow.realizedPnlUSD, 100), `long realized ${longRow.realizedPnlUSD}`);
    assert.ok(close(longRow.feesUSD, 3), `long fees ${longRow.feesUSD}`);
    assert.ok(close(shortRow.realizedPnlUSD, 90), `short realized ${shortRow.realizedPnlUSD}`);
    assert.ok(close(shortRow.feesUSD, 3.6), `short fees ${shortRow.feesUSD}`);
    assert.ok(close(r.totals.feesUSD, 6.6));
});

test('buildYearReport: heavy-scaling LONG matches continuous FIFO realized', () => {
    // Single LONG position, scaled in twice then exited in two SELLs.
    // FIFO: (150-100)*2 + (160-120)*3 = 100 + 120 = 220.
    const p = {
        status: 'CLOSED', market: 'BTC-USD', side: 'LONG',
        createdAt: '2024-01-01T00:00:00Z', closedAt: '2024-01-10T00:00:00Z',
        maxSize: '5'
    };
    const fills = [
        { market: 'BTC-USD', side: 'BUY',  createdAt: '2024-01-01T00:00:00Z', size: '2', price: '100', fee: '0' },
        { market: 'BTC-USD', side: 'BUY',  createdAt: '2024-01-02T00:00:00Z', size: '3', price: '120', fee: '0' },
        { market: 'BTC-USD', side: 'SELL', createdAt: '2024-01-08T00:00:00Z', size: '2', price: '150', fee: '0' },
        { market: 'BTC-USD', side: 'SELL', createdAt: '2024-01-10T00:00:00Z', size: '3', price: '160', fee: '0' }
    ];
    const r = TR.buildYearReport([p], fills, [], 2024, {});
    assert.equal(r.rows.length, 1);
    assert.ok(close(r.rows[0].realizedPnlUSD, 220),
        `expected 220, got ${r.rows[0].realizedPnlUSD}`);
});

test('buildYearReport: rows sorted by closedAt descending', () => {
    const positions = [
        { status: 'CLOSED', market: 'ETH-USD', side: 'LONG',
          createdAt: '2024-01-01T00:00:00Z', closedAt: '2024-01-05T00:00:00Z',
          maxSize: '1' },
        { status: 'CLOSED', market: 'ETH-USD', side: 'LONG',
          createdAt: '2024-02-01T00:00:00Z', closedAt: '2024-02-05T00:00:00Z',
          maxSize: '1' }
    ];
    const r = TR.buildYearReport(positions, [], [], 2024, {});
    assert.equal(r.rows[0].closedAtISO, '2024-02-05T00:00:00Z');
    assert.equal(r.rows[1].closedAtISO, '2024-01-05T00:00:00Z');
});

test('buildYearReport: closes in one millisecond list newest first in chain order, whatever the listing order', () => {
    const OPEN_BTC = '2024-03-01T00:00:00Z', OPEN_ETH = '2024-03-01T01:00:00Z', CLOSE = '2024-03-01T02:00:00Z';
    const fill = (market, createdAt, height, side, size, price) =>
        ({ market, createdAt, createdAtHeight: String(height), side, size: String(size), price: String(price), fee: '0' });
    const closed = (market, side, createdAt) => ({ status: 'CLOSED', market, side, createdAt, closedAt: CLOSE });
    // Cross-market: in the closing block ETH's close comes first, BTC's last.
    const crossFills = [
        fill('BTC-USD', OPEN_BTC, 10, 'BUY', 1, 100),
        fill('ETH-USD', OPEN_ETH, 20, 'BUY', 1, 50),
        fill('ETH-USD', CLOSE, 30, 'SELL', 1, 40),
        fill('BTC-USD', CLOSE, 30, 'SELL', 1, 120)
    ];
    const btc = closed('BTC-USD', 'LONG', OPEN_BTC), eth = closed('ETH-USD', 'LONG', OPEN_ETH);
    [[eth, btc], [btc, eth]].forEach(listed => {
        const r = TR.buildYearReport(listed, crossFills, [], 2024, {});
        assert.deepEqual(r.rows.map(row => row.market), ['BTC-USD', 'ETH-USD'], `listed ${listed.map(p => p.market)}`);
    });
    // A reversal pair: a LONG reversed by a SELL 2, the SHORT it opens closed by a BUY 1, all at CLOSE.
    const flipFills = [
        fill('BTC-USD', OPEN_BTC, 10, 'BUY', 1, 100),
        fill('BTC-USD', CLOSE, 30, 'SELL', 2, 110),
        fill('BTC-USD', CLOSE, 30, 'BUY', 1, 105)
    ];
    const long = closed('BTC-USD', 'LONG', OPEN_BTC), short = closed('BTC-USD', 'SHORT', CLOSE);
    [[long, short], [short, long]].forEach(listed => {
        const r = TR.buildYearReport(listed, flipFills, [], 2024, {});
        assert.deepEqual(r.rows.map(row => row.side), ['SHORT', 'LONG'], `listed ${listed.map(p => p.side)}`);
    });
});

// ---------------------------------------------------------------------------
// convertRowsToEur — idempotent: stale EUR/_fxMissing reset on re-call.
// ---------------------------------------------------------------------------

// A row whose realized, funding and fees all fell on one UTC date.
function oneDayRow(date, realized, funding, fees) {
    return {
        realizedPnlUSD: realized, netFundingUSD: funding, feesUSD: fees,
        netUSD: realized + funding - fees,
        eventsByDate: [{ date, realizedUSD: realized, fundingUSD: funding, feesUSD: fees }],
        _fxMissing: false
    };
}

test('convertRowsToEur: present rate populates EUR mirrors', () => {
    const rows = [oneDayRow('2024-03-12', 100, -2, 1.25)];
    const warnings = { missingFxDates: [] };
    TR.convertRowsToEur(rows, { '2024-03-12': 1.25 }, warnings);
    assert.equal(rows[0].eventsByDate[0].usdPerEur, 1.25);
    assert.ok(close(rows[0].realizedPnlEUR, 80));
    assert.ok(close(rows[0].netFundingEUR, -1.6));
    assert.ok(close(rows[0].feesEUR, 1));
    assert.ok(close(rows[0].netEUR, 77.4));
    assert.equal(rows[0]._fxMissing, false);
    assert.equal(warnings.missingFxDates.length, 0);
});

test('convertRowsToEur: EUR = USD / ECB quote, not USD × a rounded inverse', () => {
    // A synthetic EUR/USD quote of 1.2345. Frankfurter's USD→EUR would be
    // round(1 / 1.2345, 5) = 0.81004 and give 81004.00.
    const rows = [oneDayRow('2024-06-12', 100000, 0, 0)];
    TR.convertRowsToEur(rows, { '2024-06-12': 1.2345 }, { missingFxDates: [] });
    assert.equal(rows[0].netEUR.toFixed(2), '81004.46');
    assert.equal(rows[0].eventsByDate[0].usdPerEur, 1.2345);
});

test('convertRowsToEur: an event\'s EUR is its USD cents ÷ quote rounded to cents once, half away from zero', () => {
    // At a synthetic quote of 1.2001, 48.01 / 1.2001 = 40.004999583… and
    // 168.02 / 1.2001 = 140.004999583…: each just below a half cent, so
    // they read 40.00 and 140.00, never rounded first to the micro.
    const atQuote = (date, realized, funding, quote) => {
        const rows = [oneDayRow(date, realized, funding, 0)];
        TR.convertRowsToEur(rows, { [date]: quote }, { missingFxDates: [] });
        return rows[0];
    };
    const near = atQuote('2025-03-03', 48.01, 0, 1.2001);
    assert.equal(near.eventsByDate[0].realizedEUR, 40);
    assert.equal(near.realizedPnlEUR, 40);
    assert.equal(atQuote('2025-03-03', -48.01, 0, 1.2001).realizedPnlEUR, -40);
    const pair = atQuote('2025-03-04', 48.01, 168.02, 1.2001);
    assert.deepEqual([pair.eventsByDate[0].realizedEUR, pair.eventsByDate[0].fundingEUR], [40, 140]);
    assert.equal(pair.netEUR, 180);
    // An exact half cent rounds away from zero: 0.05 / 4 = 0.0125 → 0.01;
    // 0.10 / 4 = 0.025 → 0.03, −0.10 / 4 → −0.03.
    assert.equal(atQuote('2025-03-05', 0.1, 0, 4).realizedPnlEUR, 0.03);
    assert.equal(atQuote('2025-03-05', -0.1, 0, 4).realizedPnlEUR, -0.03);
    assert.equal(atQuote('2025-03-05', 0.05, 0, 4).realizedPnlEUR, 0.01);
});

test('convertRowsToEur: absent rate flags row and pushes to missing', () => {
    const rows = [oneDayRow('2024-03-12', 100, 0, 0)];
    const warnings = { missingFxDates: [] };
    TR.convertRowsToEur(rows, {}, warnings);
    assert.equal(rows[0].eventsByDate[0].usdPerEur, undefined);
    assert.equal(rows[0].netEUR, undefined);
    assert.equal(rows[0]._fxMissing, true);
    assert.deepEqual(warnings.missingFxDates, ['2024-03-12']);
});

test('convertRowsToEur: idempotent — second call with rate clears stale _fxMissing', () => {
    const rows = [oneDayRow('2024-03-12', 100, 0, 0)];
    TR.convertRowsToEur(rows, {}, { missingFxDates: [] });
    assert.equal(rows[0]._fxMissing, true);
    TR.convertRowsToEur(rows, { '2024-03-12': 1.25 }, { missingFxDates: [] });
    assert.equal(rows[0]._fxMissing, false);
    assert.equal(rows[0].eventsByDate[0].usdPerEur, 1.25);
    assert.ok(close(rows[0].netEUR, 80));
});

test('convertRowsToEur: idempotent — second call without rate clears stale EUR', () => {
    const rows = [oneDayRow('2024-03-12', 100, 0, 0)];
    TR.convertRowsToEur(rows, { '2024-03-12': 1.25 }, { missingFxDates: [] });
    assert.ok(close(rows[0].netEUR, 80));
    TR.convertRowsToEur(rows, {}, { missingFxDates: [] });
    assert.equal(rows[0].eventsByDate[0].usdPerEur, undefined);
    assert.equal(rows[0].netEUR, undefined);
    assert.equal(rows[0]._fxMissing, true);
});

test('convertRowsToEur: idempotent — stale missingFxDates cleared on re-run with rates', () => {
    // First call: rate unavailable → date added to warnings.missingFxDates.
    // Second call on same rows with rate available must NOT leave the
    // stale date in the warnings array.
    const rows = [oneDayRow('2024-03-12', 100, 0, 0)];
    const warnings = { missingFxDates: [] };
    TR.convertRowsToEur(rows, {}, warnings);
    assert.deepEqual(warnings.missingFxDates, ['2024-03-12']);
    TR.convertRowsToEur(rows, { '2024-03-12': 1.25 }, warnings);
    assert.deepEqual(warnings.missingFxDates, [],
        'stale missing date must be cleared when rate becomes available');
});

test('convertRowsToEur: deduplicates missing dates', () => {
    const rows = [oneDayRow('2024-03-12', 1, 0, 0), oneDayRow('2024-03-12', 2, 0, 0)];
    const warnings = { missingFxDates: [] };
    TR.convertRowsToEur(rows, {}, warnings);
    assert.deepEqual(warnings.missingFxDates, ['2024-03-12']);
});

// ---------------------------------------------------------------------------
// summarize — totals + win/loss bucketing.
// ---------------------------------------------------------------------------

test('summarize: gross gains/losses bucket by netUSD sign', () => {
    const rows = [
        { netUSD: 100, netEUR: 80, feesUSD: 1, feesEUR: 0.8, netFundingUSD: 0, netFundingEUR: 0, _fxConverted: true },
        { netUSD: -40, netEUR: -32, feesUSD: 0.5, feesEUR: 0.4, netFundingUSD: -1, netFundingEUR: -0.8, _fxConverted: true },
        { netUSD: 0, netEUR: 0, feesUSD: 0, feesEUR: 0, netFundingUSD: 0, netFundingEUR: 0, _fxConverted: true }
    ];
    const s = TR.summarize(rows);
    assert.equal(s.count, 3);
    assert.equal(s.winCount, 1);
    assert.equal(s.lossCount, 1);
    assert.equal(s.scratchCount, 1);
    assert.ok(close(s.netUSD, 60));
    assert.ok(close(s.grossGainsUSD, 100));
    assert.ok(close(s.grossLossesUSD, -40));
    assert.ok(close(s.netEUR, 48));
    assert.equal(s.eurPartial, false);
});

test('CLASSIFICATION: perpetuals are Categoria G derivative operations (CIRS art. 10.º n.º 1 e)), the one category', () => {
    assert.equal(TR.CLASSIFICATION.id, 'G');
    assert.equal(TR.CLASSIFICATION.label,
        'Categoria G — mais-valias, operações com instrumentos derivados (art. 10.º n.º 1 e) CIRS)');
    assert.match(TR.CLASSIFICATION.note, /accountant/);
    assert.ok(!('CLASSIFICATIONS' in TR), 'the E / G choice is gone');
});

test('summarize: zero EUR coverage collapses EUR totals to undefined', () => {
    const rows = [
        { netUSD: 10, netEUR: undefined, feesUSD: 0, feesEUR: undefined, netFundingUSD: 0, netFundingEUR: undefined, _fxConverted: false },
        { netUSD: 20, netEUR: undefined, feesUSD: 0, feesEUR: undefined, netFundingUSD: 0, netFundingEUR: undefined, _fxConverted: false }
    ];
    const s = TR.summarize(rows);
    assert.equal(s.netEUR, undefined);
    assert.equal(s.grossGainsEUR, undefined);
    assert.equal(s.grossLossesEUR, undefined);
    assert.equal(s.eurRowCount, 0);
    assert.equal(s.eurMissingCount, 2);
    assert.equal(s.eurPartial, false); // partial only when SOME rows have rate AND some don't
});

test('summarize: a year whose rows all converted keeps its funding EUR, though no row\'s fills are complete', () => {
    const rows = [{
        status: 'closed', _attributionIncomplete: true, _fxConverted: true,
        realizedPnlUSD: null, feesUSD: null, netUSD: null, netFundingUSD: -5, netFundingEUR: -4
    }];
    const s = TR.summarize(rows);
    assert.equal(s.fundingUSD, -5);
    assert.equal(s.fundingEUR, -4);
    assert.equal(s.eurComplete, true);
    assert.equal(s.feesEUR, undefined, 'the fills-derived EUR totals stay unknown');
    assert.equal(s.netEUR, undefined);
});

test('summarize: a row without FX makes every EUR total undefined, not a partial sum', () => {
    const rows = [
        { netUSD: 10, netEUR: 8, feesUSD: 1, feesEUR: 0.8, netFundingUSD: -5, netFundingEUR: -4, _fxConverted: true },
        { netUSD: -20, netEUR: undefined, feesUSD: 2, feesEUR: undefined, netFundingUSD: -3, netFundingEUR: undefined, _fxConverted: false }
    ];
    const s = TR.summarize(rows);
    assert.equal(s.eurPartial, true);
    assert.equal(s.eurRowCount, 1);
    assert.equal(s.eurMissingCount, 1);
    // A sum over the converted rows alone would sit beside USD totals
    // covering every row and read as their conversion.
    for (const key of ['netEUR', 'grossGainsEUR', 'grossLossesEUR', 'feesEUR', 'fundingEUR']) {
        assert.equal(s[key], undefined, key);
    }
    assert.ok(close(s.netUSD, -10), 'USD totals still cover every row');
    assert.ok(close(s.fundingUSD, -8));
});

test('summarize: the EUR gross lines bucket each row by the sign of its own NET EUR', () => {
    // Per-event conversion can turn a USD gain into an EUR loss: a fee
    // paid on a low-quote day outweighs a gain on a high-quote day.
    const rows = [{ netUSD: 1, netEUR: -2.92, feesUSD: 0, feesEUR: 0, netFundingUSD: 0, netFundingEUR: 0, _fxConverted: true }];
    const s = TR.summarize(rows);
    assert.equal(s.grossGainsUSD, 1);
    assert.equal(s.grossLossesUSD, 0);
    assert.equal(s.grossGainsEUR, 0);
    assert.equal(s.grossLossesEUR, -2.92);
    assert.equal(s.winCount, 1, 'W / L / S stay on NET USD');
});

// ---------------------------------------------------------------------------
// Cents: every row amount is rounded to cents (EUR per event date), NET
// derives from the rounded parts and every total sums the rows' cents, so
// the screen, the CSV and the JSON foot as displayed.
// ---------------------------------------------------------------------------

test('buildYearReport: a row\'s NET is its cent-rounded realized + funding − fees, in the row and the CSV', () => {
    // Realized 10.006 and funding 0.006 each round up to the next cent;
    // their raw sum 10.012 would round down to 10.01.
    const p = {
        status: 'CLOSED', market: 'ETH-USD', side: 'LONG',
        createdAt: '2024-03-10T00:00:00Z', closedAt: '2024-03-11T00:00:00Z'
    };
    const fills = [
        { market: 'ETH-USD', side: 'BUY',  createdAt: '2024-03-10T00:00:00Z', size: '1', price: '1000', fee: '0' },
        { market: 'ETH-USD', side: 'SELL', createdAt: '2024-03-11T00:00:00Z', size: '1', price: '1010.006', fee: '0' }
    ];
    const payments = [{ ticker: 'ETH-USD', side: 'LONG', createdAt: '2024-03-10T08:00:00Z', payment: '0.006' }];
    const r = TR.buildYearReport([p], fills, payments, 2024, null);
    const row = r.rows[0];
    assert.equal(row.realizedPnlUSD, 10.01);
    assert.equal(row.netFundingUSD, 0.01);
    assert.equal(row.netUSD, 10.02);
    assert.equal(r.totals.netUSD, 10.02);
    const lines = csvRecords(r.rows);
    const header = lines[0].split(',');
    const cells = lines[1].split(',');
    assert.equal(cells[header.indexOf('net_usd')], '10.02');
});

test('summarize: every total is the sum of the rows\' cents, so two $0.004 rows total $0.00', () => {
    const row = { netUSD: 0.004, netEUR: 0.004, feesUSD: 0.004, feesEUR: 0.004,
        netFundingUSD: 0.004, netFundingEUR: 0.004, _fxConverted: true };
    const s = TR.summarize([{ ...row }, { ...row }]);
    for (const key of ['netUSD', 'netEUR', 'grossGainsUSD', 'grossGainsEUR', 'feesUSD', 'feesEUR', 'fundingUSD', 'fundingEUR']) {
        assert.equal(s[key], 0, key);
    }
    assert.equal(s.scratchCount, 2, 'a net that displays as $0.00 is a scratch');
});

test('summarize: cent totals carry no float drift (0.10 + 0.20 is 0.30)', () => {
    const rows = [0.1, 0.2].map(v => ({ netUSD: v, feesUSD: v, netFundingUSD: v }));
    const s = TR.summarize(rows);
    assert.equal(s.netUSD, 0.3);
    assert.equal(s.feesUSD, 0.3);
});

test('buildYearReport: a loss and a rebate on a half-cent tie round away from zero, as gains and fees do', () => {
    const p = (day) => ({ status: 'CLOSED', market: 'ETH-USD', side: 'LONG',
        createdAt: `2024-03-${day}T00:00:00Z`, closedAt: `2024-03-${day}T01:00:00Z` });
    const trade = (day, exit, fee) => [
        ethFill(`2024-03-${day}T00:00:00Z`, 'BUY', '0.5', '100', fee),
        ethFill(`2024-03-${day}T01:00:00Z`, 'SELL', '0.5', exit, '0')
    ];
    const r = TR.buildYearReport([p('10'), p('11')], [...trade('10', '99.75', '-0.015'), ...trade('11', '100.25', '0.015')], [], 2024, null);
    const byDay = Object.fromEntries(r.rows.map(row => [row.createdAtISO.slice(8, 10), row]));
    assert.deepEqual([byDay['10'].realizedPnlUSD, byDay['10'].feesUSD], [-0.13, -0.02]);
    assert.deepEqual([byDay['11'].realizedPnlUSD, byDay['11'].feesUSD], [0.13, 0.02]);
});

test('buildYearReport: FIFO realized on an exact half cent rounds as the decimal, not the float below it', () => {
    const p = { status: 'CLOSED', market: 'BTC-USD', side: 'LONG', createdAt: '2024-03-10T00:00:00Z', closedAt: '2024-03-10T01:00:00Z' };
    const fills = [
        { market: 'BTC-USD', side: 'BUY',  createdAt: '2024-03-10T00:00:00Z', size: '0.5', price: '64000.1', fee: '0' },
        { market: 'BTC-USD', side: 'SELL', createdAt: '2024-03-10T01:00:00Z', size: '0.5', price: '64000.13', fee: '0' }
    ];
    assert.equal(TR.buildYearReport([p], fills, [], 2024, null).rows[0].realizedPnlUSD, 0.02);
});

test('buildYearReport: FIFO realized just under a half cent reads $0.00, rounded once from the exact decimal', () => {
    // (150.0000396 − 100.00004) × 0.0001 is exactly 0.00499999996.
    const p = { status: 'CLOSED', market: 'BTC-USD', side: 'LONG', createdAt: '2024-03-10T00:00:00Z', closedAt: '2024-03-10T01:00:00Z' };
    const fills = [
        { market: 'BTC-USD', side: 'BUY',  createdAt: '2024-03-10T00:00:00Z', size: '0.0001', price: '100.00004', fee: '0' },
        { market: 'BTC-USD', side: 'SELL', createdAt: '2024-03-10T01:00:00Z', size: '0.0001', price: '150.0000396', fee: '0' }
    ];
    const r = TR.buildYearReport([p], fills, [], 2024, null);
    assert.deepEqual([r.rows[0].realizedPnlUSD, r.rows[0].netUSD], [0, 0]);
    assert.deepEqual(r.rows[0].eventsByDate.map(e => e.realizedUSD), [0]);
});

test('toJson: each event date\'s USD amounts are at cents, and its EUR converts from those cents', () => {
    // Fees 0.1 + 0.2 on one date (0.30000000000000004 in binary floats)
    // and a 0.0054 fee on another, at 1.1 USD per EUR: $0.01, so €0.01
    // (0.0054 / 1.1 would round to €0.00 beside the row's $0.01).
    const p = { status: 'CLOSED', market: 'ETH-USD', side: 'LONG', createdAt: '2024-03-10T00:00:00Z', closedAt: '2024-03-11T00:00:00Z' };
    const fills = [
        ethFill('2024-03-10T00:00:00Z', 'BUY', '1', '100', '0.1'),
        ethFill('2024-03-10T00:00:01Z', 'BUY', '1', '100', '0.2'),
        ethFill('2024-03-11T00:00:00Z', 'SELL', '2', '100', '0.0054')
    ];
    const payments = [ethPayment('2024-03-10T08:00:00Z', '0.1'), ethPayment('2024-03-10T09:00:00Z', '0.2')];
    const r = TR.buildYearReport([p], fills, payments, 2024, { '2024-03-10': 1.1, '2024-03-11': 1.1 });
    const events = JSON.parse(TR.toJson(r.rows, r.totals, 2024)).rows[0].eventsByDate;
    assert.deepEqual(events.map(e => [e.date, e.feesUSD, e.fundingUSD, e.realizedUSD]),
        [['2024-03-10', 0.3, 0.3, 0], ['2024-03-11', 0.01, 0, 0]]);
    assert.deepEqual(events.map(e => e.feesEUR), [0.27, 0.01]);
    assert.equal(r.rows[0].feesEUR, 0.28);
    assert.equal(r.rows[0].feesUSD, 0.31);
});

test('buildYearReport: each event date\'s realized USD is that date\'s exact FIFO sum at cents', () => {
    // (100.3 − 100) × 0.05 is the decimal 0.015 on the closing date: $0.02.
    const p = { status: 'CLOSED', market: 'ETH-USD', side: 'LONG', createdAt: '2024-03-10T00:00:00Z', closedAt: '2024-03-11T00:00:00Z' };
    const fills = [
        ethFill('2024-03-10T00:00:00Z', 'BUY', '0.05', '100', '0'),
        ethFill('2024-03-11T00:00:00Z', 'SELL', '0.05', '100.3', '0')
    ];
    const row = TR.buildYearReport([p], fills, [], 2024, null).rows[0];
    assert.deepEqual(row.eventsByDate.map(e => [e.date, e.realizedUSD]), [['2024-03-10', 0], ['2024-03-11', 0.02]]);
    assert.equal(row.realizedPnlUSD, 0.02);
});

test('convertRowsToEur: EUR rounds to cents per event date, and NET EUR derives from the rounded parts', () => {
    // 0.006 USD realized on each of two dates at 1.0: €0.01 per date, so
    // €0.02 for the row although its USD realized is 0.012 → $0.01.
    const row = {
        realizedPnlUSD: 0.01, netFundingUSD: 0, feesUSD: 0, netUSD: 0.01,
        eventsByDate: [
            { date: '2024-03-12', realizedUSD: 0.006, fundingUSD: 0, feesUSD: 0 },
            { date: '2024-03-13', realizedUSD: 0.006, fundingUSD: 0, feesUSD: 0 }
        ]
    };
    TR.convertRowsToEur([row], { '2024-03-12': 1, '2024-03-13': 1 }, { missingFxDates: [] });
    assert.deepEqual(row.eventsByDate.map(e => e.realizedEUR), [0.01, 0.01]);
    assert.equal(row.realizedPnlEUR, 0.02);
    assert.equal(row.netEUR, 0.02);
});

// ---------------------------------------------------------------------------
// toCsv — RFC 4180 escaping + new FIFO delta columns.
// ---------------------------------------------------------------------------


test('toCsv: RFC 4180 escapes comma, quote, newline', () => {
    const rows = [{
        closedAtISO: '2024-03-12T00:00:00Z',
        createdAtISO: '2024-03-10T00:00:00Z',
        closedDateUTC: '2024-03-12',
        market: 'ETH,USD',
        side: 'LO"NG',
        maxSize: 1, entryPrice: 3000, exitPrice: 3100,
        realizedPnlUSD: 100, netFundingUSD: 0, feesUSD: 0, netUSD: 100,
        realizedPnlEUR: 92, netFundingEUR: 0, feesEUR: 0, netEUR: 92,
        fillCount: 2,
        _feeAttributionWarning: false,
        _fxMissing: false
    }];
    const lines = csvRecords(rows);
    assert.ok(lines[0].startsWith('status,closed_at_utc,'), 'header first');
    assert.ok(lines[1].includes('"ETH,USD"'), `expected quoted market, got: ${lines[1]}`);
    assert.ok(lines[1].includes('"LO""NG"'), `expected doubled quotes, got: ${lines[1]}`);
});

test('toCsv: EUR cells convert at the ECB quote as published', () => {
    const rows = [{ ...oneDayRow('2024-06-12', 100000, 0, 0), market: 'ETH-USD', side: 'LONG', fillCount: 2 }];
    TR.convertRowsToEur(rows, { '2024-06-12': 1.2345 }, { missingFxDates: [] });
    const lines = csvRecords(rows);
    const header = lines[0].split(',');
    const cells = lines[1].split(',');
    assert.ok(!header.includes('fx_rate_usd_eur'), 'the USD→EUR column is retired');
    assert.equal(cells[header.indexOf('net_eur')], '81004.46');
});

test('toCsv: an amount that rounds to zero is written 0.00, never -0.00', () => {
    const rows = [{ ...oneDayRow('2025-03-12', 0, -0.001, -0.004), market: 'ETH-USD', side: 'LONG', fillCount: 2 }];
    TR.convertRowsToEur(rows, { '2025-03-12': 1.25 }, { missingFxDates: [] });
    const lines = csvRecords(rows);
    const header = lines[0].split(',');
    const cells = lines[1].split(',');
    for (const col of ['net_funding_usd', 'fees_usd', 'net_funding_eur', 'fees_eur']) {
        assert.equal(cells[header.indexOf(col)], '0.00', col);
    }
});

test('toCsv: empty EUR cells when the row has no FX', () => {
    const rows = [{
        closedAtISO: '2024-03-12T00:00:00Z',
        createdAtISO: '2024-03-10T00:00:00Z',
        closedDateUTC: '2024-03-12',
        market: 'ETH-USD', side: 'LONG',
        maxSize: 1, entryPrice: 3000, exitPrice: 3100,
        realizedPnlUSD: 100, netFundingUSD: 0, feesUSD: 0, netUSD: 100,
        realizedPnlEUR: undefined, netFundingEUR: undefined,
        feesEUR: undefined, netEUR: undefined,
        fillCount: 2,
        _feeAttributionWarning: false,
        _fxMissing: true
    }];
    const lines = csvRecords(rows);
    const dataRow = lines[1];
    assert.ok(dataRow.includes(',,,,,'), `expected four empty EUR fields, got: ${dataRow}`);
});

test('toJson: undefined fields serialize as null (stable schema across FX coverage)', () => {
    // JSON.stringify silently drops undefined object values, so without
    // explicit nullification a row with no EUR rate would lose its
    // netEUR / realizedPnlEUR keys entirely — making the exported shape vary
    // with FX coverage and breaking downstream "is field present?"
    // checks.
    const rows = [{
        closedAtISO: '2024-03-12T00:00:00Z',
        market: 'ETH-USD', side: 'LONG',
        realizedPnlUSD: 100, netFundingUSD: 0, feesUSD: 0, netUSD: 100,
        netEUR: undefined,
        realizedPnlEUR: undefined, netFundingEUR: undefined, feesEUR: undefined
    }];
    const totals = TR.summarize(rows);
    const out = JSON.parse(TR.toJson(rows, totals, 2024));
    assert.equal(out.rows[0].realizedPnlEUR, null, 'realizedPnlEUR must be null, not absent');
    assert.equal(out.rows[0].netEUR, null);
    assert.equal(out.totals.netEUR, null, 'totals.netEUR must be null when no EUR coverage');
    // Ensure the key actually exists (not just absent-and-defaulted)
    assert.ok('realizedPnlEUR' in out.rows[0]);
    assert.ok('netEUR' in out.totals);
});

test('toCsv: invalid_fill_in_window column exports _hasInvalidFill', () => {
    // External consumers branch on this column without re-deriving the
    // condition from `realized_fill_error`.
    const rows = [{
        closedAtISO: '2024-01-15T00:00:00Z',
        createdAtISO: '2024-01-10T00:00:00Z',
        closedDateUTC: '2024-01-15',
        market: 'BTC-USD', side: 'LONG',
        maxSize: 1, entryPrice: 100, exitPrice: 0,
        realizedPnlUSD: 0, netFundingUSD: 0, feesUSD: 0, netUSD: 0,
        realizedPnlEUR: undefined, netFundingEUR: undefined,
        feesEUR: undefined, netEUR: undefined,
        fillCount: 1,
        _realizedFillError: 'invalid-fill-in-slice',
        _hasInvalidFill: true,
        _attributionIncomplete: true,
        _feeAttributionWarning: false,
        _fxMissing: true
    }];
    const lines = csvRecords(rows);
    const header = lines[0].split(',');
    const dataRow = lines[1].split(',');
    const idx = header.indexOf('invalid_fill_in_window');
    assert.ok(idx >= 0, 'header must include invalid_fill_in_window column');
    assert.equal(dataRow[idx], 'true');
});

test('buildYearReport: a fill with unparseable createdAt stays out of FIFO and leaves the row incomplete', () => {
    // A fill with no usable timestamp cannot be placed in the market's
    // chronology, so the attribution walk leaves it out (it must not
    // consume inventory) and cannot vouch for any position in that market.
    const p = {
        status: 'CLOSED', market: 'BTC-USD', side: 'LONG',
        createdAt: '2024-01-10T00:00:00Z', closedAt: '2024-01-15T00:00:00Z',
        maxSize: '1'
    };
    const fills = [
        // unparseable createdAt — must be ignored by BOTH FIFO + windowing
        { market: 'BTC-USD', createdAt: 'not-a-date',           side: 'BUY',  size: '999', price: '1', fee: '0' },
        { market: 'BTC-USD', createdAt: '2024-01-11T00:00:00Z', side: 'BUY',  size: '1',   price: '100', fee: '0' },
        { market: 'BTC-USD', createdAt: '2024-01-14T00:00:00Z', side: 'SELL', size: '1',   price: '150', fee: '0' }
    ];
    // If the bad fill leaked into FIFO, the BUY 999@1 would consume the
    // SELL and produce ~-149,851 of attributed realized.
    const attribution = globalThis.RiskMetrics.attributeFillsToPositions([p], fills).get(p);
    assert.ok(close(attribution.realized, 50),
        `unparseable-createdAt fill must NOT affect FIFO inventory; expected 50, got ${attribution.realized}`);
    assert.equal(attribution.complete, false);
    const r = TR.buildYearReport([p], fills, [], 2024, {});
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0]._attributionIncomplete, true);
    assert.equal(r.rows[0].realizedPnlUSD, null);
});

// ---------------------------------------------------------------------------
// Funding unknown — payments that did not load are never $0.
// ---------------------------------------------------------------------------

const FUNDED_LONG = {
    status: 'CLOSED', market: 'ETH-USD', side: 'LONG',
    createdAt: '2024-03-10T00:00:00Z', closedAt: '2024-03-12T00:00:00Z'
};
const FUNDED_LONG_FILLS = [
    { market: 'ETH-USD', side: 'BUY',  createdAt: '2024-03-10T00:00:00Z', size: '1', price: '3000', fee: '0.50' },
    { market: 'ETH-USD', side: 'SELL', createdAt: '2024-03-12T00:00:00Z', size: '1', price: '3100', fee: '0.75' }
];

test('buildYearReport: unloaded funding payments read null funding and net and blank their totals, not $0', () => {
    const quotes = { '2024-03-10': 1.25, '2024-03-12': 1.25 };
    const r = TR.buildYearReport([FUNDED_LONG], FUNDED_LONG_FILLS, null, 2024, quotes);
    const row = r.rows[0];
    assert.equal(row._fundingMissing, true);
    assert.equal(row.netFundingUSD, null);
    assert.equal(row.netUSD, null);
    assert.equal(row.netFundingEUR, undefined);
    assert.equal(row.netEUR, undefined);
    assert.ok(close(row.realizedPnlUSD, 100), 'realized does not depend on funding');
    assert.ok(close(row.feesUSD, 1.25), 'fees do not depend on funding');
    assert.equal(r.totals.fundingMissingCount, 1);
    for (const key of ['netUSD', 'netEUR', 'grossGainsUSD', 'grossGainsEUR', 'grossLossesUSD',
        'grossLossesEUR', 'fundingUSD', 'fundingEUR']) {
        assert.equal(r.totals[key], undefined, key);
    }
    assert.ok(close(r.totals.feesUSD, 1.25), 'the fee total does not depend on funding');
    assert.equal(r.totals.winCount + r.totals.lossCount + r.totals.scratchCount, 0,
        'a row with unknown net is in no W / L / S bucket');
});

test('buildYearReport: no funding payment in the year is a known zero, not missing', () => {
    const r = TR.buildYearReport([FUNDED_LONG], FUNDED_LONG_FILLS, [], 2024, {});
    assert.equal(r.rows[0]._fundingMissing, false);
    assert.equal(r.rows[0].netFundingUSD, 0);
    assert.ok(close(r.rows[0].netUSD, 98.75));
    assert.equal(r.totals.fundingUSD, 0);
    assert.equal(r.totals.fundingMissingCount, 0);
});

test('toCsv: a row with unknown funding exports empty funding and net cells and funding_missing = true', () => {
    const r = TR.buildYearReport([FUNDED_LONG], FUNDED_LONG_FILLS, null, 2024, {});
    const lines = csvRecords(r.rows);
    const header = lines[0].split(',');
    const cells = lines[1].split(',');
    assert.equal(cells[header.indexOf('funding_missing')], 'true');
    assert.equal(cells[header.indexOf('net_funding_usd')], '');
    assert.equal(cells[header.indexOf('net_usd')], '');
    assert.equal(cells[header.indexOf('realized_pnl_usd')], '100.00');
});

// ---------------------------------------------------------------------------
// priceText — the on-screen ENTRY / EXIT digits.
// ---------------------------------------------------------------------------

test('priceText: rounds half up from the decimal the price stands for, not from the binary float', () => {
    // Each double lies just below its decimal tie, so toFixed(4) reads .1234 / .4242.
    assert.equal(TR.priceText(64012.12345), '64012.1235');
    assert.equal(TR.priceText(42424.42425), '42424.4243');
    assert.equal(TR.priceText(64012.123449999999), '64012.1235', 'float VWAP noise below the tie');
    assert.equal(TR.priceText(64012.1234499), '64012.1234', 'a value below the tie rounds down');
});

test('priceText: rounds once at 4 decimals, never through the export precision first', () => {
    // At 12 significant digits first, 100000.99504950495 reads 100000.995050 and then .9951.
    assert.equal(TR.priceText(100000.99504950495), '100000.995');
});

test('buildYearReport: an ENTRY whose exact VWAP is a 4-decimal tie rounds up on screen', () => {
    // 27 × 1.1 at 42424.42425 sums in binary floating point to a VWAP of
    // 42424.424249999945, below the tie by more than 15 significant digits
    // see; the attribution's exact VWAP is the tie itself.
    const REPEATED_FILLS = 27;
    const p = {
        status: 'CLOSED', market: 'BTC-USD', side: 'LONG',
        createdAt: '2024-05-01T00:00:00Z', closedAt: '2024-05-03T00:00:00Z'
    };
    const fills = Array.from({ length: REPEATED_FILLS }, (_, i) => ({
        market: 'BTC-USD', side: 'BUY', createdAt: '2024-05-01T00:00:00Z',
        createdAtHeight: String(i + 1), size: '1.1', price: '42424.42425', fee: '0'
    }));
    fills.push({ market: 'BTC-USD', side: 'SELL', createdAt: '2024-05-03T00:00:00Z',
        createdAtHeight: String(REPEATED_FILLS + 1), size: '29.7', price: '42500', fee: '0' });
    const row = TR.buildYearReport([p], fills, [], 2024, {}).rows[0];
    assert.equal(TR.priceText(row.entryPrice), '42424.4243');
});

test('toCsv / toJson: a micro-price and a large size are written as plain decimals, never in exponent form', () => {
    const row = { status: 'closed', closedAtISO: '2024-03-12T00:00:00Z', createdAtISO: '2024-03-10T00:00:00Z',
        market: 'BABYDOGE-USD', side: 'LONG', peakSize: 2e21, entryPrice: 0.000000406473, exitPrice: 0.000000416473 };
    const lines = csvRecords([row]);
    const header = lines[0].split(',');
    const cells = lines[1].split(',');
    assert.equal(cells[header.indexOf('peak_size')], '2000000000000000000000');
    assert.equal(cells[header.indexOf('entry_price')], '0.000000406473');
    assert.equal(cells[header.indexOf('exit_price')], '0.000000416473');
    const json = TR.toJson([row], {}, 2024);
    assert.match(json, /"peakSize": 2000000000000000000000,/);
    assert.match(json, /"entryPrice": 0\.000000406473,/);
    assert.match(json, /"exitPrice": 0\.000000416473\n/);
    assert.equal(JSON.parse(json).rows[0].entryPrice, 0.000000406473);
});

test('priceText: carries across the decimal point and trims trailing zeros', () => {
    assert.equal(TR.priceText(9.99995), '10');
    assert.equal(TR.priceText(3100.5), '3100.5');
    assert.equal(TR.priceText(3000), '3000');
});

test('priceText: no number reads null', () => {
    assert.equal(TR.priceText(null), null);
    assert.equal(TR.priceText(NaN), null);
});

test('toCsv: a UTF-8 BOM, then the 23-column header and one 23-column record per row, no meta line', () => {
    const row = {
        status: 'closed', closedAtISO: '2024-03-12T00:00:00Z', createdAtISO: '2024-03-10T00:00:00Z',
        market: 'ETH-USD', side: 'LONG', realizedPnlUSD: 1, netFundingUSD: 0, feesUSD: 0, netUSD: 1, fillCount: 2
    };
    const csv = TR.toCsv([row]);
    assert.ok(csv.startsWith('\uFEFFstatus,'), JSON.stringify(csv.slice(0, 20)));
    assert.ok(!csv.includes('#'), 'no comment line');
    const records = csvRecords([row]).filter(Boolean);
    const COLUMNS = 23;
    assert.equal(records.length, 2);
    records.forEach(record => assert.equal(record.split(',').length, COLUMNS, record));
});

test('toCsv: ends with CRLF', () => {
    const csv = TR.toCsv([]);
    assert.ok(csv.endsWith('\r\n'));
});

// ---------------------------------------------------------------------------
// toJson — schema/metadata coverage.
// ---------------------------------------------------------------------------

test('toJson: meta block carries the classification, its accountant note, year, schemaVersion', () => {
    const rows = [{
        closedAtISO: '2024-03-12T00:00:00Z',
        market: 'ETH-USD', side: 'LONG',
        realizedPnlUSD: 100, netFundingUSD: 0, feesUSD: 0, netUSD: 100
    }];
    const totals = TR.summarize(rows);
    const out = JSON.parse(TR.toJson(rows, totals, 2024));
    assert.equal(out.meta.classification, 'G');
    assert.equal(out.meta.classificationLabel, TR.CLASSIFICATION.label);
    assert.equal(out.meta.classificationNote, TR.CLASSIFICATION.note);
    assert.equal(out.meta.year, 2024);
    assert.equal(out.meta.schemaVersion, 9);
    assert.equal(out.meta.asOf, null, 'no snapshot time given');
    assert.ok(typeof out.meta.generatedAt === 'string'
        && /^\d{4}-\d{2}-\d{2}T/.test(out.meta.generatedAt),
        'generatedAt must be ISO');
});

test('toJson: totals + rows round-trip without mutation', () => {
    const rows = [
        { closedAtISO: '2024-01-01T00:00:00Z', market: 'BTC-USD', side: 'LONG',
          realizedPnlUSD: 50, netFundingUSD: 0, feesUSD: 1, netUSD: 49 },
        { closedAtISO: '2024-02-01T00:00:00Z', market: 'ETH-USD', side: 'SHORT',
          realizedPnlUSD: -20, netFundingUSD: 0, feesUSD: 0.5, netUSD: -20.5 }
    ];
    const totals = TR.summarize(rows);
    const out = JSON.parse(TR.toJson(rows, totals, 2024));
    assert.equal(out.rows.length, 2);
    assert.equal(out.rows[0].market, 'BTC-USD');
    assert.equal(out.totals.count, 2);
    assert.equal(out.totals.winCount, 1);
    assert.equal(out.totals.lossCount, 1);
});

// ---------------------------------------------------------------------------
// _internal.csvEscape — direct unit test of escape rules.
// ---------------------------------------------------------------------------

test('csvEscape: plain string unquoted', () => {
    assert.equal(TR._internal.csvEscape('ETH-USD'), 'ETH-USD');
});

test('csvEscape: comma forces quotes', () => {
    assert.equal(TR._internal.csvEscape('a,b'), '"a,b"');
});

test('csvEscape: embedded quote doubles', () => {
    assert.equal(TR._internal.csvEscape('a"b'), '"a""b"');
});

test('csvEscape: newline forces quotes', () => {
    assert.equal(TR._internal.csvEscape('a\nb'), '"a\nb"');
});

test('csvEscape: null/undefined empty string', () => {
    assert.equal(TR._internal.csvEscape(null), '');
    assert.equal(TR._internal.csvEscape(undefined), '');
});


