'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Tax module is browser-targeted and depends on window.RiskMetrics
// (computeRealizedFromFills). Shim window onto globalThis, load
// risk-metrics first, then tax-report.
globalThis.window = globalThis;
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
// aggregateFeesForPosition — window + market filter (NO side filter).
// /v4/fills exposes side as BUY/SELL; positions are LONG/SHORT. Both
// sides legitimately belong to a position's lifecycle (open + close
// fills always use opposite sides), so the helper must not equality-
// match on side.
// ---------------------------------------------------------------------------

test('aggregateFeesForPosition: sums in-window fills for same market regardless of BUY vs SELL', () => {
    const position = {
        market: 'ETH-USD',
        side: 'LONG',
        createdAt: '2024-01-10T00:00:00Z',
        closedAt: '2024-01-15T00:00:00Z'
    };
    const fills = [
        { market: 'ETH-USD', side: 'BUY',  createdAt: '2024-01-10T01:00:00Z', fee: '1.50' },
        { market: 'ETH-USD', side: 'SELL', createdAt: '2024-01-14T22:00:00Z', fee: '2.25' },
        { market: 'BTC-USD', side: 'BUY',  createdAt: '2024-01-12T00:00:00Z', fee: '5.00' },
        { market: 'ETH-USD', side: 'BUY',  createdAt: '2024-01-09T23:59:00Z', fee: '5.00' },
        { market: 'ETH-USD', side: 'SELL', createdAt: '2024-01-15T00:00:01Z', fee: '5.00' }
    ];
    const result = TR.aggregateFeesForPosition(position, fills, [position]);
    assert.ok(close(result.totalFee, 3.75, 1e-9), `expected 3.75, got ${result.totalFee}`);
    assert.equal(result.fillCount, 2);
    assert.equal(result.warning, null);
});

test('aggregateFeesForPosition: flags overlap when another closed position shares market window', () => {
    const a = {
        status: 'CLOSED', market: 'ETH-USD', side: 'LONG',
        createdAt: '2024-01-10T00:00:00Z', closedAt: '2024-01-20T00:00:00Z'
    };
    const b = {
        status: 'CLOSED', market: 'ETH-USD', side: 'SHORT',
        createdAt: '2024-01-15T00:00:00Z', closedAt: '2024-01-25T00:00:00Z'
    };
    const fills = [
        { market: 'ETH-USD', side: 'BUY', createdAt: '2024-01-17T00:00:00Z', fee: '1.00' }
    ];
    const result = TR.aggregateFeesForPosition(a, fills, [a, b]);
    assert.equal(result.warning, 'overlap');
});

test('aggregateFeesForPosition: no fills returns zero, no warning', () => {
    const position = {
        market: 'ETH-USD', side: 'LONG',
        createdAt: '2024-01-10T00:00:00Z', closedAt: '2024-01-15T00:00:00Z'
    };
    const result = TR.aggregateFeesForPosition(position, [], [position]);
    assert.equal(result.totalFee, 0);
    assert.equal(result.fillCount, 0);
    assert.equal(result.warning, null);
});

// ---------------------------------------------------------------------------
// realizedFromSlicedFills — FIFO over per-position-sliced fills.
// Source of truth for taxable realized P&L. Aligns with the rest of
// the dashboard's P&L pipeline (FIFO-from-fills is authoritative).
// ---------------------------------------------------------------------------

test('realizedFromSlicedFills: BUY-then-SELL within window yields exit-entry × size', () => {
    const position = {
        market: 'BTC-USD',
        createdAt: '2024-01-10T00:00:00Z',
        closedAt: '2024-01-15T00:00:00Z'
    };
    const fills = [
        { market: 'BTC-USD', createdAt: '2024-01-10T00:00:00Z', side: 'BUY',  size: '1', price: '100' },
        { market: 'BTC-USD', createdAt: '2024-01-15T00:00:00Z', side: 'SELL', size: '1', price: '150' }
    ];
    const r = TR.realizedFromSlicedFills(position, fills);
    assert.ok(close(r.realized, 50), `expected 50, got ${r.realized}`);
    assert.equal(r.fillCount, 2);
});

test('realizedFromSlicedFills: SELL-open SHORT then BUY-close', () => {
    const position = {
        market: 'BTC-USD',
        createdAt: '2024-02-01T00:00:00Z',
        closedAt: '2024-02-05T00:00:00Z'
    };
    const fills = [
        { market: 'BTC-USD', createdAt: '2024-02-01T00:00:00Z', side: 'SELL', size: '1', price: '200' },
        { market: 'BTC-USD', createdAt: '2024-02-05T00:00:00Z', side: 'BUY',  size: '1', price: '180' }
    ];
    const r = TR.realizedFromSlicedFills(position, fills);
    assert.ok(close(r.realized, 20), `expected 20, got ${r.realized}`);
});

test('realizedFromSlicedFills: scaled-in LONG resolves via FIFO', () => {
    const position = {
        market: 'BTC-USD',
        createdAt: '2024-03-01T00:00:00Z',
        closedAt: '2024-03-10T00:00:00Z'
    };
    const fills = [
        { market: 'BTC-USD', createdAt: '2024-03-01T00:00:00Z', side: 'BUY',  size: '1', price: '100' },
        { market: 'BTC-USD', createdAt: '2024-03-05T00:00:00Z', side: 'BUY',  size: '1', price: '200' },
        { market: 'BTC-USD', createdAt: '2024-03-10T00:00:00Z', side: 'SELL', size: '2', price: '300' }
    ];
    // FIFO: (300-100)*1 + (300-200)*1 = 300
    const r = TR.realizedFromSlicedFills(position, fills);
    assert.ok(close(r.realized, 300), `expected 300, got ${r.realized}`);
});

test('realizedFromSlicedFills: invalid fill in flat slice → invalid-fill-in-slice error', () => {
    // RiskMetrics.computeRealizedFromFills silently skips fills with
    // invalid price/size/side. A flat slice with a bad fill would
    // produce realized=0 with no error if we trusted FIFO blindly.
    const position = {
        market: 'BTC-USD',
        createdAt: '2024-01-10T00:00:00Z',
        closedAt: '2024-01-15T00:00:00Z'
    };
    const fills = [
        { market: 'BTC-USD', createdAt: '2024-01-11T00:00:00Z', side: 'BUY',  size: '1', price: '100' },
        { market: 'BTC-USD', createdAt: '2024-01-12T00:00:00Z', side: 'BUY',  size: '1', price: 'NaN' }, // invalid price
        { market: 'BTC-USD', createdAt: '2024-01-13T00:00:00Z', side: 'SELL', size: '2', price: '150' }
    ];
    const r = TR.realizedFromSlicedFills(position, fills);
    assert.equal(r.error, 'invalid-fill-in-slice');
    assert.equal(r.realized, 0);
});

test('buildYearReport: invalid-price fill in flat slice → invalid-fill-in-slice + warning counted', () => {
    // Net-flat (BUY 1 + BUY 1 + SELL 2) so the partial-fill-slice gate
    // doesn't trip. One fill carries a NaN price, which
    // computeRealizedFromFills would silently skip — the new
    // allFillsFifoUsable gate must catch it instead.
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
    assert.equal(r.rows[0]._realizedFromFills, false);
    assert.equal(r.rows[0]._realizedFillError, 'invalid-fill-in-slice');
    assert.equal(r.warnings.positionsWithoutFifoCount, 1);
    assert.equal(r.warnings.positionsWithInvalidFillCount, 1,
        'invalid-fill rows must increment the separate counter so the panel can warn the totals may be understated');
});

test('buildYearReport: invalid fill in a partial slice still flips the invalid-fill counter', () => {
    // Slice has only a BUY (not net flat → partial-fill-slice), but the
    // BUY's price is NaN. realizedError settles on 'partial-fill-slice'
    // (first-failing gate), but the invalid-fill condition is independent
    // and must still be counted — otherwise the panel would show "totals
    // exact" while continuous FIFO has silently skipped the invalid fill.
    const p = {
        status: 'CLOSED', market: 'BTC-USD', side: 'LONG',
        createdAt: '2024-01-10T00:00:00Z', closedAt: '2024-01-15T00:00:00Z',
        netFunding: '0', maxSize: '1'
    };
    const fills = [
        { market: 'BTC-USD', createdAt: '2024-01-11T00:00:00Z', side: 'BUY', size: '1', price: 'NaN' }
    ];
    const r = TR.buildYearReport([p], fills, 2024, {});
    assert.equal(r.rows[0]._realizedFillError, 'partial-fill-slice');
    assert.equal(r.rows[0]._hasInvalidFill, true);
    assert.equal(r.warnings.positionsWithoutFifoCount, 1);
    assert.equal(r.warnings.positionsWithInvalidFillCount, 1,
        'invalid-fill must be tracked independently of net-flat: the FIFO-skip risk applies regardless of slice completeness');
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

test('realizedFromSlicedFills: partial slice flagged with error matching buildYearReport', () => {
    // Public helper must apply the same net-flat gate as the optimized
    // batch path in buildYearReport, otherwise a future caller (or
    // regression in either path) could silently re-introduce the
    // FIFO-returns-0-for-orphan-inventory bug.
    const position = {
        market: 'BTC-USD',
        createdAt: '2024-01-10T00:00:00Z',
        closedAt: '2024-01-15T00:00:00Z'
    };
    const fills = [
        { market: 'BTC-USD', createdAt: '2024-01-11T00:00:00Z', side: 'BUY', size: '1', price: '100' }
        // SELL missing — net != 0
    ];
    const r = TR.realizedFromSlicedFills(position, fills);
    assert.equal(r.realized, 0);
    assert.equal(r.fillCount, 1);
    assert.equal(r.error, 'partial-fill-slice');
});

test('realizedFromSlicedFills: ignores fills outside window or in other markets', () => {
    const position = {
        market: 'BTC-USD',
        createdAt: '2024-04-01T00:00:00Z',
        closedAt: '2024-04-05T00:00:00Z'
    };
    const fills = [
        { market: 'BTC-USD', createdAt: '2024-04-01T00:00:00Z', side: 'BUY',  size: '1', price: '100' },
        { market: 'BTC-USD', createdAt: '2024-04-05T00:00:00Z', side: 'SELL', size: '1', price: '150' },
        { market: 'BTC-USD', createdAt: '2024-03-30T00:00:00Z', side: 'BUY',  size: '5', price: '999' },
        { market: 'BTC-USD', createdAt: '2024-04-10T00:00:00Z', side: 'SELL', size: '5', price: '999' },
        { market: 'ETH-USD', createdAt: '2024-04-02T00:00:00Z', side: 'BUY',  size: '5', price: '999' }
    ];
    const r = TR.realizedFromSlicedFills(position, fills);
    assert.ok(close(r.realized, 50), `expected 50, got ${r.realized}`);
    assert.equal(r.fillCount, 2);
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
    assert.equal(row._realizedFromFills, true);
});

test('buildYearReport: no fills in window flags row as not-from-FIFO', () => {
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
    assert.equal(row.realizedPnlUSD, 0);
    assert.equal(row._realizedFromFills, false);
    assert.equal(r.warnings.positionsWithoutFifoCount, 1);
});

test('buildYearReport: missing maxSize/entry/exit render as null (distinguishable from real 0)', () => {
    const p = {
        status: 'CLOSED', market: 'BTC-USD', side: 'LONG',
        createdAt: '2024-01-01T00:00:00Z', closedAt: '2024-01-02T00:00:00Z',
        netFunding: '0'
        // maxSize, sumOpen, size, entryPrice, exitPrice all absent
    };
    const r = TR.buildYearReport([p], [], 2024, {});
    const row = r.rows[0];
    assert.equal(row.maxSize, null);
    assert.equal(row.entryPrice, null);
    assert.equal(row.exitPrice, null);
});

test('buildYearReport: closed-position size=0 alone does NOT seed maxSize', () => {
    // dYdX closed-position rows commonly have size:"0" after close.
    // Falling back to that would turn an unavailable max into a hard 0,
    // which is misleading because the position clearly had non-zero
    // size at some point.
    const p = {
        status: 'CLOSED', market: 'BTC-USD', side: 'LONG',
        createdAt: '2024-01-01T00:00:00Z', closedAt: '2024-01-02T00:00:00Z',
        netFunding: '0', size: '0'
        // maxSize and sumOpen intentionally absent
    };
    const r = TR.buildYearReport([p], [], 2024, {});
    assert.equal(r.rows[0].maxSize, null);
});

test('buildYearReport: partial fill slice (no closing fill) flagged as not-FIFO', () => {
    // Only the opening BUY arrived in the indexer window — net size is
    // not zero, so FIFO would silently return 0 realized for orphan
    // inventory. The row must drop _realizedFromFills so the panel
    // surfaces a warning instead of a misleading $0.
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
    assert.equal(r.rows[0]._realizedFromFills, false);
    assert.equal(r.rows[0].realizedPnlUSD, 0);
    assert.equal(r.warnings.positionsWithoutFifoCount, 1);
});

test('buildYearReport: partial fill slice (no opening fill) flagged as not-FIFO', () => {
    // Symmetric case: closing SELL present but opening BUY out of window.
    const p = {
        status: 'CLOSED', market: 'BTC-USD', side: 'LONG',
        createdAt: '2024-03-01T00:00:00Z', closedAt: '2024-03-05T00:00:00Z',
        netFunding: '0', maxSize: '1'
    };
    const fills = [
        { market: 'BTC-USD', side: 'SELL', createdAt: '2024-03-05T00:00:00Z', size: '1', price: '120' }
    ];
    const r = TR.buildYearReport([p], fills, 2024, {});
    assert.equal(r.rows[0]._realizedFromFills, false);
    assert.equal(r.warnings.positionsWithoutFifoCount, 1);
});

test('buildYearReport: real 0 entry/exit preserved (not coerced to null)', () => {
    const p = {
        status: 'CLOSED', market: 'BTC-USD', side: 'LONG',
        createdAt: '2024-01-01T00:00:00Z', closedAt: '2024-01-02T00:00:00Z',
        entryPrice: '0', exitPrice: '0', maxSize: '0', netFunding: '0'
    };
    const r = TR.buildYearReport([p], [], 2024, {});
    const row = r.rows[0];
    assert.equal(row.maxSize, 0);
    assert.equal(row.entryPrice, 0);
    assert.equal(row.exitPrice, 0);
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
    // positions; the attribution rule (smallest-openMs claims it) places
    // the boundary fill into A alone.
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
    // BUY 1@100 opens A. SELL 1@110 closes A (flip-out). BUY 1@110 opens
    // B. SELL 1@120 closes B.
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

test('buildYearReport: realized attributed by continuous FIFO across position boundaries', () => {
    // Pathological-but-real scenario from a heavily-scaled live account:
    // the indexer marks position A CLOSED at 11:00 with only its opening
    // BUY in its slice (closing fill landed at 12:00 inside B's window).
    // Continuous FIFO (BUY 2@100 → SELL 2@160) realizes 120 at the SELL.
    // The SELL is in B's window only, so it's attributed to B.
    //
    // Old per-window code: A's slice not flat → realized=0; B's slice
    // not flat → realized=0; total = 0. Wrong by $120.
    // New: A's realized=0 (only extending fill), B's realized=120.
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
    const sumRealized = r.rows.reduce((s, row) => s + row.realizedPnlUSD, 0);
    assert.ok(close(sumRealized, 120),
        `continuous FIFO must surface the 120 realized at the closing SELL even though neither slice is flat in isolation; got ${sumRealized}`);
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
        _realizedFromFills: true,
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
        _realizedFromFills: true,
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
    assert.equal(out.meta.schemaVersion, 1);
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

// ---------------------------------------------------------------------------
// _internal.fillsInWindow — verify NO side filter (BUY and SELL both in).
// ---------------------------------------------------------------------------

test('fillsInWindow: includes BUY and SELL fills indiscriminately', () => {
    const position = {
        market: 'ETH-USD',
        createdAt: '2024-01-10T00:00:00Z',
        closedAt: '2024-01-15T00:00:00Z'
    };
    const fills = [
        { market: 'ETH-USD', side: 'BUY',  createdAt: '2024-01-11T00:00:00Z' },
        { market: 'ETH-USD', side: 'SELL', createdAt: '2024-01-14T00:00:00Z' }
    ];
    const out = TR._internal.fillsInWindow(position, fills);
    assert.equal(out.length, 2);
});
