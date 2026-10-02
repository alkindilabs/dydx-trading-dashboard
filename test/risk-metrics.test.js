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

// Two open positions in one cross-margin subaccount. dYdX liquidates when
// total account value falls below the TOTAL maintenance margin requirement,
// Σ |S_j|·P_j·MMF_j over every open position, so each position's liq price
// must carry the other position's requirement too.
const TWO_POSITION_MARKETS = {
    'BTC-USD': { oraclePrice: '80000', maintenanceMarginFraction: '0.012' },
    'ETH-USD': { oraclePrice: '2000', maintenanceMarginFraction: '0.05' }
};
const TWO_POSITION_SUB = { equity: '300000' };
const BTC_LONG_10 = { market: 'BTC-USD', side: 'LONG', size: '10', status: 'OPEN' };
const ETH_SHORT_100 = { market: 'ETH-USD', side: 'SHORT', size: '-100', status: 'OPEN' };

// Total account value and total maintenance margin requirement when
// `market` trades at `price` and every other position stays at its oracle.
function accountAtPrice(positions, market, price) {
    let value = parseFloat(TWO_POSITION_SUB.equity);
    let mmr = 0;
    for (const p of positions) {
        const m = TWO_POSITION_MARKETS[p.market];
        const oracle = parseFloat(m.oraclePrice);
        const mark = p.market === market ? price : oracle;
        const signed = parseFloat(p.size) * (p.side === 'SHORT' && parseFloat(p.size) > 0 ? -1 : 1);
        value += signed * (mark - oracle);
        mmr += Math.abs(signed) * mark * parseFloat(m.maintenanceMarginFraction);
    }
    return { value, mmr };
}

test('crossMarginLiqPrice includes the other open positions\' maintenance margin (LONG and SHORT)', () => {
    const positions = [BTC_LONG_10, ETH_SHORT_100];
    const btcLiq = RM.crossMarginLiqPrice(BTC_LONG_10, TWO_POSITION_SUB, TWO_POSITION_MARKETS, positions);
    const ethLiq = RM.crossMarginLiqPrice(ETH_SHORT_100, TWO_POSITION_SUB, TWO_POSITION_MARKETS, positions);
    // (10·80000 − 300000 + 100·2000·0.05) / (10·0.988) = 51619.43; leaving
    // out ETH's $10000 requirement gives the optimistic 50607.29.
    assert.ok(close(btcLiq, 51619.43), `expected ~51619.43, got ${btcLiq}`);
    // (300000 − 10·80000·0.012 + 100·2000) / (100·1.05) = 4670.48; leaving
    // out BTC's $9600 requirement gives the optimistic 4761.90.
    assert.ok(close(ethLiq, 4670.48), `expected ~4670.48, got ${ethLiq}`);
    // At each liq price the account sits exactly at its liquidation line.
    for (const [market, liq] of [['BTC-USD', btcLiq], ['ETH-USD', ethLiq]]) {
        const { value, mmr } = accountAtPrice(positions, market, liq);
        assert.ok(close(value, mmr), `${market}: account value ${value} vs requirement ${mmr}`);
    }
});

test('crossMarginLiqPrice is null when another open position\'s requirement is unknown', () => {
    const noEthMmf = { ...TWO_POSITION_MARKETS, 'ETH-USD': { oraclePrice: '2000' } };
    const noEthOracle = { ...TWO_POSITION_MARKETS, 'ETH-USD': { maintenanceMarginFraction: '0.05' } };
    const positions = [BTC_LONG_10, ETH_SHORT_100];
    assert.equal(RM.crossMarginLiqPrice(BTC_LONG_10, TWO_POSITION_SUB, noEthMmf, positions), null);
    assert.equal(RM.crossMarginLiqPrice(BTC_LONG_10, TWO_POSITION_SUB, noEthOracle, positions), null);
});

test('crossMarginLiqPrice ignores CLOSED positions and the position\'s own market in the list', () => {
    const closedEth = { ...ETH_SHORT_100, status: 'CLOSED' };
    const alone = RM.crossMarginLiqPrice(BTC_LONG_10, TWO_POSITION_SUB, TWO_POSITION_MARKETS);
    assert.ok(close(alone, 50607.29), `expected ~50607.29, got ${alone}`);
    assert.equal(
        RM.crossMarginLiqPrice(BTC_LONG_10, TWO_POSITION_SUB, TWO_POSITION_MARKETS, [{ ...BTC_LONG_10 }, closedEth]),
        alone
    );
});

// A SHORT of 0.01 BTC beside a LONG of 1000 ETH whose $120000 requirement
// dwarfs the $50000 equity: the SHORT's P_liq numerator E − R + |S|·O is
// 50000 − 120000 + 1000 < 0, so no price keeps the account above its
// total maintenance margin.
const UNDER_MMR_MARKETS = {
    'BTC-USD': { oraclePrice: '100000', maintenanceMarginFraction: '0.03' },
    'ETH-USD': { oraclePrice: '4000', maintenanceMarginFraction: '0.03' }
};
const UNDER_MMR_SHORT = { market: 'BTC-USD', side: 'SHORT', size: '-0.01', status: 'OPEN' };
const UNDER_MMR_POSITIONS = [UNDER_MMR_SHORT, { market: 'ETH-USD', side: 'LONG', size: '1000', status: 'OPEN' }];

test('a SHORT on an account below maintenance margin at every price has no liq price, and its row says so', () => {
    assert.equal(RM.crossMarginLiqPrice(UNDER_MMR_SHORT, { equity: '50000' }, UNDER_MMR_MARKETS, UNDER_MMR_POSITIONS), null);
    const row = RM.liquidationRow(UNDER_MMR_SHORT, { equity: '50000' }, UNDER_MMR_MARKETS, UNDER_MMR_POSITIONS);
    assert.equal(row.liqState, RM.LIQUIDATION_STATE.BELOW_MAINTENANCE);
    assert.equal(row.liq, null);
    assert.equal(row.distancePct, null);
});

test('a LONG that no price above $0 can liquidate has no liq price and the full 100% of room', () => {
    const position = { market: 'BTC-USD', size: '0.001', side: 'LONG', status: 'OPEN' };
    const markets = { 'BTC-USD': { oraclePrice: '100000', maintenanceMarginFraction: '0.05' } };
    const row = RM.liquidationRow(position, { equity: '1000000' }, markets);
    assert.equal(row.liqState, RM.LIQUIDATION_STATE.NO_PRICE_LIQUIDATES);
    assert.equal(row.liq, null);
    assert.equal(row.distancePct, 100);
});

test('a liquidation price within reach reads AT_PRICE; missing inputs UNKNOWN', () => {
    const row = RM.liquidationRow(BTC_LONG_10, TWO_POSITION_SUB, TWO_POSITION_MARKETS, [BTC_LONG_10, ETH_SHORT_100]);
    assert.equal(row.liqState, RM.LIQUIDATION_STATE.AT_PRICE);
    const unpriced = RM.liquidationRow(BTC_LONG_10, TWO_POSITION_SUB, { 'BTC-USD': { oraclePrice: '80000' } });
    assert.equal(unpriced.liqState, RM.LIQUIDATION_STATE.UNKNOWN);
    assert.equal(unpriced.liq, null);
});

test('an unknown liquidation names what is missing: another open position\'s margin, or the row\'s own input', () => {
    const { LIQUIDATION_STATE: STATE, LIQUIDATION_INPUT: INPUT } = RM;
    const positions = [BTC_LONG_10, ETH_SHORT_100];
    const withEth = (eth) => ({ ...TWO_POSITION_MARKETS, 'ETH-USD': eth });

    // The BTC row's own inputs are all there; ETH's requirement is not.
    const noEthOracle = RM.liquidationRow(BTC_LONG_10, TWO_POSITION_SUB, withEth({ maintenanceMarginFraction: '0.05' }), positions);
    assert.equal(noEthOracle.liqState, STATE.OTHER_MARGIN_UNKNOWN);
    assert.deepEqual(noEthOracle.missing, [{ market: 'ETH-USD', input: INPUT.ORACLE }]);
    assert.equal(noEthOracle.liq, null);
    const noEthMmf = RM.liquidationRow(BTC_LONG_10, TWO_POSITION_SUB, withEth({ oraclePrice: '2000' }), positions);
    assert.equal(noEthMmf.liqState, STATE.OTHER_MARGIN_UNKNOWN);
    assert.deepEqual(noEthMmf.missing, [{ market: 'ETH-USD', input: INPUT.MMF }]);

    // The row's own inputs, the first missing one named.
    const own = (position, sub, markets) => {
        const row = RM.liquidationRow(position, sub, markets, positions);
        assert.equal(row.liqState, STATE.UNKNOWN);
        return row.missing;
    };
    assert.deepEqual(own(BTC_LONG_10, { equity: '0' }, TWO_POSITION_MARKETS), [{ market: null, input: INPUT.EQUITY }]);
    assert.deepEqual(own({ ...BTC_LONG_10, size: '0' }, TWO_POSITION_SUB, TWO_POSITION_MARKETS), [{ market: null, input: INPUT.SIZE }]);
    assert.deepEqual(own(BTC_LONG_10, TWO_POSITION_SUB, { 'ETH-USD': TWO_POSITION_MARKETS['ETH-USD'] }), [{ market: 'BTC-USD', input: INPUT.ORACLE }]);
    assert.deepEqual(own(BTC_LONG_10, TWO_POSITION_SUB, { ...TWO_POSITION_MARKETS, 'BTC-USD': { oraclePrice: '80000' } }), [{ market: 'BTC-USD', input: INPUT.MMF }]);
    assert.deepEqual(own({ ...BTC_LONG_10, side: '' }, TWO_POSITION_SUB, TWO_POSITION_MARKETS), [{ market: null, input: INPUT.SIDE }]);

    // A known liquidation misses nothing.
    assert.deepEqual(RM.liquidationRow(BTC_LONG_10, TWO_POSITION_SUB, TWO_POSITION_MARKETS, positions).missing, []);
});

test('another open position whose size is absent or not wholly numeric leaves the liquidation unknown, never $0 of margin', () => {
    const { LIQUIDATION_STATE: STATE, LIQUIDATION_INPUT: INPUT } = RM;
    const markets = {
        'BTC-USD': { oraclePrice: '60000', maintenanceMarginFraction: '0.03' },
        'ETH-USD': { oraclePrice: '3000', maintenanceMarginFraction: '0.05' }
    };
    const sub = { equity: '30000' };
    const btc = { market: 'BTC-USD', side: 'LONG', size: '2', status: 'OPEN' };
    const ethOfSize = (size) => ({ market: 'ETH-USD', side: 'SHORT', size, status: 'OPEN' });

    for (const size of ['', undefined, '5abc']) {
        const row = RM.liquidationRow(btc, sub, markets, [btc, ethOfSize(size)]);
        assert.equal(row.liqState, STATE.OTHER_MARGIN_UNKNOWN, `ETH size ${JSON.stringify(size)}`);
        assert.deepEqual(row.missing, [{ market: 'ETH-USD', input: INPUT.SIZE }]);
        assert.equal(row.liq, null);
    }

    // A reported '0' is a known zero: no margin, the BTC row priced alone.
    const flatEth = RM.liquidationRow(btc, sub, markets, [btc, ethOfSize('0')]);
    const alone = RM.liquidationRow(btc, sub, markets, [btc]);
    assert.equal(flatEth.liqState, STATE.AT_PRICE);
    assert.equal(flatEth.liq, alone.liq);
});

test('liquidationRow passes the open positions through to the liq price', () => {
    const row = RM.liquidationRow(BTC_LONG_10, TWO_POSITION_SUB, TWO_POSITION_MARKETS, [BTC_LONG_10, ETH_SHORT_100]);
    assert.ok(close(row.liq, 51619.43), `expected ~51619.43, got ${row.liq}`);
});

test('liquidationRow distancePct is negative once the oracle is past the liq price (LONG and SHORT)', () => {
    // Equity 5000 is below the 10·80000·0.012 = 9600 requirement: already
    // liquidatable on either side.
    const sub = { equity: '5000' };
    const markets = { 'BTC-USD': TWO_POSITION_MARKETS['BTC-USD'] };
    const long = RM.liquidationRow({ market: 'BTC-USD', side: 'LONG', size: '10' }, sub, markets);
    const short = RM.liquidationRow({ market: 'BTC-USD', side: 'SHORT', size: '-10' }, sub, markets);
    // LONG liq (800000 − 5000)/9.88 = 80465.59 sits above the 80000 oracle.
    assert.ok(close(long.distancePct, -0.582, 1e-3), `expected ~-0.582%, got ${long.distancePct}`);
    // SHORT liq (5000 + 800000)/10.12 = 79545.45 sits below it.
    assert.ok(close(short.distancePct, -0.568, 1e-3), `expected ~-0.568%, got ${short.distancePct}`);
});

test('liquidationRow distancePct is positive for a SHORT whose liq price is above the oracle', () => {
    const row = RM.liquidationRow({ market: 'ETH-USD', side: 'SHORT', size: '-1' }, { equity: '20' },
        { 'ETH-USD': { oraclePrice: '100', maintenanceMarginFraction: '0.05' } });
    // liq 114.286 → (114.286 − 100) / 100 = +14.29%
    assert.ok(close(row.distancePct, 14.286, 1e-2), `expected ~14.29%, got ${row.distancePct}`);
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

// The card is labelled mark-price based; an entry-priced leverage under
// that label is a wrong number, so without an oracle there is none.
test('leverageUtilization is null when an open position has no oracle price, even beside a priced one', () => {
    const unpriced = { market: 'SOL-USD', side: 'LONG', size: '10', status: 'OPEN', entryPrice: '100' };
    const priced = { market: 'BTC-USD', side: 'LONG', size: '1', status: 'OPEN', oraclePrice: '50000' };
    const sub = { equity: '50000' };
    assert.equal(RM.leverageUtilization([unpriced], sub, {}), null, 'entry price is not a fallback');
    assert.equal(RM.leverageUtilization([priced, unpriced], sub, {}), null,
        'a sum over the priced positions alone would understate leverage');
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
    assert.equal(RM.usableEquity({ equity: '5abc' }), null, 'a partly numeric equity is unparseable, not $5');
    assert.equal(RM.usableEquity({}), null);
    assert.equal(RM.usableEquity(null), null);
});

test('decimalNumberOf reads only a wholly numeric value; a partly numeric one is unknown, never its leading digits', () => {
    assert.equal(RM.decimalNumberOf('60000'), 60000);
    assert.equal(RM.decimalNumberOf('-0.0000125'), -0.0000125);
    assert.equal(RM.decimalNumberOf('4e-10'), 4e-10);
    assert.equal(RM.decimalNumberOf('0'), 0, 'a reported zero is a known zero');
    assert.equal(RM.decimalNumberOf(0.5), 0.5);
    assert.equal(RM.decimalNumberOf('60000abc'), null);
    assert.equal(RM.decimalNumberOf('0.0000125xyz'), null);
    assert.equal(RM.decimalNumberOf('1x'), null);
    assert.equal(RM.decimalNumberOf('abc'), null);
    assert.equal(RM.decimalNumberOf(''), null, 'blank is unknown, never 0');
    assert.equal(RM.decimalNumberOf('Infinity'), null);
    assert.equal(RM.decimalNumberOf(NaN), null);
    assert.equal(RM.decimalNumberOf(undefined), null);
    assert.equal(RM.decimalNumberOf(null), null);
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
    assert.equal(RM.positionNotional({ market: 'ETH-USD', size: '3', entryPrice: '2000' }, markets), null,
        'entry price is not a fallback when no oracle exists');
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

test('attributeFillsToPositions: entryVwap is the exact decimal VWAP, not the float sum of many fills', () => {
    // 27 × 1.1 × 42424.42425 summed in binary floating point gives
    // 42424.424249999945, below the 4-decimal tie that 15 significant
    // digits can see; the exact VWAP is the fill price itself.
    const REPEATED_FILLS = 27;
    const p = { market: 'BTC-USD', status: 'CLOSED', side: 'LONG', createdAt: T1, closedAt: T2 };
    const fills = Array.from({ length: REPEATED_FILLS },
        (_, i) => mkFill('BTC-USD', T1, i + 1, 'BUY', '1.1', '42424.42425', 0));
    fills.push(mkFill('BTC-USD', T2, REPEATED_FILLS + 1, 'SELL', '29.7', '42500', 0));
    const a = RM.attributeFillsToPositions([p], fills).get(p);
    assert.equal(a.complete, true);
    assert.equal(a.entryVwap, 42424.42425);
    assert.equal(a.exitVwap, 42500);
});

test('attributeFillsToPositions: a reversal splits its fill into exact portion sizes for both VWAPs', () => {
    // The float walk holds 1000.1 + 0.2 = 1000.3000000000001, so the SELL
    // 1000.4 closes that and opens 0.09999999999990905; the decimal
    // portions are 1000.3 and 0.1. The SHORT's entry VWAP averages that
    // opening portion with a second SELL: (0.1 × 110.3 + 0.1 × 100) ÷ 0.2
    // = 105.15 exactly, where the float portion would read
    // 105.149999999998 at 15 significant digits.
    const T3_NOON = '2025-01-03T12:00:00.000Z';
    const long  = { market: 'ETH-USD', status: 'CLOSED', side: 'LONG',  createdAt: T1, closedAt: T3 };
    const short = { market: 'ETH-USD', status: 'CLOSED', side: 'SHORT', createdAt: T3, closedAt: T4 };
    const fills = [
        mkFill('ETH-USD', T1, 1, 'BUY',  '1000.1', '100',   0),
        mkFill('ETH-USD', T1, 2, 'BUY',  '0.2',    '100',   0),
        mkFill('ETH-USD', T3, 3, 'SELL', '1000.4', '110.3', 0),   // closes 1000.3 LONG, opens 0.1 SHORT
        mkFill('ETH-USD', T3_NOON, 4, 'SELL', '0.1', '100', 0),
        mkFill('ETH-USD', T4, 5, 'BUY',  '0.2',    '105',   0)
    ];
    const byPosition = RM.attributeFillsToPositions([long, short], fills);
    const L = byPosition.get(long);
    const S = byPosition.get(short);
    assert.equal(L.complete && S.complete, true);
    assert.deepEqual([L.entryVwap, L.exitVwap], [100, 110.3]);
    assert.deepEqual([S.entryVwap, S.exitVwap], [105.15, 105]);
});

test('attributeFillsToPositions: a VWAP between 15-digit steps rounds its last digit half up from the exact quotient', () => {
    // (1 × 1 + 2 × 0.5) ÷ 3 = 0.6666…: 15 significant digits read
    // 0.666666666666667, never the truncated 0.666666666666666.
    const p = { market: 'BTC-USD', status: 'CLOSED', side: 'LONG', createdAt: T1, closedAt: T2 };
    const fills = [
        mkFill('BTC-USD', T1, 1, 'BUY',  '1', '1',   0),
        mkFill('BTC-USD', T1, 2, 'BUY',  '2', '0.5', 0),
        mkFill('BTC-USD', T2, 3, 'SELL', '3', '1',   0)
    ];
    const a = RM.attributeFillsToPositions([p], fills).get(p);
    assert.equal(a.complete, true);
    assert.equal(a.entryVwap, 0.666666666666667);
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

// One closed ETH-USD position of `side` over the given fills, attributed.
function attributedTrade(side, fills) {
    const position = { market: 'ETH-USD', status: 'CLOSED', side, createdAt: T1, closedAt: T3 };
    return RM.attributeFillsToPositions([position], fills).get(position);
}

test('attributeFillsToPositions sums realized, fees and profit exactly, so a decimal-zero trade is a scratch', () => {
    // Fee equals the gain: +0.30 realized, 0.10 + 0.20 fees.
    const feeOffset = attributedTrade('LONG', [
        mkFill('ETH-USD', T1, 1, 'BUY',  1, 100,   0.1),
        mkFill('ETH-USD', T3, 2, 'SELL', 1, 100.3, 0.2)
    ]);
    // Scaled in at two prices, out at their average, no fees.
    const averagedOut = attributedTrade('LONG', [
        mkFill('ETH-USD', T1, 1, 'BUY',  1, 100.1,  0),
        mkFill('ETH-USD', T2, 2, 'BUY',  1, 100.2,  0),
        mkFill('ETH-USD', T3, 3, 'SELL', 2, 100.15, 0)
    ]);
    const threeLots = attributedTrade('LONG', [
        mkFill('ETH-USD', T1, 1, 'BUY',  3, 100.1, 0.1),
        mkFill('ETH-USD', T3, 2, 'SELL', 3, 100.2, 0.2)
    ]);
    const shortMirror = attributedTrade('SHORT', [
        mkFill('ETH-USD', T1, 1, 'SELL', 3, 100.2, 0.1),
        mkFill('ETH-USD', T3, 2, 'BUY',  3, 100.1, 0.2)
    ]);
    [feeOffset, averagedOut, threeLots, shortMirror].forEach((a, i) => {
        assert.ok(a.profit === 0, `case ${i}: profit ${a.profit}`);
        assert.equal(a.realized, a.fees, `case ${i}`);
    });
    assert.equal(feeOffset.realized, 0.3);
    assert.equal(feeOffset.fees, 0.3);
    const cls = RM.classifyClosed([feeOffset, averagedOut, threeLots, shortMirror]
        .map(a => ({ ...a, status: 'CLOSED' })));
    assert.deepEqual([cls.winCount, cls.lossCount, cls.scratchCount, cls.winRate], [0, 0, 4, null]);
});

test('attributeFillsToPositions: a half-dollar profit is the exact decimal, so it rounds half away from zero', () => {
    const a = attributedTrade('LONG', [
        mkFill('ETH-USD', T1, 1, 'BUY',  1, 100,   0.2),
        mkFill('ETH-USD', T3, 2, 'SELL', 1, 109.8, 0.1)
    ]);
    assert.equal(a.realized, 9.8);
    assert.equal(a.fees, 0.3);
    assert.equal(a.profit, 9.5);
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

test('attributeFillsToPositions: a fill without a fee leaves the positions holding it incomplete, its fees unknown, its size and prices intact', () => {
    const CAUSE = RM.INCOMPLETE_CAUSE;
    const long = { market: 'BTC-USD', status: 'CLOSED', side: 'LONG', createdAt: T1, closedAt: T2 };
    const later = { market: 'BTC-USD', status: 'CLOSED', side: 'LONG', createdAt: T3, closedAt: T4 };
    for (const fee of [undefined, '', 'abc', '12abc']) {
        const fills = [
            { ...mkFill('BTC-USD', T1, 1, 'BUY', 1, 100, 0), fee },
            mkFill('BTC-USD', T2, 2, 'SELL', 1, 110, 0.5),
            mkFill('BTC-USD', T3, 3, 'BUY', 1, 100, 0.25),
            mkFill('BTC-USD', T4, 4, 'SELL', 1, 120, 0.25)
        ];
        const byPosition = RM.attributeFillsToPositions([long, later], fills);
        const a = byPosition.get(long);
        assert.equal(a.complete, false, JSON.stringify(fee));
        assert.equal(a.incompleteCause, CAUSE.UNKNOWN_FEE);
        assert.equal(a.fees, null);
        assert.equal(a.profit, null);
        assert.equal(a.portions[0].fee, null, 'the portion of the fee-less fill');
        assert.deepEqual([a.realized, a.peakSize, a.entryVwap, a.exitVwap], [10, 1, 100, 110]);
        const b = byPosition.get(later);
        assert.equal(b.complete, true, 'the net size stays right, so the later trade is untouched');
        assert.deepEqual([b.realized, b.fees, b.profit], [20, 0.5, 19.5]);
    }
});

test('incompleteCause precedence: the open-size mismatch outranks an unknown fee', () => {
    const { causeOf } = precedence;
    const CAUSE = RM.INCOMPLETE_CAUSE;
    const open = { market: 'BTC-USD', status: 'OPEN', side: 'LONG', size: '2', createdAt: T1, closedAt: null };
    const feeless = [{ ...mkFill('BTC-USD', T1, 1, 'BUY', 2, 100, 0), fee: undefined }];
    assert.equal(causeOf([open], feeless, open), CAUSE.UNKNOWN_FEE);
    const larger = { ...open, size: '3' };
    assert.equal(causeOf([larger], feeless, larger), CAUSE.OPEN_SIZE_MISMATCH);
});

test('incompleteCause precedence: not being flat at close outranks an unknown fee', () => {
    // A CLOSED position never meets the open-size case, so this is the
    // pair next to it in its order.
    const { causeOf, closedLong, roundTrip } = precedence;
    const CAUSE = RM.INCOMPLETE_CAUSE;
    const feeless = [{ ...roundTrip[0], fee: '' }, roundTrip[1]];
    assert.equal(causeOf([closedLong], feeless, closedLong), CAUSE.UNKNOWN_FEE);
    const closedEarly = { ...closedLong, closedAt: T1 };
    assert.equal(causeOf([closedEarly], feeless, closedEarly), CAUSE.NOT_FLAT_AT_CLOSE);
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
        { createdAt: '2025-01-02T00:00:00Z', totalPnl: '-100', equity: '900', netTransfers: '0' },
        { createdAt: '2025-01-01T00:00:00Z', totalPnl: '0',    equity: '1000', netTransfers: '0' }
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

test('payoffEmptyBucketReason names no bucket while the payoff is defined', () => {
    const c = RM.classifyClosed([
        { status: 'CLOSED', profit: 300, complete: true },
        { status: 'CLOSED', profit: -100, complete: true }
    ]);
    assert.equal(c.payoff, 3);
    assert.equal(RM.payoffEmptyBucketReason(c), '');
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

test('classifyClosed sums profits exactly and takes each mean as the exact quotient, so a decimal tie stays a tie', () => {
    const closedWith = profits => profits.map(profit => ({ status: 'CLOSED', profit, complete: true }));
    // Exact sum 5.00 over ten trades; float addition leaves 4.99999999998545.
    const ten = RM.classifyClosed(closedWith(
        [27904.4, 10028.3, 23100.4, 28703.1, 20756.1, 14916.9, -42013.4, -30039.7, -17663.4, -35687.7]));
    assert.equal(ten.totalProfit, 5);
    assert.equal(ten.grossWin, 125409.2);
    assert.equal(ten.grossLoss, 125404.2);
    assert.equal(ten.expectancy, 0.5);
    // Nineteen wins summing exactly to 175341.5: a mean of exactly 9228.5.
    const nineteen = RM.classifyClosed(closedWith([4944.465945, 17218.083112, 12540.0395, 33.972375, 11702.436775,
        8859.716455, 10188.269984, 10890.73597, 4920.29401, 11853.752973, 15861.757724, 11153.349634, 17775.272937,
        1253.918992, 8595.695135, 13225.937074, 8199.33873, 547.462436, 5577.000239]));
    assert.equal(nineteen.avgWin, 9228.5);
    assert.equal(nineteen.expectancy, 9228.5);
    // $0.04 lost over three trades: the mean is the exact quotient at 15
    // significant digits.
    const thirds = RM.classifyClosed(closedWith([-0.01, -0.01, -0.02, 0.03]));
    assert.equal(thirds.avgLoss, 0.0133333333333333);
    assert.equal(thirds.expectancy, -0.0025);
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
        { status: 'OPEN',   netFunding: '0'     }, // a reported zero is known
    ];
    assert.ok(close(RM.netFundingTotal(positions), 11.75));
    assert.equal(RM.netFundingGap(positions), '');
});

test('a missing or unparseable netFunding makes the funding total unknown, never a $0 contribution', () => {
    for (const unknown of [undefined, null, '', ' ', 'NaN', '12abc']) {
        const positions = [{ status: 'CLOSED', netFunding: '12.5' }, { status: 'OPEN', netFunding: unknown }];
        assert.equal(RM.positionNetFunding(positions[1]), null, `netFunding ${JSON.stringify(unknown)}`);
        assert.equal(RM.netFundingTotal(positions), null, `netFunding ${JSON.stringify(unknown)}`);
        assert.equal(RM.netFundingGap(positions), 'No netFunding reported for 1 position');
    }
    const twoMissing = [{ status: 'CLOSED' }, { status: 'CLOSED', netFunding: 'n/a' }];
    assert.equal(RM.netFundingGap(twoMissing), 'No netFunding reported for 2 positions');
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

test('marketPnL: a position without netFunding makes its market\'s funding and total unknown, not other markets\'', () => {
    const positions = [
        { market: 'SOL-USD', status: 'CLOSED', realizedPnl: '10', netFunding: '-1' },
        { market: 'SOL-USD', status: 'OPEN',   unrealizedPnl: '5' },
        { market: 'ETH-USD', status: 'CLOSED', realizedPnl: '20', netFunding: '2' },
    ];
    const m = RM.marketPnL(positions);
    assert.equal(m['SOL-USD'].netFunding, null);
    assert.equal(m['SOL-USD'].total, null);
    assert.ok(close(m['SOL-USD'].realizedClosed, 10), 'the known components stay');
    assert.ok(close(m['ETH-USD'].netFunding, 2));
    assert.ok(close(m['ETH-USD'].total, 22));
});

// profitLedger: marketPnL's slots at cents, summed to the account ledger.
const ledgerSlot = (realized, funding, fees) => ({
    realizedClosed: realized, unrealizedOpen: 0, netFunding: funding, fees,
    total: funding === null ? null : realized + funding - fees, closedCount: 1, openCount: 0
});

test('profitLedger: each market rounds to cents first, so its rows add up to the account totals exactly', () => {
    // Raw sums would round to trading 30.01, funding 0.01, fees 1.00.
    const slot = ledgerSlot(10.004, 0.004, 0.3349);
    const ledger = RM.profitLedger({ 'A-USD': slot, 'B-USD': slot, 'C-USD': slot });
    assert.deepEqual(
        [ledger.byMarket['A-USD'].trading, ledger.byMarket['A-USD'].netFunding, ledger.byMarket['A-USD'].fees, ledger.byMarket['A-USD'].total],
        [10, 0, 0.33, 9.67]);
    assert.deepEqual([ledger.trading, ledger.funding, ledger.fees, ledger.total], [30, 0, 0.99, 29.01]);
    assert.equal(ledger.byMarket['A-USD'].closedCount, 1, 'the slot\'s counts are kept');
});

// ---------------------------------------------------------------------------
// wholeCents + exactSum: amounts are summed as the exact decimals they
// stand for and rounded to cents once, half away from zero.
// ---------------------------------------------------------------------------

test('wholeCents rounds a half-cent tie away from zero on both signs', () => {
    assert.equal(RM.wholeCents(0.125), 13);
    assert.equal(RM.wholeCents(-0.125), -13);
    assert.equal(RM.wholeCents(0.015), 2);
    assert.equal(RM.wholeCents(-0.015), -2);
    assert.equal(RM.wholeCents(0.0049), 0);
    assert.equal(RM.wholeCents(-0.0049), 0);
    assert.ok(Object.is(RM.wholeCents(-0.0049), 0), 'a loss that rounds to zero is 0, never -0');
});

test('wholeCents rounds the decimal amount, not the binary float just below its tie', () => {
    // 1.005 * 100 is 100.49999999999999 in binary floats.
    assert.equal(RM.wholeCents(1.005), 101);
    assert.equal(RM.wholeCents(-1.005), -101);
    assert.equal(RM.wholeCents('1234.565'), 123457);
    // A FIFO amount whose price difference cancels (64000.13 − 64000.1)
    // carries more noise than the 15-digit floor drops; computeRealizedFromFills
    // sums it exactly before it reaches wholeCents (below).
});

test('wholeCents rounds a computed amount once at cents from its 15-significant-digit decimal, never through the micro', () => {
    // 0.00499999996 is under half a cent; at the micro it would be 0.005000.
    assert.equal(RM.wholeCents(0.004999999960000001), 0);
    assert.equal(RM.wholeCents(-0.004999999960000001), 0);
    assert.equal(RM.wholeCents('0.0049999996'), 0, 'decimal text rounds once from its own digits');
});

test('profitLedger: FIFO unrealized just under a half cent reads $0.00, rounded once', () => {
    // BUY 0.0001 @ 100.00004 marked at 150.0000396: exactly 0.00499999996.
    const fills = [mkFill('BTC-USD', T1, 1, 'BUY', '0.0001', '100.00004', '0')];
    const unrealized = RM.computeUnrealizedFromFills(fills, { 'BTC-USD': { oraclePrice: '150.0000396' } });
    const ledger = RM.profitLedger(RM.marketPnL([], { 'BTC-USD': 0 }, {}, unrealized.byMarket));
    assert.deepEqual([ledger.byMarket['BTC-USD'].trading, ledger.trading, ledger.total], [0, 0, 0]);
});

test('profitLedger: FIFO realized of an exact half cent rounds away from zero, as the decimal', () => {
    // (64000.13 − 64000.1) × 0.5 is 0.014999999999417923 and
    // (1.2 − 1.1) × 0.05 is 0.004999999999999994 in binary floats.
    const fills = [
        mkFill('BTC-USD', T1, 1, 'BUY', '0.5', '64000.1', '0'),
        mkFill('BTC-USD', T2, 2, 'SELL', '0.5', '64000.13', '0'),
        mkFill('ETH-USD', T1, 3, 'BUY', '0.05', '1.1', '0'),
        mkFill('ETH-USD', T2, 4, 'SELL', '0.05', '1.2', '0'),
    ];
    const realized = RM.computeRealizedFromFills(fills);
    assert.deepEqual([realized.byMarket['BTC-USD'], realized.byMarket['ETH-USD'], realized.total], [0.015, 0.005, 0.02]);
    const ledger = RM.profitLedger(RM.marketPnL([], { 'BTC-USD': 0, 'ETH-USD': 0 }, realized.byMarket, {}));
    assert.deepEqual([ledger.byMarket['BTC-USD'].trading, ledger.byMarket['ETH-USD'].trading, ledger.total], [0.02, 0.01, 0.03]);
});

test('FIFO realized just under a half cent is the exact decimal and reads $0.00, rounded once', () => {
    // (150.0000396 − 100.00004) × 0.0001 is exactly 0.00499999996; taken
    // at the micro first it would be 0.005000 and read $0.01.
    const fills = [
        mkFill('BTC-USD', T1, 1, 'BUY', '0.0001', '100.00004', '0'),
        mkFill('BTC-USD', T2, 2, 'SELL', '0.0001', '150.0000396', '0'),
    ];
    const realized = RM.computeRealizedFromFills(fills);
    assert.deepEqual([realized.byMarket['BTC-USD'], realized.total], [0.00499999996, 0.00499999996]);
    const ledger = RM.profitLedger(RM.marketPnL([], { 'BTC-USD': 0 }, realized.byMarket, {}));
    assert.deepEqual([ledger.byMarket['BTC-USD'].trading, ledger.trading, ledger.total], [0, 0, 0]);
    const position = { market: 'BTC-USD', status: 'CLOSED', side: 'LONG', createdAt: T1, closedAt: T2 };
    const a = RM.attributeFillsToPositions([position], fills).get(position);
    assert.deepEqual([a.complete, a.realized, a.profit], [true, 0.00499999996, 0.00499999996]);
    assert.equal(RM.wholeCents(a.profit), 0);
});

test('a reversing fill\'s fee share below the micro is kept, so the closed position\'s fees round once at cents', () => {
    // SELL 3 with fee 0.014999 closes a LONG 1 and opens a SHORT 2: the
    // LONG's share is 0.014999 / 3 = 0.004999666…, $0.00; taken to the
    // micro first it would be 0.005000 and read $0.01.
    const fills = [
        mkFill('BTC-USD', T1, 1, 'BUY', '1', '100', '0'),
        mkFill('BTC-USD', T2, 2, 'SELL', '3', '100', '0.014999'),
    ];
    const long = { market: 'BTC-USD', status: 'CLOSED', side: 'LONG', createdAt: T1, closedAt: T2 };
    const short = { market: 'BTC-USD', status: 'OPEN', side: 'SHORT', size: '-2', createdAt: T2 };
    const a = RM.attributeFillsToPositions([long, short], fills);
    assert.equal(a.get(long).complete, true);
    assert.equal(RM.wholeCents(a.get(long).fees), 0);
    assert.equal(RM.wholeCents(a.get(short).fees), 1);
});

test('a reversing fill\'s fee share is the exact quotient fee × portion size ÷ fill size', () => {
    // SELL 2.9 with fee 0.123457 closes a LONG 0.2 and opens a SHORT 2.7.
    // The LONG's share is exactly 0.0085142758620689655…, which reads
    // 0.00851427586206897 at 15 significant digits; the float product
    // 0.123457 × (0.2 / 2.9) reads 0.00851427586206896.
    const fills = [
        mkFill('BTC-USD', T1, 1, 'BUY', '0.2', '100', '0'),
        mkFill('BTC-USD', T2, 2, 'SELL', '2.9', '100', '0.123457'),
    ];
    const long = { market: 'BTC-USD', status: 'CLOSED', side: 'LONG', createdAt: T1, closedAt: T2 };
    const short = { market: 'BTC-USD', status: 'OPEN', side: 'SHORT', size: '-2.7', createdAt: T2 };
    const a = RM.attributeFillsToPositions([long, short], fills);
    const reversingShare = position => a.get(position).portions.find(part => part.fill === fills[1]).fee;
    assert.equal(reversingShare(long), 0.00851427586206897);
    assert.equal(reversingShare(short), 0.114942724137931);
    assert.equal(a.get(long).fees, 0.00851427586206897);
});

test('a position\'s fees are the exact sum of its exact fee shares, not of their 15-digit Numbers', () => {
    // SELL 6 with fee 0.013 closes a LONG 1 and opens a SHORT 5 (share
    // 0.0108333…); BUY 6 with fee -0.007 closes the SHORT and opens a LONG 1
    // (share -0.0058333…). The SHORT's fees are exactly 0.005, a half-cent
    // tie; the sum of the shares at 15 significant digits is
    // 0.00499999999999997, which would read $0.00.
    const fills = [
        mkFill('BTC-USD', T1, 1, 'BUY', '1', '100', '0'),
        mkFill('BTC-USD', T2, 2, 'SELL', '6', '100', '0.013'),
        mkFill('BTC-USD', T3, 3, 'BUY', '6', '100', '-0.007'),
        mkFill('BTC-USD', T4, 4, 'SELL', '1', '100', '0'),
    ];
    const firstLong = { market: 'BTC-USD', status: 'CLOSED', side: 'LONG', createdAt: T1, closedAt: T2 };
    const short = { market: 'BTC-USD', status: 'CLOSED', side: 'SHORT', createdAt: T2, closedAt: T3 };
    const lastLong = { market: 'BTC-USD', status: 'CLOSED', side: 'LONG', createdAt: T3, closedAt: T4 };
    const a = RM.attributeFillsToPositions([firstLong, short, lastLong], fills).get(short);
    assert.equal(a.complete, true);
    assert.deepEqual([a.fees, a.profit], [0.005, -0.005]);
    assert.equal(RM.portionFeesTotal(a.portions), 0.005);
    assert.equal(RM.wholeCents(a.fees), 1);
});

test('FIFO unrealized whose oracle nearly cancels the lot price is the exact decimal, rounded once', () => {
    // (64000.13 − 64000.1) × 0.5 is exactly 0.015, a half-cent tie; the
    // binary product is 0.014999999999417923, which would read $0.01.
    const fills = [mkFill('BTC-USD', T1, 1, 'BUY', '0.5', '64000.1', '0')];
    const unrealized = RM.computeUnrealizedFromFills(fills, { 'BTC-USD': { oraclePrice: '64000.13' } });
    assert.deepEqual([unrealized.byMarket['BTC-USD'], unrealized.total], [0.015, 0.015]);
    const ledger = RM.profitLedger(RM.marketPnL([], { 'BTC-USD': 0 }, {}, unrealized.byMarket));
    assert.deepEqual([ledger.byMarket['BTC-USD'].trading, ledger.total], [0.02, 0.02]);
});

test('profitLedger: realized and unrealized add exactly before their one rounding', () => {
    // 1000.01 + (−1000.005) is 0.004999999999995453 in binary floats.
    const ledger = RM.profitLedger({ 'A-USD': { ...ledgerSlot(1000.01, 0, 0), unrealizedOpen: -1000.005 } });
    assert.equal(ledger.trading, 0.01);
});

test('exactSum adds the exact decimals the amounts stand for, so the sum carries no float drift', () => {
    assert.equal(RM.exactSum(['0.1', '0.2']), 0.3);
    assert.equal(RM.exactSum(['0.013', '0.017', '0.975']), 1.005);
    assert.equal(RM.wholeCents(RM.exactSum(['0.013', '0.017', '0.975'])), 101);
    assert.equal(RM.exactSum([0.1, 0.2, '-0.000001']), 0.299999);
    assert.equal(RM.exactSum([0.00499999996, '-0.000000001']), 0.00499999896, 'an amount below the micro is kept, never snapped to it');
    assert.equal(RM.exactSum([]), 0);
    assert.equal(RM.exactSum(['1', 'n/a']), null, 'an amount that does not parse makes the sum unknown');
});

test('profitLedger: a funding net that is an exact half-cent tie rounds away from zero, as the decimal amount', () => {
    const positions = [
        { market: 'BTC-USD', status: 'CLOSED', realizedPnl: '0', netFunding: '0.013' },
        { market: 'BTC-USD', status: 'CLOSED', realizedPnl: '0', netFunding: '0.017' },
        { market: 'BTC-USD', status: 'CLOSED', realizedPnl: '0', netFunding: '0.975' },
        { market: 'ETH-USD', status: 'CLOSED', realizedPnl: '0', netFunding: '-0.125' },
    ];
    const ledger = RM.profitLedger(RM.marketPnL(positions));
    assert.equal(ledger.byMarket['BTC-USD'].netFunding, 1.01);
    assert.equal(ledger.byMarket['ETH-USD'].netFunding, -0.13);
    assert.equal(ledger.funding, 0.88);
});

test('marketFees and feesTotal sum fill fees exactly', () => {
    const fills = [{ market: 'BTC-USD', fee: '0.1' }, { market: 'BTC-USD', fee: '0.2' }];
    assert.equal(RM.marketFees(fills)['BTC-USD'], 0.3);
    assert.equal(RM.feesTotal(fills), 0.3);
});

test('profitLedger: a market with unknown funding leaves its own and the account\'s funding and total unknown', () => {
    const ledger = RM.profitLedger({ 'A-USD': ledgerSlot(5, null, 1), 'B-USD': ledgerSlot(7, 2, 1) });
    assert.equal(ledger.byMarket['A-USD'].netFunding, null);
    assert.equal(ledger.byMarket['A-USD'].total, null);
    assert.equal(ledger.byMarket['B-USD'].total, 8);
    assert.equal(ledger.funding, null);
    assert.equal(ledger.total, null);
    assert.deepEqual([ledger.trading, ledger.fees], [12, 2]);
});

// ---------------------------------------------------------------------------
// feesTotal + marketFees + marketPnL feesMap fold-in. dYdX `fill.fee` is
// positive when the user paid (taker / most maker), negative for maker
// rebates. The headline subtracts the sum so rebates ADD to profit.
// ---------------------------------------------------------------------------

test('feesTotal: positive fees paid, negative rebates received, null entries skipped', () => {
    const fills = [
        { fee: '0.50' },   // taker fee paid
        { fee: '1.25' },   // another paid fee
        { fee: '-0.10' },  // maker rebate
        null               // no fill
    ];
    assert.ok(close(RM.feesTotal(fills), 1.65));
});

test('feesTotal and feeGap: a fill whose fee is absent, blank or not wholly numeric leaves the total unknown, never $0', () => {
    // The rule changed: an unparseable fee used to add nothing.
    const known = [{ fee: '0.50' }, { fee: '-0.10' }];
    assert.equal(RM.feeGap(known), '');
    for (const fee of [undefined, null, '', '  ', 'NaN', '12abc']) {
        const fills = [...known, { fee }];
        assert.equal(RM.feesTotal(fills), null, JSON.stringify(fee));
        assert.equal(RM.feeGap(fills), '1 fill without a fee', JSON.stringify(fee));
    }
    assert.equal(RM.feeGap([{ fee: 'x' }, {}, { fee: '0' }]), '2 fills without a fee');
    assert.equal(RM.feesTotal([{ fee: '0' }]), 0, "a reported '0' is a known zero");
});

test('feesTotal: empty / null input → 0', () => {
    assert.equal(RM.feesTotal([]), 0);
    assert.equal(RM.feesTotal(null), 0);
});

test('marketFees: bucket by fill.market, an unparseable fee leaves only its market unknown, missing market → "Unknown"', () => {
    // The rule changed: SOL-USD's unparseable fee used to be dropped,
    // reading as a market without fees.
    const fills = [
        { market: 'ETH-USD', fee: '1'    },
        { market: 'ETH-USD', fee: '2'    },
        { market: 'BTC-USD', fee: '0.5'  },
        { market: 'BTC-USD', fee: '-0.2' }, // rebate
        {                    fee: '0.05' }, // missing market → 'Unknown'
        { market: 'SOL-USD', fee: '0.4'  },
        { market: 'SOL-USD', fee: 'NaN'  }, // unparseable → SOL-USD unknown
    ];
    const m = RM.marketFees(fills);
    assert.ok(close(m['ETH-USD'], 3));
    assert.ok(close(m['BTC-USD'], 0.3));
    assert.ok(close(m['Unknown'], 0.05));
    assert.equal(m['SOL-USD'], null);
});

test('marketPnL and profitLedger: a market whose fees are unknown leaves its own and the account\'s fees and total unknown', () => {
    const positions = [
        { market: 'ETH-USD', status: 'CLOSED', realizedPnl: '100', netFunding: '5' },
        { market: 'SOL-USD', status: 'CLOSED', realizedPnl: '50',  netFunding: '1' },
    ];
    const ledger = RM.profitLedger(RM.marketPnL(positions, { 'ETH-USD': 2, 'SOL-USD': null }));
    assert.equal(ledger.byMarket['ETH-USD'].fees, 2);
    assert.equal(ledger.byMarket['ETH-USD'].total, 103);
    assert.equal(ledger.byMarket['SOL-USD'].fees, null);
    assert.equal(ledger.byMarket['SOL-USD'].total, null);
    assert.equal(ledger.fees, null);
    assert.equal(ledger.total, null);
    assert.deepEqual([ledger.trading, ledger.funding], [150, 6]);
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

// /addresses/{address} returns assetPositions as a map keyed by symbol
// ({} when empty), never an array.
test('activeChildSubaccounts flags child with asset positions', () => {
    const subs = [
        { subaccountNumber: 256, equity: '0', assetPositions: { USDC: { symbol: 'USDC', size: '5', side: 'LONG' } } }
    ];
    assert.equal(RM.activeChildSubaccounts(subs).length, 1);
});

test('activeChildSubaccounts flags a child whose equity is absent or unparseable: unknown, not $0', () => {
    const subs = [
        { subaccountNumber: 128 },
        { subaccountNumber: 256, equity: 'n/a', openPerpetualPositions: {}, assetPositions: {} },
        { subaccountNumber: 384, equity: '0' }
    ];
    assert.deepEqual(RM.activeChildSubaccounts(subs).map(s => s.subaccountNumber), [128, 256]);
});

test('activeChildSubaccounts skips zero-everywhere children', () => {
    const subs = [
        { subaccountNumber: 0,   equity: '0' },
        { subaccountNumber: 128, equity: '0', openPerpetualPositions: {}, assetPositions: {} },
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
        { market: 'BTC-USD', status: 'OPEN', unrealizedPnl: '999', netFunding: '0' }
    ];
    const agg = RM.marketPnL(positions, null, { 'BTC-USD': 10 }, { 'BTC-USD': 40, 'ETH-USD': 5 });
    assert.equal(agg['BTC-USD'].unrealizedOpen, 40);
    assert.equal(agg['BTC-USD'].total, 50);
    assert.equal(agg['BTC-USD'].openCount, 1);
    assert.equal(agg['ETH-USD'].unrealizedOpen, 5);
});

test('histPnlMonthly: monthly deltas chain across months, sum to latest totalPnl', () => {
    const hist = [
        { createdAt: '2025-01-15T00:00:00Z', totalPnl: '100', equity: '0', netTransfers: '0' },
        { createdAt: '2025-01-31T00:00:00Z', totalPnl: '200', equity: '0', netTransfers: '0' },
        { createdAt: '2025-02-15T00:00:00Z', totalPnl: '150', equity: '0', netTransfers: '0' },
        { createdAt: '2025-02-28T00:00:00Z', totalPnl: '500', equity: '0', netTransfers: '0' },
        { createdAt: '2025-03-15T00:00:00Z', totalPnl: '450', equity: '0', netTransfers: '0' },
    ];
    const m = RM.histPnlMonthly(hist);
    // January: lastInMonth(200) − 0 (first month) = 200
    assert.ok(m['2025-01'].hasData);
    assert.ok(close(m['2025-01'].delta, 200));
    // February: lastInMonth(500) − lastOfPriorMonth(200) = 300
    assert.ok(m['2025-02'].hasData);
    assert.ok(close(m['2025-02'].delta, 300));
    // March: lastInMonth(450) − lastOfPriorMonth(500) = −50
    assert.ok(m['2025-03'].hasData);
    assert.ok(close(m['2025-03'].delta, -50));
    // Reconciliation: Σ deltas == latest totalPnl
    const total = Object.values(m).reduce((s, v) => s + v.delta, 0);
    assert.ok(close(total, 450));
});

test('histPnlMonthly: a month\'s change is the exact decimal difference of its totalPnl rows', () => {
    const m = RM.histPnlMonthly([
        { createdAt: '2025-01-31T00:00:00Z', totalPnl: '54.886431', equity: '0', netTransfers: '0' },
        { createdAt: '2025-02-28T00:00:00Z', totalPnl: '156.386431', equity: '0', netTransfers: '0' },
    ]);
    assert.equal(m['2025-02'].delta, 101.5);
});

test('histPnlMonthly: each month carries the cumulative totalPnl it starts from and ends at', () => {
    const m = RM.histPnlMonthly([
        { createdAt: '2025-01-31T00:00:00Z', totalPnl: '0.5', equity: '0', netTransfers: '0' },
        { createdAt: '2025-02-28T00:00:00Z', totalPnl: '1.0', equity: '0', netTransfers: '0' },
        { createdAt: '2025-03-31T00:00:00Z', totalPnl: '1.5', equity: '0', netTransfers: '0' },
    ]);
    assert.deepEqual([m['2025-01'], m['2025-02'], m['2025-03']].map(({ start, end }) => [start, end]),
        [[0, 0.5], [0.5, 1], [1, 1.5]], 'January starts from the inception 0');
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
        { createdAt: '2025-01-01T00:00:00Z', totalPnl: '0', equity: '0', netTransfers: '0'   },
        { createdAt: '2025-01-02T00:00:00Z', totalPnl: '100', equity: '0', netTransfers: '0' },
        { createdAt: '2025-01-03T00:00:00Z', totalPnl: '250', equity: '0', netTransfers: '0' }
    ];
    const dd = RM.histPnlDrawdown(hist);
    assert.equal(dd.dollarDrawdown, 0);
});

test('histPnlDrawdown peak then trough', () => {
    const hist = [
        { createdAt: '2025-01-01T00:00:00Z', totalPnl: '0', equity: '0', netTransfers: '0'    },
        { createdAt: '2025-01-02T00:00:00Z', totalPnl: '500', equity: '0', netTransfers: '0'  },
        { createdAt: '2025-01-03T00:00:00Z', totalPnl: '300', equity: '0', netTransfers: '0'  },
        { createdAt: '2025-01-04T00:00:00Z', totalPnl: '100', equity: '0', netTransfers: '0'  }
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

// A /historical-pnl curve that never draws down has a true drawdown of $0;
// only a missing or empty series hands the drawdown cards to the
// closed-trade ledger.
test('drawdownSource stays on historical-pnl for a monotonic series, falls back only when it is empty', () => {
    const monotonic = [
        { createdAt: '2025-01-01T00:00:00Z', totalPnl: '0', equity: '0', netTransfers: '0' },
        { createdAt: '2025-01-02T00:00:00Z', totalPnl: '500', equity: '0', netTransfers: '0' }
    ];
    assert.equal(RM.drawdownSource(monotonic), 'hist');
    assert.equal(RM.drawdownSource([{ createdAt: '2025-01-01T00:00:00Z', totalPnl: '10', equity: '0', netTransfers: '0' }]), 'hist');
    assert.equal(RM.drawdownSource([]), 'trade');
    assert.equal(RM.drawdownSource(null), 'trade');
    assert.equal(RM.drawdownSource([{ createdAt: '2025-01-01T00:00:00Z' }]), 'hist',
        'a row without totalPnl is an unknown row, not an empty series (historicalPnlRowGap names it)');
});

// ---------------------------------------------------------------------------
// /historical-pnl row validation: a row whose time or amount does not parse
// is unknown. It never reaches a sort comparator and is never dropped; the
// series builders refuse the rows and historicalPnlRowGap says why.
// ---------------------------------------------------------------------------

const HIST_ROW_HOUR_MS = 3600000;
const HIST_ROW_START_MS = Date.parse('2025-01-01T00:00:00.000Z');
// Hourly rows on $1000 of equity with totalPnl 0, 100, 50, 120, 130,
// served newest first as the indexer does.
const hourlyHistRows = () => ['0', '100', '50', '120', '130'].map((totalPnl, i) => ({
    createdAt: new Date(HIST_ROW_START_MS + i * HIST_ROW_HOUR_MS).toISOString(),
    totalPnl, equity: '1000', netTransfers: '0'
})).reverse();
const HIST_TROUGH_PNL = '50';
const HIST_LATE_PEAK_PNL = '120';
const withRow = (pnl, patch) => hourlyHistRows().map(r => (r.totalPnl === pnl ? { ...r, ...patch } : r));

test('historicalPnlRowGap counts rows without a valid time or amount', () => {
    assert.equal(RM.historicalPnlRowGap(hourlyHistRows()), '');
    assert.equal(RM.historicalPnlRowGap([]), '');
    const one = '1 /historical-pnl row without a valid time or amount';
    assert.equal(RM.historicalPnlRowGap(withRow(HIST_TROUGH_PNL, { equity: undefined })), one,
        'an absent equity is unknown, never $0');
    assert.equal(RM.historicalPnlRowGap(withRow(HIST_TROUGH_PNL, { netTransfers: null })), one,
        'an absent netTransfers is unknown, never $0');
    assert.equal(RM.historicalPnlRowGap(withRow(HIST_LATE_PEAK_PNL, { createdAt: 'not-a-time' })), one);
    assert.equal(RM.historicalPnlRowGap(withRow(HIST_TROUGH_PNL, { totalPnl: '' })), one);
    assert.equal(RM.historicalPnlRowGap(withRow(HIST_TROUGH_PNL, { totalPnl: undefined })), one);
    assert.equal(RM.historicalPnlRowGap(withRow(HIST_TROUGH_PNL, { equity: '' })), one);
    assert.equal(RM.historicalPnlRowGap(withRow(HIST_TROUGH_PNL, { netTransfers: '12abc' })), one);
    assert.equal(RM.historicalPnlRowGap(hourlyHistRows().concat([null])), one);
    assert.equal(RM.historicalPnlRowGap(withRow(HIST_TROUGH_PNL, { totalPnl: '', createdAt: '' })
        .map(r => (r.totalPnl === HIST_LATE_PEAK_PNL ? { ...r, totalPnl: 'abc' } : r))),
        '2 /historical-pnl rows without a valid time or amount');
});

test('a /historical-pnl row without equity before a deposit leaves every return on the rows unknown, never read as $0 equity', () => {
    // $1M of equity earning $1000 an hour; the row before a $50,000
    // deposit has no equity. Read as $0, that hour would return
    // 1000 / 50000 = 2% instead of about 0.1%.
    const MILLION = 1000000;
    const DEPOSIT_ROW = 5;
    const rows = Array.from({ length: 10 }, (_, i) => ({
        createdAt: new Date(HIST_ROW_START_MS + i * HIST_ROW_HOUR_MS).toISOString(),
        totalPnl: String(1000 * i),
        equity: String(MILLION + 1000 * i),
        netTransfers: i === DEPOSIT_ROW ? '50000' : '0'
    }));
    assert.equal(RM.computeTimeWeightedReturnsFromHist(rows).length, rows.length - 1);
    const noEquity = rows.map((r, i) => (i === DEPOSIT_ROW - 1 ? { ...r, equity: undefined } : r));
    const gap = '1 /historical-pnl row without a valid time or amount';
    assert.equal(RM.historicalPnlRowGap(noEquity), gap);
    assert.deepEqual(RM.computeTimeWeightedReturnsFromHist(noEquity), []);
    // A trade opened in the hour after that row has no known base either.
    const trade = (openH, closeH) => ({
        status: 'CLOSED', complete: true, profit: 100,
        createdAt: new Date(HIST_ROW_START_MS + openH * HIST_ROW_HOUR_MS).toISOString(),
        closedAt: new Date(HIST_ROW_START_MS + closeH * HIST_ROW_HOUR_MS).toISOString()
    });
    const trades = [trade(DEPOSIT_ROW - 0.5, DEPOSIT_ROW - 0.25), trade(1.5, 1.75)];
    assert.deepEqual(RM.tradeReturnsOnEquity(trades, noEquity), [null, null]);
    const ratios = RM.perTradeRatios(trades, noEquity);
    assert.equal(ratios.ok, false);
    assert.equal(ratios.reason, gap);
});

test('an unparseable createdAt or an empty totalPnl leaves the series and its returns unknown, never reordered or dropped', () => {
    const clean = hourlyHistRows();
    assert.deepEqual(RM.buildCumulativeTotalPnlSeries(clean).map(p => p.c), [0, 100, 50, 120, 130]);
    assert.equal(RM.histPnlDrawdown(clean).dollarDrawdown, 50);
    [
        ['an unparseable createdAt', withRow(HIST_LATE_PEAK_PNL, { createdAt: 'not-a-time' })],
        ['an empty totalPnl', withRow(HIST_TROUGH_PNL, { totalPnl: '' })]
    ].forEach(([name, rows]) => {
        assert.deepEqual(RM.buildCumulativeTotalPnlSeries(rows, { t: '2025-01-02T00:00:00.000Z', c: 130 }), [], name);
        assert.deepEqual(RM.computeTimeWeightedReturnsFromHist(rows), [], name);
        assert.deepEqual(RM.varSampleReturns(rows), [], name);
        assert.equal(RM.histPnlDrawdownEvents(rows).length, 0, name);
        assert.equal(RM.equityAdjustedTotalPnl(rows, '1000'), null, name);
        assert.equal(RM.drawdownSource(rows), 'hist', `${name}: the rows exist, so the drawdown views read their gap`);
    });
});

test('time-weighted returns order the rows by parsed time, not by their text', () => {
    // 01:00+01:00 is 00:00Z, before 00:30Z, though its text sorts after.
    const rows = [
        { createdAt: '2025-01-01T00:30:00Z', totalPnl: '10', equity: '1000', netTransfers: '0' },
        { createdAt: '2025-01-01T01:00:00+01:00', totalPnl: '0', equity: '1000', netTransfers: '0' }
    ];
    assert.deepEqual(RM.computeTimeWeightedReturnsFromHist(rows), [10 / 1000]);
});

// ---------------------------------------------------------------------------
// historicalVaR — VaR / Expected Shortfall in dollars at current equity.
// ---------------------------------------------------------------------------

test('historicalVaR is the 5th-percentile return and the mean of the worst 5%, as dollar losses', () => {
    // -0.010, -0.009, …, +0.089: the 5th-percentile return is -0.005 and
    // the worst 5 of the 100 returns average -0.008.
    const returns = Array.from({ length: 100 }, (_, i) => (i - 10) / 1000);
    const out = RM.historicalVaR(returns, { equity: '200000' });
    assert.ok(close(out.varReturn, -0.005, 1e-12));
    assert.ok(close(out.esReturn, -0.008, 1e-12));
    assert.ok(close(out.varLoss, 1000));
    assert.ok(close(out.esLoss, 1600));
});

test('Expected Shortfall averages exactly the worst 5%, so a gain past the tail never dilutes it', () => {
    // n = 40: the worst 5% is the 2 losses; the third-worst return is a gain.
    const returns = [-0.2, -0.1, ...Array(38).fill(0.01)];
    const out = RM.historicalVaR(returns, { equity: '1000' });
    assert.ok(close(out.esReturn, -0.15, 1e-12), `got ${out.esReturn}`);
    assert.ok(close(out.esLoss, 150, 1e-9));
});

test('Expected Shortfall weighs the return on the 5% boundary by its fractional share (Acerbi-Tasche)', () => {
    // n = 50: the worst 5% is 2.5 returns, the two worst plus half the third.
    const returns = [-0.3, -0.2, -0.1, ...Array(47).fill(0.01)];
    const out = RM.historicalVaR(returns, { equity: '1000' });
    assert.ok(close(out.esReturn, (-0.3 - 0.2 - 0.5 * 0.1) / 2.5, 1e-12), `got ${out.esReturn}`);
});

test('historicalVaR floors the loss at $0 when the 5th-percentile return is a gain', () => {
    const returns = Array.from({ length: 40 }, (_, i) => (i + 1) / 1000);
    const out = RM.historicalVaR(returns, { equity: '100000' });
    assert.ok(out.varReturn > 0 && out.esReturn > 0, 'the whole tail is gains');
    assert.equal(out.varLoss, 0);
    assert.equal(out.esLoss, 0);
});

test('historicalVaR is null without usable equity or returns', () => {
    const returns = [-0.02, -0.01, 0.01, 0.019];
    assert.equal(RM.historicalVaR(returns, { equity: '-50000' }), null, 'negative equity would flip the sign');
    assert.equal(RM.historicalVaR(returns, { equity: '0' }), null);
    assert.equal(RM.historicalVaR(returns, null), null);
    assert.equal(RM.historicalVaR([], { equity: '1000' }), null);
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
    assert.equal(cd.pctOfPeakProfit, null, 'no series, no peak to give back');
    assert.equal(cd.peakAt, null);
});

test('histPnlCurrentDrawdown monotonically rising → at peak ($0 DD)', () => {
    const hist = [
        { createdAt: '2025-01-01T00:00:00Z', totalPnl: '0', equity: '0', netTransfers: '0'   },
        { createdAt: '2025-01-02T00:00:00Z', totalPnl: '100', equity: '0', netTransfers: '0' },
        { createdAt: '2025-01-03T00:00:00Z', totalPnl: '250', equity: '0', netTransfers: '0' }
    ];
    const cd = RM.histPnlCurrentDrawdown(hist);
    assert.equal(cd.dollarDrawdown, 0);
    assert.equal(cd.peakValue, 250);
    assert.equal(cd.currentValue, 250);
    assert.equal(cd.peakAt, '2025-01-03T00:00:00Z');
});

test('histPnlCurrentDrawdown peak then drop → DD = peak − current', () => {
    const hist = [
        { createdAt: '2025-01-01T00:00:00Z', totalPnl: '0', equity: '0', netTransfers: '0'    },
        { createdAt: '2025-01-02T00:00:00Z', totalPnl: '500', equity: '0', netTransfers: '0'  },
        { createdAt: '2025-01-03T00:00:00Z', totalPnl: '300', equity: '0', netTransfers: '0'  },
        { createdAt: '2025-01-04T00:00:00Z', totalPnl: '100', equity: '0', netTransfers: '0'  }
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
        { createdAt: '2025-01-01T00:00:00Z', totalPnl: '0', equity: '0', netTransfers: '0'   },
        { createdAt: '2025-01-02T00:00:00Z', totalPnl: '200', equity: '0', netTransfers: '0' },
        { createdAt: '2025-01-03T00:00:00Z', totalPnl: '50', equity: '0', netTransfers: '0'  },
        { createdAt: '2025-01-04T00:00:00Z', totalPnl: '300', equity: '0', netTransfers: '0' }
    ];
    // Max DD was 200→50 but current=300 > prior peak 200, so currently at peak.
    const cd = RM.histPnlCurrentDrawdown(hist);
    assert.equal(cd.dollarDrawdown, 0);
    assert.equal(cd.peakValue, 300);
    assert.equal(cd.currentValue, 300);
});

test('histPnlCurrentDrawdown partial recovery → smaller DD than max', () => {
    const hist = [
        { createdAt: '2025-01-01T00:00:00Z', totalPnl: '0', equity: '0', netTransfers: '0'   },
        { createdAt: '2025-01-02T00:00:00Z', totalPnl: '500', equity: '0', netTransfers: '0' },
        { createdAt: '2025-01-03T00:00:00Z', totalPnl: '100', equity: '0', netTransfers: '0' },
        { createdAt: '2025-01-04T00:00:00Z', totalPnl: '350', equity: '0', netTransfers: '0' }
    ];
    // Max DD was 500→100 = $400. Current = $350, so current DD = 500-350 = $150.
    const cd = RM.histPnlCurrentDrawdown(hist);
    assert.equal(cd.dollarDrawdown, 150);
    assert.ok(close(cd.pctOfPeakProfit, 30));
    assert.equal(cd.peakValue, 500);
    assert.equal(cd.currentValue, 350);
});

test('histPnlCurrentDrawdown single point → at peak ($0 DD)', () => {
    const hist = [{ createdAt: '2025-01-01T00:00:00Z', totalPnl: '123', equity: '0', netTransfers: '0' }];
    const cd = RM.histPnlCurrentDrawdown(hist);
    assert.equal(cd.dollarDrawdown, 0);
    assert.equal(cd.peakValue, 123);
    assert.equal(cd.currentValue, 123);
    assert.equal(cd.hasData, true);
});

test('histPnlCurrentDrawdown handles unsorted input by sorting chronologically', () => {
    const hist = [
        { createdAt: '2025-01-04T00:00:00Z', totalPnl: '100', equity: '0', netTransfers: '0' },
        { createdAt: '2025-01-02T00:00:00Z', totalPnl: '500', equity: '0', netTransfers: '0' },
        { createdAt: '2025-01-01T00:00:00Z', totalPnl: '0', equity: '0', netTransfers: '0'   },
        { createdAt: '2025-01-03T00:00:00Z', totalPnl: '300', equity: '0', netTransfers: '0' }
    ];
    const cd = RM.histPnlCurrentDrawdown(hist);
    // Sorted: 0, 500, 300, 100. Peak 500, current 100, DD 400.
    assert.equal(cd.dollarDrawdown, 400);
    assert.equal(cd.currentAt, '2025-01-04T00:00:00Z');
});

test('histPnlCurrentDrawdown peak ≤ 0 → pct = 0 (no peak profit to denominate)', () => {
    const hist = [
        { createdAt: '2025-01-01T00:00:00Z', totalPnl: '-100', equity: '0', netTransfers: '0' },
        { createdAt: '2025-01-02T00:00:00Z', totalPnl: '-200', equity: '0', netTransfers: '0' },
        { createdAt: '2025-01-03T00:00:00Z', totalPnl: '-300', equity: '0', netTransfers: '0' }
    ];
    // The series opens at the inception value 0 (the first row is already
    // −100), so the peak is 0 and current = −300: DD = 300, and a peak
    // that is no gain has no percent given back (null, not 0%).
    const cd = RM.histPnlCurrentDrawdown(hist);
    assert.equal(cd.dollarDrawdown, 300);
    assert.equal(cd.peakValue, 0);
    assert.equal(cd.pctOfPeakProfit, null);
    // A peak of +$0.30 displays as $0: no percent either.
    const dust = [{ createdAt: '2025-01-01T00:00:00Z', totalPnl: '0.3', equity: '0', netTransfers: '0' }, { createdAt: '2025-01-02T00:00:00Z', totalPnl: '-300', equity: '0', netTransfers: '0' }];
    assert.equal(RM.histPnlCurrentDrawdown(dust).pctOfPeakProfit, null);
    assert.equal(RM.histPnlDrawdown(dust).pctOfPeakProfit, null);
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

test('trade-system drawdown family leaves no series while a closed position has no valid close time, never dropping or misplacing it', () => {
    // +100, -150, +20: a $150 drawdown once every close is known.
    const closedAt = ['2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z', '2025-01-03T00:00:00Z'];
    const positions = [100, -150, 20].map((profit, i) => ({ status: 'CLOSED', closedAt: closedAt[i], profit, complete: true }));
    assert.equal(RM.tradeSystemDrawdown(positions).dollarDrawdown, 150);
    for (const badClose of [undefined, 'garbage']) {
        const untimed = positions.map((p, i) => (i === 1 ? { ...p, closedAt: badClose } : p));
        const label = `closedAt ${badClose}`;
        assert.equal(RM.closeTimeGap(untimed), '1 closed position without a valid close time', label);
        const worst = RM.tradeSystemDrawdown(untimed);
        assert.equal(worst.dollarDrawdown, 0, label);
        assert.equal(worst.troughAt, null, label);
        assert.deepEqual(RM.tradeSystemDrawdownEvents(untimed), [], label);
        assert.equal(RM.tradeSystemCurrentDrawdown(untimed).hasData, false, label);
    }
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

test('equal non-zero returns have no spread whatever float residue their mean leaves: Sharpe and Sortino are null', () => {
    // 40 × 0.001 averages to 0.0010000000000000002 in binary, which left a
    // standard deviation of ~1e-18 and a Sharpe of ~1.5e15.
    [0.001, 0.01, -0.01].forEach(r => {
        const returns = Array(40).fill(r);
        assert.equal(RM.computeSharpe(returns), null, `Sharpe of 40 × ${r}`);
        assert.equal(RM.computeSortino(returns), null, `Sortino of 40 × ${r}`);
    });
    // Returns that differ only past the noise floor are alike too, while
    // two that differ at it have a spread.
    assert.equal(RM.computeSharpe([0.1, 0.1 + 1e-17, 0.1]), null);
    assert.notEqual(RM.computeSharpe([0.1, 0.100000000000001, 0.1]), null);
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
        { createdAt: '2025-01-01T00:00:00Z', equity: '0',    totalPnl: '0', netTransfers: '0' },
        { createdAt: '2025-01-02T00:00:00Z', equity: '1000', totalPnl: '0', netTransfers: '0' },
        { createdAt: '2025-01-03T00:00:00Z', equity: '1050', totalPnl: '50', netTransfers: '0' }
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
        { createdAt: '2025-01-01T00:00:00Z', equity: '1000',  totalPnl: '0', netTransfers: '0' },
        { createdAt: '2025-01-02T00:00:00Z', equity: '10000', totalPnl: '100', netTransfers: '0' }
    ];
    const r = RM.computeTimeWeightedReturnsFromHist(rows);
    assert.equal(r.length, 1);
    assert.ok(close(r[0], 0.1), `expected 0.1 (100/1000), got ${r[0]}`);
});

test('computeTimeWeightedReturnsFromHist isolates pnlDelta (transfers ignored)', () => {
    // Equity jumps from 1000 → 5000 via deposit but totalPnl unchanged.
    // r = pnlDelta / prevEq = 0 / 1000 = 0 (NOT (5000-1000)/1000 = 4).
    const rows = [
        { createdAt: '2025-01-01T00:00:00Z', equity: '1000', totalPnl: '0', netTransfers: '0' },
        { createdAt: '2025-01-02T00:00:00Z', equity: '5000', totalPnl: '0', netTransfers: '0' }
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

// A return spanning k sampling intervals is weighted by k (weighted least
// squares under r ~ N(μ·k, σ²·k)): per-interval mean Σr ÷ Σk, variance
// Σ (r − μ·k)² ÷ k ÷ (n − 1), downside Σ min(0, r)² ÷ k ÷ n.
test('computeAnnualizedFromReturns weights a return by the sampling intervals it spans', () => {
    // Rows at 0, 2, 3 and 4 h: median 1 h, so k = 2, 1, 1. μ = 0.04 / 4 =
    // 0.01; residuals 0.02² / 2 + 0.02² / 1 + 0 = 6e-4 over n − 1 = 2 gives
    // σ² = 3e-4, Sharpe = 0.01 / √3e-4 ≈ 0.577350; downside 1e-4 / 1 over
    // n = 3, Sortino = 0.01 / √(1e-4 / 3) ≈ 1.732051.
    const ts = [0, 2, 3, 4].map(atHour);
    const intervalsMs = [2, 1, 1].map(h => h * 3600000);
    const out = RM.computeAnnualizedFromReturns([0.04, -0.01, 0.01], ts, { intervalsMs });
    assert.ok(close(out.sharpe, 0.577350, 1e-6), `Sharpe ${out.sharpe}`);
    assert.ok(close(out.sortino, 1.732051, 1e-6), `Sortino ${out.sortino}`);
});

// One hourly return process (Park–Miller LCG, Box–Muller normals), its
// /historical-pnl rows taken hourly throughout or daily for the first
// `dailyDays` days and hourly after.
function sampledProcessRows(hourlyReturns, dailyDays) {
    const equity0 = 100000;
    let t = H0;
    let pnl = 0;
    const rows = [{ createdAt: new Date(t).toISOString(), totalPnl: '0', equity: String(equity0), netTransfers: String(equity0) }];
    hourlyReturns.forEach((r, i) => {
        pnl += r * (equity0 + pnl);
        t += 3600000;
        const hoursSoFar = i + 1;
        const inDailyStretch = hoursSoFar <= dailyDays * 24;
        if (!inDailyStretch || hoursSoFar % 24 === 0) {
            rows.push({ createdAt: new Date(t).toISOString(), totalPnl: String(pnl), equity: String(equity0 + pnl), netTransfers: '0' });
        }
    });
    return rows;
}

function seededHourlyReturns(seed, hours, mu, sigma) {
    let s = seed;
    const uniform = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    return Array.from({ length: hours }, () => mu + sigma * Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform()));
}

function timeSeriesRatios(rows) {
    const points = RM.timeWeightedReturnPoints(rows);
    return RM.computeAnnualizedFromReturns(points.map(p => p.r), rows.map(r => r.createdAt),
        { intervalsMs: points.map(p => p.intervalMs) });
}

test('Sharpe and Sortino read the same process alike whether its rows are hourly or partly daily', () => {
    // 200 days of one hourly process; the second sample's first 100 days
    // arrive as daily rows. Counted as one interval each, the daily
    // returns inflated the ratio by about 37%.
    const DAYS = 200;
    const DAILY_DAYS = 100;
    const returns = seededHourlyReturns(424242, DAYS * 24, 0.0001, 0.003);
    const hourly = timeSeriesRatios(sampledProcessRows(returns, 0));
    const mixed = timeSeriesRatios(sampledProcessRows(returns, DAILY_DAYS));
    const SAMPLING_TOLERANCE = 0.05;
    ['sharpeAnnualized', 'sortinoAnnualized'].forEach(field => {
        const drift = Math.abs(mixed[field] / hourly[field] - 1);
        assert.ok(drift < SAMPLING_TOLERANCE, `${field}: hourly ${hourly[field]}, partly daily ${mixed[field]}`);
    });
});

test('the inception return, of unknown length, counts as one interval', () => {
    // The first row already holds a profit: its return from inception has
    // no length (intervalMs NaN) and weighs as one interval, never NaN.
    const rows = [pnlRow(0, 50, 1050, 1000), pnlRow(1, 60, 1060), pnlRow(2, 40, 1040), pnlRow(3, 70, 1070)];
    const points = RM.timeWeightedReturnPoints(rows);
    assert.ok(Number.isNaN(points[0].intervalMs));
    const out = timeSeriesRatios(rows);
    const unweighted = RM.computeAnnualizedFromReturns(points.map(p => p.r), rows.map(r => r.createdAt));
    assert.ok(close(out.sharpe, unweighted.sharpe, 1e-12), `${out.sharpe} vs ${unweighted.sharpe}`);
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

test('peakSize is the exact held size, so many small fills summing to a tie give the decimal return', () => {
    // 10000 BUYs of 0.0003 at $100 hold exactly 3 (their float running
    // sum drifts to 3.0000000000004805), sold at $101.005: 3.015 ÷ 300.
    const FILL_COUNT = 10000;
    const position = { market: 'BTC-USD', status: 'CLOSED', side: 'LONG', createdAt: T1, closedAt: T2 };
    const fills = Array.from({ length: FILL_COUNT }, (_, i) => mkFill('BTC-USD', T1, i + 1, 'BUY', '0.0003', '100', '0'));
    fills.push(mkFill('BTC-USD', T2, FILL_COUNT + 1, 'SELL', '3', '101.005', '0'));
    const a = { ...position, ...RM.attributeFillsToPositions([position], fills).get(position) };
    assert.equal(a.peakSize, 3);
    assert.equal(RM.peakNotional(a), 300);
    assert.equal(RM.tradeReturn(a), 0.01005);
});

test('peakNotional and tradeReturn are exact quotients of the decimals they stand for', () => {
    // 0.1 × 3 is 0.30000000000000004 and 0.0001 ÷ 0.3 is 3.3333333333333337e-4 in binary floats.
    const p = { profit: 0.0001, peakSize: 0.1, entryVwap: 3, complete: true };
    assert.equal(RM.peakNotional(p), 0.3);
    assert.equal(RM.tradeReturn(p), 0.000333333333333333);
    assert.equal(RM.tradeReturn({ ...p, profit: -0.0001 }), -0.000333333333333333);
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

test('a span just short of the one-month minimum never reads as a full month in the reason', () => {
    // 30 daily returns span 30 / 365.25 years = 0.986 months: rounded to
    // one decimal that read "have 1.0 months" against a 1-month minimum.
    const DAY_MS = 24 * 3600000;
    const rets = Array(30).fill(0.01);
    const ts = rets.map((_, i) => new Date(Date.UTC(2025, 0, 1) + i * DAY_MS).toISOString());
    const gate = RM.assessAdequacy(rets, ts, 30);
    assert.equal(gate.adequate, false);
    assert.equal(gate.reason, 'Need ≥1 month of valid data (have 0.9 months)');

    const trades = tradesClosedAt([H0, H0 + 15 * DAY_MS, H0 + 30 * DAY_MS], [2000, -1000, 3000]);
    const perTrade = RM.perTradeRatios(trades, EQUITY_ROW, 2);
    assert.equal(perTrade.ok, false);
    assert.equal(perTrade.reason, 'Need ≥1 month from first to last close (have 0.9 months)');
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
        { createdAt: '2025-01-01T00:00:00Z', totalPnl: '0', equity: '0', netTransfers: '0' },
        { createdAt: '2025-01-02T00:00:00Z', totalPnl: '100', equity: '0', netTransfers: '0' },  // peak 1
        { createdAt: '2025-01-03T00:00:00Z', totalPnl: '40', equity: '0', netTransfers: '0' },   // trough 1
        { createdAt: '2025-01-04T00:00:00Z', totalPnl: '120', equity: '0', netTransfers: '0' },  // recovers + new peak
        { createdAt: '2025-01-05T00:00:00Z', totalPnl: '60', equity: '0', netTransfers: '0' },   // trough 2 (no recovery)
    ];
    const events = RM.histPnlDrawdownEvents(rows);
    assert.equal(events.length, 2, `expected 2 events, got ${events.length}`);
    assert.equal(events[0].recoveryAt, '2025-01-04T00:00:00Z');
    assert.equal(events[1].recoveryAt, null);
});

test('histPnlDrawdownEvents recovery requires returning to or above prior peak', () => {
    const rows = [
        { createdAt: '2025-01-01T00:00:00Z', totalPnl: '0', equity: '0', netTransfers: '0' },
        { createdAt: '2025-01-02T00:00:00Z', totalPnl: '100', equity: '0', netTransfers: '0' },
        { createdAt: '2025-01-03T00:00:00Z', totalPnl: '50', equity: '0', netTransfers: '0' },
        { createdAt: '2025-01-04T00:00:00Z', totalPnl: '99', equity: '0', netTransfers: '0' }, // below peak → not recovered
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

test('the trade-system series starts at 0 at the first close, so a losing first trade is a drawdown, as on /historical-pnl', () => {
    const closes = ['2025-01-01T00:00:00.000Z', '2025-01-02T00:00:00.000Z', '2025-01-03T00:00:00.000Z'];
    const trades = [-100, 30, -20].map((profit, i) => ({ status: 'CLOSED', closedAt: closes[i], profit, complete: true }));
    const worst = RM.tradeSystemDrawdown(trades);
    assert.equal(worst.dollarDrawdown, 100);
    assert.equal(worst.peakValue, 0);
    assert.equal(worst.peakAt, closes[0]);
    assert.equal(worst.n, trades.length, 'n counts the closed trades, not the series points');
    const current = RM.tradeSystemCurrentDrawdown(trades);
    assert.equal(current.dollarDrawdown, 90);
    assert.equal(current.peakValue, 0);
    const events = RM.tradeSystemDrawdownEvents(trades);
    assert.equal(events.length, 1);
    assert.equal(events[0].peakCum, 0);
    assert.equal(events[0].recoveryAt, null);
    // The same profit on the /historical-pnl path measures the same drawdown.
    const rows = [-100, -70, -90].map((totalPnl, i) => ({ createdAt: closes[i], totalPnl: String(totalPnl), equity: '0', netTransfers: '0' }));
    assert.equal(RM.histPnlDrawdown(rows).dollarDrawdown, worst.dollarDrawdown);
    assert.equal(RM.histPnlCurrentDrawdown(rows).dollarDrawdown, current.dollarDrawdown);
    // One losing trade is a drawdown of its whole loss.
    assert.equal(RM.tradeSystemDrawdown(trades.slice(0, 1)).dollarDrawdown, 100);
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

test('liquidationRow tolerates empty marketsMap: no oracle, so no notional, leverage or liq price', () => {
    const p = { market: 'BTC-USD', size: '1', side: 'LONG', entryPrice: '100' };
    const sub = { equity: '50' };
    const row = RM.liquidationRow(p, sub, {});
    assert.ok(row !== null);
    assert.equal(row.entry, 100);
    assert.equal(row.oracle, 0);
    assert.equal(row.notional, null);
    assert.equal(row.lev, null);
    assert.equal(row.liq, null);
    assert.equal(row.distancePct, null);
});

test('positionOraclePrice reads the position, then the markets map, never the entry price', () => {
    const markets = { 'BTC-USD': { oraclePrice: '100000' }, 'ETH-USD': { oraclePrice: '0' } };
    assert.equal(RM.positionOraclePrice({ market: 'BTC-USD', oraclePrice: '110000' }, markets), 110000);
    assert.equal(RM.positionOraclePrice({ market: 'BTC-USD', entryPrice: '90000' }, markets), 100000);
    assert.equal(RM.positionOraclePrice({ market: 'ETH-USD', entryPrice: '2000' }, markets), null, 'zero oracle');
    assert.equal(RM.positionOraclePrice({ market: 'SOL-USD', entryPrice: '100' }, markets), null, 'market missing');
    assert.equal(RM.positionOraclePrice({ market: 'BTC-USD' }, null), null, 'no markets map');
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
    assert.equal(monthly['2025-01'].winCount, 1);
    assert.equal(monthly['2025-01'].lossCount, 1);
    assert.equal(monthly['2025-01'].expectancy, 25); // (100−50)/2
    assert.equal(monthly['2025-02'].winCount, 1);
    assert.equal(monthly['2025-02'].profitFactor, null); // no losses
});

test('classifyByMonth applies an account-wide unavailable reason to every month', () => {
    const reason = '1 position missing fill data';
    const monthly = RM.classifyByMonth([
        { status: 'CLOSED', closedAt: '2025-01-15T00:00:00Z', profit: 100, complete: true },
        { status: 'CLOSED', closedAt: '2025-01-20T00:00:00Z', profit: -50, complete: true }
    ], reason);
    assert.equal(monthly['2025-01'].incompleteReason, reason);
    assert.equal(monthly['2025-01'].winRate, null);
    assert.equal(monthly['2025-01'].winCount, 1, 'counts stay available');
});

test('classifyByMonth buckets by closedAt alone and blanks every month while a close time is unknown', () => {
    const january = [
        { status: 'CLOSED', closedAt: '2025-01-15T00:00:00Z', profit: 100, complete: true },
        { status: 'CLOSED', closedAt: '2025-01-20T00:00:00Z', profit: -50, complete: true },
    ];
    [undefined, 'not-a-date'].forEach(closedAt => {
        const untimed = { status: 'CLOSED', createdAt: '2024-12-01T00:00:00Z', closedAt, profit: -1000, complete: true };
        const monthly = RM.classifyByMonth([...january, untimed]);
        assert.deepEqual(Object.keys(monthly), ['2025-01'], `closedAt ${closedAt}`);
        assert.equal(monthly['2025-01'].incompleteReason, '1 closed position without a valid close time');
        assert.equal(monthly['2025-01'].winRate, null);
    });
    assert.equal(RM.closeTimeGap(january), '');
});

test('classifyByMonth empty / null input → {}', () => {
    assert.deepEqual(RM.classifyByMonth(null), {});
    assert.deepEqual(RM.classifyByMonth([]), {});
});

// ---------------------------------------------------------------------------
// Monthly Performance Breakdown month keys: UTC calendar months, whatever
// the viewer's timezone, keyed 'YYYY-MM' so they sort chronologically.
// ---------------------------------------------------------------------------

// Runs `fn` with the process in timezone `tz`, restoring it afterwards.
function inTimezone(tz, fn) {
    const saved = process.env.TZ;
    process.env.TZ = tz;
    try { return fn(); } finally {
        if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
    }
}

test('monthKeyUTC buckets by the UTC calendar month in any viewer timezone', () => {
    // 20:00 UTC on 31 August is already 1 September in Tokyo and still
    // 31 August in New York; 02:00 UTC on 1 February is 31 January there.
    inTimezone('Asia/Tokyo', () => {
        assert.equal(RM.monthKeyUTC('2025-08-31T20:00:00.000Z'), '2025-08');
    });
    inTimezone('America/New_York', () => {
        assert.equal(RM.monthKeyUTC('2026-02-01T02:00:00.000Z'), '2026-02');
    });
    assert.equal(RM.monthKeyUTC('not a date'), null);
    assert.equal(RM.monthKeyUTC(undefined), null);
});

test('monthLabel names a month key in English, in UTC', () => {
    inTimezone('America/Los_Angeles', () => {
        // Midnight UTC on 1 September is still August in Los Angeles.
        assert.equal(RM.monthLabel('2026-09'), 'September 2026');
        assert.equal(RM.monthLabel('2025-01'), 'January 2025');
    });
});

test('classifyByMonth and histPnlMonthly key a month-end trade and row by its UTC month', () => {
    inTimezone('Asia/Tokyo', () => {
        const monthly = RM.classifyByMonth([
            { status: 'CLOSED', closedAt: '2025-08-31T20:00:00.000Z', profit: 100, complete: true }
        ]);
        assert.deepEqual(Object.keys(monthly), ['2025-08']);
        const deltas = RM.histPnlMonthly([
            { createdAt: '2025-08-01T00:00:00.000Z', totalPnl: '10', equity: '0', netTransfers: '0' },
            { createdAt: '2025-08-31T20:00:00.000Z', totalPnl: '50', equity: '0', netTransfers: '0' }
        ]);
        assert.deepEqual(Object.keys(deltas), ['2025-08']);
        assert.equal(deltas['2025-08'].delta, 50);
    });
});

test('histPnlMonthly: a month without rows reads unknown, and so does the next month\'s change', () => {
    // No February row: March's change from the last known month-end
    // (January) holds February's change too, so it is not March's.
    const m = RM.histPnlMonthly([
        { createdAt: '2025-01-31T00:00:00Z', totalPnl: '100', equity: '0', netTransfers: '0' },
        { createdAt: '2025-03-10T00:00:00Z', totalPnl: '600', equity: '0', netTransfers: '0' },
        { createdAt: '2025-03-31T00:00:00Z', totalPnl: '650', equity: '0', netTransfers: '0' },
        { createdAt: '2025-04-30T00:00:00Z', totalPnl: '700', equity: '0', netTransfers: '0' }
    ]);
    assert.deepEqual(Object.keys(m), ['2025-01', '2025-02', '2025-03', '2025-04']);
    assert.equal(m['2025-01'].delta, 100);
    assert.equal(m['2025-02'].hasData, false);
    assert.equal(m['2025-02'].delta, null);
    assert.match(m['2025-02'].reason, /no \/historical-pnl rows/i);
    assert.equal(m['2025-03'].hasData, true);
    assert.equal(m['2025-03'].delta, null);
    assert.match(m['2025-03'].reason, /February 2025/);
    assert.equal(m['2025-04'].delta, 50, 'a known prior month-end gives a known change again');
    assert.equal(m['2025-04'].reason, '');
});

// ---------------------------------------------------------------------------
// assessMonthAdequacy — the Monthly SHARPE gate, judged against the month's
// own calendar periods.
// ---------------------------------------------------------------------------

// Hourly /historical-pnl timestamps from `fromIso`, `count` of them.
function hourlyTimestamps(fromIso, count) {
    const start = Date.parse(fromIso);
    return Array.from({ length: count }, (_, i) => new Date(start + i * 3600000).toISOString());
}

test('assessMonthAdequacy passes a complete month of any length and fails a sparse one', () => {
    const HOURS = { september: 30 * 24, february: 28 * 24, august: 31 * 24 };
    const gate = (key, rows) => {
        const ts = hourlyTimestamps(`${key}-01T00:00:00.000Z`, rows);
        const returns = Array.from({ length: rows - 1 }, (_, i) => (i % 2 ? 0.001 : -0.0005));
        return RM.assessMonthAdequacy(returns, ts, rows, key);
    };
    assert.equal(gate('2025-09', HOURS.september).adequate, true, 'complete 30-day month');
    assert.equal(gate('2026-02', HOURS.february).adequate, true, 'complete February');
    assert.equal(gate('2025-08', HOURS.august).adequate, true, 'complete 31-day month');

    const sparse = gate('2026-02', 84);
    assert.equal(sparse.adequate, false);
    assert.match(sparse.reason, /12% of the month/);
});

test('assessMonthAdequacy keeps the minimum return count and the row-coverage rule', () => {
    const key = '2025-09';
    const few = RM.assessMonthAdequacy(Array(10).fill(0.01), hourlyTimestamps(`${key}-01T00:00:00.000Z`, 11), 11, key);
    assert.equal(few.adequate, false);
    assert.match(few.reason, /returns/i);

    // Every hour has a row, but most rows produced no valid return.
    const rows = 720;
    const filtered = RM.assessMonthAdequacy(Array(400).fill(0.01), hourlyTimestamps(`${key}-01T00:00:00.000Z`, rows), 1000, key);
    assert.equal(filtered.adequate, false);
    assert.match(filtered.reason, /coverage/i);
});

test('a coverage reason truncates its percent, so a failing coverage never reads as the threshold', () => {
    const HOURS_IN_APRIL = 30 * 24;
    const month = RM.assessMonthAdequacy(Array(358).fill(0.01),
        hourlyTimestamps('2025-04-01T00:00:00.000Z', HOURS_IN_APRIL), HOURS_IN_APRIL, '2025-04');
    assert.equal(month.adequate, false);
    assert.equal(month.reason, 'Returns cover 49% of the month (need ≥50%)');

    const ROWS = 4000;
    const account = RM.assessAdequacy(Array(1988).fill(0.01), hourlyTimestamps('2025-01-01T00:00:00.000Z', ROWS), ROWS);
    assert.equal(account.adequate, false);
    assert.match(account.reason, /^Coverage 49% /);

    // 290 of 1000 is 29%, though 0.29 × 100 is 28.999… in floating point.
    const DAY_MS = 24 * 3600000;
    const daily = Array.from({ length: 1000 }, (_, d) => new Date(H0 + d * DAY_MS).toISOString());
    assert.match(RM.assessAdequacy(Array(290).fill(0.01), daily, daily.length).reason, /^Coverage 29% /);
});

// ---------------------------------------------------------------------------
// attributeFillsToPositions — a closed round trip no listed position owns.
// ---------------------------------------------------------------------------

test('attributeFillsToPositions: a closed round trip no listed position owns makes the market\'s closed positions incomplete', () => {
    // The fills hold a losing trip (T1→T2) and a winning one (T3→T4);
    // the CLOSED list holds only the winner.
    const winner = { market: 'BTC-USD', status: 'CLOSED', side: 'LONG', createdAt: T3, closedAt: T4 };
    const ethTrade = { market: 'ETH-USD', status: 'CLOSED', side: 'LONG', createdAt: T1, closedAt: T2 };
    const fills = [
        mkFill('BTC-USD', T1, 1, 'BUY',  1, 100, 0),
        mkFill('BTC-USD', T2, 2, 'SELL', 1, 50,  0),
        mkFill('BTC-USD', T3, 3, 'BUY',  1, 100, 0),
        mkFill('BTC-USD', T4, 4, 'SELL', 1, 110, 0),
        mkFill('ETH-USD', T1, 5, 'BUY',  1, 10,  0),
        mkFill('ETH-USD', T2, 6, 'SELL', 1, 11,  0)
    ];
    const byPosition = RM.attributeFillsToPositions([winner, ethTrade], fills);
    assert.equal(byPosition.get(winner).complete, false);
    assert.equal(byPosition.get(winner).incompleteCause, RM.INCOMPLETE_CAUSE.UNLISTED_TRADE);
    assert.equal(byPosition.get(ethTrade).complete, true, 'another market is untouched');
    assert.equal(RM.classifyClosed([
        { ...winner, ...byPosition.get(winner) }, { ...ethTrade, ...byPosition.get(ethTrade) }
    ]).incompleteReason, '1 position missing fill data');
});

test('attributeFillsToPositions: an unlisted round trip leaves the market\'s OPEN position, and open lots without an OPEN row leave closed ones, complete', () => {
    const open = { market: 'BTC-USD', status: 'OPEN', side: 'LONG', size: '1', createdAt: T3, closedAt: null };
    const trips = [
        mkFill('BTC-USD', T1, 1, 'BUY',  1, 100, 0),
        mkFill('BTC-USD', T2, 2, 'SELL', 1, 50,  0),
        mkFill('BTC-USD', T3, 3, 'BUY',  1, 100, 0)
    ];
    assert.equal(RM.attributeFillsToPositions([open], trips).get(open).complete, true);

    // The lots left open belong to no listed position, but no closed
    // trade is missing (processData flags the phantom lots on its own).
    const closed = { market: 'BTC-USD', status: 'CLOSED', side: 'LONG', createdAt: T1, closedAt: T2 };
    assert.equal(RM.attributeFillsToPositions([closed], trips).get(closed).complete, true);
});

test('attributeFillsToPositions reports at account level each market whose fills hold an unlisted closed trade, one without any listed position included', () => {
    const winner = { market: 'BTC-USD', status: 'CLOSED', side: 'LONG', createdAt: T3, closedAt: T4 };
    const fills = [
        mkFill('BTC-USD', T1, 1, 'BUY',  1, 100, 0),
        mkFill('BTC-USD', T2, 2, 'SELL', 1, 50,  0),
        mkFill('BTC-USD', T3, 3, 'BUY',  1, 100, 0),
        mkFill('BTC-USD', T4, 4, 'SELL', 1, 110, 0),
        mkFill('SOL-USD', T1, 5, 'BUY',  2, 10,  0),
        mkFill('SOL-USD', T2, 6, 'SELL', 2, 9,   0),
        mkFill('ETH-USD', T1, 7, 'BUY',  1, 10,  0)
    ];
    const attribution = RM.attributeFillsToPositions([winner], fills);
    assert.deepEqual(attribution.unlistedTradeMarkets, ['BTC-USD', 'SOL-USD'],
        'ETH-USD holds open lots only, which the open-lots check covers');

    const listed = { ...winner, createdAt: T1, closedAt: T2 };
    const complete = RM.attributeFillsToPositions([listed, winner], fills.filter(f => f.market === 'BTC-USD'));
    assert.deepEqual(complete.unlistedTradeMarkets, []);
    assert.deepEqual(RM.attributeFillsToPositions([winner], null).unlistedTradeMarkets, []);
});

test('incompleteCause precedence: a cause on the position itself outranks an unlisted trade in its market', () => {
    const { causeOf, closedLong, roundTrip } = precedence;
    const CAUSE = RM.INCOMPLETE_CAUSE;
    const unlistedTrip = [mkFill('BTC-USD', T3, 3, 'BUY', 1, 100, 0), mkFill('BTC-USD', T4, 4, 'SELL', 1, 90, 0)];
    assert.equal(causeOf([closedLong], [...roundTrip, ...unlistedTrip], closedLong), CAUSE.UNLISTED_TRADE);
    const short = { ...closedLong, side: 'SHORT' };
    assert.equal(causeOf([short], [...roundTrip, ...unlistedTrip], short), CAUSE.SIDE_MISMATCH);
});

test('incompleteCause precedence: an unknown fee on the position outranks an unlisted trade in its market', () => {
    const { causeOf, closedLong, roundTrip } = precedence;
    const CAUSE = RM.INCOMPLETE_CAUSE;
    const unlistedTrip = [mkFill('BTC-USD', T3, 3, 'BUY', 1, 100, 0), mkFill('BTC-USD', T4, 4, 'SELL', 1, 90, 0)];
    const feeless = [{ ...roundTrip[0], fee: 'n/a' }, roundTrip[1]];
    assert.equal(causeOf([closedLong], [...feeless, ...unlistedTrip], closedLong), CAUSE.UNKNOWN_FEE);
});

// ---------------------------------------------------------------------------
// Live anchor: the totalPnl series every drawdown view and the monthly
// PROFIT read ends at the live point (equity now − net transfers), not at
// the last hourly /historical-pnl row.
// ---------------------------------------------------------------------------

const H0 = Date.parse('2025-01-01T00:00:00.000Z');
const atHour = (h) => new Date(H0 + h * 3600000).toISOString();
const pnlRow = (h, totalPnl, equity = 1000, netTransfers = 0) => ({
    createdAt: atHour(h), totalPnl: String(totalPnl), equity: String(equity), netTransfers: String(netTransfers)
});

test('livePnlPoint is the fills-based Total Profit headline, dated now', () => {
    const rows = [pnlRow(1, 50, 1050), pnlRow(0, 100, 1100)];
    const nowMs = H0 + 1.5 * 3600000;
    assert.deepEqual(RM.livePnlPoint(rows, -200, nowMs), { t: atHour(1.5), c: -200 });
});

test('a transfer after the last hourly row does not move the live point, which never reads equity', () => {
    // Profit −200 at the last row; a $5000 deposit since then lifts equity
    // to 5800, but the account made nothing more: the headline still reads −200.
    const rows = [pnlRow(0, 0, 1000), pnlRow(1, 500, 1500), pnlRow(2, -200, 800)];
    const live = RM.livePnlPoint(rows, -200, H0 + 2.75 * 3600000);
    assert.equal(live.c, -200);
    assert.equal(RM.histPnlCurrentDrawdown(rows, live).dollarDrawdown, 700);
});

test('livePnlPoint is null without a headline or without rows', () => {
    const rows = [pnlRow(0, 100, 1100), pnlRow(1, 50, 1050)];
    const later = H0 + 2 * 3600000;
    assert.equal(RM.livePnlPoint(rows, null, later), null);
    assert.equal(RM.livePnlPoint(rows, NaN, later), null);
    assert.equal(RM.livePnlPoint([], 40, later), null);
});

// ---------------------------------------------------------------------------
// profitReconciliation: the fills-based headline against /historical-pnl.
// A headline that disagrees is no headline and no live point.
// ---------------------------------------------------------------------------

test('profitReconciliation reads a headline far from /historical-pnl as a disagreement, with the gap in its reason', () => {
    // A subaccount with no fills (headline $0.00) whose /historical-pnl
    // ends at +$8,075,294.54 on the equity it still holds.
    const rows = [pnlRow(0, 8075000, 1515000), pnlRow(1, 8075294.54, 1515959.24)];
    const check = RM.profitReconciliation(rows, '1515959.24', 0);
    assert.equal(check.reason,
        'Fills disagree with /historical-pnl by -$8,075,295: fills may be incomplete, '
        + 'or /historical-pnl may count flows that are not trades');
    assert.ok(close(check.gap, -8075294.54));
});

test('profitReconciliation tolerates 1% of the reference, floored at $1', () => {
    const rows = [pnlRow(0, 0), pnlRow(1, 1000, 2000)];
    assert.equal(RM.profitReconciliation(rows, '2000', 1010).reason, '');
    assert.notEqual(RM.profitReconciliation(rows, '2000', 1010.02).reason, '');
    const small = [pnlRow(0, 0), pnlRow(1, 20, 1020)];
    assert.equal(RM.profitReconciliation(small, '1020', 21).reason, '');
    assert.notEqual(RM.profitReconciliation(small, '1020', 21.02).reason, '');
});

test('profitReconciliation agrees with a headline between the last row and the equity-adjusted value', () => {
    // Profit +1000 at the last row; since then a $10,000 deposit and a
    // +$300 price move lift equity by 10,300. The equity-adjusted value
    // (+11,300) assumes no transfer, so it alone would read the deposit as
    // a disagreement; the headline (+1300) lies between it and the row.
    const rows = [pnlRow(0, 0, 1000), pnlRow(1, 1000, 2000)];
    assert.equal(RM.profitReconciliation(rows, '12300', 1300).reason, '');
    // A −$300 move beside the deposit: the headline (+700) is $300 below
    // the row, more than 1% of the references.
    assert.notEqual(RM.profitReconciliation(rows, '11700', 700).reason, '');
});

test('profitReconciliation is null when it cannot be checked', () => {
    const rows = [pnlRow(0, 0), pnlRow(1, 1000, 2000)];
    assert.equal(RM.profitReconciliation(rows, '2000', null), null);
    assert.equal(RM.profitReconciliation(rows, undefined, 1000), null);
    assert.equal(RM.profitReconciliation([], '2000', 1000), null);
    assert.equal(RM.profitReconciliation([...rows, { ...pnlRow(2, 5), totalPnl: '' }], '2000', 0), null);
});

test('a clock at or behind the last row dates the live point just after it, so the headline is never dropped', () => {
    // Rows at 00:00 (+500) and 01:00 (−200); the headline reads −900 and
    // the client clock is 30 s behind the indexer's 01:00 row.
    const rows = [pnlRow(0, 500), pnlRow(1, -200)];
    const lastMs = H0 + 3600000;
    const justAfter = new Date(lastMs + 1).toISOString();
    for (const nowMs of [lastMs - 30000, lastMs, NaN]) {
        const live = RM.livePnlPoint(rows, -900, nowMs);
        assert.deepEqual(live, { t: justAfter, c: -900 }, `now ${nowMs}`);
    }
    const live = RM.livePnlPoint(rows, -900, lastMs - 30000);
    assert.equal(RM.histPnlCurrentDrawdown(rows, live).dollarDrawdown, 1400);
    assert.equal(RM.histPnlDrawdown(rows, live).dollarDrawdown, 1400);
});

test('a live point below the last row deepens Max DD, Current DD, the event list and the month\'s PROFIT together', () => {
    // Peak 100 → last row 60 (a $40 drawdown on the rows) → live 20.
    const rows = [pnlRow(0, 0), pnlRow(1, 100), pnlRow(2, 60)];
    const live = { t: atHour(3), c: 20 };

    assert.deepEqual(RM.buildCumulativeTotalPnlSeries(rows, live).slice(-1), [live]);
    assert.equal(RM.histPnlDrawdown(rows).dollarDrawdown, 40, 'rows only');
    assert.equal(RM.histPnlDrawdown(rows, live).dollarDrawdown, 80);
    assert.equal(RM.histPnlDrawdown(rows, live).troughAt, live.t);
    const cdd = RM.histPnlCurrentDrawdown(rows, live);
    assert.equal(cdd.dollarDrawdown, 80);
    assert.equal(cdd.currentAt, live.t);
    assert.equal(cdd.currentValue, 20);
    const [event] = RM.histPnlDrawdownEvents(rows, live);
    assert.equal(event.troughAt, live.t);
    assert.equal(event.depthAbs, 80);
    assert.equal(RM.histPnlMonthly(rows)['2025-01'].delta, 60, 'rows only');
    assert.equal(RM.histPnlMonthly(rows, live)['2025-01'].delta, 20);
});

test('a live point in a month without rows gives that month its PROFIT from the prior month-end', () => {
    const rows = [pnlRow(0, 0), pnlRow(24 * 30, 100)];
    const live = { t: '2025-02-01T00:30:00.000Z', c: 130 };
    const monthly = RM.histPnlMonthly(rows, live);
    assert.equal(monthly['2025-01'].delta, 100);
    assert.deepEqual(monthly['2025-02'], { delta: 30, start: 100, end: 130, hasData: true, reason: '' });
});

test('Current Drawdown dates its peak at the last time the series stood there, like the drawdown event', () => {
    // 100 is reached at hour 1, left, regained at hour 3, then left again.
    const rows = [pnlRow(0, 0), pnlRow(1, 100), pnlRow(2, 50), pnlRow(3, 100), pnlRow(4, 70)];
    const cdd = RM.histPnlCurrentDrawdown(rows);
    const events = RM.histPnlDrawdownEvents(rows);
    assert.equal(cdd.peakAt, atHour(3));
    assert.equal(events[events.length - 1].peakAt, cdd.peakAt);
});

test('a drawdown event ends at its recovery, or while ongoing at the series\' last point', () => {
    const rows = [pnlRow(0, 0), pnlRow(1, 100), pnlRow(2, 40), pnlRow(3, 120), pnlRow(4, 60), pnlRow(5, 70)];
    const [recovered, ongoing] = RM.histPnlDrawdownEvents(rows);
    assert.equal(recovered.endAt, atHour(3));
    assert.equal(ongoing.recoveryAt, null);
    assert.equal(ongoing.endAt, atHour(5));
    const live = { t: atHour(9), c: 80 };
    assert.equal(RM.histPnlDrawdownEvents(rows, live)[1].endAt, live.t);
});

// ---------------------------------------------------------------------------
// Time-weighted returns: Modified Dietz base and the materiality floor.
// ---------------------------------------------------------------------------

test('a time-weighted return\'s base is the prior equity plus the period\'s inflow, so the hour after a deposit counts', () => {
    const rows = [
        pnlRow(0, 0, 0),
        pnlRow(1, 50, 1050, 1000),     // deposit onto an empty account: base 0 + 1000
        pnlRow(2, 100, 2100, 1000),    // second deposit: base 1050 + 1000
        pnlRow(3, 100, 1100, -1000)    // withdrawal: base stays the prior 2100
    ];
    const r = RM.computeTimeWeightedReturnsFromHist(rows);
    assert.equal(r.length, 3);
    assert.ok(close(r[0], 0.05, 1e-12), `got ${r[0]}`);
    assert.ok(close(r[1], 50 / 2050, 1e-12), `got ${r[1]}`);
    assert.equal(r[2], 0);
});

test('a time-weighted return on a base below 1% of the median positive equity is excluded', () => {
    // Median positive equity 100000, floor 1000. A near-total withdrawal
    // leaves $999, then $996: the −$3 hours on those bases (−0.3% each)
    // are below the floor; the withdrawal hour itself has a $100000 base.
    const dust = [pnlRow(0, 0, 100000), pnlRow(1, 0, 100000), pnlRow(2, 0, 100000), pnlRow(3, 0, 100000),
        pnlRow(4, 0, 999, -99001), pnlRow(5, -3, 996), pnlRow(6, -6, 993)];
    const kept = RM.computeTimeWeightedReturnsFromHist(dust);
    assert.deepEqual(kept, [0, 0, 0, 0]);
    // A base exactly at the floor is kept.
    const atFloor = [pnlRow(0, 0, 100000), pnlRow(1, 0, 100000), pnlRow(2, 0, 100000), pnlRow(3, 0, 1000, -99000), pnlRow(4, 3, 1003)];
    const r = RM.computeTimeWeightedReturnsFromHist(atFloor);
    assert.equal(r.length, 4);
    assert.ok(close(r[3], 0.003, 1e-12), `got ${r[3]}`);
});

// ---------------------------------------------------------------------------
// Compounding and Calmar.
// ---------------------------------------------------------------------------

test('compoundReturns: compounded return, CAGR over the given years, and Calmar = CAGR ÷ max drawdown of the compounded curve', () => {
    // Wealth 1 → 1.1 → 0.55 → 0.66: compounded −34%, max drawdown 50%,
    // CAGR over 2 years 0.66^(1/2) − 1 ≈ −0.187596.
    const s = RM.compoundReturns([0.1, -0.5, 0.2], 2);
    assert.ok(close(s.compounded, -0.34, 1e-12));
    assert.ok(close(s.maxDrawdownPct, 50, 1e-9));
    assert.ok(close(s.cagr, -0.187596, 1e-6), `got ${s.cagr}`);
    assert.ok(close(s.calmar, -0.375192, 1e-6), `got ${s.calmar}`);
    assert.equal(RM.compoundReturns([0.1, -0.5, 0.2], 0).calmar, null, 'no elapsed time, no CAGR');
    assert.equal(RM.compoundReturns([0.1, 0.2], 1).calmar, null, 'no drawdown, no Calmar');
});

test('compoundReturns reads no drawdown, and no Calmar, when the compounded drawdown displays as 0.0%', () => {
    // A −1e-9 return draws the curve down by 1e-7 %, which the Calmar
    // caption shows as 0.0%; dividing by it gave a ratio in the millions.
    const tiny = RM.compoundReturns([0.01, 0.02, -1e-9, 0.03], 1);
    assert.equal(tiny.maxDrawdownPct, null);
    assert.equal(tiny.calmar, null);
    // Either side of the 0.05% that rounds to 0.1%: 0.049% reads as none,
    // 0.051% keeps its drawdown and its Calmar.
    assert.equal(RM.compoundReturns([0.01, -0.00049], 1).maxDrawdownPct, null);
    const shown = RM.compoundReturns([0.01, -0.00051], 1);
    assert.ok(close(shown.maxDrawdownPct, 0.051, 1e-9), `got ${shown.maxDrawdownPct}`);
    assert.notEqual(shown.calmar, null);
});

test('historicalPnlYears counts calendar time from the first to the last row, hours without capital included', () => {
    // A year of daily rows, the first half on an empty account: the
    // sample-adequacy span counts only the funded half.
    const DAYS = 366;
    const rows = Array.from({ length: DAYS }, (_, d) => pnlRow(24 * d, d % 2, d < DAYS / 2 ? 0 : 1000));
    const years = RM.historicalPnlYears(rows.slice().reverse());
    assert.ok(close(years, 365 / 365.25, 1e-9), `got ${years}`);
    const rets = RM.computeTimeWeightedReturnsFromHist(rows);
    const adq = RM.assessAdequacy(rets, rows.map(r => r.createdAt), rows.length);
    assert.ok(adq.years < years * 0.6, `adequacy span ${adq.years} counts funded periods only`);
});

// ---------------------------------------------------------------------------
// Per-trade return on equity at open, and its annualized ratios.
// ---------------------------------------------------------------------------

const closedOn = (createdAt, closedAt, profit, extra = {}) => ({
    market: 'BTC-USD', status: 'CLOSED', side: 'LONG', createdAt, closedAt, profit, complete: true,
    peakSize: 1, entryVwap: 100, ...extra
});

test('tradeReturnsOnEquity divides profit by the equity of the /historical-pnl row at or before the open', () => {
    const rows = [pnlRow(1, 0, 2000), pnlRow(0, 0, 1000), pnlRow(2, 0, 0)];
    const positions = [
        closedOn(atHour(0.5), atHour(3), 100),              // row at hour 0: 1000
        closedOn(atHour(1), atHour(3), -50),                // row exactly at the open: 2000
        closedOn('2024-12-31T23:00:00.000Z', atHour(3), 10), // before the first row
        closedOn(atHour(2.5), atHour(3), 10),               // the row's equity is 0
        closedOn(atHour(0.5), atHour(3), 10, { complete: false })
    ];
    assert.deepEqual(RM.tradeReturnsOnEquity(positions, rows), [0.1, -0.025, null, null, null]);
});

const YEAR_MS = 365.25 * 24 * 3600000;
const EQUITY_ROW = [{ createdAt: '2024-12-01T00:00:00.000Z', totalPnl: '0', equity: '100000', netTransfers: '0' }];
// Decisive trades with these profits, each opened an hour before its close.
const tradesClosedAt = (closesMs, profits) => closesMs.map((ms, i) => closedOn(
    new Date(ms - 3600000).toISOString(), new Date(ms).toISOString(), profits[i]));

test('perTradeRatios annualizes by √((n − 1) ÷ span) over the close times', () => {
    // Returns 0.02, −0.01, 0.03 over one year: 2 intervals per year.
    // Per-trade Sharpe = 0.013333 / 0.020817 = 0.640513, × √2 = 0.905822.
    const trades = tradesClosedAt([H0, H0 + YEAR_MS / 2, H0 + YEAR_MS], [2000, -1000, 3000]);
    const s = RM.perTradeRatios(trades, EQUITY_ROW, 2);
    assert.equal(s.ok, true, s.reason);
    assert.ok(close(s.tpy, 2, 1e-9), `tpy ${s.tpy}`);
    assert.ok(close(s.sharpe, 0.905822, 1e-6), `sharpe ${s.sharpe}`);
    assert.ok(close(s.compounded, 1.02 * 0.99 * 1.03 - 1, 1e-12));
});

test('perTradeRatios reads — with a reason, never an unannualized value, when the closes span under a month', () => {
    const sameInstant = tradesClosedAt([H0, H0, H0], [2000, -1000, 3000]);
    const zero = RM.perTradeRatios(sameInstant, EQUITY_ROW, 2);
    assert.equal(zero.ok, false);
    assert.match(zero.reason, /month/);
    const DAYS_20 = 20 * 24 * 3600000;
    const short = RM.perTradeRatios(tradesClosedAt([H0, H0 + DAYS_20 / 2, H0 + DAYS_20], [2000, -1000, 3000]), EQUITY_ROW, 2);
    assert.equal(short.ok, false);
    assert.match(short.reason, /month/);
    assert.equal(short.sharpe, undefined);
});

test('perTradeRatios needs the minimum trade count and every trade\'s equity at open', () => {
    const trades = tradesClosedAt([H0, H0 + YEAR_MS / 2, H0 + YEAR_MS], [2000, -1000, 3000]);
    const few = RM.perTradeRatios(trades, EQUITY_ROW, 5);
    assert.equal(few.ok, false);
    assert.match(few.reason, /5 decisive trades \(have 3\)/);
    const noEquity = RM.perTradeRatios(trades, [{ createdAt: atHour(0), totalPnl: '0', equity: '0', netTransfers: '0' }], 2);
    assert.equal(noEquity.ok, false);
    assert.match(noEquity.reason, /equity at open/i);
});

test('perTradeRatios reads — naming the trades whose close time does not parse, never a ratio over the rest', () => {
    const trades = tradesClosedAt([H0, H0 + YEAR_MS / 3, H0 + 2 * YEAR_MS / 3, H0 + YEAR_MS], [2000, -1000, 3000, -500]);
    trades[1].closedAt = 'not-a-date';
    const s = RM.perTradeRatios(trades, EQUITY_ROW, 2);
    assert.equal(s.ok, false);
    assert.equal(s.n, 4);
    assert.equal(s.reason, '1 of 4 trades without a valid close time');
});

test('equity at open is the Modified Dietz base: the prior row\'s equity plus the next row\'s inflow', () => {
    // An empty account funded with $100000 at 10:05, recorded on the 11:00
    // row's netTransfers; a trade opened at 10:20 earned $1000.
    const rows = [pnlRow(10, 0, 0), pnlRow(11, 1000, 101000, 100000)];
    const positions = [
        closedOn(atHour(10.33), atHour(10.9), 1000),
        closedOn(atHour(9.5), atHour(10.9), 500),             // before every row: 0 + the first row's inflow (0)
    ];
    assert.deepEqual(RM.tradeReturnsOnEquity(positions, rows), [0.01, null]);
    // A dust balance before the deposit joins the deposit, not replaces it.
    const dust = [pnlRow(10, 0, 100), pnlRow(11, 1000, 101100, 100000)];
    assert.deepEqual(RM.tradeReturnsOnEquity(positions.slice(0, 1), dust), [1000 / 100100]);
    // The first row after an open that precedes every row carries the deposit.
    const first = [pnlRow(11, 1000, 101000, 100000)];
    assert.deepEqual(RM.tradeReturnsOnEquity([closedOn(atHour(10.5), atHour(10.9), 1000)], first), [0.01]);
});

test('equity at open below the account-wide dust floor gives the trade no return, as the time-weighted returns drop that period', () => {
    // $1M of equity, except hours 10-11 on $100 after a near-total
    // withdrawal; the money returns on hour 12's row. A trade opened at
    // 10:30 lost $5000 on that $100 base.
    const MILLION = 1000000, DUST = 100;
    const rows = Array.from({ length: 13 }, (_, h) => (
        h === 10 ? pnlRow(h, 0, DUST, DUST - MILLION)
            : h === 11 ? pnlRow(h, 0, DUST)
                : h === 12 ? pnlRow(h, 0, MILLION, MILLION - DUST)
                    : pnlRow(h, 0, MILLION)));
    assert.equal(RM.computeTimeWeightedReturnsFromHist(rows).length, rows.length - 2, 'the 10:00 → 11:00 period is dust');
    const funded = closedOn(atHour(2.5), atHour(3), 1000);
    const onDust = closedOn(atHour(10.5), atHour(10.9), -5000);
    assert.deepEqual(RM.tradeReturnsOnEquity([funded, onDust], rows), [1000 / MILLION, null]);
    assert.match(RM.perTradeRatios([funded, onDust], rows, 2).reason, /^No funded equity at open for 1 of 2 trades$/);
});

test('perTradeRatios names a trade without funded equity at open', () => {
    const trades = tradesClosedAt([H0, H0 + YEAR_MS / 2, H0 + YEAR_MS], [2000, -1000, 3000]);
    const out = RM.perTradeRatios(trades, [{ createdAt: atHour(0), totalPnl: '0', equity: '0', netTransfers: '0' }], 2);
    assert.equal(out.ok, false);
    assert.match(out.reason, /^No funded equity at open for 3 of 3 trades$/);
});

test('per-trade Calmar compounds over the calendar time from the first open to the last close', () => {
    // A: open day 0, close day 180, +10%. B: open day 180, close day 215, −5%.
    // Wealth 1.045 over 215 days: CAGR 7.764%, drawdown 5%, Calmar 1.553.
    const DAY_MS = 24 * 3600000;
    const trades = [
        closedOn(new Date(H0).toISOString(), new Date(H0 + 180 * DAY_MS).toISOString(), 10000),
        closedOn(new Date(H0 + 180 * DAY_MS).toISOString(), new Date(H0 + 215 * DAY_MS).toISOString(), -5000),
    ];
    const s = RM.perTradeRatios(trades, EQUITY_ROW, 2);
    assert.equal(s.ok, true, s.reason);
    assert.ok(close(s.calmar, 1.553, 1e-3), `calmar ${s.calmar}`);
    assert.ok(close(s.maxDrawdownPct, 5, 1e-9), `drawdown ${s.maxDrawdownPct}`);
});

test('compoundReturns reads no compounded return, CAGR or Calmar once wealth reaches zero or below', () => {
    for (const returns of [[0.1, -1.2, 0.1], [-1.2, -1.2], [0.5, -1]]) {
        assert.deepEqual(RM.compoundReturns(returns, 1),
            { compounded: null, cagr: null, maxDrawdownPct: null, calmar: null }, returns.join(','));
    }
});

test('a peak plateau is dated at its last row in every drawdown view', () => {
    const DAY = 24;
    const plateaus = {
        two: [pnlRow(0, 0), pnlRow(DAY, 100), pnlRow(19 * DAY, 100), pnlRow(20 * DAY, 40)],
        three: [pnlRow(0, 0), pnlRow(DAY, 100), pnlRow(9 * DAY, 100), pnlRow(19 * DAY, 100), pnlRow(20 * DAY, 40)],
    };
    const peakAt = atHour(19 * DAY);
    for (const [rowsAtPeak, rows] of Object.entries(plateaus)) {
        assert.equal(RM.histPnlDrawdown(rows).peakAt, peakAt, rowsAtPeak);
        assert.equal(RM.histPnlDrawdownEvents(rows)[0].peakAt, peakAt, rowsAtPeak);
        assert.equal(RM.histPnlCurrentDrawdown(rows).peakAt, peakAt, rowsAtPeak);
    }
});

test('a loss already in the first /historical-pnl row is measured from the inception value 0', () => {
    const rows = [pnlRow(0, -5000), pnlRow(1, -6000), pnlRow(2, -8000)];
    const worst = RM.histPnlDrawdown(rows);
    assert.equal(worst.dollarDrawdown, 8000);
    assert.equal(worst.peakValue, 0);
    assert.equal(worst.peakAt, atHour(0));
    const current = RM.histPnlCurrentDrawdown(rows);
    assert.equal(current.dollarDrawdown, 8000);
    assert.equal(current.peakAt, atHour(0));
    assert.equal(RM.histPnlDrawdownEvents(rows)[0].peakCum, 0);
    assert.equal(RM.histPnlMonthly(rows)['2025-01'].delta, -8000, 'the month measures from the same 0');
});

test('rows that do not reach inception get no inception value, and the month they start in reads unknown with the reason', () => {
    const CUT = 'Historical profit before 2025-02-10 not in cached snapshot';
    const rows = [
        { createdAt: '2025-02-10T00:00:00.000Z', totalPnl: '1000', equity: '0', netTransfers: '0' },
        { createdAt: '2025-02-28T23:00:00.000Z', totalPnl: '1200', equity: '0', netTransfers: '0' },
        { createdAt: '2025-03-15T00:00:00.000Z', totalPnl: '900', equity: '0', netTransfers: '0' },
        { createdAt: '2025-03-31T23:00:00.000Z', totalPnl: '1100', equity: '0', netTransfers: '0' },
    ];
    assert.deepEqual(RM.buildCumulativeTotalPnlSeries(rows, null, CUT)[0], { t: rows[0].createdAt, c: 1000 });
    assert.deepEqual(RM.buildCumulativeTotalPnlSeries(rows)[0], { t: rows[0].createdAt, c: 0 }, 'complete rows keep it');
    const monthly = RM.histPnlMonthly(rows, null, CUT);
    assert.deepEqual(monthly['2025-02'], { delta: null, start: null, end: null, hasData: true, reason: CUT });
    assert.equal(monthly['2025-03'].delta, -100);
    const drawdowns = RM.histPnlMonthlyDrawdown(rows, null, CUT);
    assert.deepEqual(drawdowns['2025-02'], { dollarDrawdown: null, peakValue: null, troughValue: null, reason: CUT });
    assert.equal(drawdowns['2025-03'].dollarDrawdown, 300);
});

test('a month\'s returns are those ending in it, on the account-wide dust floor', () => {
    // 10 January rows at $1M of equity, then February on $2000: the floor
    // is 1% of the account's median ($10000), so every February-base return is dust.
    const jan = Array.from({ length: 10 }, (_, i) => ({
        createdAt: new Date(Date.UTC(2025, 0, 31, 14 + i)).toISOString(), totalPnl: String(i % 2 ? 100 : 0), equity: '1000000', netTransfers: '0' }));
    const feb = Array.from({ length: 6 }, (_, i) => ({
        createdAt: new Date(Date.UTC(2025, 1, 1, i)).toISOString(), totalPnl: String(i % 2 ? -1000 : -900), equity: '2000', netTransfers: '0' }));
    const byMonth = RM.timeWeightedReturnsByMonth([...jan, ...feb]);
    assert.equal(byMonth['2025-01'].length, 9);
    // February keeps only the boundary hour, which ends at its first row on
    // January's $1M base: 0 → −900 after a +100 row reads −1000 / 1e6.
    assert.equal(byMonth['2025-02'].length, 1);
    assert.ok(close(byMonth['2025-02'][0], -1000 / 1000000, 1e-12), `got ${byMonth['2025-02'][0]}`);
});

test('a return spanning a month without rows is in no month, as that month\'s PROFIT is unknown', () => {
    // Hourly rows on Jan 31 and Mar 1, none in February; the gap return
    // carries a −30% move. A December → January boundary hour still counts.
    const at = (iso, totalPnl) => ({ createdAt: iso, totalPnl: String(totalPnl), equity: '1000000', netTransfers: '0' });
    const rows = [
        at('2029-12-31T23:00:00.000Z', 0), at('2030-01-01T00:00:00.000Z', 100),
        at('2030-01-31T22:00:00.000Z', 0), at('2030-01-31T23:00:00.000Z', 100),
        at('2030-03-01T00:00:00.000Z', -300000), at('2030-03-01T01:00:00.000Z', -299000), at('2030-03-01T02:00:00.000Z', -299500),
    ];
    const byMonth = RM.timeWeightedReturnsByMonth(rows);
    assert.deepEqual(byMonth['2030-03'], [1000 / 1000000, -500 / 1000000]);
    assert.equal(RM.histPnlMonthly(rows)['2030-03'].delta, null, 'March\'s PROFIT is unknown for the same reason');
    assert.deepEqual(byMonth['2030-01'], [100 / 1000000, -100 / 1000000, 100 / 1000000]);
});

test('the VaR sample keeps returns over at most 1.5 median sampling intervals', () => {
    // Hourly rows; a 1.5 h step is kept, a 3 h step carrying a 50% loss is not.
    const hours = [0, 1, 2, 3, 4.5, 7.5, 8.5, 9.5];
    const pnl = [0, 10, 0, 10, 0, -500, -490, -500];
    const rows = hours.map((h, i) => pnlRow(h, pnl[i]));
    const all = RM.computeTimeWeightedReturnsFromHist(rows);
    const sample = RM.varSampleReturns(rows);
    assert.equal(all.length, 7);
    assert.deepEqual(sample, all.filter((_, i) => i !== 4));
    assert.ok(!sample.some(r => r <= -0.5));
});

test('the VaR sample keeps a return over exactly the median ÷ 1.5 and drops one a millisecond shorter', () => {
    // Three-hourly rows (median 3 h, so the band's lower edge is 2 h): one
    // step of exactly 2 h, one of 2 h less a millisecond.
    const { MS_PER_HOUR } = globalThis.AppConstants;
    const ONE_MS = 1;
    const SAMPLING_MS = 3 * MS_PER_HOUR;
    const lowerEdgeMs = SAMPLING_MS / RM.VAR_MAX_INTERVAL_MULTIPLE;
    const steps = [SAMPLING_MS, SAMPLING_MS, SAMPLING_MS, SAMPLING_MS, lowerEdgeMs, SAMPLING_MS, SAMPLING_MS,
        lowerEdgeMs - ONE_MS, SAMPLING_MS + ONE_MS, SAMPLING_MS];
    const tooShort = steps.indexOf(lowerEdgeMs - ONE_MS);
    let t = H0;
    const rows = [pnlRow(0, 0)];
    steps.forEach((step, i) => {
        t += step;
        rows.push({ ...pnlRow(0, (i + 1) * 10), createdAt: new Date(t).toISOString() });
    });
    const all = RM.computeTimeWeightedReturnsFromHist(rows);
    assert.equal(all.length, steps.length);
    assert.deepEqual(RM.varSampleReturns(rows), all.filter((_, i) => i !== tooShort));
});

test('the VaR sample needs as many returns of its own as the Sharpe gate: 29 read a reason naming the count, 30 none', () => {
    const MIN_RETURNS = 30;
    const WEEKLY_PPY = 52;
    const returns = (n) => Array.from({ length: n }, (_, i) => (i - 5) / 1000);
    assert.equal(RM.varSampleGap(returns(MIN_RETURNS - 1), WEEKLY_PPY),
        `Only ${MIN_RETURNS - 1} returns span one sampling period (need ≥${MIN_RETURNS})`);
    assert.equal(RM.varSampleGap(returns(1), WEEKLY_PPY), `Only 1 return spans one sampling period (need ≥${MIN_RETURNS})`);
    assert.equal(RM.varSampleGap(returns(MIN_RETURNS), WEEKLY_PPY), '');
});

test('the VaR sample needs a month spanned by its own returns, as the Sharpe gate does', () => {
    // 31 hourly one-period returns span about 31 hours.
    const { MS_PER_YEAR, MS_PER_HOUR, MONTHS_PER_YEAR } = globalThis.AppConstants;
    const HOURLY_PPY = MS_PER_YEAR / MS_PER_HOUR;
    const HOURS_IN_SAMPLE = 31;
    const MONTH_OF_HOURS = Math.ceil(HOURLY_PPY / MONTHS_PER_YEAR);
    const returns = (n) => Array.from({ length: n }, (_, i) => (i - 5) / 1000);
    assert.equal(RM.varSampleGap(returns(HOURS_IN_SAMPLE), HOURLY_PPY),
        'Need ≥1 month of valid data (have 0.0 months)');
    assert.equal(RM.varSampleGap(returns(MONTH_OF_HOURS), HOURLY_PPY), '');
});

test('a month\'s MAX DD runs from the prior month-end, so a drop at the boundary counts', () => {
    // August flat at 10000; September opens at 2000 and rises to 5595.
    const monthly = RM.histPnlMonthlyDrawdown([
        { createdAt: '2025-08-01T00:00:00.000Z', totalPnl: '10000', equity: '0', netTransfers: '0' },
        { createdAt: '2025-08-31T23:00:00.000Z', totalPnl: '10000', equity: '0', netTransfers: '0' },
        { createdAt: '2025-09-01T00:00:00.000Z', totalPnl: '2000', equity: '0', netTransfers: '0' },
        { createdAt: '2025-09-20T00:00:00.000Z', totalPnl: '5595', equity: '0', netTransfers: '0' },
    ]);
    assert.equal(monthly['2025-09'].dollarDrawdown, 8000);
    assert.equal(monthly['2025-08'].dollarDrawdown, 0, 'a flat month with data has a $0 drawdown');
});

test('a month\'s MAX DD needs two points: one row plus the prior month-end, or the live point', () => {
    const rows = [
        { createdAt: '2025-09-30T23:00:00.000Z', totalPnl: '1000', equity: '0', netTransfers: '0' },
        { createdAt: '2025-10-01T00:30:00.000Z', totalPnl: '600', equity: '0', netTransfers: '0' },
        { createdAt: '2025-12-01T00:00:00.000Z', totalPnl: '500', equity: '0', netTransfers: '0' },
    ];
    const live = { t: '2025-12-01T00:59:00.000Z', c: 450 };
    const monthly = RM.histPnlMonthlyDrawdown(rows, live);
    assert.equal(monthly['2025-10'].dollarDrawdown, 400, 'one October row plus September\'s end');
    assert.equal(monthly['2025-11'].dollarDrawdown, null);
    assert.equal(monthly['2025-11'].reason, RM.NO_MONTH_ROWS_REASON);
    assert.equal(monthly['2025-12'].dollarDrawdown, 50, 'after a gap month: the row plus the live point');
    const noLive = RM.histPnlMonthlyDrawdown(rows);
    assert.equal(noLive['2025-12'].dollarDrawdown, null);
    assert.match(noLive['2025-12'].reason, /2 points/);
});

// The worst drawdown is the deepest as displayed (Format.drawdownAsDisplayed:
// the displayed peak less the displayed trough), the raw depth breaking
// ties, so it is the Drawdown Periods table's top row on every path.
// Synthetic series: raw depths 10.4 (+$1 → -$10, shown $11) and 10.6
// (+$20 → +$10, shown $10).
const DISPLAYED_DEEPER = [0.6, -9.8, 0.6, 20.4, 9.8, 20.4];

test('the worst drawdown is the deepest event as displayed, on /historical-pnl, the closed-trade path and each month', () => {
    const rows = DISPLAYED_DEEPER.map((v, i) => ({ createdAt: `2025-09-0${i + 1}T00:00:00.000Z`, totalPnl: String(v), equity: '0', netTransfers: '0' }));
    const worst = RM.histPnlDrawdown(rows);
    assert.equal(worst.peakValue, 0.6);
    assert.equal(worst.troughValue, -9.8);
    assert.equal(worst.peakAt, rows[0].createdAt);
    assert.equal(worst.troughAt, rows[1].createdAt);

    const trades = DISPLAYED_DEEPER.map((v, i) => ({
        status: 'CLOSED', closedAt: rows[i].createdAt, profit: v - (i ? DISPLAYED_DEEPER[i - 1] : 0), complete: true
    }));
    const tradeWorst = RM.tradeSystemDrawdown(trades);
    assert.equal(tradeWorst.peakAt, rows[0].createdAt);
    assert.equal(tradeWorst.troughAt, rows[1].createdAt);

    const month = RM.histPnlMonthlyDrawdown(rows)['2025-09'];
    assert.equal(month.peakValue, 0.6);
    assert.equal(month.troughValue, -9.8);
});

// Two drawdowns that both display as $10 (raw 9.6, then 10.4): the
// deeper raw depth ranks first though it came second.
const SHOWN_ALIKE = [0, 9.6, 0, 20.4, 10];

test('drawdowns that display alike rank by their raw depth, the later deeper one first', () => {
    const rows = SHOWN_ALIKE.map((v, i) => ({ createdAt: `2025-09-0${i + 1}T00:00:00.000Z`, totalPnl: String(v), equity: '0', netTransfers: '0' }));
    const events = RM.histPnlDrawdownEvents(rows);
    assert.deepEqual(events.map(ev => ev.shownDepth), [10, 10]);
    assert.deepEqual(events.slice().sort(RM.deeperDrawdownFirst).map(ev => ev.peakCum), [20.4, 9.6]);
    const worst = RM.histPnlDrawdown(rows);
    assert.equal(worst.peakValue, 20.4);
    assert.equal(worst.troughValue, 10);
});

// A drawdown ends at the first point whose gap to its peak displays as $0
// (the rule by which Current Drawdown reads at peak), and the peak restarts
// there: a later dip is its own drawdown.
const REGAINED_AS_DISPLAYED = [0, 100, 50, 99.8, 60, 120];

test('a drawdown recovers where its gap to the peak displays as $0, and the next dip is its own drawdown, on every path', () => {
    const hour = h => `2025-09-01T0${h}:00:00.000Z`;
    const rows = REGAINED_AS_DISPLAYED.map((v, h) => ({ createdAt: hour(h), totalPnl: String(v), equity: '0', netTransfers: '0' }));
    const summary = evs => evs.map(ev => [ev.peakAt, ev.troughAt, ev.recoveryAt, ev.shownDepth]);
    const expected = [[hour(1), hour(2), hour(3), 50], [hour(3), hour(4), hour(5), 40]];
    assert.deepEqual(summary(RM.histPnlDrawdownEvents(rows)), expected);

    const trades = REGAINED_AS_DISPLAYED.map((v, h) => ({
        status: 'CLOSED', closedAt: hour(h), profit: v - (h ? REGAINED_AS_DISPLAYED[h - 1] : 0), complete: true
    }));
    assert.deepEqual(summary(RM.tradeSystemDrawdownEvents(trades)), expected);

    // Ending in the second dip: Current Drawdown's peak is where the first
    // drawdown recovered, the ongoing event's peak.
    const ongoing = rows.slice(0, 5);
    const current = RM.histPnlCurrentDrawdown(ongoing);
    const last = RM.histPnlDrawdownEvents(ongoing).at(-1);
    assert.equal(current.peakAt, hour(3));
    assert.equal(last.peakAt, current.peakAt);
});

test('a month\'s MAX DD carries its peak and trough, $0 apart for a month that never drew down, null without a scan', () => {
    const monthly = RM.histPnlMonthlyDrawdown([
        { createdAt: '2025-08-01T00:00:00.000Z', totalPnl: '100.5', equity: '0', netTransfers: '0' },
        { createdAt: '2025-08-31T23:00:00.000Z', totalPnl: '100.5', equity: '0', netTransfers: '0' },
        { createdAt: '2025-10-01T00:00:00.000Z', totalPnl: '50', equity: '0', netTransfers: '0' },
    ], { t: '2025-10-01T01:00:00.000Z', c: 0.4 });
    assert.equal(monthly['2025-08'].dollarDrawdown, 0);
    assert.ok(Number.isFinite(monthly['2025-08'].peakValue));
    assert.equal(monthly['2025-08'].troughValue, monthly['2025-08'].peakValue);
    assert.equal(monthly['2025-09'].peakValue, null);
    assert.equal(monthly['2025-09'].troughValue, null);
    assert.equal(monthly['2025-10'].peakValue, 50);
    assert.equal(monthly['2025-10'].troughValue, 0.4);
});

// ---------------------------------------------------------------------------
// The inception period of the time-weighted returns, and the trade-system
// series' order within one millisecond and its end at now.
// ---------------------------------------------------------------------------

test('rows that reach inception open the time-weighted returns with the period from inception to the first row', () => {
    // $10000 deposited at inception; the first row already holds −$100.
    const rows = [pnlRow(0, -100, 9900, 10000), pnlRow(1, 0, 10000), pnlRow(2, 50, 10050)];
    const fromInception = RM.computeTimeWeightedReturnsFromHist(rows);
    assert.equal(fromInception.length, 3);
    assert.ok(close(fromInception[0], -0.01, 1e-12), `got ${fromInception[0]}`);
    assert.ok(close(fromInception[1], 100 / 9900, 1e-12), `got ${fromInception[1]}`);
    assert.deepEqual(RM.timeWeightedReturnsByMonth(rows)['2025-01'], fromInception);
    assert.deepEqual(RM.varSampleReturns(rows), fromInception.slice(1),
        'the inception period has no known length, so it is no one-interval outcome');

    const CUT = 'Historical profit before 2025-01-01 00:00 UTC not in cached snapshot';
    assert.deepEqual(RM.computeTimeWeightedReturnsFromHist(rows, CUT), fromInception.slice(1));
    assert.deepEqual(RM.timeWeightedReturnsByMonth(rows, CUT)['2025-01'], fromInception.slice(1));
});

// A closed position with complete attribution whose closing fill is `fill`.
const closedBy = (fill, profit) => ({
    status: 'CLOSED', closedAt: fill.createdAt, profit, complete: true, portions: [{ fill }]
});

test('closes in one millisecond enter the trade-system series in chain order, whatever order they are listed in', () => {
    const block = (h, height) => ({ createdAt: atHour(h), createdAtHeight: String(height) });
    const first = closedBy(block(0, 1), 500);
    const lossFill = block(12, 2);
    const winFill = block(12, 2);
    const loss = closedBy(lossFill, -100);
    const win = closedBy(winFill, 100);
    const lossFirst = [first.portions[0].fill, lossFill, winFill];
    const winFirst = [first.portions[0].fill, winFill, lossFill];
    for (const listed of [[first, win, loss], [first, loss, win]]) {
        // 500 → 400 → 500: a $100 drawdown, recovered in the same block.
        const recovered = RM.tradeSystemDrawdownEvents(listed, { fills: lossFirst });
        assert.equal(recovered.length, 1);
        assert.equal(recovered[0].recoveryAt, atHour(12));
        assert.equal(RM.tradeSystemCurrentDrawdown(listed, { fills: lossFirst }).dollarDrawdown, 0);
        // 500 → 600 → 500: $100 below the 600 peak, ongoing.
        const ongoing = RM.tradeSystemDrawdownEvents(listed, { fills: winFirst });
        assert.equal(ongoing.length, 1);
        assert.equal(ongoing[0].recoveryAt, null);
        assert.equal(ongoing[0].peakCum, 600);
        assert.equal(RM.tradeSystemCurrentDrawdown(listed, { fills: winFirst }).dollarDrawdown, 100);
        assert.equal(RM.tradeSystemDrawdown(listed, { fills: winFirst }).dollarDrawdown, 100);
    }
});

test('the trade-system series ends now, so its time below peak runs to now, not to the last close', () => {
    const positions = [closedBy({ createdAt: atHour(1) }, 300), closedBy({ createdAt: atHour(2) }, -100)];
    const nowMs = H0 + 74 * 3600000;
    const current = RM.tradeSystemCurrentDrawdown(positions, { nowMs });
    assert.equal(current.dollarDrawdown, 100);
    assert.equal(current.peakAt, atHour(1));
    assert.equal(current.currentAt, atHour(74));
    const [event] = RM.tradeSystemDrawdownEvents(positions, { nowMs });
    assert.equal(event.recoveryAt, null);
    assert.equal(event.endAt, atHour(74));
    assert.equal(RM.tradeSystemDrawdown(positions, { nowMs }).n, 2, 'n counts closed trades');
});

test('a drawdown whose gap to its peak displays as $0 at the live point recovers there', () => {
    const rows = [pnlRow(0, 0), pnlRow(1, 1000), pnlRow(2, 0)];
    const [event] = RM.histPnlDrawdownEvents(rows, { t: atHour(3), c: 999.7 });
    assert.equal(event.recoveryAt, atHour(3));
    assert.equal(event.endAt, atHour(3));
});
