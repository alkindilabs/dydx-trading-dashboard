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
