'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Tax module is browser-targeted; shim window onto globalThis so the IIFE
// attaches, then grab the global.
globalThis.window = globalThis;
require('../tax-report.js');
const TR = globalThis.TaxReport;

const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

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
// aggregateFeesForPosition — window + ambiguity flag.
// ---------------------------------------------------------------------------

test('aggregateFeesForPosition: sums in-window fills for same market+side', () => {
    const position = {
        market: 'ETH-USD',
        side: 'LONG',
        createdAt: '2024-01-10T00:00:00Z',
        closedAt: '2024-01-15T00:00:00Z'
    };
    const fills = [
        { market: 'ETH-USD', side: 'LONG',  createdAt: '2024-01-10T01:00:00Z', fee: '1.50' },
        { market: 'ETH-USD', side: 'LONG',  createdAt: '2024-01-14T22:00:00Z', fee: '2.25' },
        { market: 'ETH-USD', side: 'SHORT', createdAt: '2024-01-12T00:00:00Z', fee: '5.00' }, // wrong side
        { market: 'BTC-USD', side: 'LONG',  createdAt: '2024-01-12T00:00:00Z', fee: '5.00' }, // wrong market
        { market: 'ETH-USD', side: 'LONG',  createdAt: '2024-01-09T23:59:00Z', fee: '5.00' }, // before window
        { market: 'ETH-USD', side: 'LONG',  createdAt: '2024-01-15T00:00:01Z', fee: '5.00' }  // after window
    ];
    const result = TR.aggregateFeesForPosition(position, fills, [position]);
    assert.ok(close(result.totalFee, 3.75), `expected 3.75, got ${result.totalFee}`);
    assert.equal(result.fillCount, 2);
    assert.equal(result.warning, null);
});

test('aggregateFeesForPosition: flags overlap when another closed position shares market+side window', () => {
    const a = {
        status: 'CLOSED', market: 'ETH-USD', side: 'LONG',
        createdAt: '2024-01-10T00:00:00Z', closedAt: '2024-01-20T00:00:00Z'
    };
    const b = {
        status: 'CLOSED', market: 'ETH-USD', side: 'LONG',
        createdAt: '2024-01-15T00:00:00Z', closedAt: '2024-01-25T00:00:00Z'
    };
    const fills = [
        { market: 'ETH-USD', side: 'LONG', createdAt: '2024-01-17T00:00:00Z', fee: '1.00' }
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
// netRealizedPnl — derived vs indexer-supplied branch.
// ---------------------------------------------------------------------------

test('netRealizedPnl: derived flag subtracts fees', () => {
    assert.ok(close(TR.netRealizedPnl(100, 5, 3, true), 102));
});

test('netRealizedPnl: indexer-supplied (derived=false) does NOT subtract fees', () => {
    // Guards against double-counting if indexer realizedPnl already nets fees.
    assert.ok(close(TR.netRealizedPnl(100, 5, 3, false), 105));
});

test('netRealizedPnl: loss with paid funding, derived branch', () => {
    assert.ok(close(TR.netRealizedPnl(-50, -2, 1, true), -53));
});

// ---------------------------------------------------------------------------
// buildYearReport — filter by closedAt UTC year, exclude OPEN, attribute fees.
// ---------------------------------------------------------------------------

test('buildYearReport: filters by closedAt UTC year', () => {
    const positions = [
        { status: 'CLOSED', market: 'ETH-USD', side: 'LONG',
          createdAt: '2024-12-30T00:00:00Z', closedAt: '2024-12-31T23:59:59Z',
          realizedPnl: '100', netFunding: '0', entryPrice: '3000', exitPrice: '3100',
          maxSize: '1', _derivedRealizedPnl: true },
        { status: 'CLOSED', market: 'ETH-USD', side: 'LONG',
          createdAt: '2025-01-01T00:00:00Z', closedAt: '2025-01-02T00:00:00Z',
          realizedPnl: '50', netFunding: '0', entryPrice: '3100', exitPrice: '3150',
          maxSize: '1', _derivedRealizedPnl: true }
    ];
    const r2024 = TR.buildYearReport(positions, [], 2024, {});
    assert.equal(r2024.rows.length, 1);
    assert.equal(r2024.rows[0].closedAtISO, '2024-12-31T23:59:59Z');
    const r2025 = TR.buildYearReport(positions, [], 2025, {});
    assert.equal(r2025.rows.length, 1);
    assert.equal(r2025.rows[0].closedAtISO, '2025-01-02T00:00:00Z');
});

test('buildYearReport: excludes OPEN positions even when createdAt in year', () => {
    const positions = [
        { status: 'OPEN', market: 'ETH-USD', side: 'LONG',
          createdAt: '2024-06-01T00:00:00Z', closedAt: null },
        { status: 'CLOSED', market: 'ETH-USD', side: 'LONG',
          createdAt: '2024-06-01T00:00:00Z', closedAt: '2024-06-10T00:00:00Z',
          realizedPnl: '10', netFunding: '0', entryPrice: '3000', exitPrice: '3010',
          maxSize: '1' }
    ];
    const r = TR.buildYearReport(positions, [], 2024, {});
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].closedAtISO, '2024-06-10T00:00:00Z');
});

test('buildYearReport: attributes fees via window and computes netUSD with derived guard', () => {
    const p = {
        status: 'CLOSED', market: 'ETH-USD', side: 'LONG',
        createdAt: '2024-03-10T00:00:00Z', closedAt: '2024-03-12T00:00:00Z',
        realizedPnl: '100', netFunding: '-2', entryPrice: '3000', exitPrice: '3100',
        maxSize: '1', _derivedRealizedPnl: true
    };
    const fills = [
        { market: 'ETH-USD', side: 'LONG', createdAt: '2024-03-10T05:00:00Z', fee: '0.50' },
        { market: 'ETH-USD', side: 'LONG', createdAt: '2024-03-11T05:00:00Z', fee: '0.75' }
    ];
    const r = TR.buildYearReport([p], fills, 2024, {});
    assert.equal(r.rows.length, 1);
    const row = r.rows[0];
    assert.ok(close(row.feesUSD, 1.25));
    // derived flag → fees subtracted: 100 + (-2) - 1.25 = 96.75
    assert.ok(close(row.netUSD, 96.75), `expected 96.75, got ${row.netUSD}`);
    assert.equal(row._derivedRealizedPnl, true);
    assert.equal(row._feeDoubleCountRisk, false);
});

test('buildYearReport: indexer-supplied row carries fee-double-count-risk flag', () => {
    const p = {
        status: 'CLOSED', market: 'ETH-USD', side: 'LONG',
        createdAt: '2024-03-10T00:00:00Z', closedAt: '2024-03-12T00:00:00Z',
        realizedPnl: '100', netFunding: '0', entryPrice: '3000', exitPrice: '3100',
        maxSize: '1'
    };
    const fills = [
        { market: 'ETH-USD', side: 'LONG', createdAt: '2024-03-10T05:00:00Z', fee: '0.50' }
    ];
    const r = TR.buildYearReport([p], fills, 2024, {});
    const row = r.rows[0];
    assert.equal(row._derivedRealizedPnl, false);
    assert.equal(row._feeDoubleCountRisk, true);
    // derived=false → fees NOT subtracted: 100 + 0 - 0 = 100
    assert.ok(close(row.netUSD, 100));
    assert.equal(r.warnings.feeDoubleCountRiskCount, 1);
});

test('buildYearReport: rows sorted by closedAt descending', () => {
    const positions = [
        { status: 'CLOSED', market: 'ETH-USD', side: 'LONG',
          createdAt: '2024-01-01T00:00:00Z', closedAt: '2024-01-05T00:00:00Z',
          realizedPnl: '10', netFunding: '0', maxSize: '1', entryPrice: '1', exitPrice: '1' },
        { status: 'CLOSED', market: 'ETH-USD', side: 'LONG',
          createdAt: '2024-02-01T00:00:00Z', closedAt: '2024-02-05T00:00:00Z',
          realizedPnl: '20', netFunding: '0', maxSize: '1', entryPrice: '1', exitPrice: '1' }
    ];
    const r = TR.buildYearReport(positions, [], 2024, {});
    assert.equal(r.rows[0].closedAtISO, '2024-02-05T00:00:00Z');
    assert.equal(r.rows[1].closedAtISO, '2024-01-05T00:00:00Z');
});

// ---------------------------------------------------------------------------
// convertRowsToEur — present rate populates mirrors; absent → flag + warn.
// ---------------------------------------------------------------------------

test('convertRowsToEur: present rate populates EUR mirrors', () => {
    const rows = [{
        closedDateUTC: '2024-03-12',
        realizedPnlUSD: 100, netFundingUSD: -2, feesUSD: 1.25, netUSD: 96.75,
        _fxMissing: false
    }];
    const fxRates = { '2024-03-12': 0.92 };
    const warnings = { missingFxDates: [] };
    TR.convertRowsToEur(rows, fxRates, warnings);
    assert.ok(close(rows[0].fxRate, 0.92));
    assert.ok(close(rows[0].realizedPnlEUR, 92));
    assert.ok(close(rows[0].netEUR, 96.75 * 0.92));
    assert.equal(rows[0]._fxMissing, false);
    assert.equal(warnings.missingFxDates.length, 0);
});

test('convertRowsToEur: absent rate flags row and pushes to warnings.missingFxDates', () => {
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
// toCsv — RFC 4180 escaping.
// ---------------------------------------------------------------------------

test('toCsv: RFC 4180 escapes comma, quote, newline', () => {
    const rows = [{
        closedAtISO: '2024-03-12T00:00:00Z',
        createdAtISO: '2024-03-10T00:00:00Z',
        closedDateUTC: '2024-03-12',
        market: 'ETH,USD',   // comma → must quote
        side: 'LO"NG',       // quote → must quote and double
        maxSize: 1, entryPrice: 3000, exitPrice: 3100,
        realizedPnlUSD: 100, netFundingUSD: 0, feesUSD: 0, netUSD: 100,
        fxRate: 0.92, realizedPnlEUR: 92, netFundingEUR: 0, feesEUR: 0, netEUR: 92,
        holdingDays: 2,
        _derivedRealizedPnl: false, _feeAttributionWarning: false,
        _fxMissing: false, _feeDoubleCountRisk: false
    }];
    const csv = TR.toCsv(rows, 'E', 2024);
    const lines = csv.split('\r\n');
    assert.ok(lines[0].startsWith('# Categoria E'), 'meta line first');
    assert.ok(lines[1].split(',').length >= 20, 'header has 21 columns');
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
        holdingDays: 2,
        _derivedRealizedPnl: false, _feeAttributionWarning: false,
        _fxMissing: true, _feeDoubleCountRisk: false
    }];
    const csv = TR.toCsv(rows, 'E', 2024);
    const lines = csv.split('\r\n');
    const dataRow = lines[2];
    // fx_rate_usd_eur and 4 EUR columns should all be empty between commas
    assert.ok(dataRow.includes(',,,,,'), `expected run of empty fields, got: ${dataRow}`);
});

test('toCsv: ends with CRLF', () => {
    const csv = TR.toCsv([], 'E', 2024);
    assert.ok(csv.endsWith('\r\n'));
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
