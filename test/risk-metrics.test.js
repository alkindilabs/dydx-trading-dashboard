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
    // Real account: BTC-USD LONG 6.5 @ entry 76898.46, oracle 78928.28,
    // equity 473363.91, MMF observed at ~0.012. dYdX UI showed liq $6,177.
    const position = { market: 'BTC-USD', size: '6.5', side: 'LONG' };
    const sub = { equity: '473363.91' };
    const markets = {
        'BTC-USD': { oraclePrice: '78928.28', maintenanceMarginFraction: '0.012' }
    };
    const liq = RM.crossMarginLiqPrice(position, sub, markets);
    assert.ok(liq !== null, 'expected numeric liq');
    assert.ok(close(liq, 6177.50, 1.0), `expected ~6177.50, got ${liq}`);
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
        { market: 'BTC-USD', side: 'LONG', size: '6.5', status: 'OPEN', entryPrice: '76898.46' }
    ];
    const sub = { equity: '473363.91' };
    const markets = { 'BTC-USD': { oraclePrice: '78928.28' } };
    const lev = RM.leverageUtilization(positions, sub, markets);
    // Oracle-based: 6.5·78928.28 / 473363.91 = 1.0838
    assert.ok(close(lev, 1.0838, 1e-3), `expected ~1.0838, got ${lev}`);
});

test('leverageUtilization returns null when equity ≤ 0', () => {
    const positions = [
        { market: 'BTC-USD', side: 'LONG', size: '1', status: 'OPEN', oraclePrice: '100000' }
    ];
    assert.equal(RM.leverageUtilization(positions, { equity: '0' }, {}), null);
    assert.equal(RM.leverageUtilization(positions, { equity: '-100' }, {}), null);
    assert.equal(RM.leverageUtilization(positions, null, {}), null);
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
    const position = { market: 'BTC-USD', side: 'LONG', size: '6.5', status: 'OPEN', entryPrice: '76898.46' };
    const sub = { equity: '473363.91' };
    const markets = {
        'BTC-USD': { oraclePrice: '78928.28', maintenanceMarginFraction: '0.012' }
    };
    const row = RM.liquidationRow(position, sub, markets);
    assert.ok(close(row.notional, 6.5 * 78928.28, 1e-2));
    assert.ok(close(row.lev, 1.0838, 1e-3));
});

test('liquidationRow distancePct from oracle and liq', () => {
    const position = { market: 'BTC-USD', side: 'LONG', size: '6.5', status: 'OPEN' };
    const sub = { equity: '473363.91' };
    const markets = {
        'BTC-USD': { oraclePrice: '78928.28', maintenanceMarginFraction: '0.012' }
    };
    const row = RM.liquidationRow(position, sub, markets);
    // (78928.28 - 6177.50) / 78928.28 ≈ 92.17%
    assert.ok(close(row.distancePct, 92.17, 0.05), `expected ~92.17%, got ${row.distancePct}`);
});

// ---------------------------------------------------------------------------
// normalizeRealizedPnl — indexer-zero repair.
// ---------------------------------------------------------------------------

test('normalizeRealizedPnl LONG: zero realizedPnl + valid prices → derived', () => {
    const positions = [{
        status: 'CLOSED', side: 'LONG',
        entryPrice: '100', exitPrice: '120', maxSize: '2',
        realizedPnl: '0'
    }];
    const out = RM.normalizeRealizedPnl(positions);
    assert.equal(out.correctedCount, 1);
    assert.equal(parseFloat(positions[0].realizedPnl), 40); // (120-100)·2·(+1)
    assert.equal(positions[0]._derivedRealizedPnl, true);
});

test('normalizeRealizedPnl preserves indexer non-zero value', () => {
    const positions = [{
        status: 'CLOSED', side: 'LONG',
        entryPrice: '100', exitPrice: '120', maxSize: '2',
        realizedPnl: '37.5'
    }];
    const out = RM.normalizeRealizedPnl(positions);
    assert.equal(out.correctedCount, 0);
    assert.equal(positions[0].realizedPnl, '37.5');
    assert.equal(positions[0]._derivedRealizedPnl, undefined);
});

test('normalizeRealizedPnl leaves zero in place when prices missing', () => {
    const positions = [{
        status: 'CLOSED', side: 'LONG',
        entryPrice: '0', exitPrice: '0', maxSize: '2',
        realizedPnl: '0'
    }];
    const out = RM.normalizeRealizedPnl(positions);
    assert.equal(out.correctedCount, 0);
    assert.equal(positions[0].realizedPnl, '0');
});

test('normalizeRealizedPnl SHORT: side multiplier flips sign', () => {
    const positions = [{
        status: 'CLOSED', side: 'SHORT',
        entryPrice: '120', exitPrice: '100', maxSize: '2',
        realizedPnl: '0'
    }];
    RM.normalizeRealizedPnl(positions);
    // (100-120)·2·(-1) = +40 (short profits when price drops)
    assert.equal(parseFloat(positions[0].realizedPnl), 40);
});

// ---------------------------------------------------------------------------
// classifyClosed — denominator for every win-rate-style ratio.
// ---------------------------------------------------------------------------

test('classifyClosed partitions wins/losses/scratches; decisive = wins+losses', () => {
    const positions = [
        { status: 'CLOSED', realizedPnl: '100' },
        { status: 'CLOSED', realizedPnl: '-50' },
        { status: 'CLOSED', realizedPnl: '0'   },
        { status: 'OPEN',   realizedPnl: '200' }, // ignored
    ];
    const c = RM.classifyClosed(positions);
    assert.equal(c.winCount, 1);
    assert.equal(c.lossCount, 1);
    assert.equal(c.scratchCount, 1);
    assert.equal(c.decisiveCount, 2);
    assert.equal(c.closedCount, 3);
    assert.equal(c.grossWin, 100);
    assert.equal(c.grossLoss, 50);
    assert.equal(c.totalRealized, 50);
});

test('classifyClosed empty input', () => {
    const c = RM.classifyClosed([]);
    assert.equal(c.decisiveCount, 0);
    assert.equal(c.closedCount, 0);
    assert.equal(c.totalRealized, 0);
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

test('computeRealizedFromFills tie-breaks same-createdAt by createdAtHeight then id', () => {
    // Two fills at same createdAt but different heights — height 100 first.
    const fills = [
        { market: 'BTC-USD', createdAt: '2025-01-01T00:00:00Z', createdAtHeight: '100', id: 'a', side: 'BUY',  size: '1', price: '100' },
        { market: 'BTC-USD', createdAt: '2025-01-01T00:00:00Z', createdAtHeight: '101', id: 'b', side: 'SELL', size: '1', price: '120' }
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
        { status: 'CLOSED', closedAt: '2025-01-01T00:00:00Z', realizedPnl: '100'  },
        { status: 'CLOSED', closedAt: '2025-01-02T00:00:00Z', realizedPnl: '200'  },
        { status: 'CLOSED', closedAt: '2025-01-03T00:00:00Z', realizedPnl: '-150' },
        { status: 'CLOSED', closedAt: '2025-01-04T00:00:00Z', realizedPnl: '-100' }
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

test('tradeSystemCurrentDrawdown on cumulative realizedPnl', () => {
    const positions = [
        { status: 'CLOSED', closedAt: '2025-01-01T00:00:00Z', realizedPnl: '100'  },
        { status: 'CLOSED', closedAt: '2025-01-02T00:00:00Z', realizedPnl: '200'  },
        { status: 'CLOSED', closedAt: '2025-01-03T00:00:00Z', realizedPnl: '-150' },
        { status: 'CLOSED', closedAt: '2025-01-04T00:00:00Z', realizedPnl: '-100' }
    ];
    // Cumulative: 100, 300, 150, 50. Peak 300, current 50, current DD = 250.
    const cd = RM.tradeSystemCurrentDrawdown(positions);
    assert.equal(cd.dollarDrawdown, 250);
    assert.equal(cd.peakValue, 300);
    assert.equal(cd.currentValue, 50);
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

test('computeSharpe returns finite ratio when returns have variance', () => {
    const s = RM.computeSharpe([0.02, -0.01, 0.03, -0.02, 0.01]);
    assert.ok(typeof s === 'number' && isFinite(s), `expected finite, got ${s}`);
});

test('computeSortino returns Infinity when mean > 0 and no downside variance', () => {
    // All returns positive: downside deviation = 0, mean > 0 → Infinity.
    assert.equal(RM.computeSortino([0.01, 0.02, 0.03]), Infinity);
});

test('computeSortino returns null when downside variance = 0 and mean ≤ 0', () => {
    assert.equal(RM.computeSortino([0, 0, 0]), null);
});

test('computeSortino returns finite ratio when downside variance > 0', () => {
    const s = RM.computeSortino([0.02, -0.03, 0.01, -0.01]);
    assert.ok(typeof s === 'number' && isFinite(s), `expected finite, got ${s}`);
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
// computeAnnualizedFromReturns / FromHistoricalPnl — ppy detection +
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

test('computeAnnualizedFromHistoricalPnl integrates the full pipeline', () => {
    const rows = [
        { createdAt: '2025-01-01T00:00:00Z', equity: '1000', totalPnl: '0' },
        { createdAt: '2025-01-02T00:00:00Z', equity: '1010', totalPnl: '10' },
        { createdAt: '2025-01-03T00:00:00Z', equity: '1005', totalPnl: '5' },
        { createdAt: '2025-01-04T00:00:00Z', equity: '1030', totalPnl: '30' }
    ];
    const out = RM.computeAnnualizedFromHistoricalPnl(rows);
    assert.equal(out.returns.length, 3);
    assert.ok(typeof out.ppy === 'number' && out.ppy > 0);
});

// ---------------------------------------------------------------------------
// tradeReturn — maxSize → sumOpen → size fallback chain.
// ---------------------------------------------------------------------------

test('tradeReturn prefers maxSize when present', () => {
    const p = { maxSize: '2', sumOpen: '10', size: '5', entryPrice: '100', realizedPnl: '20' };
    // r = 20 / (2 * 100) = 0.10
    assert.ok(close(RM.tradeReturn(p), 0.1));
});

test('tradeReturn falls back to sumOpen when maxSize missing', () => {
    const p = { sumOpen: '4', size: '5', entryPrice: '100', realizedPnl: '20' };
    // r = 20 / (4 * 100) = 0.05
    assert.ok(close(RM.tradeReturn(p), 0.05));
});

test('tradeReturn falls back to size when both maxSize and sumOpen missing', () => {
    const p = { size: '5', entryPrice: '100', realizedPnl: '20' };
    // r = 20 / (5 * 100) = 0.04
    assert.ok(close(RM.tradeReturn(p), 0.04));
});

test('tradeReturn returns null when notional cannot be computed', () => {
    assert.equal(RM.tradeReturn({ entryPrice: '100', realizedPnl: '20' }), null);
    assert.equal(RM.tradeReturn({ size: '5', realizedPnl: '20' }), null);
    assert.equal(RM.tradeReturn({ size: '0', entryPrice: '100', realizedPnl: '20' }), null);
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

test('tradeSystemDrawdownEvents enumerates events on cumulative realizedPnl', () => {
    const positions = [
        { status: 'CLOSED', closedAt: '2025-01-01T00:00:00Z', realizedPnl: '100' },
        { status: 'CLOSED', closedAt: '2025-01-02T00:00:00Z', realizedPnl: '-60' },
        { status: 'CLOSED', closedAt: '2025-01-03T00:00:00Z', realizedPnl: '80' },  // cum 120 → new peak
        { status: 'CLOSED', closedAt: '2025-01-04T00:00:00Z', realizedPnl: '-40' }, // trough 80
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
