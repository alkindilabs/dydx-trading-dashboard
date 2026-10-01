'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const RM = require('./setup');

// Tolerance for float comparisons on derived dollar values.
const close = (a, b, eps = 1e-2) => Math.abs(a - b) < eps;

// ---------------------------------------------------------------------------
// crossMarginLiqPrice — pin the LONG bug we fixed (formula previously had the
// wrong shape: oracle - equity/(S·(1-M)) instead of (S·O - E)/(S·(1-M))).
// ---------------------------------------------------------------------------

test('crossMarginLiqPrice LONG canonical regression (matches dYdX official)', () => {
    // Fixture: BTC-USD LONG 5 @ entry 75000, oracle 80000, equity 300000,
    // MMF 0.012: liq = (5·80000 − 300000) / (5·0.988) = 20242.91. The old
    // wrong shape, oracle − equity/(S·(1−M)), would give 19271.26.
    const position = { market: 'BTC-USD', size: '5', side: 'LONG' };
    const sub = { equity: '300000' };
    const markets = {
        'BTC-USD': { oraclePrice: '80000', maintenanceMarginFraction: '0.012' }
    };
    const liq = RM.crossMarginLiqPrice(position, sub, markets);
    assert.ok(liq !== null, 'expected numeric liq');
    assert.ok(close(liq, 20242.91, 1.0), `expected ~20242.91, got ${liq}`);
});

test('crossMarginLiqPrice LONG reads oracle from marketsMap when position lacks it', () => {
    const position = { market: 'BTC-USD', size: '1', side: 'LONG' };
    const sub = { equity: '50000' };
    const markets = {
        'BTC-USD': { oraclePrice: '100000', maintenanceMarginFraction: '0.05' }
    };
    const liq = RM.crossMarginLiqPrice(position, sub, markets);
    // (1·100000 - 50000) / (1·0.95) = 52631.58
    assert.ok(close(liq, 52631.58, 0.1), `expected ~52631.58, got ${liq}`);
});

test('crossMarginLiqPrice LONG returns null when MMF / size / equity missing', () => {
    const sub = { equity: '50000' };
    const okMarket = { 'BTC-USD': { oraclePrice: '100000', maintenanceMarginFraction: '0.05' } };
    const noMmf  = { 'BTC-USD': { oraclePrice: '100000' } };
    const noOracle = { 'BTC-USD': { maintenanceMarginFraction: '0.05' } };

    assert.equal(
        RM.crossMarginLiqPrice({ market: 'BTC-USD', size: '0', side: 'LONG' }, sub, okMarket),
        null, 'size=0 should yield null'
    );
    assert.equal(
        RM.crossMarginLiqPrice({ market: 'BTC-USD', size: '1', side: 'LONG' }, sub, noMmf),
        null, 'missing MMF should yield null'
    );
    assert.equal(
        RM.crossMarginLiqPrice({ market: 'BTC-USD', size: '1', side: 'LONG' }, sub, noOracle),
        null, 'missing oracle should yield null'
    );
    assert.equal(
        RM.crossMarginLiqPrice({ market: 'BTC-USD', size: '1', side: 'LONG' }, { equity: '0' }, okMarket),
        null, 'equity=0 should yield null'
    );
});

test('crossMarginLiqPrice LONG floors at 0 when computed P_liq is negative', () => {
    // Tiny, deeply overcollateralized position: equity dwarfs notional → math
    // produces a negative number; helper must clamp via Math.max(0, …) so the
    // UI never renders a negative liquidation price.
    const position = { market: 'BTC-USD', size: '0.001', side: 'LONG' };
    const sub = { equity: '1000000' };
    const markets = {
        'BTC-USD': { oraclePrice: '100000', maintenanceMarginFraction: '0.05' }
    };
    const liq = RM.crossMarginLiqPrice(position, sub, markets);
    assert.equal(liq, 0, `expected 0, got ${liq}`);
});

test('crossMarginLiqPrice SHORT canonical', () => {
    // (E + |S|·O) / (|S|·(1+M)) — short liq is above oracle.
    const position = { market: 'ETH-USD', size: '1', side: 'SHORT' };
    const sub = { equity: '20' };
    const markets = {
        'ETH-USD': { oraclePrice: '100', maintenanceMarginFraction: '0.05' }
    };
    const liq = RM.crossMarginLiqPrice(position, sub, markets);
    assert.ok(close(liq, 114.286, 0.01), `expected ~114.286, got ${liq}`);
});

test('crossMarginLiqPrice unknown side returns null', () => {
    const sub = { equity: '50000' };
    const markets = { 'BTC-USD': { oraclePrice: '100000', maintenanceMarginFraction: '0.05' } };
    const out = RM.crossMarginLiqPrice({ market: 'BTC-USD', size: '1', side: 'BOTH' }, sub, markets);
    assert.equal(out, null);
});

// ---------------------------------------------------------------------------
// leverageUtilization — pin the entry-vs-oracle and marketsMap-source bugs.
// ---------------------------------------------------------------------------

test('leverageUtilization uses oracle (mark) over entry', () => {
    const positions = [
        { market: 'BTC-USD', side: 'LONG', size: '1', status: 'OPEN', entryPrice: '50000', oraclePrice: '100000' }
    ];
    const sub = { equity: '50000' };
    const lev = RM.leverageUtilization(positions, sub, {});
    // Oracle-based: 1·100000 / 50000 = 2.0. Entry-based would be 1.0.
    assert.ok(close(lev, 2.0), `expected 2.0 from oracle, got ${lev}`);
});

test('leverageUtilization falls back to entry when oracle absent everywhere', () => {
    const positions = [
        { market: 'BTC-USD', side: 'LONG', size: '1', status: 'OPEN', entryPrice: '50000' }
    ];
    const sub = { equity: '50000' };
    const lev = RM.leverageUtilization(positions, sub, {});
    assert.ok(close(lev, 1.0), `expected 1.0 from entry fallback, got ${lev}`);
});

test('leverageUtilization reads oracle from marketsMap when position lacks oraclePrice', () => {
    // This is the exact bug we shipped: positions from /perpetualPositions
    // do NOT carry oraclePrice; it lives on /perpetualMarkets[ticker]. When
    // the helper had no marketsMap argument, this fallback always failed and
    // notional silently used entryPrice.
    const positions = [
        { market: 'BTC-USD', side: 'LONG', size: '5', status: 'OPEN', entryPrice: '75000' }
    ];
    const sub = { equity: '300000' };
    const markets = { 'BTC-USD': { oraclePrice: '80000' } };
    const lev = RM.leverageUtilization(positions, sub, markets);
    // Oracle-based: 5·80000 / 300000 = 1.3333 (entry-based would be 1.25)
    assert.ok(close(lev, 1.3333, 1e-3), `expected ~1.3333, got ${lev}`);
});

test('leverageUtilization returns null when equity ≤ 0', () => {
    const positions = [
        { market: 'BTC-USD', side: 'LONG', size: '1', status: 'OPEN', oraclePrice: '100000' }
    ];
    assert.equal(RM.leverageUtilization(positions, { equity: '0' }, {}), null);
    assert.equal(RM.leverageUtilization(positions, { equity: '-100' }, {}), null);
    assert.equal(RM.leverageUtilization(positions, null, {}), null);
});

test('usableEquity is the equity only when it is positive', () => {
    assert.equal(RM.usableEquity({ equity: '0.01' }), 0.01);
    assert.equal(RM.usableEquity({ equity: '0' }), null, 'zero equity');
    assert.equal(RM.usableEquity({ equity: '-100' }), null);
    assert.equal(RM.usableEquity({ equity: 'n/a' }), null);
    assert.equal(RM.usableEquity({}), null);
    assert.equal(RM.usableEquity(null), null);
});

test('leverageUtilization skips closed positions', () => {
    const positions = [
        { market: 'BTC-USD', side: 'LONG', size: '1', status: 'CLOSED', oraclePrice: '100000' },
        { market: 'ETH-USD', side: 'LONG', size: '1', status: 'OPEN',   oraclePrice: '4000' }
    ];
    const sub = { equity: '40000' };
    const lev = RM.leverageUtilization(positions, sub, {});
    // Only ETH counts: 4000/40000 = 0.1
    assert.ok(close(lev, 0.1), `expected 0.1, got ${lev}`);
});

// ---------------------------------------------------------------------------
// liquidationRow — display-side helper used by the Liquidation Risk table.
// ---------------------------------------------------------------------------

test('liquidationRow notional uses oracle-first (matches leverageUtilization)', () => {
    const position = { market: 'BTC-USD', side: 'LONG', size: '5', status: 'OPEN', entryPrice: '75000' };
    const sub = { equity: '300000' };
    const markets = {
        'BTC-USD': { oraclePrice: '80000', maintenanceMarginFraction: '0.012' }
    };
    const row = RM.liquidationRow(position, sub, markets);
    assert.ok(close(row.notional, 5 * 80000, 1e-2));
    assert.ok(close(row.lev, 1.3333, 1e-3));
});

test('liquidationRow distancePct from oracle and liq', () => {
    const position = { market: 'BTC-USD', side: 'LONG', size: '5', status: 'OPEN' };
    const sub = { equity: '300000' };
    const markets = {
        'BTC-USD': { oraclePrice: '80000', maintenanceMarginFraction: '0.012' }
    };
    const row = RM.liquidationRow(position, sub, markets);
    // (80000 - 20242.91) / 80000 ≈ 74.70%
    assert.ok(close(row.distancePct, 74.70, 0.05), `expected ~74.70%, got ${row.distancePct}`);
});

test('positionNotional values an open position at oracle without needing the subaccount', () => {
    const markets = { 'BTC-USD': { oraclePrice: '100000' } };
    assert.equal(RM.positionNotional({ market: 'BTC-USD', size: '-2', entryPrice: '90000' }, markets), 200000,
        'a SHORT size counts by magnitude, priced at the market oracle');
    assert.equal(RM.positionNotional({ market: 'BTC-USD', size: '2', oraclePrice: '110000' }, markets), 220000,
        'a position-level oracle wins over the market map');
    assert.equal(RM.positionNotional({ market: 'ETH-USD', size: '3', entryPrice: '2000' }, markets), 6000,
        'entry price is the fallback when no oracle exists');
    assert.equal(RM.positionNotional({ market: 'ETH-USD', size: '3' }, markets), null, 'no price at all');
    assert.equal(RM.positionNotional({ market: 'BTC-USD', size: '0' }, markets), null, 'no size');
});

// ---------------------------------------------------------------------------
// attributeFillsToPositions — per-position P&L, size and prices from one
// FIFO walk over /fills. Replaces the indexer's realizedPnl / maxSize /
// entryPrice / exitPrice, which are wrong on scaled, SHORT and flip rows.
// ---------------------------------------------------------------------------

function mkFill(market, createdAt, height, side, size, price, fee) {
    return {
        id: `${market}-${height}-${side}`, market, createdAt,
        createdAtHeight: String(height), side,
        size: String(size), price: String(price), fee: String(fee)
    };
}

const T1 = '2025-01-01T00:00:00.000Z';
const T2 = '2025-01-02T00:00:00.000Z';
const T3 = '2025-01-03T00:00:00.000Z';
const T4 = '2025-01-04T00:00:00.000Z';

test('attributeFillsToPositions splits a flip fill between the closed LONG and the SHORT it opens', () => {
    const long  = { market: 'ETH-USD', status: 'CLOSED', side: 'LONG',  createdAt: T1, closedAt: T2 };
    const short = { market: 'ETH-USD', status: 'CLOSED', side: 'SHORT', createdAt: T2, closedAt: T3 };
    const fills = [
        mkFill('ETH-USD', T1, 1, 'BUY',  2, 100, 1),
        mkFill('ETH-USD', T2, 2, 'SELL', 5, 150, 5),   // closes 2 LONG, opens 3 SHORT
        mkFill('ETH-USD', T3, 3, 'BUY',  3, 120, 0.6)
    ];
    const rawSnapshot = JSON.parse(JSON.stringify([long, short]));
    const byPosition = RM.attributeFillsToPositions([long, short], fills);
    const L = byPosition.get(long);
    const S = byPosition.get(short);

    // LONG: (150−100)·2 realized; fee 1 + 5·(2/5) of the flip fill.
    assert.ok(close(L.realized, 100), `long realized ${L.realized}`);
    assert.ok(close(L.fees, 3), `long fees ${L.fees}`);
    assert.ok(close(L.profit, 97));
    assert.equal(L.peakSize, 2);
    assert.ok(close(L.entryVwap, 100));
    assert.ok(close(L.exitVwap, 150));
    assert.equal(L.fillCount, 2);
    assert.equal(L.openedByFlip, false);
    assert.equal(L.closedByFlip, true);
    assert.equal(L.complete, true);

    // SHORT: opened by the flip's residual 3 @150, closed 3 @120.
    assert.ok(close(S.realized, 90), `short realized ${S.realized}`);
    assert.ok(close(S.fees, 3.6), `short fees ${S.fees}`);
    assert.ok(close(S.profit, 86.4));
    assert.equal(S.peakSize, 3);
    assert.ok(close(S.entryVwap, 150));
    assert.ok(close(S.exitVwap, 120));
    assert.equal(S.fillCount, 2);
    assert.equal(S.openedByFlip, true);
    assert.equal(S.closedByFlip, false);
    assert.equal(S.complete, true);

    // Per-position values partition the market-wide totals exactly.
    assert.ok(close(L.realized + S.realized, RM.computeRealizedFromFills(fills).total));
    assert.ok(close(L.fees + S.fees, RM.feesTotal(fills)));
    assert.deepEqual([long, short], rawSnapshot, 'raw indexer positions must not be mutated');
});

test('attributeFillsToPositions: SHORT peakSize is the largest short exposure, not the indexer maxSize', () => {
    // The indexer reports maxSize as max() over the SIGNED size, which on a
    // SHORT is the size left before the final closing BUY (-0.7 here).
    const short = {
        market: 'BTC-USD', status: 'CLOSED', side: 'SHORT',
        createdAt: T1, closedAt: T3, maxSize: '-0.7'
    };
    const fills = [
        mkFill('BTC-USD', T1, 1, 'SELL', 5,   100, 0),
        mkFill('BTC-USD', T2, 2, 'SELL', 5,   100, 0),
        mkFill('BTC-USD', T3, 3, 'BUY',  9.3, 90,  0),
        mkFill('BTC-USD', T3, 4, 'BUY',  0.7, 90,  0)
    ];
    const a = RM.attributeFillsToPositions([short], fills).get(short);
    assert.equal(a.peakSize, 10);
    assert.ok(close(a.realized, 100), `realized ${a.realized}`);
    assert.equal(a.complete, true);
});

test('attributeFillsToPositions: scaled position uses FIFO realized, peak size and VWAP prices', () => {
    // BUY 2@100, SELL 1@150 (net 1), BUY 3@200 (net 4 = peak), SELL 4@250.
    // FIFO: 1·(150−100) + 1·(250−100) + 3·(250−200) = 350.
    // Peak 4, not sumOpen 5; entry VWAP (2·100 + 3·200)/5 = 160;
    // exit VWAP (1·150 + 4·250)/5 = 230.
    const p = { market: 'BTC-USD', status: 'CLOSED', side: 'LONG', createdAt: T1, closedAt: T4 };
    const fills = [
        mkFill('BTC-USD', T1, 1, 'BUY',  2, 100, 0),
        mkFill('BTC-USD', T2, 2, 'SELL', 1, 150, 0),
        mkFill('BTC-USD', T3, 3, 'BUY',  3, 200, 0),
        mkFill('BTC-USD', T4, 4, 'SELL', 4, 250, 0)
    ];
    const a = RM.attributeFillsToPositions([p], fills).get(p);
    assert.ok(close(a.realized, 350), `realized ${a.realized}`);
    assert.equal(a.peakSize, 4);
    assert.ok(close(a.entryVwap, 160));
    assert.ok(close(a.exitVwap, 230));
    assert.equal(a.fillCount, 4);
    assert.equal(a.complete, true);
});

test('attributeFillsToPositions: a segment starting at another position\'s close instant goes to the position created then', () => {
    // A closes and B opens at the same millisecond via two separate fills
    // (heights 10 and 11). B's first fill also lies inside A's inclusive
    // [createdAt, closedAt] window; the exact createdAt match must win.
    const a = { market: 'BTC-USD', status: 'CLOSED', side: 'LONG', createdAt: T1, closedAt: T2 };
    const b = { market: 'BTC-USD', status: 'CLOSED', side: 'LONG', createdAt: T2, closedAt: T3 };
    const fills = [
        mkFill('BTC-USD', T1, 1,  'BUY',  1, 100, 0.1),
        mkFill('BTC-USD', T2, 10, 'SELL', 1, 110, 0.2),
        mkFill('BTC-USD', T2, 11, 'BUY',  1, 110, 0.3),
        mkFill('BTC-USD', T3, 20, 'SELL', 1, 120, 0.4)
    ];
    const byPosition = RM.attributeFillsToPositions([a, b], fills);
    const A = byPosition.get(a);
    const B = byPosition.get(b);
    assert.ok(close(A.realized, 10));
    assert.ok(close(A.fees, 0.3));
    assert.equal(A.fillCount, 2);
    assert.equal(A.complete, true);
    assert.ok(close(B.realized, 10));
    assert.ok(close(B.fees, 0.7));
    assert.equal(B.fillCount, 2);
    assert.equal(B.complete, true);
    assert.equal(A.closedByFlip || B.openedByFlip, false, 'separate fills are not a flip');
});

test('attributeFillsToPositions: OPEN position with partial closes is complete and carries realized so far', () => {
    const p = { market: 'BTC-USD', status: 'OPEN', side: 'LONG', size: '2', createdAt: T1, closedAt: null };
    const fills = [
        mkFill('BTC-USD', T1, 1, 'BUY',  3, 100, 0),
        mkFill('BTC-USD', T2, 2, 'SELL', 1, 130, 0)
    ];
    const a = RM.attributeFillsToPositions([p], fills).get(p);
    assert.ok(close(a.realized, 30));
    assert.equal(a.peakSize, 3);
    assert.equal(a.exitVwap, 130);
    assert.equal(a.complete, true);
});

test('attributeFillsToPositions: CLOSED position whose fills never return to flat is incomplete', () => {
    const p = { market: 'BTC-USD', status: 'CLOSED', side: 'LONG', createdAt: T1, closedAt: T3 };
    const fills = [
        mkFill('BTC-USD', T1, 1, 'BUY',  2, 100, 0),
        mkFill('BTC-USD', T2, 2, 'SELL', 1, 120, 0)
        // the closing SELL of the second unit is missing
    ];
    const a = RM.attributeFillsToPositions([p], fills).get(p);
    assert.equal(a.complete, false);
    assert.ok(close(a.realized, 20), 'the realized that IS attributable is still reported');
});

test('attributeFillsToPositions: CLOSED position whose fills return to flat only after its closedAt is incomplete', () => {
    // The indexer closed the position at T2, but the fills stay open until
    // T3: the closing fill in between is missing, and the T3 SELL may
    // belong to a position absent from the list.
    const p = { market: 'BTC-USD', status: 'CLOSED', side: 'LONG', createdAt: T1, closedAt: T2 };
    const fills = [
        mkFill('BTC-USD', T1, 1, 'BUY',  1, 100, 0),
        mkFill('BTC-USD', T3, 2, 'SELL', 1, 120, 0)
    ];
    const a = RM.attributeFillsToPositions([p], fills).get(p);
    assert.equal(a.complete, false);
    assert.ok(close(a.realized, 20), 'the realized that IS attributable is still reported');

    const closedAtFlat = { ...p, closedAt: T3 };
    assert.equal(RM.attributeFillsToPositions([closedAtFlat], fills).get(closedAtFlat).complete, true,
        'returning to flat exactly at closedAt is complete');
});

test('attributeFillsToPositions: position with no matching fill segment is incomplete with no prices', () => {
    const p = { market: 'BTC-USD', status: 'CLOSED', side: 'LONG', createdAt: T2, closedAt: T3 };
    const fills = [
        // A segment that starts before p opened does not belong to p.
        mkFill('BTC-USD', T1, 1, 'BUY',  1, 100, 0),
        mkFill('BTC-USD', T4, 2, 'SELL', 1, 120, 0)
    ];
    const a = RM.attributeFillsToPositions([p], fills).get(p);
    assert.equal(a.complete, false);
    assert.equal(a.realized, 0);
    assert.equal(a.fees, 0);
    assert.equal(a.peakSize, null);
    assert.equal(a.entryVwap, null);
    assert.equal(a.exitVwap, null);
    assert.equal(a.fillCount, 0);
});

test('isFifoUsableFill accepts exactly the fills the FIFO walk can use', () => {
    const ok = { side: 'BUY', size: '1', price: '100' };
    assert.equal(RM.isFifoUsableFill(ok), true);
    assert.equal(RM.isFifoUsableFill({ ...ok, side: 'sell' }), true, 'side is case-insensitive');
    assert.equal(RM.isFifoUsableFill({ ...ok, size: '0' }), false);
    assert.equal(RM.isFifoUsableFill({ ...ok, price: 'Infinity' }), false);
    assert.equal(RM.isFifoUsableFill({ ...ok, side: 'LONG' }), false);
    assert.equal(RM.isFifoUsableFill(null), false);
});

test('attributeFillsToPositions: unparseable fill inside a window marks only that position incomplete', () => {
    const hit  = { market: 'BTC-USD', status: 'CLOSED', side: 'LONG', createdAt: T1, closedAt: T2 };
    const miss = { market: 'BTC-USD', status: 'CLOSED', side: 'LONG', createdAt: T3, closedAt: T4 };
    const fills = [
        mkFill('BTC-USD', T1, 1, 'BUY',  1, 100, 0),
        { ...mkFill('BTC-USD', T1, 2, 'BUY', 1, 100, 0), price: 'NaN' },
        mkFill('BTC-USD', T2, 3, 'SELL', 1, 110, 0),
        mkFill('BTC-USD', T3, 4, 'BUY',  1, 100, 0),
        mkFill('BTC-USD', T4, 5, 'SELL', 1, 105, 0)
    ];
    const byPosition = RM.attributeFillsToPositions([hit, miss], fills);
    assert.equal(byPosition.get(hit).complete, false);
    assert.equal(byPosition.get(miss).complete, true);
});

test('attributeFillsToPositions: fills that disagree with the indexer position mark it incomplete', () => {
    // Two flat round trips inside one indexer position's window: the fills
    // saw a flat moment the indexer did not, so a fill is missing somewhere.
    const merged = { market: 'BTC-USD', status: 'CLOSED', side: 'LONG', createdAt: T1, closedAt: T4 };
    const twoTrips = [
        mkFill('BTC-USD', T1, 1, 'BUY',  1, 100, 0),
        mkFill('BTC-USD', T2, 2, 'SELL', 1, 110, 0),
        mkFill('BTC-USD', T3, 3, 'BUY',  1, 100, 0),
        mkFill('BTC-USD', T4, 4, 'SELL', 1, 110, 0)
    ];
    const m = RM.attributeFillsToPositions([merged], twoTrips).get(merged);
    assert.equal(m.complete, false);
    assert.ok(close(m.realized, 20), 'both round trips are still attributed');

    // A LONG whose window holds only a SHORT round trip.
    const long = { market: 'BTC-USD', status: 'CLOSED', side: 'LONG', createdAt: T1, closedAt: T2 };
    const shortTrip = [
        mkFill('BTC-USD', T1, 1, 'SELL', 1, 110, 0),
        mkFill('BTC-USD', T2, 2, 'BUY',  1, 100, 0)
    ];
    assert.equal(RM.attributeFillsToPositions([long], shortTrip).get(long).complete, false);
});

test('attributeFillsToPositions: missing fills array marks every position incomplete', () => {
    const p = { market: 'BTC-USD', status: 'CLOSED', side: 'LONG', createdAt: T1, closedAt: T2 };
    const byPosition = RM.attributeFillsToPositions([p], null);
    assert.equal(byPosition.get(p).complete, false);
    assert.equal(byPosition.get(p).peakSize, null);
});

test('attributeFillsToPositions: a multi-million-unit position built from fractional fills still returns to flat', () => {
    // Summing 4194304.1 three times in binary floating point leaves a
    // residue of a few 1e-9 units against the decimal close size, more
    // than any fixed sub-step tolerance allows at this magnitude.
    const p = { market: 'TIA-USD', status: 'CLOSED', side: 'LONG', createdAt: T1, closedAt: T4 };
    const fills = [
        mkFill('TIA-USD', T1, 1, 'BUY',  '4194304.1',  5, 0),
        mkFill('TIA-USD', T2, 2, 'BUY',  '4194304.1',  5, 0),
        mkFill('TIA-USD', T3, 3, 'BUY',  '4194304.1',  5, 0),
        mkFill('TIA-USD', T4, 4, 'SELL', '12582912.3', 6, 0)
    ];
    const a = RM.attributeFillsToPositions([p], fills).get(p);
    assert.equal(a.complete, true);
    assert.ok(close(a.peakSize, 12582912.3, 1e-6), `peak ${a.peakSize}`);
    assert.ok(close(a.realized, 12582912.3, 1e-6), `realized ${a.realized}`);
    assert.equal(a.closedByFlip, false);
});

test('attributeFillsToPositions: a position opened and reversed in the same millisecond keeps both rows complete', () => {
    // LONG opens and is reversed into a SHORT within one block, so both
    // positions share createdAt. The flip's closing portion belongs to the
    // LONG and its opening portion to the SHORT.
    const long  = { market: 'ETH-USD', status: 'CLOSED', side: 'LONG',  createdAt: T1, closedAt: T1 };
    const short = { market: 'ETH-USD', status: 'CLOSED', side: 'SHORT', createdAt: T1, closedAt: T2 };
    const fills = [
        mkFill('ETH-USD', T1, 1, 'BUY',  2, 100, 0),
        mkFill('ETH-USD', T1, 2, 'SELL', 5, 110, 0),   // closes 2 LONG, opens 3 SHORT
        mkFill('ETH-USD', T2, 3, 'BUY',  3, 100, 0)
    ];
    for (const order of [[long, short], [short, long]]) {
        const byPosition = RM.attributeFillsToPositions(order, fills);
        const L = byPosition.get(long);
        const S = byPosition.get(short);
        assert.equal(L.complete, true, 'LONG complete');
        assert.ok(close(L.realized, 20));
        assert.equal(L.peakSize, 2);
        assert.equal(L.closedByFlip, true);
        assert.equal(S.complete, true, 'SHORT complete');
        assert.ok(close(S.realized, 30));
        assert.equal(S.peakSize, 3);
        assert.equal(S.openedByFlip, true);
    }
});

test('attributeFillsToPositions: float residue left from a multi-million-unit peak does not survive a small final close', () => {
    // Exact decimal net is 0, but the float running sum ends at -2.2e-9:
    // residue accumulated near the 1e7 peak, measured against a final
    // 10.1-unit fill. It must not become a phantom SHORT that poisons the
    // next position in the market.
    const p1 = { market: 'BERA-USD', status: 'CLOSED', side: 'LONG', createdAt: T1, closedAt: T2 };
    const p2 = { market: 'BERA-USD', status: 'CLOSED', side: 'LONG', createdAt: T3, closedAt: T4 };
    const fills = [
        mkFill('BERA-USD', T1, 1, 'BUY',  '5000000.1', 0.16, 0),
        mkFill('BERA-USD', T1, 2, 'BUY',  '4999999.3', 0.16, 0),
        mkFill('BERA-USD', T2, 3, 'SELL', '9999989.3', 0.17, 0),
        mkFill('BERA-USD', T2, 4, 'SELL', '10.1',      0.17, 0),
        mkFill('BERA-USD', T3, 5, 'BUY',  '100',       0.18, 0),
        mkFill('BERA-USD', T4, 6, 'SELL', '100',       0.19, 0)
    ];
    const byPosition = RM.attributeFillsToPositions([p1, p2], fills);
    const A = byPosition.get(p1);
    const B = byPosition.get(p2);
    assert.equal(A.complete, true, 'P1 complete');
    assert.equal(A.closedByFlip, false);
    assert.equal(B.complete, true, 'P2 complete');
    assert.equal(B.openedByFlip, false);
    assert.equal(B.peakSize, 100);
});

test('attributeFillsToPositions: same-side positions created in one millisecond take segments in close order', () => {
    // A opens and closes at T1; B reopens at T1 and closes at T2. The
    // indexer lists CLOSED positions newest-first, so B arrives before A.
    const a = { market: 'ETH-USD', status: 'CLOSED', side: 'LONG', createdAt: T1, closedAt: T1 };
    const b = { market: 'ETH-USD', status: 'CLOSED', side: 'LONG', createdAt: T1, closedAt: T2 };
    const fills = [
        mkFill('ETH-USD', T1, 1, 'BUY',  1, 100, 1),
        mkFill('ETH-USD', T1, 2, 'SELL', 1, 110, 1),
        mkFill('ETH-USD', T1, 3, 'BUY',  3, 105, 1),
        mkFill('ETH-USD', T2, 4, 'SELL', 3, 90,  1)
    ];
    for (const order of [[b, a], [a, b]]) {
        const byPosition = RM.attributeFillsToPositions(order, fills);
        const A = byPosition.get(a);
        const B = byPosition.get(b);
        assert.ok(close(A.profit, 8), `A profit ${A.profit}`);
        assert.equal(A.peakSize, 1);
        assert.equal(A.complete, true);
        assert.ok(close(B.profit, -47), `B profit ${B.profit}`);
        assert.equal(B.peakSize, 3);
        assert.equal(B.complete, true);
    }
});

test('attributeFillsToPositions: same-side positions sharing createdAt AND closedAt cannot be told apart and are incomplete', () => {
    const a = { market: 'ETH-USD', status: 'CLOSED', side: 'LONG', createdAt: T1, closedAt: T1 };
    const b = { market: 'ETH-USD', status: 'CLOSED', side: 'LONG', createdAt: T1, closedAt: T1 };
    const fills = [
        mkFill('ETH-USD', T1, 1, 'BUY',  1, 100, 0),
        mkFill('ETH-USD', T1, 2, 'SELL', 1, 110, 0),
        mkFill('ETH-USD', T1, 3, 'BUY',  3, 105, 0),
        mkFill('ETH-USD', T1, 4, 'SELL', 3, 90,  0)
    ];
    const byPosition = RM.attributeFillsToPositions([a, b], fills);
    assert.equal(byPosition.get(a).complete, false);
    assert.equal(byPosition.get(b).complete, false);
});

test('attributeFillsToPositions: opposite-side positions opened and closed in one millisecond each take the segment on their side', () => {
    // LONG opens and is reversed into a SHORT that closes, all at T1, so
    // both positions share createdAt AND closedAt; only side tells them apart.
    const long  = { market: 'ETH-USD', status: 'CLOSED', side: 'LONG',  createdAt: T1, closedAt: T1 };
    const short = { market: 'ETH-USD', status: 'CLOSED', side: 'SHORT', createdAt: T1, closedAt: T1 };
    const fills = [
        mkFill('ETH-USD', T1, 1, 'BUY',  1, 100, 0),
        mkFill('ETH-USD', T1, 2, 'SELL', 2, 110, 0),   // closes 1 LONG, opens 1 SHORT
        mkFill('ETH-USD', T1, 3, 'BUY',  1, 105, 0)
    ];
    for (const order of [[short, long], [long, short]]) {
        const byPosition = RM.attributeFillsToPositions(order, fills);
        const L = byPosition.get(long);
        const S = byPosition.get(short);
        assert.equal(L.complete, true, 'LONG complete');
        assert.ok(close(L.realized, 10), `LONG realized ${L.realized}`);
        assert.equal(S.complete, true, 'SHORT complete');
        assert.ok(close(S.realized, 5), `SHORT realized ${S.realized}`);
    }
});

test('attributeFillsToPositions: an unusable fill exactly at closedAt marks the position incomplete', () => {
    const p = { market: 'BTC-USD', status: 'CLOSED', side: 'LONG', createdAt: T1, closedAt: T2 };
    const fills = [
        mkFill('BTC-USD', T1, 1, 'BUY',  1, 100, 0),
        mkFill('BTC-USD', T2, 2, 'SELL', 1, 110, 0),
        { ...mkFill('BTC-USD', T2, 3, 'SELL', 1, 110, 0), price: 'NaN' }
    ];
    assert.equal(RM.attributeFillsToPositions([p], fills).get(p).complete, false);
});

test('attributeFillsToPositions: a flip segment with no opposite-side position at its start marks the position incomplete', () => {
    // The opening BUY of the earlier LONG is missing, so its closing SELL
    // opens a phantom SHORT that the later LONG's BUY 3 @100 reverses. The
    // walk then sees a LONG of 2 opened by a flip, reversed by SELL 4 @120,
    // but no SHORT closed at T3: the LONG's size and profit are wrong.
    const earlier  = { market: 'BTC-USD', status: 'CLOSED', side: 'LONG',  createdAt: T1, closedAt: T2 };
    const later    = { market: 'BTC-USD', status: 'CLOSED', side: 'LONG',  createdAt: T3, closedAt: T4 };
    const reversal = { market: 'BTC-USD', status: 'OPEN',   side: 'SHORT', createdAt: T4, closedAt: null };
    const fills = [
        mkFill('BTC-USD', T2, 2, 'SELL', 1, 110, 0),
        mkFill('BTC-USD', T3, 3, 'BUY',  3, 100, 0),
        mkFill('BTC-USD', T4, 4, 'SELL', 4, 120, 0)
    ];
    const byPosition = RM.attributeFillsToPositions([earlier, later, reversal], fills);
    assert.equal(byPosition.get(earlier).complete, false);
    assert.equal(byPosition.get(later).complete, false);
});

test('attributeFillsToPositions: an OPEN position is complete only when its signed indexer size equals the net size the fills end on', () => {
    // The earlier LONG's opening BUY is missing, so the walk reads a phantom
    // SHORT of 1, reversed by BUY 3 into a LONG of 2 and by SELL 4 into a
    // SHORT of 2. The reversal has its flip partner, but the indexer holds
    // a SHORT of 1: the walk's size, and with it every value, is off.
    const earlier  = { market: 'BTC-USD', status: 'CLOSED', side: 'LONG', createdAt: T1, closedAt: T2 };
    const later    = { market: 'BTC-USD', status: 'CLOSED', side: 'LONG', createdAt: T3, closedAt: T4 };
    const reversal = { market: 'BTC-USD', status: 'OPEN', side: 'SHORT', size: '-1', createdAt: T4, closedAt: null };
    const fills = [
        mkFill('BTC-USD', T2, 2, 'SELL', 1, 110, 0),
        mkFill('BTC-USD', T3, 3, 'BUY',  3, 100, 0),
        mkFill('BTC-USD', T4, 4, 'SELL', 4, 120, 0)
    ];
    const attributed = size => {
        const open = { ...reversal, size };
        return RM.attributeFillsToPositions([earlier, later, open], fills).get(open);
    };
    assert.equal(attributed('-1').complete, false, 'walk SHORT 2 against indexer SHORT 1');
    assert.equal(attributed('2').complete, false, 'the sizes are compared signed');
    assert.equal(attributed(undefined).complete, false, 'an OPEN row without a size cannot be checked');
    assert.equal(attributed('-2').complete, true, 'walk and indexer agree on SHORT 2');
});

test('attributeFillsToPositions: the open-size comparison allows the float residue of summed fill sizes', () => {
    // 0.1 + 0.2 sums to 0.30000000000000004 in binary floating point.
    const open = { market: 'BTC-USD', status: 'OPEN', side: 'LONG', size: '0.3', createdAt: T1, closedAt: null };
    const fills = [
        mkFill('BTC-USD', T1, 1, 'BUY', 0.1, 100, 0),
        mkFill('BTC-USD', T2, 2, 'BUY', 0.2, 100, 0)
    ];
    const a = RM.attributeFillsToPositions([open], fills).get(open);
    assert.equal(a.complete, true);
    assert.equal(a.openSizeDisagrees, false);
});

test('attributeFillsToPositions: openSizeDisagrees marks only an OPEN position whose indexer size differs from the walk', () => {
    const open = { market: 'BTC-USD', status: 'OPEN', side: 'LONG', size: '3', createdAt: T1, closedAt: null };
    const fills = [mkFill('BTC-USD', T1, 1, 'BUY', 2, 100, 0)];
    const a = RM.attributeFillsToPositions([open], fills).get(open);
    assert.equal(a.complete, false);
    assert.equal(a.openSizeDisagrees, true, 'walk LONG 2 against indexer LONG 3');

    // Incomplete for another reason: an unusable fill inside its window,
    // while the sizes agree.
    const sized = { ...open, size: '2' };
    const withUnusable = [...fills, { ...mkFill('BTC-USD', T2, 2, 'BUY', 1, 100, 0), price: 'n/a' }];
    const b = RM.attributeFillsToPositions([sized], withUnusable).get(sized);
    assert.equal(b.complete, false);
    assert.equal(b.openSizeDisagrees, false);
});

test('attributeFillsToPositions: incompleteCause names why a position is incomplete, null when complete', () => {
    const CAUSE = RM.INCOMPLETE_CAUSE;
    const causeOf = (positions, fills, p = positions[0]) => RM.attributeFillsToPositions(positions, fills).get(p).incompleteCause;
    const roundTrip = [mkFill('BTC-USD', T1, 1, 'BUY', 1, 100, 0), mkFill('BTC-USD', T2, 2, 'SELL', 1, 110, 0)];
    const closedLong = { market: 'BTC-USD', status: 'CLOSED', side: 'LONG', createdAt: T1, closedAt: T2 };

    assert.equal(causeOf([closedLong], roundTrip), null);
    assert.equal(causeOf([closedLong], null), CAUSE.NO_MATCHING_FILLS);
    assert.equal(causeOf([closedLong], [...roundTrip, { ...mkFill('BTC-USD', T2, 3, 'BUY', 1, 100, 0), price: 'NaN' }]),
        CAUSE.UNUSABLE_FILL);
    assert.equal(causeOf([{ ...closedLong, closedAt: T4 }],
        [...roundTrip, mkFill('BTC-USD', T3, 3, 'BUY', 1, 100, 0), mkFill('BTC-USD', T4, 4, 'SELL', 1, 110, 0)]),
        CAUSE.FLAT_MID_POSITION);
    assert.equal(causeOf([{ ...closedLong, side: 'SHORT' }], roundTrip), CAUSE.SIDE_MISMATCH);
    assert.equal(causeOf([{ ...closedLong, closedAt: T1 }], roundTrip), CAUSE.NOT_FLAT_AT_CLOSE);
    const twin = { ...closedLong };
    assert.equal(causeOf([closedLong, twin], roundTrip), CAUSE.INDISTINGUISHABLE);

    // The SELL reverses the LONG, but no SHORT opens at T2 to take it.
    const reversed = [mkFill('BTC-USD', T1, 1, 'BUY', 1, 100, 0), mkFill('BTC-USD', T2, 2, 'SELL', 2, 110, 0)];
    assert.equal(causeOf([closedLong], reversed), CAUSE.REVERSAL_PARTNER_MISSING);

    const open = { market: 'BTC-USD', status: 'OPEN', side: 'LONG', size: '3', createdAt: T1, closedAt: null };
    assert.equal(causeOf([open], [mkFill('BTC-USD', T1, 1, 'BUY', 2, 100, 0)]), CAUSE.OPEN_SIZE_MISMATCH);
});

test('attributeFillsToPositions: an unusable fill is named as the cause over the open-size mismatch it produces', () => {
    // The skipped BUY 1 leaves the walk at LONG 2 against the indexer's 3.
    const open = { market: 'BTC-USD', status: 'OPEN', side: 'LONG', size: '3', createdAt: T1, closedAt: null };
    const fills = [
        mkFill('BTC-USD', T1, 1, 'BUY', 2, 100, 0),
        { ...mkFill('BTC-USD', T2, 2, 'BUY', 1, 100, 0), price: 'n/a' }
    ];
    const a = RM.attributeFillsToPositions([open], fills).get(open);
    assert.equal(a.incompleteCause, RM.INCOMPLETE_CAUSE.UNUSABLE_FILL);
    assert.equal(a.openSizeDisagrees, true, 'the size check still reports its own finding');
});

// When several causes apply at once, incompleteCause names the first in
// INCOMPLETE_CAUSE order. One test per adjacent pair that can co-occur;
// each also shows the later cause alone, so both really apply.
// NO_MATCHING_FILLS cannot co-occur with the other segment causes (they
// need a segment), nor with REVERSAL_PARTNER_MISSING (only a segment's
// owner can miss its reversal partner).
const precedence = {
    causeOf: (positions, fills, p) => RM.attributeFillsToPositions(positions, fills).get(p).incompleteCause,
    closedLong: { market: 'BTC-USD', status: 'CLOSED', side: 'LONG', createdAt: T1, closedAt: T2 },
    // The SELL at T2 reverses the LONG, but no SHORT opens at T2 to take it.
    reversed: [mkFill('BTC-USD', T1, 1, 'BUY', 1, 100, 0), mkFill('BTC-USD', T2, 2, 'SELL', 2, 110, 0)],
    roundTrip: [mkFill('BTC-USD', T1, 1, 'BUY', 1, 100, 0), mkFill('BTC-USD', T2, 2, 'SELL', 1, 110, 0)],
    unusableAtT2: { ...mkFill('BTC-USD', T2, 3, 'BUY', 1, 100, 0), price: 'NaN' }
};

test('incompleteCause precedence: an unusable fill outranks a missing reversal partner', () => {
    const { causeOf, closedLong, reversed, unusableAtT2 } = precedence;
    const CAUSE = RM.INCOMPLETE_CAUSE;
    assert.equal(causeOf([closedLong], reversed, closedLong), CAUSE.REVERSAL_PARTNER_MISSING);
    assert.equal(causeOf([closedLong], [...reversed, unusableAtT2], closedLong), CAUSE.UNUSABLE_FILL);
});

test('incompleteCause precedence: a missing reversal partner outranks indistinguishable positions', () => {
    // The twin listed first owns the reversed segment.
    const { causeOf, closedLong, reversed } = precedence;
    const CAUSE = RM.INCOMPLETE_CAUSE;
    const twin = { ...closedLong };
    assert.equal(causeOf([closedLong, twin], precedence.roundTrip, closedLong), CAUSE.INDISTINGUISHABLE);
    assert.equal(causeOf([closedLong, twin], reversed, closedLong), CAUSE.REVERSAL_PARTNER_MISSING);
});

test('incompleteCause precedence: indistinguishable positions outrank the segment cause they produce', () => {
    // Its twin took the only segment, so the second twin has none.
    const { causeOf, closedLong, roundTrip } = precedence;
    const CAUSE = RM.INCOMPLETE_CAUSE;
    const twin = { ...closedLong };
    const different = { ...closedLong, closedAt: T3 };
    assert.equal(causeOf([closedLong, different], roundTrip, different), CAUSE.NO_MATCHING_FILLS);
    assert.equal(causeOf([closedLong, twin], roundTrip, twin), CAUSE.INDISTINGUISHABLE);
});

test('incompleteCause precedence: an unusable fill outranks the segment cause', () => {
    const { causeOf, closedLong, roundTrip, unusableAtT2 } = precedence;
    const CAUSE = RM.INCOMPLETE_CAUSE;
    const short = { ...closedLong, side: 'SHORT' };
    assert.equal(causeOf([short], roundTrip, short), CAUSE.SIDE_MISMATCH);
    assert.equal(causeOf([short], [...roundTrip, unusableAtT2], short), CAUSE.UNUSABLE_FILL);
});

test('incompleteCause precedence: the segment cause outranks the open-size mismatch it produces', () => {
    // The walk ends SHORT 2 on a SELL; the indexer holds LONG 2.
    const { causeOf } = precedence;
    const CAUSE = RM.INCOMPLETE_CAUSE;
    const open = { market: 'BTC-USD', status: 'OPEN', side: 'LONG', size: '2', createdAt: T1, closedAt: null };
    const sell = [mkFill('BTC-USD', T1, 1, 'SELL', 2, 100, 0)];
    const sideless = { ...open, side: undefined };
    assert.equal(causeOf([sideless], sell, sideless), CAUSE.OPEN_SIZE_MISMATCH);
    assert.equal(causeOf([open], sell, open), CAUSE.SIDE_MISMATCH);
});

test('incompleteCause precedence: a side mismatch outranks not being flat at close', () => {
    // The fills close the LONG at T2, after the position's closedAt of T1.
    const { causeOf, closedLong, roundTrip } = precedence;
    const CAUSE = RM.INCOMPLETE_CAUSE;
    const closedEarly = { ...closedLong, closedAt: T1 };
    assert.equal(causeOf([closedEarly], roundTrip, closedEarly), CAUSE.NOT_FLAT_AT_CLOSE);
    const shortClosedEarly = { ...closedEarly, side: 'SHORT' };
    assert.equal(causeOf([shortClosedEarly], roundTrip, shortClosedEarly), CAUSE.SIDE_MISMATCH);
});

test('attributeFillsToPositions: a flip segment with no opposite-side position opened at its reversal marks the position incomplete', () => {
    // The SELL reverses the LONG, yet the position the list holds from T2
    // is another LONG, not a SHORT: a fill around the reversal is missing.
    const long = { market: 'BTC-USD', status: 'CLOSED', side: 'LONG', createdAt: T1, closedAt: T2 };
    const nextLong = { market: 'BTC-USD', status: 'CLOSED', side: 'LONG', createdAt: T2, closedAt: T3 };
    const fills = [
        mkFill('BTC-USD', T1, 1, 'BUY',  1, 100, 0),
        mkFill('BTC-USD', T2, 2, 'SELL', 2, 110, 0),
        mkFill('BTC-USD', T3, 3, 'BUY',  1, 105, 0)
    ];
    const withoutPartner = RM.attributeFillsToPositions([long, nextLong], fills);
    assert.equal(withoutPartner.get(long).complete, false);
    assert.equal(withoutPartner.get(nextLong).complete, false);

    const short = { market: 'BTC-USD', status: 'CLOSED', side: 'SHORT', createdAt: T2, closedAt: T3 };
    const withPartner = RM.attributeFillsToPositions([long, short], fills);
    assert.equal(withPartner.get(long).complete, true, 'the listed SHORT is the reversal partner');
    assert.equal(withPartner.get(short).complete, true);
});

// ---------------------------------------------------------------------------
// isOpenInFills — whether the fill walk still holds a position open.
// ---------------------------------------------------------------------------

test('isOpenInFills: a position reopened on the same side in its close block is still open', () => {
    const reopened = { market: 'ETH-USD', status: 'OPEN', side: 'LONG', createdAt: T1 };
    const fills = [
        mkFill('ETH-USD', T1, 1, 'BUY',  1, 100, 0),
        mkFill('ETH-USD', T1, 2, 'SELL', 1, 110, 0),
        mkFill('ETH-USD', T1, 3, 'BUY',  2, 105, 0)
    ];
    assert.equal(RM.isOpenInFills(reopened, fills), true);
});

test('isOpenInFills: a stale OPEN copy of a position the fills closed is not open', () => {
    const stale = { market: 'ETH-USD', status: 'OPEN', side: 'LONG', createdAt: T1 };
    const closedOut = [
        mkFill('ETH-USD', T1, 1, 'BUY',  1, 100, 0),
        mkFill('ETH-USD', T2, 2, 'SELL', 1, 110, 0)
    ];
    assert.equal(RM.isOpenInFills(stale, closedOut), false);

    // A later same-side position is open, but it is not this one.
    const reopenedLater = [...closedOut, mkFill('ETH-USD', T3, 3, 'BUY', 2, 105, 0)];
    assert.equal(RM.isOpenInFills(stale, reopenedLater), false);
    const later = { market: 'ETH-USD', status: 'OPEN', side: 'LONG', createdAt: T3 };
    assert.equal(RM.isOpenInFills(later, reopenedLater), true);

    // Reversed in its opening block: the walk holds the SHORT, not the LONG.
    const reversed = [
        mkFill('ETH-USD', T1, 1, 'BUY',  1, 100, 0),
        mkFill('ETH-USD', T1, 2, 'SELL', 3, 110, 0)
    ];
    assert.equal(RM.isOpenInFills(stale, reversed), false);
    assert.equal(RM.isOpenInFills(null, closedOut), false);
});

test('hasCompleteAttribution: only an explicit complete === true counts', () => {
    assert.equal(RM.hasCompleteAttribution({ complete: true }), true);
    assert.equal(RM.hasCompleteAttribution({ complete: false }), false);
    assert.equal(RM.hasCompleteAttribution({ profit: 100 }), false, 'no attribution at all is not complete');
    assert.equal(RM.hasCompleteAttribution(null), false);
    const c = RM.classifyClosed([{ status: 'CLOSED', profit: 100 }]);
    assert.equal(c.incompleteCount, 1, 'the classifier applies the same predicate');
    assert.equal(RM.tradeReturn({ profit: 10, peakSize: 1, entryVwap: 100 }), null);
});

// ---------------------------------------------------------------------------
// computeUnrealizedFromFills — FIFO lots left open, marked at the oracle.
// ---------------------------------------------------------------------------

test('computeUnrealizedFromFills marks the FIFO lots left open at the oracle, not the average entry', () => {
    // BUY 2@100, BUY 2@200, SELL 2@300: FIFO consumes the 100 lots, so the
    // 2 left open cost 200. At oracle 250 that is +100 (an average-cost
    // basis of 150 would say +200 and double-count realized profit).
    const fills = [
        mkFill('BTC-USD', T1, 1, 'BUY',  2, 100, 0),
        mkFill('BTC-USD', T2, 2, 'BUY',  2, 200, 0),
        mkFill('BTC-USD', T3, 3, 'SELL', 2, 300, 0),
        mkFill('ETH-USD', T1, 4, 'SELL', 1, 50,  0)
    ];
    const markets = { 'BTC-USD': { oraclePrice: '250' }, 'ETH-USD': { oraclePrice: '40' } };
    const u = RM.computeUnrealizedFromFills(fills, markets);
    assert.ok(close(u.byMarket['BTC-USD'], 100), `BTC ${u.byMarket['BTC-USD']}`);
    assert.ok(close(u.byMarket['ETH-USD'], 10), `short marks (entry − oracle) × size: ${u.byMarket['ETH-USD']}`);
    assert.ok(close(u.total, 110));
    assert.deepEqual(u.unpricedMarkets, []);
    assert.deepEqual([...u.openMarkets].sort(), ['BTC-USD', 'ETH-USD']);

    // Realized + unrealized equals cash flow plus the marked inventory.
    const realized = RM.computeRealizedFromFills(fills).byMarket['BTC-USD'];
    const cashFlow = -2 * 100 - 2 * 200 + 2 * 300;
    assert.ok(close(realized + u.byMarket['BTC-USD'], cashFlow + 2 * 250));
});

test('computeUnrealizedFromFills: a flat market contributes 0 without needing a price', () => {
    const fills = [
        mkFill('BTC-USD', T1, 1, 'BUY',  1, 100, 0),
        mkFill('BTC-USD', T2, 2, 'SELL', 1, 110, 0)
    ];
    const u = RM.computeUnrealizedFromFills(fills, {});
    assert.equal(u.total, 0);
    assert.deepEqual(u.unpricedMarkets, []);
    assert.deepEqual(u.openMarkets, []);
});

test('computeUnrealizedFromFills: open inventory without an oracle price leaves the total unknown', () => {
    const fills = [
        mkFill('BTC-USD', T1, 1, 'BUY', 1, 100, 0),
        mkFill('ETH-USD', T1, 2, 'BUY', 1, 10,  0)
    ];
    const u = RM.computeUnrealizedFromFills(fills, { 'BTC-USD': { oraclePrice: '120' } });
    assert.equal(u.total, null);
    assert.equal(u.byMarket['ETH-USD'], null);
    assert.ok(close(u.byMarket['BTC-USD'], 20));
    assert.deepEqual(u.unpricedMarkets, ['ETH-USD']);
});

test('computeUnrealizedFromFills: a lot sold down to float residue leaves no phantom lot', () => {
    // SELL 0.1 then SELL 0.3 consume the 0.4 lot exactly in decimal, but
    // (0.4 − 0.1) − 0.3 is 5.6e-17 in binary floating point. Only the
    // 1 @200 lot is left open, so at 250 the mark is exactly +50.
    const fills = [
        mkFill('BTC-USD', T1, 1, 'BUY',  '0.4', 100, 0),
        mkFill('BTC-USD', T2, 2, 'BUY',  '1',   200, 0),
        mkFill('BTC-USD', T3, 3, 'SELL', '0.1', 150, 0),
        mkFill('BTC-USD', T4, 4, 'SELL', '0.3', 150, 0)
    ];
    const u = RM.computeUnrealizedFromFills(fills, { 'BTC-USD': { oraclePrice: '250' } });
    assert.equal(u.byMarket['BTC-USD'], 50);
});

test('equityAdjustedTotalPnl moves the latest /historical-pnl totalPnl by the equity change since that row', () => {
    const hist = [
        { createdAt: '2025-01-02T00:00:00Z', totalPnl: '-100', equity: '900' },
        { createdAt: '2025-01-01T00:00:00Z', totalPnl: '0',    equity: '1000' }
    ];
    assert.equal(RM.equityAdjustedTotalPnl(hist, '950'), -50);
    assert.equal(RM.equityAdjustedTotalPnl([], '950'), null);
    assert.equal(RM.equityAdjustedTotalPnl(hist, undefined), null);
});

// ---------------------------------------------------------------------------
// classifyClosed — denominator for every win-rate-style ratio.
// ---------------------------------------------------------------------------

test('classifyClosed partitions wins/losses/scratches; decisive = wins+losses', () => {
    const positions = [
        { status: 'CLOSED', profit: 100, complete: true },
        { status: 'CLOSED', profit: -50, complete: true },
        { status: 'CLOSED', profit: 0, complete: true },
        { status: 'OPEN',   profit: 200, complete: true }, // ignored
    ];
    const c = RM.classifyClosed(positions);
    assert.equal(c.winCount, 1);
    assert.equal(c.lossCount, 1);
    assert.equal(c.scratchCount, 1);
    assert.equal(c.decisiveCount, 2);
    assert.equal(c.closedCount, 3);
    assert.equal(c.grossWin, 100);
    assert.equal(c.grossLoss, 50);
    assert.equal(c.totalProfit, 50);
});

test('classifyClosed empty input', () => {
    const c = RM.classifyClosed([]);
    assert.equal(c.decisiveCount, 0);
    assert.equal(c.closedCount, 0);
    assert.equal(c.totalProfit, 0);
});

test('classifyClosed buckets by fill-attributed profit, not the indexer realizedPnl', () => {
    const c = RM.classifyClosed([
        { status: 'CLOSED', realizedPnl: '50', profit: -200, complete: true }
    ]);
    assert.equal(c.winCount, 0);
    assert.equal(c.lossCount, 1);
    assert.equal(c.grossLoss, 200);
});

test('classifyClosed is all-or-nothing: one incomplete closed position nulls every derived ratio', () => {
    const c = RM.classifyClosed([
        { status: 'CLOSED', profit: 100, complete: true  },
        { status: 'CLOSED', profit: -50, complete: true  },
        { status: 'CLOSED', profit: 30,  complete: false }
    ]);
    assert.equal(c.incompleteCount, 1);
    assert.equal(c.incompleteReason, '1 position missing fill data');
    assert.equal(c.closedCount, 3);
    assert.equal(c.winRate, null);
    assert.equal(c.profitFactor, null);
    assert.equal(c.avgWin, null);
    assert.equal(c.avgLoss, null);
    assert.equal(c.expectancy, null);

    const complete = RM.classifyClosed([
        { status: 'CLOSED', profit: 100, complete: true },
        { status: 'CLOSED', profit: -50, complete: true }
    ]);
    assert.equal(complete.incompleteCount, 0);
    assert.equal(complete.incompleteReason, '');
    assert.equal(complete.winRate, 50);
});

test('classifyClosed derives the payoff ratio and the win rate it needs to break even', () => {
    const c = RM.classifyClosed([
        { status: 'CLOSED', profit: 300, complete: true },
        { status: 'CLOSED', profit: -100, complete: true },
        { status: 'CLOSED', profit: -100, complete: true }
    ]);
    // payoff = avgWin / avgLoss = 300 / 100; breakeven WR = 1 / (1 + 3)
    assert.equal(c.payoff, 3);
    assert.equal(c.breakevenWinRate, 25);

    const noLosses = RM.classifyClosed([{ status: 'CLOSED', profit: 300, complete: true }]);
    assert.equal(noLosses.payoff, null);
    assert.equal(noLosses.breakevenWinRate, null);

    const incomplete = RM.classifyClosed([
        { status: 'CLOSED', profit: 300, complete: true },
        { status: 'CLOSED', profit: -100, complete: true },
        { status: 'CLOSED', profit: 5, complete: false }
    ]);
    assert.equal(incomplete.payoff, null);
    assert.equal(incomplete.breakevenWinRate, null);
});

test('classifyClosed picks the single largest win and largest loss as bestTrade / worstTrade', () => {
    const c = RM.classifyClosed([
        { status: 'CLOSED', profit: 996, complete: true },
        { status: 'CLOSED', profit: 298, complete: true },
        { status: 'CLOSED', profit: -500, complete: true },
        { status: 'CLOSED', profit: -2000, complete: true },
        { status: 'CLOSED', profit: 0, complete: true }
    ]);
    assert.equal(c.bestTrade, 996);
    assert.equal(c.worstTrade, -2000);

    const winsOnly = RM.classifyClosed([{ status: 'CLOSED', profit: 10, complete: true }]);
    assert.equal(winsOnly.bestTrade, 10);
    assert.equal(winsOnly.worstTrade, null, 'no loss, no worst trade');
    const scratchOnly = RM.classifyClosed([{ status: 'CLOSED', profit: 0, complete: true }]);
    assert.equal(scratchOnly.bestTrade, null, 'a scratch is neither');
    assert.equal(scratchOnly.worstTrade, null);
});

test('classifyClosed nulls bestTrade / worstTrade under the all-or-nothing rule', () => {
    const trades = [
        { status: 'CLOSED', profit: 100, complete: true },
        { status: 'CLOSED', profit: -50, complete: true }
    ];
    const incomplete = RM.classifyClosed([...trades, { status: 'CLOSED', profit: 30, complete: false }]);
    assert.equal(incomplete.bestTrade, null);
    assert.equal(incomplete.worstTrade, null);
    const unavailable = RM.classifyClosed(trades, 'Closed positions failed to load');
    assert.equal(unavailable.bestTrade, null);
    assert.equal(unavailable.worstTrade, null);
});

test('oppositeSide flips LONG and SHORT and has no answer for anything else', () => {
    assert.equal(RM.oppositeSide('LONG'), 'SHORT');
    assert.equal(RM.oppositeSide('SHORT'), 'LONG');
    assert.equal(RM.oppositeSide(''), null);
    assert.equal(RM.oppositeSide(undefined), null);
});

test('classifyClosed with an unavailable closed-position list nulls every ratio and says why', () => {
    const reason = 'Closed positions failed to load';
    const c = RM.classifyClosed([
        { status: 'CLOSED', profit: 100, complete: true },
        { status: 'CLOSED', profit: -50, complete: true }
    ], reason);
    assert.equal(c.incompleteReason, reason);
    assert.equal(c.winRate, null);
    assert.equal(c.profitFactor, null);
    assert.equal(c.avgWin, null);
    assert.equal(c.avgLoss, null);
    assert.equal(c.expectancy, null);
    assert.equal(c.payoff, null);
    assert.equal(RM.classifyClosed([], reason).incompleteReason, reason,
        'an empty list is unknown, not an account without trades');
});

// ---------------------------------------------------------------------------
// netFundingTotal + marketPnL funding fold-in. Pins that the Total Profit
// headline and the Per-market Profit family agree with the equity-based
// historical-pnl curve by including netFunding alongside realized/unrealized.
// ---------------------------------------------------------------------------

test('netFundingTotal sums netFunding across OPEN and CLOSED positions', () => {
    const positions = [
        { status: 'CLOSED', netFunding: '12.5'  },
        { status: 'CLOSED', netFunding: '-4'    },
        { status: 'OPEN',   netFunding: '3.25'  },
        { status: 'OPEN'                         }, // missing → treated as 0
        { status: 'CLOSED', netFunding: 'NaN'   }, // unparseable → 0
    ];
    assert.ok(close(RM.netFundingTotal(positions), 11.75));
});

test('netFundingTotal empty / null input → 0', () => {
    assert.equal(RM.netFundingTotal([]), 0);
    assert.equal(RM.netFundingTotal(null), 0);
});

test('marketPnL folds netFunding into total alongside realized + unrealized', () => {
    const positions = [
        { market: 'ETH-USD', status: 'CLOSED', realizedPnl: '100', netFunding: '5'   },
        { market: 'ETH-USD', status: 'CLOSED', realizedPnl: '-30', netFunding: '-2'  },
        { market: 'ETH-USD', status: 'OPEN',   unrealizedPnl: '50', netFunding: '1.5' },
        { market: 'BTC-USD', status: 'CLOSED', realizedPnl: '200', netFunding: '-7'  },
    ];
    const m = RM.marketPnL(positions);
    assert.ok(close(m['ETH-USD'].realizedClosed, 70));
    assert.ok(close(m['ETH-USD'].unrealizedOpen, 50));
    assert.ok(close(m['ETH-USD'].netFunding, 4.5));
    assert.ok(close(m['ETH-USD'].total, 124.5));
    assert.equal(m['ETH-USD'].closedCount, 2);
    assert.equal(m['ETH-USD'].openCount, 1);
    assert.ok(close(m['BTC-USD'].netFunding, -7));
    assert.ok(close(m['BTC-USD'].total, 193));
});

test('marketPnL with no funding fields behaves like realized + unrealized only', () => {
    const positions = [
        { market: 'SOL-USD', status: 'CLOSED', realizedPnl: '10' },
        { market: 'SOL-USD', status: 'OPEN',   unrealizedPnl: '5' },
    ];
    const m = RM.marketPnL(positions);
    assert.equal(m['SOL-USD'].netFunding, 0);
    assert.ok(close(m['SOL-USD'].total, 15));
});

// ---------------------------------------------------------------------------
// feesTotal + marketFees + marketPnL feesMap fold-in. dYdX `fill.fee` is
// positive when the user paid (taker / most maker), negative for maker
// rebates. The headline subtracts the sum so rebates ADD to profit.
// ---------------------------------------------------------------------------

test('feesTotal: positive fees paid, negative rebates received, NaN-safe', () => {
    const fills = [
        { fee: '0.50' },   // taker fee paid
        { fee: '1.25' },   // another paid fee
        { fee: '-0.10' },  // maker rebate
        { fee: 'NaN'   },  // unparseable → 0
        { },               // missing → 0
        null               // null → 0
    ];
    assert.ok(close(RM.feesTotal(fills), 1.65));
});

test('feesTotal: empty / null input → 0', () => {
    assert.equal(RM.feesTotal([]), 0);
    assert.equal(RM.feesTotal(null), 0);
});

test('marketFees: bucket by fill.market, NaN values dropped, missing market → "Unknown"', () => {
    const fills = [
        { market: 'ETH-USD', fee: '1'    },
        { market: 'ETH-USD', fee: '2'    },
        { market: 'BTC-USD', fee: '0.5'  },
        { market: 'BTC-USD', fee: '-0.2' }, // rebate
        {                    fee: '0.05' }, // missing market → 'Unknown'
        { market: 'SOL-USD', fee: 'NaN'  }, // unparseable → dropped
    ];
    const m = RM.marketFees(fills);
    assert.ok(close(m['ETH-USD'], 3));
    assert.ok(close(m['BTC-USD'], 0.3));
    assert.ok(close(m['Unknown'], 0.05));
    assert.equal(m['SOL-USD'], undefined);
});

test('marketPnL with feesMap subtracts fees from per-market total', () => {
    const positions = [
        { market: 'ETH-USD', status: 'CLOSED', realizedPnl: '100', netFunding: '5'   },
        { market: 'BTC-USD', status: 'OPEN',   unrealizedPnl: '50', netFunding: '-2' },
    ];
    const fees = { 'ETH-USD': 7.5, 'BTC-USD': -1.5 }; // rebate on BTC-USD
    const m = RM.marketPnL(positions, fees);
    assert.ok(close(m['ETH-USD'].fees, 7.5));
    // 100 + 0 + 5 − 7.5 = 97.5
    assert.ok(close(m['ETH-USD'].total, 97.5));
    assert.ok(close(m['BTC-USD'].fees, -1.5));
    // 0 + 50 − 2 − (−1.5) = 49.5
    assert.ok(close(m['BTC-USD'].total, 49.5));
});

test('marketPnL feesMap entry for a market with no positions creates a fees-only slot', () => {
    const positions = [
        { market: 'ETH-USD', status: 'CLOSED', realizedPnl: '100' },
    ];
    const fees = { 'SOL-USD': 3 }; // fee on a market with no positions in this slice
    const m = RM.marketPnL(positions, fees);
    assert.ok(close(m['SOL-USD'].fees, 3));
    assert.ok(close(m['SOL-USD'].total, -3));
    assert.equal(m['SOL-USD'].closedCount, 0);
    assert.equal(m['SOL-USD'].openCount, 0);
});

// ---------------------------------------------------------------------------
// activeChildSubaccounts — detects isolated-margin blind spots. Dashboard
// analyses sub=0 only; any child sub with state must be surfaced.
// ---------------------------------------------------------------------------

test('activeChildSubaccounts empty / non-array → []', () => {
    assert.deepEqual(RM.activeChildSubaccounts([]), []);
    assert.deepEqual(RM.activeChildSubaccounts(null), []);
    assert.deepEqual(RM.activeChildSubaccounts(undefined), []);
});

test('activeChildSubaccounts ignores sub=0 even with state', () => {
    const subs = [
        { subaccountNumber: 0, equity: '10000', openPerpetualPositions: { 'ETH-USD': {} } }
    ];
    assert.equal(RM.activeChildSubaccounts(subs).length, 0);
});

test('activeChildSubaccounts flags child with non-zero equity', () => {
    const subs = [
        { subaccountNumber: 0,   equity: '0' },
        { subaccountNumber: 128, equity: '500' }
    ];
    const out = RM.activeChildSubaccounts(subs);
    assert.equal(out.length, 1);
    assert.equal(out[0].subaccountNumber, 128);
});

test('activeChildSubaccounts flags child with open positions even at zero equity', () => {
    const subs = [
        { subaccountNumber: 128, equity: '0', openPerpetualPositions: { 'BTC-USD': { size: '1' } } }
    ];
    assert.equal(RM.activeChildSubaccounts(subs).length, 1);
});

test('activeChildSubaccounts flags child with asset positions', () => {
    const subs = [
        { subaccountNumber: 256, equity: '0', assetPositions: [{ symbol: 'USDC' }] }
    ];
    assert.equal(RM.activeChildSubaccounts(subs).length, 1);
});

test('activeChildSubaccounts skips zero-everywhere children', () => {
    const subs = [
        { subaccountNumber: 0,   equity: '0' },
        { subaccountNumber: 128, equity: '0', openPerpetualPositions: {}, assetPositions: [] },
        { subaccountNumber: 256, equity: '0' }
    ];
    assert.equal(RM.activeChildSubaccounts(subs).length, 0);
});

// ---------------------------------------------------------------------------
// computeRealizedFromFills — FIFO inventory walk over /fills. Authoritative
// for the headline because dYdX's /perpetualPositions.realizedPnl
// undercounts on heavy-scaling accounts (empirically reconciles to
// /historical-pnl totalPnl within float-rounding).
// ---------------------------------------------------------------------------

test('computeRealizedFromFills empty / null → { total: 0, byMarket: {} }', () => {
    assert.deepEqual(RM.computeRealizedFromFills([]),   { total: 0, byMarket: {} });
    assert.deepEqual(RM.computeRealizedFromFills(null), { total: 0, byMarket: {} });
});

test('computeRealizedFromFills single open fill yields zero realized', () => {
    const fills = [
        { market: 'BTC-USD', createdAt: '2025-01-01T00:00:00Z', side: 'BUY', size: '1', price: '100' }
    ];
    const r = RM.computeRealizedFromFills(fills);
    assert.equal(r.total, 0);
    assert.equal(r.byMarket['BTC-USD'], 0);
});

test('computeRealizedFromFills simple long cycle: buy @100, sell @150 → +50', () => {
    const fills = [
        { market: 'BTC-USD', createdAt: '2025-01-01T00:00:00Z', side: 'BUY',  size: '1', price: '100' },
        { market: 'BTC-USD', createdAt: '2025-01-02T00:00:00Z', side: 'SELL', size: '1', price: '150' }
    ];
    const r = RM.computeRealizedFromFills(fills);
    assert.ok(close(r.total, 50));
    assert.ok(close(r.byMarket['BTC-USD'], 50));
});

test('computeRealizedFromFills simple short cycle: sell @200, buy @150 → +50', () => {
    const fills = [
        { market: 'ETH-USD', createdAt: '2025-01-01T00:00:00Z', side: 'SELL', size: '1', price: '200' },
        { market: 'ETH-USD', createdAt: '2025-01-02T00:00:00Z', side: 'BUY',  size: '1', price: '150' }
    ];
    const r = RM.computeRealizedFromFills(fills);
    assert.ok(close(r.total, 50));
});

test('computeRealizedFromFills scaled long with FIFO matching', () => {
    // Buy 1@100, Buy 1@200, Sell 1@300, Sell 1@50
    // FIFO: first sell matches first buy → (300-100)*1 = +200
    //       second sell matches second buy → (50-200)*1 = -150
    //       Total = +50
    const fills = [
        { market: 'BTC-USD', createdAt: '2025-01-01T00:00:00Z', side: 'BUY',  size: '1', price: '100' },
        { market: 'BTC-USD', createdAt: '2025-01-02T00:00:00Z', side: 'BUY',  size: '1', price: '200' },
        { market: 'BTC-USD', createdAt: '2025-01-03T00:00:00Z', side: 'SELL', size: '1', price: '300' },
        { market: 'BTC-USD', createdAt: '2025-01-04T00:00:00Z', side: 'SELL', size: '1', price: '50'  }
    ];
    const r = RM.computeRealizedFromFills(fills);
    assert.ok(close(r.total, 50));
});

test('computeRealizedFromFills position flip closes long and opens short atomically', () => {
    // Buy 1@100, then Sell 3@150:
    //   • Sells 1 matched against buy → (150-100)*1 = +50 realized
    //   • Excess 2 units flip into SHORT inventory at $150
    // Then Buy 2@120 closes short:
    //   • (150-120)*2 = +60 realized
    // Total realized = +110
    const fills = [
        { market: 'BTC-USD', createdAt: '2025-01-01T00:00:00Z', side: 'BUY',  size: '1', price: '100' },
        { market: 'BTC-USD', createdAt: '2025-01-02T00:00:00Z', side: 'SELL', size: '3', price: '150' },
        { market: 'BTC-USD', createdAt: '2025-01-03T00:00:00Z', side: 'BUY',  size: '2', price: '120' }
    ];
    const r = RM.computeRealizedFromFills(fills);
    assert.ok(close(r.total, 110));
});

test('computeRealizedFromFills buckets per market independently', () => {
    const fills = [
        { market: 'BTC-USD', createdAt: '2025-01-01T00:00:00Z', side: 'BUY',  size: '1', price: '100' },
        { market: 'ETH-USD', createdAt: '2025-01-01T00:00:00Z', side: 'BUY',  size: '1', price: '50'  },
        { market: 'BTC-USD', createdAt: '2025-01-02T00:00:00Z', side: 'SELL', size: '1', price: '120' },
        { market: 'ETH-USD', createdAt: '2025-01-02T00:00:00Z', side: 'SELL', size: '1', price: '40'  }
    ];
    const r = RM.computeRealizedFromFills(fills);
    assert.ok(close(r.byMarket['BTC-USD'], 20));
    assert.ok(close(r.byMarket['ETH-USD'], -10));
    assert.ok(close(r.total, 10));
});

test('computeRealizedFromFills open inventory at end is excluded from realized', () => {
    // Buy 2@100, Sell 1@150 → realized +50; 1 unit still open
    const fills = [
        { market: 'BTC-USD', createdAt: '2025-01-01T00:00:00Z', side: 'BUY',  size: '2', price: '100' },
        { market: 'BTC-USD', createdAt: '2025-01-02T00:00:00Z', side: 'SELL', size: '1', price: '150' }
    ];
    const r = RM.computeRealizedFromFills(fills);
    assert.ok(close(r.total, 50)); // closed portion only
});

test('computeRealizedFromFills keeps the input order inside a block, whatever the fill ids say', () => {
    // /fills in page mode lists a block's fills in chain order. A fill id
    // is a hash of its event id, so id order says nothing about chain order.
    const inBlock = (id, side, price) => ({
        id, market: 'BTC-USD', createdAt: T1, createdAtHeight: '100', side, size: '1', price: String(price)
    });
    // BUY@100 then SELL@120 realizes +20; the BUY@110 stays open.
    const fills = [inBlock('f3', 'BUY', 100), inBlock('f2', 'SELL', 120), inBlock('f1', 'BUY', 110)];
    const r = RM.computeRealizedFromFills(fills);
    assert.ok(close(r.total, 20), `realized ${r.total}`);
});

test('computeRealizedFromFills orders same-createdAt fills by createdAtHeight', () => {
    // Listed out of height order: walking them as listed would close the
    // @100 lot (+20); height order closes the @90 lot first (+30).
    const fills = [
        { market: 'BTC-USD', createdAt: '2025-01-01T00:00:00Z', createdAtHeight: '101', id: 'a', side: 'BUY',  size: '1', price: '100' },
        { market: 'BTC-USD', createdAt: '2025-01-01T00:00:00Z', createdAtHeight: '102', id: 'b', side: 'SELL', size: '1', price: '120' },
        { market: 'BTC-USD', createdAt: '2025-01-01T00:00:00Z', createdAtHeight: '100', id: 'c', side: 'BUY',  size: '1', price: '90' }
    ];
    const r = RM.computeRealizedFromFills(fills);
    assert.ok(close(r.total, 30));
});

test('computeRealizedFromFills orders a fill without createdAtHeight by createdAt', () => {
    // The height-less BUY @50 is the newest fill; sorting it as height 0
    // would put it first and close it (+70) instead of the @100 lot (+20).
    const fills = [
        { market: 'BTC-USD', createdAt: '2025-01-01T00:00:02Z', createdAtHeight: '200', id: 'a', side: 'SELL', size: '1', price: '120' },
        { market: 'BTC-USD', createdAt: '2025-01-01T00:00:03Z',                          id: 'b', side: 'BUY',  size: '1', price: '50' },
        { market: 'BTC-USD', createdAt: '2025-01-01T00:00:01Z', createdAtHeight: '100', id: 'c', side: 'BUY',  size: '1', price: '100' }
    ];
    const r = RM.computeRealizedFromFills(fills);
    assert.ok(close(r.total, 20));
});

test('marketPnL respects realizedByMarket override (FIFO source)', () => {
    const positions = [
        { market: 'ETH-USD', status: 'CLOSED', realizedPnl: '100', netFunding: '5'   },
        { market: 'BTC-USD', status: 'OPEN',   unrealizedPnl: '50', netFunding: '-2' },
    ];
    const fees = { 'ETH-USD': 3 };
    // FIFO map asserts ETH realized = 200 (overrides indexer's 100)
    const fifo = { 'ETH-USD': 200 };
    const m = RM.marketPnL(positions, fees, fifo);
    assert.ok(close(m['ETH-USD'].realizedClosed, 200));
    // 200 + 0 + 5 − 3 = 202
    assert.ok(close(m['ETH-USD'].total, 202));
    // BTC has no FIFO entry: realizedClosed cleared (override applies to all
    // existing slots), unrealized + funding survive.
    assert.equal(m['BTC-USD'].realizedClosed, 0);
    assert.ok(close(m['BTC-USD'].total, 48));
});

// ---------------------------------------------------------------------------
// histPnlMonthly — pins that monthly Δ totalPnl deltas chain across months
// and that empty months emit hasData=false (callers must render "—").
// ---------------------------------------------------------------------------

test('marketPnL respects unrealizedByMarket override (FIFO lots at the oracle)', () => {
    const positions = [
        { market: 'BTC-USD', status: 'OPEN', unrealizedPnl: '999' }
    ];
    const agg = RM.marketPnL(positions, null, { 'BTC-USD': 10 }, { 'BTC-USD': 40, 'ETH-USD': 5 });
    assert.equal(agg['BTC-USD'].unrealizedOpen, 40);
    assert.equal(agg['BTC-USD'].total, 50);
    assert.equal(agg['BTC-USD'].openCount, 1);
    assert.equal(agg['ETH-USD'].unrealizedOpen, 5);
});

test('histPnlMonthly: monthly deltas chain across months, sum to latest totalPnl', () => {
    const hist = [
        { createdAt: '2025-01-15T00:00:00Z', totalPnl: '100' },
        { createdAt: '2025-01-31T00:00:00Z', totalPnl: '200' },
        { createdAt: '2025-02-15T00:00:00Z', totalPnl: '150' },
        { createdAt: '2025-02-28T00:00:00Z', totalPnl: '500' },
        { createdAt: '2025-03-15T00:00:00Z', totalPnl: '450' },
    ];
    const m = RM.histPnlMonthly(hist);
    // January: lastInMonth(200) − 0 (first month) = 200
    assert.ok(m['January 2025'].hasData);
    assert.ok(close(m['January 2025'].delta, 200));
    // February: lastInMonth(500) − lastOfPriorMonth(200) = 300
    assert.ok(m['February 2025'].hasData);
    assert.ok(close(m['February 2025'].delta, 300));
    // March: lastInMonth(450) − lastOfPriorMonth(500) = −50
    assert.ok(m['March 2025'].hasData);
    assert.ok(close(m['March 2025'].delta, -50));
    // Reconciliation: Σ deltas == latest totalPnl
    const total = Object.values(m).reduce((s, v) => s + v.delta, 0);
    assert.ok(close(total, 450));
});

test('histPnlMonthly: empty / null input → {}', () => {
    assert.deepEqual(RM.histPnlMonthly([]), {});
    assert.deepEqual(RM.histPnlMonthly(null), {});
});

// ---------------------------------------------------------------------------
// Drawdown family.
// ---------------------------------------------------------------------------

test('histPnlDrawdown monotonically rising → 0', () => {
    const hist = [
        { createdAt: '2025-01-01T00:00:00Z', totalPnl: '0'   },
        { createdAt: '2025-01-02T00:00:00Z', totalPnl: '100' },
        { createdAt: '2025-01-03T00:00:00Z', totalPnl: '250' }
    ];
    const dd = RM.histPnlDrawdown(hist);
    assert.equal(dd.dollarDrawdown, 0);
});

test('histPnlDrawdown peak then trough', () => {
    const hist = [
        { createdAt: '2025-01-01T00:00:00Z', totalPnl: '0'    },
        { createdAt: '2025-01-02T00:00:00Z', totalPnl: '500'  },
        { createdAt: '2025-01-03T00:00:00Z', totalPnl: '300'  },
        { createdAt: '2025-01-04T00:00:00Z', totalPnl: '100'  }
    ];
    const dd = RM.histPnlDrawdown(hist);
    assert.equal(dd.dollarDrawdown, 400);
    assert.ok(close(dd.pctOfPeakProfit, 80));
    assert.equal(dd.peakValue, 500);
    assert.equal(dd.troughValue, 100);
});

test('histPnlDrawdown empty array', () => {
    const dd = RM.histPnlDrawdown([]);
    assert.equal(dd.dollarDrawdown, 0);
});

test('validDrawdownFromEquity peak ≤ 0 returns null', () => {
    const out = RM.validDrawdownFromEquity([-100, -200, -150]);
    assert.equal(out, null);
});

test('validDrawdownFromEquity trough < 0 returns null', () => {
    const out = RM.validDrawdownFromEquity([100, 50, -10]);
    assert.equal(out, null);
});

test('validDrawdownFromEquity normal case', () => {
    const out = RM.validDrawdownFromEquity([100, 50, 80, 30, 60]);
    assert.ok(out !== null);
    assert.equal(out.abs, 70);
    assert.ok(close(out.pct, 70));
});

test('tradeSystemDrawdown matches manual cumulative', () => {
    const positions = [
        { status: 'CLOSED', closedAt: '2025-01-01T00:00:00Z', profit: 100, complete: true },
        { status: 'CLOSED', closedAt: '2025-01-02T00:00:00Z', profit: 200, complete: true },
        { status: 'CLOSED', closedAt: '2025-01-03T00:00:00Z', profit: -150, complete: true },
        { status: 'CLOSED', closedAt: '2025-01-04T00:00:00Z', profit: -100, complete: true }
    ];
    // Cumulative: 100, 300, 150, 50. Peak 300 → trough 50 → DD = 250.
    const dd = RM.tradeSystemDrawdown(positions);
    assert.equal(dd.dollarDrawdown, 250);
});

// ---------------------------------------------------------------------------
// Current (active) drawdown — same series sources as the worst-DD family.
// ---------------------------------------------------------------------------

test('histPnlCurrentDrawdown empty array → hasData=false, $0', () => {
    const cd = RM.histPnlCurrentDrawdown([]);
    assert.equal(cd.hasData, false);
    assert.equal(cd.dollarDrawdown, 0);
    assert.equal(cd.pctOfPeakProfit, 0);
    assert.equal(cd.peakAt, null);
});

test('histPnlCurrentDrawdown monotonically rising → at peak ($0 DD)', () => {
    const hist = [
        { createdAt: '2025-01-01T00:00:00Z', totalPnl: '0'   },
        { createdAt: '2025-01-02T00:00:00Z', totalPnl: '100' },
        { createdAt: '2025-01-03T00:00:00Z', totalPnl: '250' }
    ];
    const cd = RM.histPnlCurrentDrawdown(hist);
    assert.equal(cd.dollarDrawdown, 0);
    assert.equal(cd.peakValue, 250);
    assert.equal(cd.currentValue, 250);
    assert.equal(cd.peakAt, '2025-01-03T00:00:00Z');
});

test('histPnlCurrentDrawdown peak then drop → DD = peak − current', () => {
    const hist = [
        { createdAt: '2025-01-01T00:00:00Z', totalPnl: '0'    },
        { createdAt: '2025-01-02T00:00:00Z', totalPnl: '500'  },
        { createdAt: '2025-01-03T00:00:00Z', totalPnl: '300'  },
        { createdAt: '2025-01-04T00:00:00Z', totalPnl: '100'  }
    ];
    // Peak 500 reached on day 2; current = 100. DD = 400. pct of peak = 80%.
    const cd = RM.histPnlCurrentDrawdown(hist);
    assert.equal(cd.dollarDrawdown, 400);
    assert.ok(close(cd.pctOfPeakProfit, 80));
    assert.equal(cd.peakValue, 500);
    assert.equal(cd.currentValue, 100);
    assert.equal(cd.peakAt, '2025-01-02T00:00:00Z');
    assert.equal(cd.currentAt, '2025-01-04T00:00:00Z');
});

test('histPnlCurrentDrawdown fully recovered above prior peak → $0 DD', () => {
    const hist = [
        { createdAt: '2025-01-01T00:00:00Z', totalPnl: '0'   },
        { createdAt: '2025-01-02T00:00:00Z', totalPnl: '200' },
        { createdAt: '2025-01-03T00:00:00Z', totalPnl: '50'  },
        { createdAt: '2025-01-04T00:00:00Z', totalPnl: '300' }
    ];
    // Max DD was 200→50 but current=300 > prior peak 200, so currently at peak.
    const cd = RM.histPnlCurrentDrawdown(hist);
    assert.equal(cd.dollarDrawdown, 0);
    assert.equal(cd.peakValue, 300);
    assert.equal(cd.currentValue, 300);
});

test('histPnlCurrentDrawdown partial recovery → smaller DD than max', () => {
    const hist = [
        { createdAt: '2025-01-01T00:00:00Z', totalPnl: '0'   },
        { createdAt: '2025-01-02T00:00:00Z', totalPnl: '500' },
        { createdAt: '2025-01-03T00:00:00Z', totalPnl: '100' },
        { createdAt: '2025-01-04T00:00:00Z', totalPnl: '350' }
    ];
    // Max DD was 500→100 = $400. Current = $350, so current DD = 500-350 = $150.
    const cd = RM.histPnlCurrentDrawdown(hist);
    assert.equal(cd.dollarDrawdown, 150);
    assert.ok(close(cd.pctOfPeakProfit, 30));
    assert.equal(cd.peakValue, 500);
    assert.equal(cd.currentValue, 350);
});

test('histPnlCurrentDrawdown single point → at peak ($0 DD)', () => {
    const hist = [{ createdAt: '2025-01-01T00:00:00Z', totalPnl: '123' }];
    const cd = RM.histPnlCurrentDrawdown(hist);
    assert.equal(cd.dollarDrawdown, 0);
    assert.equal(cd.peakValue, 123);
    assert.equal(cd.currentValue, 123);
    assert.equal(cd.hasData, true);
});

test('histPnlCurrentDrawdown handles unsorted input by sorting chronologically', () => {
    const hist = [
        { createdAt: '2025-01-04T00:00:00Z', totalPnl: '100' },
        { createdAt: '2025-01-02T00:00:00Z', totalPnl: '500' },
        { createdAt: '2025-01-01T00:00:00Z', totalPnl: '0'   },
        { createdAt: '2025-01-03T00:00:00Z', totalPnl: '300' }
    ];
    const cd = RM.histPnlCurrentDrawdown(hist);
    // Sorted: 0, 500, 300, 100. Peak 500, current 100, DD 400.
    assert.equal(cd.dollarDrawdown, 400);
    assert.equal(cd.currentAt, '2025-01-04T00:00:00Z');
});

test('histPnlCurrentDrawdown peak ≤ 0 → pct = 0 (no peak profit to denominate)', () => {
    const hist = [
        { createdAt: '2025-01-01T00:00:00Z', totalPnl: '-100' },
        { createdAt: '2025-01-02T00:00:00Z', totalPnl: '-200' },
        { createdAt: '2025-01-03T00:00:00Z', totalPnl: '-300' }
    ];
    // Peak = -100 (the highest), current = -300. DD = 200. But peak ≤ 0 so pct = 0.
    const cd = RM.histPnlCurrentDrawdown(hist);
    assert.equal(cd.dollarDrawdown, 200);
    assert.equal(cd.pctOfPeakProfit, 0);
});

test('tradeSystemCurrentDrawdown on cumulative profit', () => {
    const positions = [
        { status: 'CLOSED', closedAt: '2025-01-01T00:00:00Z', profit: 100, complete: true },
        { status: 'CLOSED', closedAt: '2025-01-02T00:00:00Z', profit: 200, complete: true },
        { status: 'CLOSED', closedAt: '2025-01-03T00:00:00Z', profit: -150, complete: true },
        { status: 'CLOSED', closedAt: '2025-01-04T00:00:00Z', profit: -100, complete: true }
    ];
    // Cumulative: 100, 300, 150, 50. Peak 300, current 50, current DD = 250.
    const cd = RM.tradeSystemCurrentDrawdown(positions);
    assert.equal(cd.dollarDrawdown, 250);
    assert.equal(cd.peakValue, 300);
    assert.equal(cd.currentValue, 50);
});

test('trade-system drawdown family is all-or-nothing: an incomplete closed position leaves no series', () => {
    const positions = [
        { status: 'CLOSED', closedAt: '2025-01-01T00:00:00Z', profit: 100, complete: true },
        { status: 'CLOSED', closedAt: '2025-01-02T00:00:00Z', profit: -50, complete: false }
    ];
    assert.equal(RM.tradeSystemDrawdown(positions).dollarDrawdown, 0);
    assert.equal(RM.tradeSystemDrawdownEvents(positions).length, 0);
    assert.equal(RM.tradeSystemCurrentDrawdown(positions).hasData, false);

    const complete = positions.map(p => ({ ...p, complete: true }));
    assert.equal(RM.tradeSystemDrawdown(complete).dollarDrawdown, 50);
    assert.equal(RM.tradeSystemCurrentDrawdown(complete).currentValue, 50);
});

test('tradeSystemCurrentDrawdown empty input → hasData=false', () => {
    const cd = RM.tradeSystemCurrentDrawdown([]);
    assert.equal(cd.hasData, false);
    assert.equal(cd.dollarDrawdown, 0);
});

// ---------------------------------------------------------------------------
// assessAdequacy — sample-size gate shared across Sharpe/Sortino/Calmar/VaR.
// ---------------------------------------------------------------------------

test('assessAdequacy n < 30 returns adequate=false', () => {
    const returns = Array(10).fill(0.01);
    const ts = returns.map((_, i) => new Date(2025, 0, i + 1).toISOString());
    const out = RM.assessAdequacy(returns, ts, 10);
    assert.equal(out.adequate, false);
    assert.match(out.reason, /returns/i);
});

test('assessAdequacy coverage < 0.5 returns adequate=false', () => {
    const returns = Array(40).fill(0.01);
    const ts = returns.map((_, i) => new Date(2025, 0, i + 1).toISOString());
    const out = RM.assessAdequacy(returns, ts, 200); // n=40, hist=200 → coverage=0.2
    assert.equal(out.adequate, false);
    assert.match(out.reason, /coverage/i);
});

// ---------------------------------------------------------------------------
// computeSharpe / computeSortino — pin null/Infinity contract the UI relies
// on for the `—` rendering path.
// ---------------------------------------------------------------------------

test('computeSharpe returns null on zero variance (constant returns)', () => {
    assert.equal(RM.computeSharpe([0.01, 0.01, 0.01, 0.01]), null);
    assert.equal(RM.computeSharpe([0]), null);
    assert.equal(RM.computeSharpe([]), null);
    assert.equal(RM.computeSharpe(null), null);
});

test('computeSharpe is mean over sample standard deviation', () => {
    // mean = 0.03 / 5 = 0.006; squared deviations 1.96e-4 + 2.56e-4 +
    // 5.76e-4 + 6.76e-4 + 0.16e-4 = 1.72e-3; sample variance = 1.72e-3 / 4
    // = 4.3e-4; Sharpe = 0.006 / √4.3e-4 ≈ 0.289346.
    const s = RM.computeSharpe([0.02, -0.01, 0.03, -0.02, 0.01]);
    assert.ok(close(s, 0.289346, 1e-6), `expected ≈ 0.289346, got ${s}`);
});

test('computeSortino returns Infinity when mean > 0 and no downside variance', () => {
    // All returns positive: downside deviation = 0, mean > 0 → Infinity.
    assert.equal(RM.computeSortino([0.01, 0.02, 0.03]), Infinity);
});

test('computeSortino returns null when downside variance = 0 and mean ≤ 0', () => {
    assert.equal(RM.computeSortino([0, 0, 0]), null);
});

test('computeSortino divides downside variance by every period, not by the losing ones', () => {
    // mean = -0.01 / 4 = -0.0025; downside squares 9e-4 + 1e-4 = 1e-3 over
    // N = 4 periods gives 2.5e-4; Sortino = -0.0025 / √2.5e-4 ≈ -0.158114.
    const s = RM.computeSortino([0.02, -0.03, 0.01, -0.01]);
    assert.ok(close(s, -0.158114, 1e-6), `expected ≈ -0.158114, got ${s}`);
});

// ---------------------------------------------------------------------------
// computeTimeWeightedReturnsFromHist — transfer-aware contract: deposits and
// withdrawals never appear as fictitious returns; denominator is PRIOR-row
// equity (not current).
// ---------------------------------------------------------------------------

test('computeTimeWeightedReturnsFromHist drops periods where prior equity ≤ 0', () => {
    const rows = [
        { createdAt: '2025-01-01T00:00:00Z', equity: '0',    totalPnl: '0' },
        { createdAt: '2025-01-02T00:00:00Z', equity: '1000', totalPnl: '0' },
        { createdAt: '2025-01-03T00:00:00Z', equity: '1050', totalPnl: '50' }
    ];
    const r = RM.computeTimeWeightedReturnsFromHist(rows);
    // Period 1→2 dropped (prevEq = 0); period 2→3 included: 50/1000 = 0.05.
    assert.equal(r.length, 1);
    assert.ok(close(r[0], 0.05));
});

test('computeTimeWeightedReturnsFromHist uses PRIOR-row equity as denominator', () => {
    // pnlDelta = 100; prev equity = 1000 → 0.10.  curr equity is 10000
    // (large deposit), but the return must NOT use it as the divisor.
    const rows = [
        { createdAt: '2025-01-01T00:00:00Z', equity: '1000',  totalPnl: '0' },
        { createdAt: '2025-01-02T00:00:00Z', equity: '10000', totalPnl: '100' }
    ];
    const r = RM.computeTimeWeightedReturnsFromHist(rows);
    assert.equal(r.length, 1);
    assert.ok(close(r[0], 0.1), `expected 0.1 (100/1000), got ${r[0]}`);
});

test('computeTimeWeightedReturnsFromHist isolates pnlDelta (transfers ignored)', () => {
    // Equity jumps from 1000 → 5000 via deposit but totalPnl unchanged.
    // r = pnlDelta / prevEq = 0 / 1000 = 0 (NOT (5000-1000)/1000 = 4).
    const rows = [
        { createdAt: '2025-01-01T00:00:00Z', equity: '1000', totalPnl: '0' },
        { createdAt: '2025-01-02T00:00:00Z', equity: '5000', totalPnl: '0' }
    ];
    const r = RM.computeTimeWeightedReturnsFromHist(rows);
    assert.equal(r.length, 1);
    assert.equal(r[0], 0);
});

// ---------------------------------------------------------------------------
// computeAnnualizedFromReturns — ppy detection +
// √ppy annualization.
// ---------------------------------------------------------------------------

test('computeAnnualizedFromReturns annualizes by √ppy', () => {
    const rets = [0.01, -0.01, 0.02, -0.02, 0.005, -0.005, 0.015];
    const ts = rets.map((_, i) => new Date(2025, 0, i + 1).toISOString());
    const out = RM.computeAnnualizedFromReturns(rets, ts);
    assert.ok(out.ppy > 350 && out.ppy < 370, `daily ppy ≈ 365.25, got ${out.ppy}`);
    const factor = Math.sqrt(out.ppy);
    assert.ok(close(out.sharpeAnnualized, out.sharpe * factor, 1e-6));
});

// ---------------------------------------------------------------------------
// tradeReturn — profit ÷ peak notional (peakSize × entryVwap).
// ---------------------------------------------------------------------------

test('tradeReturn = profit ÷ (peakSize × entryVwap), ignoring indexer size/price/P&L fields', () => {
    const p = {
        profit: 20, peakSize: 2, entryVwap: 100, complete: true,
        maxSize: '-0.5', sumOpen: '10', size: '5', entryPrice: '50', realizedPnl: '999'
    };
    // r = 20 / (2 · 100) = 0.10
    assert.ok(close(RM.tradeReturn(p), 0.1));
});

test('peakNotional = peakSize × entryVwap, the denominator tradeReturn divides by', () => {
    assert.equal(RM.peakNotional({ peakSize: 2, entryVwap: 100, complete: true }), 200);
    assert.equal(RM.peakNotional({ peakSize: 2, entryVwap: 100, complete: false }), null);
    assert.equal(RM.peakNotional({ peakSize: 0, entryVwap: 100, complete: true }), null);
    assert.equal(RM.peakNotional({ peakSize: 2, entryVwap: null, complete: true }), null);
});

test('tradeReturn returns null when the fill attribution is incomplete', () => {
    assert.equal(RM.tradeReturn({ profit: 20, peakSize: 2, entryVwap: 100, complete: false }), null);
});

test('tradeReturn returns null when peak notional cannot be computed', () => {
    assert.equal(RM.tradeReturn({ profit: 20, peakSize: null, entryVwap: 100, complete: true }), null);
    assert.equal(RM.tradeReturn({ profit: 20, peakSize: 2, entryVwap: null, complete: true }), null);
    assert.equal(RM.tradeReturn({ profit: 20, peakSize: 0, entryVwap: 100, complete: true }), null);
    assert.equal(RM.tradeReturn({ profit: 20, peakSize: -2, entryVwap: 100, complete: true }), null,
        'a signed (SHORT) size is not a peak notional');
    assert.equal(RM.tradeReturn({ profit: 20, peakSize: 2, entryVwap: -100, complete: true }), null);
    assert.equal(RM.tradeReturn({ peakSize: 2, entryVwap: 100, complete: true }), null, 'missing profit');
});

// ---------------------------------------------------------------------------
// assessAdequacy — MIN_YEARS=1/12 boundary + happy path.
// ---------------------------------------------------------------------------

test('assessAdequacy fails when years < 1/12 even with 30+ returns', () => {
    // 30 returns, each ~1 minute apart → years ≪ 1/12, even with high ppy.
    const rets = Array(30).fill(0.001);
    const ts = rets.map((_, i) => new Date(2025, 0, 1, 0, i).toISOString());
    const out = RM.assessAdequacy(rets, ts, 30);
    assert.equal(out.adequate, false);
    assert.match(out.reason, /month/i, `expected MIN_YEARS reason, got: ${out.reason}`);
});

test('assessAdequacy adequate=true at n=35 daily over 35d (>1 month)', () => {
    // Boundary detail: MIN_YEARS = 1/12 ≈ 0.0833 years ≈ 30.4 days. 30
    // returns over 30 days lands at 30/365.25 ≈ 0.0821 years and would
    // fail the gate by ~1%. 35 returns over 35 days clears it cleanly.
    const rets = Array(35).fill(0.01);
    const ts = rets.map((_, i) => new Date(2025, 0, i + 1).toISOString());
    const out = RM.assessAdequacy(rets, ts, 35);
    assert.equal(out.adequate, true, `expected adequate, reason="${out.reason}"`);
    assert.equal(out.reason, '');
});

// ---------------------------------------------------------------------------
// histPnlDrawdownEvents / tradeSystemDrawdownEvents — multi-event scans.
// ---------------------------------------------------------------------------

test('histPnlDrawdownEvents emits each peak-to-recovery cycle', () => {
    const rows = [
        { createdAt: '2025-01-01T00:00:00Z', totalPnl: '0' },
        { createdAt: '2025-01-02T00:00:00Z', totalPnl: '100' },  // peak 1
        { createdAt: '2025-01-03T00:00:00Z', totalPnl: '40' },   // trough 1
        { createdAt: '2025-01-04T00:00:00Z', totalPnl: '120' },  // recovers + new peak
        { createdAt: '2025-01-05T00:00:00Z', totalPnl: '60' },   // trough 2 (no recovery)
    ];
    const events = RM.histPnlDrawdownEvents(rows);
    assert.equal(events.length, 2, `expected 2 events, got ${events.length}`);
    assert.equal(events[0].recoveryAt, '2025-01-04T00:00:00Z');
    assert.equal(events[1].recoveryAt, null);
});

test('histPnlDrawdownEvents recovery requires returning to or above prior peak', () => {
    const rows = [
        { createdAt: '2025-01-01T00:00:00Z', totalPnl: '0' },
        { createdAt: '2025-01-02T00:00:00Z', totalPnl: '100' },
        { createdAt: '2025-01-03T00:00:00Z', totalPnl: '50' },
        { createdAt: '2025-01-04T00:00:00Z', totalPnl: '99' }, // below peak → not recovered
    ];
    const events = RM.histPnlDrawdownEvents(rows);
    assert.equal(events.length, 1);
    assert.equal(events[0].recoveryAt, null);
});

test('tradeSystemDrawdownEvents enumerates events on cumulative profit', () => {
    const positions = [
        { status: 'CLOSED', closedAt: '2025-01-01T00:00:00Z', profit: 100, complete: true },
        { status: 'CLOSED', closedAt: '2025-01-02T00:00:00Z', profit: -60, complete: true },
        { status: 'CLOSED', closedAt: '2025-01-03T00:00:00Z', profit: 80, complete: true },  // cum 120 → new peak
        { status: 'CLOSED', closedAt: '2025-01-04T00:00:00Z', profit: -40, complete: true }, // trough 80
    ];
    const events = RM.tradeSystemDrawdownEvents(positions);
    assert.ok(events.length >= 1, `expected at least 1 event, got ${events.length}`);
    assert.ok(events.every(e => e.depthAbs > 0));
});

// ---------------------------------------------------------------------------
// computeRealizedFromFills — defensive contracts: skip unknown-side and
// zero-size rows without crashing (indexer schema drift protection).
// ---------------------------------------------------------------------------

test('computeRealizedFromFills ignores unknown side strings', () => {
    const fills = [
        { market: 'ETH-USD', side: 'BUY',    size: '1', price: '100', createdAt: '2025-01-01' },
        { market: 'ETH-USD', side: 'WEIRD',  size: '1', price: '150', createdAt: '2025-01-02' },
        { market: 'ETH-USD', side: 'SELL',   size: '1', price: '150', createdAt: '2025-01-03' },
    ];
    const out = RM.computeRealizedFromFills(fills);
    assert.ok(close(out.total, 50), `expected +50 (1 buy @100, 1 sell @150), got ${out.total}`);
});

test('computeRealizedFromFills skips zero-size and unparseable fills', () => {
    const fills = [
        { market: 'BTC-USD', side: 'BUY',  size: '0',   price: '100', createdAt: '2025-01-01' },
        { market: 'BTC-USD', side: 'BUY',  size: 'NaN', price: '100', createdAt: '2025-01-02' },
        { market: 'BTC-USD', side: 'BUY',  size: '1',   price: '100', createdAt: '2025-01-03' },
        { market: 'BTC-USD', side: 'SELL', size: '1',   price: '150', createdAt: '2025-01-04' },
    ];
    const out = RM.computeRealizedFromFills(fills);
    assert.ok(close(out.total, 50));
});

// ---------------------------------------------------------------------------
// liquidationRow — null position / missing market shouldn't crash callers.
// ---------------------------------------------------------------------------

test('liquidationRow returns null for null position', () => {
    assert.equal(RM.liquidationRow(null, { equity: '1000' }, {}), null);
});

test('liquidationRow returns null for null subaccount', () => {
    assert.equal(RM.liquidationRow({ market: 'BTC-USD', size: '1', side: 'LONG' }, null, {}), null);
});

test('liquidationRow tolerates empty marketsMap (uses position entryPrice fallback)', () => {
    const p = { market: 'BTC-USD', size: '1', side: 'LONG', entryPrice: '100' };
    const sub = { equity: '50' };
    const row = RM.liquidationRow(p, sub, {});
    // size=1, oracle=0 → notional uses entryPrice fallback = 100
    assert.ok(row !== null);
    assert.equal(row.notional, 100);
});

// ---------------------------------------------------------------------------
// classifyClosed derived fields — pin the single-source-of-truth contract
// for winRate / profitFactor / avgWin / avgLoss / expectancy. Consumers
// MUST use these instead of recomputing inline (see the 'Metric
// Definitions (single source of truth)' section).
// ---------------------------------------------------------------------------

test('classifyClosed derived fields: winRate, profitFactor, avgWin, avgLoss, expectancy', () => {
    const positions = [
        { status: 'CLOSED', profit: 100, complete: true },
        { status: 'CLOSED', profit: 200, complete: true },
        { status: 'CLOSED', profit: -50, complete: true },
        { status: 'CLOSED', profit: 0, complete: true }   // scratch
    ];
    const c = RM.classifyClosed(positions);
    assert.equal(c.winCount, 2);
    assert.equal(c.lossCount, 1);
    assert.equal(c.scratchCount, 1);
    assert.equal(c.decisiveCount, 3);
    // winRate = 2 / 3 × 100 ≈ 66.67
    assert.ok(close(c.winRate, 66.666666, 1e-3));
    // profitFactor = 300 / 50 = 6
    assert.equal(c.profitFactor, 6);
    // avgWin = 300 / 2 = 150
    assert.equal(c.avgWin, 150);
    // avgLoss = 50 / 1 = 50
    assert.equal(c.avgLoss, 50);
    // expectancy = (300 − 50) / 3 ≈ 83.33
    assert.ok(close(c.expectancy, 83.333333, 1e-3));
});

test('classifyClosed derived fields are null when denominator is zero', () => {
    const allScratches = [{ status: 'CLOSED', profit: 0, complete: true }];
    const c1 = RM.classifyClosed(allScratches);
    assert.equal(c1.winRate, null);
    assert.equal(c1.profitFactor, null);
    assert.equal(c1.avgWin, null);
    assert.equal(c1.avgLoss, null);
    assert.equal(c1.expectancy, null);

    const winsOnly = [
        { status: 'CLOSED', profit: 100, complete: true },
        { status: 'CLOSED', profit: 50, complete: true }
    ];
    const c2 = RM.classifyClosed(winsOnly);
    assert.equal(c2.winRate, 100);
    assert.equal(c2.profitFactor, null, 'no losses → PF undefined');
    assert.equal(c2.avgWin, 75);
    assert.equal(c2.avgLoss, null);
    assert.equal(c2.expectancy, 75);
});

test('classifyByMonth buckets closed positions by closedAt month', () => {
    const positions = [
        { status: 'CLOSED', closedAt: '2025-01-15T00:00:00Z', profit: 100, complete: true },
        { status: 'CLOSED', closedAt: '2025-01-20T00:00:00Z', profit: -50, complete: true },
        { status: 'CLOSED', closedAt: '2025-02-05T00:00:00Z', profit: 200, complete: true },
        { status: 'OPEN',   createdAt: '2025-02-10T00:00:00Z' }, // skipped
    ];
    const monthly = RM.classifyByMonth(positions);
    const keys = Object.keys(monthly);
    assert.equal(keys.length, 2);
    assert.equal(monthly['January 2025'].winCount, 1);
    assert.equal(monthly['January 2025'].lossCount, 1);
    assert.equal(monthly['January 2025'].expectancy, 25); // (100−50)/2
    assert.equal(monthly['February 2025'].winCount, 1);
    assert.equal(monthly['February 2025'].profitFactor, null); // no losses
});

test('classifyByMonth applies an account-wide unavailable reason to every month', () => {
    const reason = '1 position missing fill data';
    const monthly = RM.classifyByMonth([
        { status: 'CLOSED', closedAt: '2025-01-15T00:00:00Z', profit: 100, complete: true },
        { status: 'CLOSED', closedAt: '2025-01-20T00:00:00Z', profit: -50, complete: true }
    ], reason);
    assert.equal(monthly['January 2025'].incompleteReason, reason);
    assert.equal(monthly['January 2025'].winRate, null);
    assert.equal(monthly['January 2025'].winCount, 1, 'counts stay available');
});

test('classifyByMonth empty / null input → {}', () => {
    assert.deepEqual(RM.classifyByMonth(null), {});
    assert.deepEqual(RM.classifyByMonth([]), {});
});
