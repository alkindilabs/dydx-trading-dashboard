'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Tax module is browser-targeted and depends on window.RiskMetrics
// (attributeFillsToPositions). Shim window onto globalThis, load
// constants and risk-metrics first, then tax-report.
globalThis.window = globalThis;
require('../src/constants.js');
require('../risk-metrics.js');
require('../tax-report.js');
const TR = globalThis.TaxReport;

const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

// ---------------------------------------------------------------------------
// closedAtYearUTC — UTC boundary correctness (not local time).
// ---------------------------------------------------------------------------

test('closedAtYearUTC: 2024-12-31T23:59:59Z classifies as 2024', () => {
    assert.equal(TR.closedAtYearUTC({ closedAt: '2024-12-31T23:59:59Z' }), 2024);
});

test('closedAtYearUTC: 2025-01-01T00:00:00Z classifies as 2025', () => {
    assert.equal(TR.closedAtYearUTC({ closedAt: '2025-01-01T00:00:00Z' }), 2025);
});

test('closedAtYearUTC: missing/invalid returns null', () => {
    assert.equal(TR.closedAtYearUTC({}), null);
    assert.equal(TR.closedAtYearUTC({ closedAt: 'not-a-date' }), null);
    assert.equal(TR.closedAtYearUTC(null), null);
});

// ---------------------------------------------------------------------------
// availableYearsFromPositions — dedupe + desc + CLOSED-only.
// ---------------------------------------------------------------------------

test('availableYearsFromPositions: dedupes, sorts desc, ignores OPEN', () => {
    const positions = [
        { status: 'CLOSED', closedAt: '2024-03-15T00:00:00Z' },
        { status: 'CLOSED', closedAt: '2024-08-20T00:00:00Z' },
        { status: 'CLOSED', closedAt: '2022-01-10T00:00:00Z' },
        { status: 'CLOSED', closedAt: '2023-06-30T00:00:00Z' },
        { status: 'OPEN',   closedAt: null }
    ];
    assert.deepEqual(TR.availableYearsFromPositions(positions), [2024, 2023, 2022]);
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
        netFunding: '0', maxSize: '2'
    };
    const fills = [
        { market: 'BTC-USD', createdAt: '2024-01-11T00:00:00Z', side: 'BUY',  size: '1', price: '100' },
        { market: 'BTC-USD', createdAt: '2024-01-12T00:00:00Z', side: 'BUY',  size: '1', price: 'NaN' },
        { market: 'BTC-USD', createdAt: '2024-01-13T00:00:00Z', side: 'SELL', size: '2', price: '150' }
    ];
    const r = TR.buildYearReport([p], fills, 2024, {});
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
        netFunding: '0', maxSize: '1'
    };
    const fills = [
        { market: 'BTC-USD', createdAt: '2024-01-11T00:00:00Z', side: 'BUY', size: '1', price: 'NaN' }
    ];
    const r = TR.buildYearReport([p], fills, 2024, {});
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
        createdAt: '2024-01-10T00:00:00Z', closedAt: '2024-01-11T00:00:00Z', netFunding: '0'
    };
    const short = {
        status: 'CLOSED', market: 'ETH-USD', side: 'SHORT',
        createdAt: '2024-01-11T00:00:00Z', closedAt: '2024-01-12T00:00:00Z', netFunding: '0'
    };
    const fills = [
        { market: 'ETH-USD', side: 'BUY',  createdAt: '2024-01-10T00:00:00Z', createdAtHeight: '1', size: '2', price: '100', fee: '1' },
        { market: 'ETH-USD', side: 'SELL', createdAt: '2024-01-11T00:00:00Z', createdAtHeight: '2', size: '5', price: '150', fee: '5' },
        { market: 'ETH-USD', side: 'BUY',  createdAt: '2024-01-12T00:00:00Z', createdAtHeight: '3', size: '3', price: '120', fee: '0.6' }
    ];
    const r = TR.buildYearReport([long, short], fills, 2024, {});
    r.rows.forEach(row => {
        assert.equal(row._realizedFillError, null, `${row.side} has no fill error`);
        assert.equal(row._attributionIncomplete, false);
        assert.equal(row._feeAttributionWarning, true, `${row.side} keeps the overlap audit hint`);
    });
    assert.equal(r.warnings.incompleteAttributionCount, 0);
    assert.equal(r.warnings.feeAttributionAmbiguousCount, 2);
});

test('buildYearReport: a window whose fills net flat but do not tie to the position is not from fills', () => {
    // Two flat round trips inside one indexer position: the sizes in the
    // window net flat, but the fills saw a flat moment the indexer did
    // not, so the attribution is incomplete.
    const merged = {
        status: 'CLOSED', market: 'BTC-USD', side: 'LONG',
        createdAt: '2024-01-10T00:00:00Z', closedAt: '2024-01-13T00:00:00Z', netFunding: '0'
    };
    const fills = [
        { market: 'BTC-USD', side: 'BUY',  createdAt: '2024-01-10T00:00:00Z', size: '1', price: '100' },
        { market: 'BTC-USD', side: 'SELL', createdAt: '2024-01-11T00:00:00Z', size: '1', price: '110' },
        { market: 'BTC-USD', side: 'BUY',  createdAt: '2024-01-12T00:00:00Z', size: '1', price: '100' },
        { market: 'BTC-USD', side: 'SELL', createdAt: '2024-01-13T00:00:00Z', size: '1', price: '110' }
    ];
    const r = TR.buildYearReport([merged], fills, 2024, {});
    assert.equal(r.rows[0]._attributionIncomplete, true);
    assert.equal(r.rows[0]._realizedFillError, 'attribution-incomplete');
    assert.equal(r.warnings.incompleteAttributionCount, 1);
});

test('buildYearReport: fill_count counts the market\'s BUY and SELL fills inside [createdAt, closedAt]', () => {
    // /v4/fills sides are BUY/SELL while positions are LONG/SHORT, and
    // both sides belong to a position's lifecycle, so the window has no
    // side filter. Both window ends are inclusive.
    const p = {
        status: 'CLOSED', market: 'ETH-USD', side: 'LONG',
        createdAt: '2024-01-10T00:00:00Z', closedAt: '2024-01-15T00:00:00Z', netFunding: '0'
    };
    const fills = [
        { market: 'ETH-USD', side: 'SELL', createdAt: '2024-01-08T00:00:00Z', size: '1', price: '90' },
        { market: 'ETH-USD', side: 'BUY',  createdAt: '2024-01-09T23:59:59Z', size: '1', price: '95' },
        { market: 'ETH-USD', side: 'BUY',  createdAt: '2024-01-10T00:00:00Z', size: '1', price: '100' },
        { market: 'BTC-USD', side: 'BUY',  createdAt: '2024-01-12T00:00:00Z', size: '1', price: '50000' },
        { market: 'ETH-USD', side: 'SELL', createdAt: '2024-01-15T00:00:00Z', size: '1', price: '110' },
        { market: 'ETH-USD', side: 'BUY',  createdAt: '2024-01-15T00:00:01Z', size: '1', price: '111' }
    ];
    assert.equal(TR.buildYearReport([p], fills, 2024, {}).rows[0].fillCount, 2);
});

test('buildYearReport: dense overlap (all positions overlap each other) marks all', () => {
    // Stress the sweep: N positions whose windows all intersect at the
    // same instant. With the unmarkedCount optimization this should
    // still mark every position even though the inner walk only runs
    // once.
    const positions = [];
    for (let i = 0; i < 8; i++) {
        positions.push({
            status: 'CLOSED', market: 'ETH-USD', side: 'LONG',
            createdAt: `2024-01-${String(10 + i).padStart(2, '0')}T00:00:00Z`,
            closedAt:  `2024-02-${String(10 + i).padStart(2, '0')}T00:00:00Z`,
            netFunding: '0', maxSize: '1'
        });
    }
    const r = TR.buildYearReport(positions, [], 2024, {});
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

test('netRealizedPnl: NaN-safe', () => {
    assert.equal(TR.netRealizedPnl('abc', null, undefined), 0);
});

// ---------------------------------------------------------------------------
// buildYearReport — filter by closedAt UTC year, exclude OPEN,
// FIFO-derived realized, side-agnostic fee attribution.
// ---------------------------------------------------------------------------

test('buildYearReport: filters by closedAt UTC year', () => {
    const positions = [
        { status: 'CLOSED', market: 'ETH-USD', side: 'LONG',
          createdAt: '2024-12-30T00:00:00Z', closedAt: '2024-12-31T23:59:59Z',
          realizedPnl: '0', netFunding: '0', entryPrice: '3000', exitPrice: '3100', maxSize: '1' },
        { status: 'CLOSED', market: 'ETH-USD', side: 'LONG',
          createdAt: '2025-01-01T00:00:00Z', closedAt: '2025-01-02T00:00:00Z',
          realizedPnl: '0', netFunding: '0', entryPrice: '3100', exitPrice: '3150', maxSize: '1' }
    ];
    const fills = [
        { market: 'ETH-USD', side: 'BUY',  createdAt: '2024-12-30T00:00:00Z', size: '1', price: '3000' },
        { market: 'ETH-USD', side: 'SELL', createdAt: '2024-12-31T23:59:59Z', size: '1', price: '3100' },
        { market: 'ETH-USD', side: 'BUY',  createdAt: '2025-01-01T00:00:00Z', size: '1', price: '3100' },
        { market: 'ETH-USD', side: 'SELL', createdAt: '2025-01-02T00:00:00Z', size: '1', price: '3150' }
    ];
    const r2024 = TR.buildYearReport(positions, fills, 2024, {});
    assert.equal(r2024.rows.length, 1);
    assert.equal(r2024.rows[0].closedAtISO, '2024-12-31T23:59:59Z');
    assert.ok(close(r2024.rows[0].realizedPnlUSD, 100));
    const r2025 = TR.buildYearReport(positions, fills, 2025, {});
    assert.equal(r2025.rows.length, 1);
    assert.ok(close(r2025.rows[0].realizedPnlUSD, 50));
});

test('buildYearReport: excludes OPEN positions even when createdAt in year', () => {
    const positions = [
        { status: 'OPEN', market: 'ETH-USD', side: 'LONG',
          createdAt: '2024-06-01T00:00:00Z', closedAt: null },
        { status: 'CLOSED', market: 'ETH-USD', side: 'LONG',
          createdAt: '2024-06-01T00:00:00Z', closedAt: '2024-06-10T00:00:00Z',
          realizedPnl: '0', netFunding: '0', maxSize: '1' }
    ];
    const fills = [
        { market: 'ETH-USD', side: 'BUY',  createdAt: '2024-06-01T00:00:00Z', size: '1', price: '3000' },
        { market: 'ETH-USD', side: 'SELL', createdAt: '2024-06-10T00:00:00Z', size: '1', price: '3010' }
    ];
    const r = TR.buildYearReport(positions, fills, 2024, {});
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].closedAtISO, '2024-06-10T00:00:00Z');
});

test('buildYearReport: netUSD = FIFO realized + netFunding − fees', () => {
    const p = {
        status: 'CLOSED', market: 'ETH-USD', side: 'LONG',
        createdAt: '2024-03-10T00:00:00Z', closedAt: '2024-03-12T00:00:00Z',
        netFunding: '-2', maxSize: '1', entryPrice: '3000', exitPrice: '3100'
    };
    const fills = [
        { market: 'ETH-USD', side: 'BUY',  createdAt: '2024-03-10T00:00:00Z', size: '1', price: '3000', fee: '0.50' },
        { market: 'ETH-USD', side: 'SELL', createdAt: '2024-03-12T00:00:00Z', size: '1', price: '3100', fee: '0.75' }
    ];
    const r = TR.buildYearReport([p], fills, 2024, {});
    const row = r.rows[0];
    assert.ok(close(row.realizedPnlUSD, 100), `realized: ${row.realizedPnlUSD}`);
    assert.ok(close(row.feesUSD, 1.25), `fees: ${row.feesUSD}`);
    assert.ok(close(row.netUSD, 96.75), `net: ${row.netUSD}`);
    assert.equal(row._attributionIncomplete, false);
});

test('buildYearReport: holdingDays counts whole days from createdAt to closedAt', () => {
    const p = {
        status: 'CLOSED', market: 'ETH-USD', side: 'LONG',
        createdAt: '2024-06-01T00:00:00Z', closedAt: '2024-06-10T12:00:00Z',
        netFunding: '0', maxSize: '1'
    };
    const fills = [
        { market: 'ETH-USD', side: 'BUY',  createdAt: '2024-06-01T00:00:00Z', size: '1', price: '3000' },
        { market: 'ETH-USD', side: 'SELL', createdAt: '2024-06-10T12:00:00Z', size: '1', price: '3010' }
    ];
    const [row] = TR.buildYearReport([p], fills, 2024, {}).rows;
    assert.equal(row.holdingDays, 9, 'nine and a half days held floors to 9');
});

test('buildYearReport: no fills in window flags the row incomplete with reason no-fills-in-window', () => {
    const p = {
        status: 'CLOSED', market: 'BTC-USD', side: 'LONG',
        createdAt: '2024-05-01T00:00:00Z', closedAt: '2024-05-05T00:00:00Z',
        netFunding: '0', maxSize: '1'
    };
    // Fills exist for the market but all OUTSIDE the window
    const fills = [
        { market: 'BTC-USD', side: 'BUY',  createdAt: '2024-04-01T00:00:00Z', size: '1', price: '100' },
        { market: 'BTC-USD', side: 'SELL', createdAt: '2024-06-01T00:00:00Z', size: '1', price: '200' }
    ];
    const r = TR.buildYearReport([p], fills, 2024, {});
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
        netFunding: '0', maxSize: '-0.5', entryPrice: '3000', exitPrice: '2950'
    };
    const fills = [
        { market: 'ETH-USD', side: 'SELL', createdAt: '2024-05-01T00:00:00Z', size: '2', price: '3000', fee: '0' },
        { market: 'ETH-USD', side: 'SELL', createdAt: '2024-05-02T00:00:00Z', size: '4', price: '3100', fee: '0' },
        { market: 'ETH-USD', side: 'BUY',  createdAt: '2024-05-03T00:00:00Z', size: '6', price: '2900', fee: '0' }
    ];
    const row = TR.buildYearReport([p], fills, 2024, {}).rows[0];
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
        netFunding: '0', maxSize: '-0.5', entryPrice: '3000', exitPrice: '2950'
    };
    const row = TR.buildYearReport([p], [], 2024, {}).rows[0];
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
        createdAt: '2025-01-01T00:00:00Z', closedAt: '2025-01-10T00:00:00Z', netFunding: '0'
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
    const row = TR.buildYearReport([long], fills, 2025, {}).rows[0];
    assert.equal(row.peakSize, null);
    assert.equal(row.entryPrice, null);
    assert.equal(row.exitPrice, null);
    const lines = TR.toCsv([row], 'E', 2025).split('\r\n');
    const header = lines[1].split(',');
    const cells = lines[2].split(',');
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
        createdAt: '2024-05-01T00:00:00Z', closedAt: '2024-05-03T00:00:00Z', netFunding: '0'
    };
    const fills = [
        { market: 'ETH-USD', side: 'BUY',  createdAt: '2024-05-01T00:00:00Z', size: '0.1', price: '100',    fee: '0' },
        { market: 'ETH-USD', side: 'BUY',  createdAt: '2024-05-02T00:00:00Z', size: '0.2', price: '100.25', fee: '0' },
        { market: 'ETH-USD', side: 'SELL', createdAt: '2024-05-03T00:00:00Z', size: '0.1', price: '101',    fee: '0' },
        { market: 'ETH-USD', side: 'SELL', createdAt: '2024-05-03T00:00:00Z', size: '0.2', price: '101',    fee: '0' }
    ];
    const report = TR.buildYearReport([p], fills, 2024, {});
    const lines = TR.toCsv(report.rows, 'E', 2024).split('\r\n');
    const header = lines[1].split(',');
    const cells = lines[2].split(',');
    assert.equal(cells[header.indexOf('peak_size')], '0.3');
    assert.equal(cells[header.indexOf('entry_price')], '100.166666667');
    assert.equal(cells[header.indexOf('exit_price')], '101');
    const jsonRow = JSON.parse(TR.toJson(report.rows, report.totals, 'E', 2024)).rows[0];
    assert.equal(jsonRow.peakSize, 0.3);
    assert.equal(jsonRow.entryPrice, 100.166666667);
    assert.equal(jsonRow.exitPrice, 101);
});

test('buildYearReport: a row with incomplete fill attribution reads null profit and blanks the year totals', () => {
    // The SELL 3 flips the LONG into a SHORT that is missing from the
    // position list (its endpoint failed). The orphaned SHORT segment,
    // including its 2026 close, would otherwise land in the 2025 LONG row.
    const long = {
        status: 'CLOSED', market: 'ETH-USD', side: 'LONG',
        createdAt: '2025-01-01T00:00:00Z', closedAt: '2025-01-10T00:00:00Z', netFunding: '-2'
    };
    const fills = [
        { market: 'ETH-USD', side: 'BUY',  createdAt: '2025-01-01T00:00:00Z', createdAtHeight: '1', size: '1', price: '100', fee: '1' },
        { market: 'ETH-USD', side: 'SELL', createdAt: '2025-01-10T00:00:00Z', createdAtHeight: '2', size: '3', price: '110', fee: '3' },
        { market: 'ETH-USD', side: 'BUY',  createdAt: '2026-02-01T00:00:00Z', createdAtHeight: '3', size: '1', price: '50',  fee: '10' }
    ];
    const r = TR.buildYearReport([long], fills, 2025, { '2025-01-10': 0.9 });
    const row = r.rows[0];
    assert.equal(row._attributionIncomplete, true);
    assert.equal(row.realizedPnlUSD, null);
    assert.equal(row.feesUSD, null);
    assert.equal(row.netUSD, null);
    assert.equal(row.netEUR, undefined);
    assert.ok(close(row.netFundingEUR, -1.8), 'funding does not depend on fills and still converts');
    assert.equal(r.warnings.incompleteAttributionCount, 1);
    assert.equal(r.totals.incompleteCount, 1);
    assert.equal(r.totals.netUSD, undefined);
    assert.equal(r.totals.feesUSD, undefined);
    assert.equal(r.totals.grossGainsUSD, undefined);
    assert.equal(r.totals.netEUR, undefined);
    assert.equal(r.totals.fundingUSD, -2);
});

test('toCsv / toJson: schema 3 exports peak_size and flags incomplete rows with empty profit cells', () => {
    const row = {
        closedAtISO: '2025-01-10T00:00:00Z', market: 'ETH-USD', side: 'LONG',
        peakSize: null, entryPrice: null, exitPrice: null,
        realizedPnlUSD: null, netFundingUSD: -2, feesUSD: null, netUSD: null,
        holdingDays: 9, fillCount: 2, _attributionIncomplete: true
    };
    const lines = TR.toCsv([row], 'E', 2025).split('\r\n');
    const header = lines[1].split(',');
    const cells = lines[2].split(',');
    assert.ok(header.includes('peak_size') && !header.includes('max_size'));
    assert.equal(cells[header.indexOf('attribution_incomplete')], 'true');
    assert.equal(cells[header.indexOf('realized_pnl_usd')], '');
    assert.equal(cells[header.indexOf('fees_usd')], '');
    assert.equal(cells[header.indexOf('net_usd')], '');
    assert.equal(cells[header.indexOf('net_funding_usd')], '-2.00');
    const json = JSON.parse(TR.toJson([row], TR.summarize([row], 'E'), 'E', 2025));
    assert.equal(json.meta.schemaVersion, 3);
});

test('buildYearReport / toCsv / toJson: schema 3 carries attribution incompleteness once, with its reason', () => {
    // realized_from_fills was always the inverse of attribution_incomplete,
    // and the without-FIFO counter always equalled the incomplete counter:
    // schema 3 keeps only attribution_incomplete and its reason.
    const p = {
        status: 'CLOSED', market: 'BTC-USD', side: 'LONG',
        createdAt: '2024-05-01T00:00:00Z', closedAt: '2024-05-05T00:00:00Z', netFunding: '0'
    };
    const r = TR.buildYearReport([p], [], 2024, {});
    assert.deepEqual(Object.keys(r.warnings).sort(),
        ['feeAttributionAmbiguousCount', 'incompleteAttributionCount', 'missingFxDates']);
    assert.equal(r.warnings.incompleteAttributionCount, 1);
    assert.ok(!('_realizedFromFills' in r.rows[0]), 'row must not carry the redundant flag');

    const lines = TR.toCsv(r.rows, 'E', 2024).split('\r\n');
    const header = lines[1].split(',');
    const cells = lines[2].split(',');
    assert.ok(!header.includes('realized_from_fills'), 'CSV must drop realized_from_fills');
    assert.equal(cells[header.indexOf('attribution_incomplete')], 'true');
    assert.equal(cells[header.indexOf('realized_fill_error')], 'no-fills-in-window');

    const json = JSON.parse(TR.toJson(r.rows, r.totals, 'E', 2024));
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
        netFunding: '0', maxSize: '1'
    };
    const fills = [
        { market: 'BTC-USD', side: 'BUY', createdAt: '2024-02-01T00:00:00Z', size: '1', price: '100' }
        // SELL missing — net = +1
    ];
    const r = TR.buildYearReport([p], fills, 2024, {});
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
        netFunding: '0', maxSize: '1'
    };
    const fills = [
        { market: 'BTC-USD', side: 'SELL', createdAt: '2024-03-05T00:00:00Z', size: '1', price: '120' }
    ];
    const r = TR.buildYearReport([p], fills, 2024, {});
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
        netFunding: '0', maxSize: '1' };
    const b = { status: 'CLOSED', market: 'ETH-USD', side: 'LONG',
        createdAt: '2024-01-15T00:00:00Z', closedAt: '2024-02-05T00:00:00Z',
        netFunding: '0', maxSize: '1' };
    const c = { status: 'CLOSED', market: 'ETH-USD', side: 'LONG',
        createdAt: '2024-01-25T00:00:00Z', closedAt: '2024-02-10T00:00:00Z',
        netFunding: '0', maxSize: '1' };
    const r = TR.buildYearReport([a, b, c], [], 2024, {});
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
        netFunding: '0', maxSize: '1'
    };
    const b = {
        status: 'CLOSED', market: 'BTC-USD', side: 'LONG',
        createdAt: '2024-01-10T11:00:00Z', closedAt: '2024-01-10T12:00:00Z',
        netFunding: '0', maxSize: '1'
    };
    // BUY 1@100 opens A. SELL 1@110 closes A. BUY 1@110 opens B.
    // SELL 1@120 closes B.
    const fills = [
        { market: 'BTC-USD', side: 'BUY',  createdAt: '2024-01-10T10:00:00Z', size: '1', price: '100', fee: '0.10' },
        { market: 'BTC-USD', side: 'SELL', createdAt: '2024-01-10T11:00:00Z', size: '1', price: '110', fee: '0.20' },
        { market: 'BTC-USD', side: 'BUY',  createdAt: '2024-01-10T11:00:00Z', size: '1', price: '110', fee: '0.20' },
        { market: 'BTC-USD', side: 'SELL', createdAt: '2024-01-10T12:00:00Z', size: '1', price: '120', fee: '0.10' }
    ];
    const r = TR.buildYearReport([a, b], fills, 2024, {});
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
        netFunding: '0', maxSize: '2'
    };
    const b = {
        status: 'CLOSED', market: 'BTC-USD', side: 'LONG',
        createdAt: '2024-01-10T10:30:00Z', closedAt: '2024-01-10T12:00:00Z',
        netFunding: '0', maxSize: '2'
    };
    const fills = [
        { market: 'BTC-USD', side: 'BUY',  createdAt: '2024-01-10T10:00:00Z', size: '2', price: '100' },
        { market: 'BTC-USD', side: 'SELL', createdAt: '2024-01-10T12:00:00Z', size: '2', price: '160' }
    ];
    const r = TR.buildYearReport([a, b], fills, 2024, {});
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
        createdAt: '2024-01-10T00:00:00Z', closedAt: '2024-01-11T00:00:00Z', netFunding: '0'
    };
    const short = {
        status: 'CLOSED', market: 'ETH-USD', side: 'SHORT',
        createdAt: '2024-01-11T00:00:00Z', closedAt: '2024-01-12T00:00:00Z', netFunding: '0'
    };
    const fills = [
        { market: 'ETH-USD', side: 'BUY',  createdAt: '2024-01-10T00:00:00Z', createdAtHeight: '1', size: '2', price: '100', fee: '1' },
        { market: 'ETH-USD', side: 'SELL', createdAt: '2024-01-11T00:00:00Z', createdAtHeight: '2', size: '5', price: '150', fee: '5' },
        { market: 'ETH-USD', side: 'BUY',  createdAt: '2024-01-12T00:00:00Z', createdAtHeight: '3', size: '3', price: '120', fee: '0.6' }
    ];
    const r = TR.buildYearReport([long, short], fills, 2024, {});
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
        netFunding: '0', maxSize: '5'
    };
    const fills = [
        { market: 'BTC-USD', side: 'BUY',  createdAt: '2024-01-01T00:00:00Z', size: '2', price: '100' },
        { market: 'BTC-USD', side: 'BUY',  createdAt: '2024-01-02T00:00:00Z', size: '3', price: '120' },
        { market: 'BTC-USD', side: 'SELL', createdAt: '2024-01-08T00:00:00Z', size: '2', price: '150' },
        { market: 'BTC-USD', side: 'SELL', createdAt: '2024-01-10T00:00:00Z', size: '3', price: '160' }
    ];
    const r = TR.buildYearReport([p], fills, 2024, {});
    assert.equal(r.rows.length, 1);
    assert.ok(close(r.rows[0].realizedPnlUSD, 220),
        `expected 220, got ${r.rows[0].realizedPnlUSD}`);
});

test('buildYearReport: rows sorted by closedAt descending', () => {
    const positions = [
        { status: 'CLOSED', market: 'ETH-USD', side: 'LONG',
          createdAt: '2024-01-01T00:00:00Z', closedAt: '2024-01-05T00:00:00Z',
          netFunding: '0', maxSize: '1' },
        { status: 'CLOSED', market: 'ETH-USD', side: 'LONG',
          createdAt: '2024-02-01T00:00:00Z', closedAt: '2024-02-05T00:00:00Z',
          netFunding: '0', maxSize: '1' }
    ];
    const r = TR.buildYearReport(positions, [], 2024, {});
    assert.equal(r.rows[0].closedAtISO, '2024-02-05T00:00:00Z');
    assert.equal(r.rows[1].closedAtISO, '2024-01-05T00:00:00Z');
});

// ---------------------------------------------------------------------------
// convertRowsToEur — idempotent: stale EUR/_fxMissing reset on re-call.
// ---------------------------------------------------------------------------

test('convertRowsToEur: present rate populates EUR mirrors', () => {
    const rows = [{
        closedDateUTC: '2024-03-12',
        realizedPnlUSD: 100, netFundingUSD: -2, feesUSD: 1.25, netUSD: 96.75,
        _fxMissing: false
    }];
    const warnings = { missingFxDates: [] };
    TR.convertRowsToEur(rows, { '2024-03-12': 0.92 }, warnings);
    assert.ok(close(rows[0].fxRate, 0.92));
    assert.ok(close(rows[0].realizedPnlEUR, 92));
    assert.ok(close(rows[0].netEUR, 96.75 * 0.92));
    assert.equal(rows[0]._fxMissing, false);
    assert.equal(warnings.missingFxDates.length, 0);
});

test('convertRowsToEur: absent rate flags row and pushes to missing', () => {
    const rows = [{
        closedDateUTC: '2024-03-12',
        realizedPnlUSD: 100, netFundingUSD: 0, feesUSD: 0, netUSD: 100,
        _fxMissing: false
    }];
    const warnings = { missingFxDates: [] };
    TR.convertRowsToEur(rows, {}, warnings);
    assert.equal(rows[0].fxRate, undefined);
    assert.equal(rows[0].netEUR, undefined);
    assert.equal(rows[0]._fxMissing, true);
    assert.deepEqual(warnings.missingFxDates, ['2024-03-12']);
});

test('convertRowsToEur: idempotent — second call with rate clears stale _fxMissing', () => {
    const rows = [{
        closedDateUTC: '2024-03-12',
        realizedPnlUSD: 100, netFundingUSD: 0, feesUSD: 0, netUSD: 100,
        _fxMissing: false
    }];
    TR.convertRowsToEur(rows, {}, { missingFxDates: [] });
    assert.equal(rows[0]._fxMissing, true);
    TR.convertRowsToEur(rows, { '2024-03-12': 0.91 }, { missingFxDates: [] });
    assert.equal(rows[0]._fxMissing, false);
    assert.ok(close(rows[0].fxRate, 0.91));
    assert.ok(close(rows[0].netEUR, 91));
});

test('convertRowsToEur: idempotent — second call without rate clears stale EUR', () => {
    const rows = [{
        closedDateUTC: '2024-03-12',
        realizedPnlUSD: 100, netFundingUSD: 0, feesUSD: 0, netUSD: 100,
        _fxMissing: false
    }];
    TR.convertRowsToEur(rows, { '2024-03-12': 0.92 }, { missingFxDates: [] });
    assert.ok(close(rows[0].netEUR, 92));
    TR.convertRowsToEur(rows, {}, { missingFxDates: [] });
    assert.equal(rows[0].fxRate, undefined);
    assert.equal(rows[0].netEUR, undefined);
    assert.equal(rows[0]._fxMissing, true);
});

test('convertRowsToEur: idempotent — stale missingFxDates cleared on re-run with rates', () => {
    // First call: rate unavailable → date added to warnings.missingFxDates.
    // Second call on same rows with rate available must NOT leave the
    // stale date in the warnings array.
    const rows = [{
        closedDateUTC: '2024-03-12',
        realizedPnlUSD: 100, netFundingUSD: 0, feesUSD: 0, netUSD: 100,
        _fxMissing: false
    }];
    const warnings = { missingFxDates: [] };
    TR.convertRowsToEur(rows, {}, warnings);
    assert.deepEqual(warnings.missingFxDates, ['2024-03-12']);
    TR.convertRowsToEur(rows, { '2024-03-12': 0.92 }, warnings);
    assert.deepEqual(warnings.missingFxDates, [],
        'stale missing date must be cleared when rate becomes available');
});

test('convertRowsToEur: deduplicates missing dates', () => {
    const rows = [
        { closedDateUTC: '2024-03-12', realizedPnlUSD: 1, netFundingUSD: 0, feesUSD: 0, netUSD: 1, _fxMissing: false },
        { closedDateUTC: '2024-03-12', realizedPnlUSD: 2, netFundingUSD: 0, feesUSD: 0, netUSD: 2, _fxMissing: false }
    ];
    const warnings = { missingFxDates: [] };
    TR.convertRowsToEur(rows, {}, warnings);
    assert.deepEqual(warnings.missingFxDates, ['2024-03-12']);
});

// ---------------------------------------------------------------------------
// summarize — totals + win/loss bucketing + classification label.
// ---------------------------------------------------------------------------

test('summarize: gross gains/losses bucket by netUSD sign', () => {
    const rows = [
        { netUSD: 100, netEUR: 92, feesUSD: 1, feesEUR: 0.92, netFundingUSD: 0, netFundingEUR: 0, fxRate: 0.92 },
        { netUSD: -40, netEUR: -36.8, feesUSD: 0.5, feesEUR: 0.46, netFundingUSD: -1, netFundingEUR: -0.92, fxRate: 0.92 },
        { netUSD: 0, netEUR: 0, feesUSD: 0, feesEUR: 0, netFundingUSD: 0, netFundingEUR: 0, fxRate: 0.92 }
    ];
    const s = TR.summarize(rows, 'E');
    assert.equal(s.count, 3);
    assert.equal(s.winCount, 1);
    assert.equal(s.lossCount, 1);
    assert.equal(s.scratchCount, 1);
    assert.ok(close(s.netUSD, 60));
    assert.ok(close(s.grossGainsUSD, 100));
    assert.ok(close(s.grossLossesUSD, -40));
    assert.ok(close(s.netEUR, 55.2));
    assert.equal(s.eurPartial, false);
});

test('summarize: classification only changes label', () => {
    const rows = [
        { netUSD: 10, netEUR: 9.2, feesUSD: 0, feesEUR: 0, netFundingUSD: 0, netFundingEUR: 0, fxRate: 0.92 }
    ];
    const e = TR.summarize(rows, 'E');
    const g = TR.summarize(rows, 'G');
    assert.equal(e.label, 'Categoria E (derivativos)');
    assert.equal(g.label, 'Categoria G (cripto-ativos)');
    assert.equal(e.netUSD, g.netUSD);
    assert.equal(e.count, g.count);
    assert.equal(e.winCount, g.winCount);
});

test('summarize: zero EUR coverage collapses EUR totals to undefined', () => {
    const rows = [
        { netUSD: 10, netEUR: undefined, feesUSD: 0, feesEUR: undefined, netFundingUSD: 0, netFundingEUR: undefined, fxRate: undefined },
        { netUSD: 20, netEUR: undefined, feesUSD: 0, feesEUR: undefined, netFundingUSD: 0, netFundingEUR: undefined, fxRate: undefined }
    ];
    const s = TR.summarize(rows, 'E');
    assert.equal(s.netEUR, undefined);
    assert.equal(s.grossGainsEUR, undefined);
    assert.equal(s.grossLossesEUR, undefined);
    assert.equal(s.eurRowCount, 0);
    assert.equal(s.eurMissingCount, 2);
    assert.equal(s.eurPartial, false); // partial only when SOME rows have rate AND some don't
});

test('summarize: missing fxRate flips eurPartial', () => {
    const rows = [
        { netUSD: 10, netEUR: 9.2, feesUSD: 0, feesEUR: 0, netFundingUSD: 0, netFundingEUR: 0, fxRate: 0.92 },
        { netUSD: 20, netEUR: undefined, feesUSD: 0, feesEUR: undefined, netFundingUSD: 0, netFundingEUR: undefined, fxRate: undefined }
    ];
    const s = TR.summarize(rows, 'E');
    assert.equal(s.eurPartial, true);
    assert.ok(close(s.netEUR, 9.2));
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
        fxRate: 0.92, realizedPnlEUR: 92, netFundingEUR: 0, feesEUR: 0, netEUR: 92,
        holdingDays: 2, fillCount: 2,
        _feeAttributionWarning: false,
        _fxMissing: false
    }];
    const csv = TR.toCsv(rows, 'E', 2024);
    const lines = csv.split('\r\n');
    assert.ok(lines[0].startsWith('# Categoria E'), 'meta line first');
    assert.ok(lines[2].includes('"ETH,USD"'), `expected quoted market, got: ${lines[2]}`);
    assert.ok(lines[2].includes('"LO""NG"'), `expected doubled quotes, got: ${lines[2]}`);
});

test('toCsv: empty EUR cells when fxRate undefined', () => {
    const rows = [{
        closedAtISO: '2024-03-12T00:00:00Z',
        createdAtISO: '2024-03-10T00:00:00Z',
        closedDateUTC: '2024-03-12',
        market: 'ETH-USD', side: 'LONG',
        maxSize: 1, entryPrice: 3000, exitPrice: 3100,
        realizedPnlUSD: 100, netFundingUSD: 0, feesUSD: 0, netUSD: 100,
        fxRate: undefined, realizedPnlEUR: undefined, netFundingEUR: undefined,
        feesEUR: undefined, netEUR: undefined,
        holdingDays: 2, fillCount: 2,
        _feeAttributionWarning: false,
        _fxMissing: true
    }];
    const csv = TR.toCsv(rows, 'E', 2024);
    const lines = csv.split('\r\n');
    const dataRow = lines[2];
    assert.ok(dataRow.includes(',,,,,'), `expected run of empty fields, got: ${dataRow}`);
});

test('toJson: undefined fields serialize as null (stable schema across FX coverage)', () => {
    // JSON.stringify silently drops undefined object values, so without
    // explicit nullification a row with no EUR rate would lose its
    // netEUR / fxRate keys entirely — making the exported shape vary
    // with FX coverage and breaking downstream "is field present?"
    // checks.
    const rows = [{
        closedAtISO: '2024-03-12T00:00:00Z',
        market: 'ETH-USD', side: 'LONG',
        realizedPnlUSD: 100, netFundingUSD: 0, feesUSD: 0, netUSD: 100,
        fxRate: undefined, netEUR: undefined,
        realizedPnlEUR: undefined, netFundingEUR: undefined, feesEUR: undefined
    }];
    const totals = TR.summarize(rows, 'E');
    const out = JSON.parse(TR.toJson(rows, totals, 'E', 2024));
    assert.equal(out.rows[0].fxRate, null, 'fxRate must be null, not absent');
    assert.equal(out.rows[0].netEUR, null);
    assert.equal(out.totals.netEUR, null, 'totals.netEUR must be null when no EUR coverage');
    // Ensure the key actually exists (not just absent-and-defaulted)
    assert.ok('fxRate' in out.rows[0]);
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
        fxRate: undefined, realizedPnlEUR: undefined, netFundingEUR: undefined,
        feesEUR: undefined, netEUR: undefined,
        holdingDays: 5, fillCount: 1,
        _realizedFillError: 'invalid-fill-in-slice',
        _hasInvalidFill: true,
        _attributionIncomplete: true,
        _feeAttributionWarning: false,
        _fxMissing: true
    }];
    const csv = TR.toCsv(rows, 'E', 2024);
    const lines = csv.split('\r\n');
    const header = lines[1].split(',');
    const dataRow = lines[2].split(',');
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
        netFunding: '0', maxSize: '1'
    };
    const fills = [
        // unparseable createdAt — must be ignored by BOTH FIFO + windowing
        { market: 'BTC-USD', createdAt: 'not-a-date',           side: 'BUY',  size: '999', price: '1' },
        { market: 'BTC-USD', createdAt: '2024-01-11T00:00:00Z', side: 'BUY',  size: '1',   price: '100' },
        { market: 'BTC-USD', createdAt: '2024-01-14T00:00:00Z', side: 'SELL', size: '1',   price: '150' }
    ];
    // If the bad fill leaked into FIFO, the BUY 999@1 would consume the
    // SELL and produce ~-149,851 of attributed realized.
    const attribution = globalThis.RiskMetrics.attributeFillsToPositions([p], fills).get(p);
    assert.ok(close(attribution.realized, 50),
        `unparseable-createdAt fill must NOT affect FIFO inventory; expected 50, got ${attribution.realized}`);
    assert.equal(attribution.complete, false);
    const r = TR.buildYearReport([p], fills, 2024, {});
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0]._attributionIncomplete, true);
    assert.equal(r.rows[0].realizedPnlUSD, null);
});

test('toCsv: ends with CRLF', () => {
    const csv = TR.toCsv([], 'E', 2024);
    assert.ok(csv.endsWith('\r\n'));
});

// ---------------------------------------------------------------------------
// toJson — schema/metadata coverage.
// ---------------------------------------------------------------------------

test('toJson: meta block carries classification, year, schemaVersion', () => {
    const rows = [{
        closedAtISO: '2024-03-12T00:00:00Z',
        market: 'ETH-USD', side: 'LONG',
        realizedPnlUSD: 100, netFundingUSD: 0, feesUSD: 0, netUSD: 100
    }];
    const totals = TR.summarize(rows, 'E');
    const out = JSON.parse(TR.toJson(rows, totals, 'E', 2024));
    assert.equal(out.meta.classification, 'E');
    assert.equal(out.meta.classificationLabel, 'Categoria E (derivativos)');
    assert.equal(out.meta.year, 2024);
    assert.equal(out.meta.schemaVersion, 3);
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
    const totals = TR.summarize(rows, 'G');
    const out = JSON.parse(TR.toJson(rows, totals, 'G', 2024));
    assert.equal(out.rows.length, 2);
    assert.equal(out.rows[0].market, 'BTC-USD');
    assert.equal(out.totals.count, 2);
    assert.equal(out.totals.winCount, 1);
    assert.equal(out.totals.lossCount, 1);
    assert.equal(out.totals.classificationId, 'G');
});

test('toJson: classification argument overrides totals.classificationId in meta', () => {
    // meta.classification follows the JSON-call argument, while totals
    // keep their own classificationId — useful when a single set of
    // totals is exported under different category labels.
    const rows = [];
    const totals = TR.summarize(rows, 'E');
    const out = JSON.parse(TR.toJson(rows, totals, 'G', 2024));
    assert.equal(out.meta.classification, 'G');
    assert.equal(out.totals.classificationId, 'E');
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


