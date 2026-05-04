'use strict';

// PortfolioCache tests. Covers the pure helpers (pack/unpack/evictOnce) that
// drive the localStorage cache, plus a round-trip and a quota-eviction
// integration test against an in-memory localStorage + LZString stub.
//
// portfolio-cache.js targets the browser via `window.PortfolioCache = {...}`.
// We shim window onto globalThis (mirroring test/setup.js) and inject
// `localStorage` and `LZString` stubs before requiring the module.

const test = require('node:test');
const assert = require('node:assert/strict');

globalThis.window = globalThis;

function makeLocalStorage(quotaBytes) {
    const map = new Map();
    function used() {
        let total = 0;
        for (const [k, v] of map) total += (k.length + v.length) * 2;
        return total;
    }
    return {
        _map: map,
        getItem(k) { return map.has(k) ? map.get(k) : null; },
        setItem(k, v) {
            v = String(v);
            if (quotaBytes !== undefined) {
                const prev = map.has(k) ? (k.length + map.get(k).length) * 2 : 0;
                const next = used() - prev + (k.length + v.length) * 2;
                if (next > quotaBytes) {
                    const e = new Error('QuotaExceededError');
                    e.name = 'QuotaExceededError';
                    throw e;
                }
            }
            map.set(k, v);
        },
        removeItem(k) { map.delete(k); }
    };
}

// Identity "compression" so the stored payload is human-inspectable in tests
// and round-trip equality is exact. The marker prefix lets the read path
// distinguish a real compressed value from raw JSON written by accident.
const LZStringStub = {
    compressToUTF16(s) { return 'C:' + s; },
    decompressFromUTF16(s) {
        if (typeof s !== 'string') return '';
        return s.startsWith('C:') ? s.slice(2) : '';
    }
};

globalThis.localStorage = makeLocalStorage();
globalThis.LZString = LZStringStub;

require('../portfolio-cache.js');
const Cache = globalThis.window.PortfolioCache;
const Internal = Cache._internal;

// ---------------------------------------------------------------------------
// pack
// ---------------------------------------------------------------------------

test('pack lowercases address, sets v=1, includes timestamp and data', () => {
    const before = Date.now();
    const p = Internal.pack('DyDx1ABC', { foo: 1 });
    const after = Date.now();
    assert.equal(p.v, 1);
    assert.equal(p.address, 'dydx1abc');
    assert.deepEqual(p.data, { foo: 1 });
    assert.ok(p.fetchedAt >= before && p.fetchedAt <= after);
});

test('pack tolerates null/undefined address', () => {
    assert.equal(Internal.pack(null, {}).address, '');
    assert.equal(Internal.pack(undefined, {}).address, '');
});

// ---------------------------------------------------------------------------
// unpack
// ---------------------------------------------------------------------------

test('unpack returns null for non-object inputs', () => {
    assert.equal(Internal.unpack(null, 'addr'), null);
    assert.equal(Internal.unpack(undefined, 'addr'), null);
    assert.equal(Internal.unpack('string', 'addr'), null);
});

test('unpack returns null on schema version mismatch', () => {
    const p = { v: 999, address: 'a', fetchedAt: 0, data: {} };
    assert.equal(Internal.unpack(p, 'a'), null);
});

test('unpack returns null on missing data', () => {
    const p = { v: 1, address: 'a', fetchedAt: 0 };
    assert.equal(Internal.unpack(p, 'a'), null);
});

test('unpack returns null on address mismatch', () => {
    const p = { v: 1, address: 'addra', fetchedAt: 0, data: {} };
    assert.equal(Internal.unpack(p, 'addrb'), null);
});

test('unpack matches case-insensitively and returns the parsed object', () => {
    const p = { v: 1, address: 'dydx1abc', fetchedAt: 0, data: { x: 1 } };
    assert.deepEqual(Internal.unpack(p, 'DYDX1ABC'), p);
});

// ---------------------------------------------------------------------------
// evictOnce — step order: fills, fundingPayments, historicalPnl(trim), closedPositions
// ---------------------------------------------------------------------------

test('evictOnce step 0 drops fills and preserves other fields', () => {
    const packed = { v: 1, address: 'a', fetchedAt: 0, data: { fills: [1, 2, 3], orders: 'keep' } };
    const out = Internal.evictOnce(packed, 0);
    assert.ok(out);
    assert.equal(out.data.fills, undefined);
    assert.equal(out.data.orders, 'keep');
    // Input is not mutated.
    assert.deepEqual(packed.data.fills, [1, 2, 3]);
});

test('evictOnce step 1 drops fundingPayments', () => {
    const packed = { v: 1, address: 'a', fetchedAt: 0, data: { fundingPayments: [1], other: 2 } };
    const out = Internal.evictOnce(packed, 1);
    assert.ok(out);
    assert.equal(out.data.fundingPayments, undefined);
    assert.equal(out.data.other, 2);
});

test('evictOnce step 2 trims historicalPnl with nested {historicalPnl: [...]} wrapper', () => {
    const arr = Array.from({ length: 6000 }, (_, i) => ({ totalPnl: String(i) }));
    const packed = { v: 1, address: 'a', fetchedAt: 0, data: { historicalPnl: { historicalPnl: arr } } };
    const out = Internal.evictOnce(packed, 2);
    assert.ok(out);
    assert.equal(out.data.historicalPnl.historicalPnl.length, Internal.HISTORICAL_PNL_TRIM);
    // Last row preserved (we keep the most recent rows for the chart).
    assert.equal(out.data.historicalPnl.historicalPnl[Internal.HISTORICAL_PNL_TRIM - 1].totalPnl, '5999');
});

test('evictOnce step 2 trims historicalPnl with plain array shape', () => {
    const arr = Array.from({ length: 6000 }, (_, i) => i);
    const packed = { v: 1, address: 'a', fetchedAt: 0, data: { historicalPnl: arr } };
    const out = Internal.evictOnce(packed, 2);
    assert.ok(out);
    assert.equal(out.data.historicalPnl.length, Internal.HISTORICAL_PNL_TRIM);
    assert.equal(out.data.historicalPnl[Internal.HISTORICAL_PNL_TRIM - 1], 5999);
});

test('evictOnce step 2 is a no-op when historicalPnl already <= trim limit', () => {
    const arr = Array.from({ length: 100 }, (_, i) => i);
    const packed = { v: 1, address: 'a', fetchedAt: 0, data: { historicalPnl: arr } };
    assert.equal(Internal.evictOnce(packed, 2), null);
});

test('evictOnce step 3 drops closedPositions', () => {
    const packed = { v: 1, address: 'a', fetchedAt: 0, data: { closedPositions: { positions: [] } } };
    const out = Internal.evictOnce(packed, 3);
    assert.ok(out);
    assert.equal(out.data.closedPositions, undefined);
});

test('evictOnce returns null when target field already absent (caller advances)', () => {
    const packed = { v: 1, address: 'a', fetchedAt: 0, data: {} };
    assert.equal(Internal.evictOnce(packed, 0), null);
    assert.equal(Internal.evictOnce(packed, 1), null);
    assert.equal(Internal.evictOnce(packed, 3), null);
});

test('evictOnce returns null beyond eviction range', () => {
    const packed = { v: 1, address: 'a', fetchedAt: 0, data: { fills: [] } };
    assert.equal(Internal.evictOnce(packed, 99), null);
});

// ---------------------------------------------------------------------------
// Public read / write / clear (round-trip via stubs)
// ---------------------------------------------------------------------------

test('write then read returns the same data', () => {
    globalThis.localStorage = makeLocalStorage();
    Cache.clear();
    const data = {
        subaccount: { equity: '12345.67' },
        openPositions: { positions: [{ market: 'BTC-USD' }] },
        historicalPnl: { historicalPnl: [{ totalPnl: '100' }] }
    };
    Cache.write('dydx1abc', data);
    assert.deepEqual(Cache.read('dydx1abc'), data);
});

test('read returns null when the slot belongs to a different address', () => {
    globalThis.localStorage = makeLocalStorage();
    Cache.write('dydx1aaa', { x: 1 });
    assert.equal(Cache.read('dydx1bbb'), null);
});

test('read returns null when no slot exists', () => {
    globalThis.localStorage = makeLocalStorage();
    assert.equal(Cache.read('dydx1abc'), null);
});

test('clear removes the slot', () => {
    globalThis.localStorage = makeLocalStorage();
    Cache.write('dydx1abc', { y: 2 });
    assert.notEqual(Cache.read('dydx1abc'), null);
    Cache.clear();
    assert.equal(Cache.read('dydx1abc'), null);
});

test('write degrades to no-op when LZString is unavailable', () => {
    globalThis.localStorage = makeLocalStorage();
    const lz = globalThis.LZString;
    globalThis.LZString = undefined;
    try {
        Cache.write('dydx1abc', { x: 1 });
        // Slot must NOT be set (cannot decompress without LZ; would poison reads).
        assert.equal(globalThis.localStorage.getItem(Cache.KEY), null);
    } finally {
        globalThis.LZString = lz;
    }
});

test('read returns null and clears slot when stored payload fails to decompress', () => {
    globalThis.localStorage = makeLocalStorage();
    // Garbage that the stub's prefix check rejects (no 'C:' prefix).
    globalThis.localStorage.setItem(Cache.KEY, 'garbage');
    assert.equal(Cache.read('dydx1abc'), null);
    assert.equal(globalThis.localStorage.getItem(Cache.KEY), null, 'poisonous slot should be purged');
});

test('quota: heaviest-first eviction drops fills, then succeeds', () => {
    // 2000-byte quota in stub units (UTF-16 doubled). Initial payload has a
    // big fills array; after dropping fills the rest fits.
    globalThis.localStorage = makeLocalStorage(2000);
    const data = {
        fills: Array.from({ length: 200 }, () => 'rowrowrowrowrowrowrowrowrowrowrow'),
        orders: 'small',
        markets: { 'BTC-USD': { oraclePrice: '78928.28' } }
    };
    Cache.write('dydx1abc', data);
    const got = Cache.read('dydx1abc');
    assert.ok(got, 'expected a stored snapshot after eviction');
    assert.equal(got.fills, undefined, 'fills should have been evicted');
    assert.equal(got.orders, 'small', 'orders should be preserved');
    assert.deepEqual(got.markets, data.markets, 'markets should be preserved');
});

test('quota: write skips silently when payload exceeds quota even after full eviction', () => {
    // 200-byte quota — even the smallest viable payload won't fit.
    globalThis.localStorage = makeLocalStorage(200);
    const data = {
        subaccount: { equity: '1'.repeat(500) },
        fills: ['x'],
        fundingPayments: ['y'],
        historicalPnl: { historicalPnl: [] },
        closedPositions: ['z']
    };
    // Should NOT throw.
    Cache.write('dydx1abc', data);
    assert.equal(globalThis.localStorage.getItem(Cache.KEY), null);
});
