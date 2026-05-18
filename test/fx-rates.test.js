'use strict';

// FxRates tests. The module hits a remote ECB-proxy (frankfurter.app),
// so the tests inject a controllable fetch stub and an in-memory
// localStorage before requiring the module. Covers: cache hits,
// timeseries miss + persist, weekend single-date fallback, network
// failure → missing[], and `clear()` semantics.

const test = require('node:test');
const assert = require('node:assert/strict');

globalThis.window = globalThis;

function makeLocalStorage() {
    const map = new Map();
    return {
        _map: map,
        getItem(k) { return map.has(k) ? map.get(k) : null; },
        setItem(k, v) { map.set(k, String(v)); },
        removeItem(k) { map.delete(k); },
        clear() { map.clear(); }
    };
}

function makeFetchStub() {
    const calls = [];
    // array of `(url, opts) => responseValue` where responseValue is
    // one of: a parsed body object (resolves immediately), `null`
    // (rejects with a network error), or `{ __bodyPromise: Promise }`
    // (body read returns the supplied promise, honoring AbortSignal).
    let nextResponses = [];
    function fetchStub(url, opts) {
        calls.push(url);
        const fn = nextResponses.shift();
        if (!fn) {
            return Promise.resolve({ ok: false, status: 500, json: () => Promise.reject(new Error('no stub')) });
        }
        const r = fn(url, opts);
        if (r === null) return Promise.reject(new Error('network'));
        // Allow stubs to delay the body to simulate a stalled body read
        // after headers arrive. When the caller passes an AbortSignal,
        // honor it — pending body promises must reject on abort so the
        // body-stall timeout regression can be exercised without waiting
        // for the real 15s production timeout.
        if (r && typeof r === 'object' && '__bodyPromise' in r) {
            const body = (opts && opts.signal)
                ? Promise.race([
                    r.__bodyPromise,
                    new Promise((_, reject) => {
                        if (opts.signal.aborted) {
                            reject(new Error('aborted'));
                            return;
                        }
                        opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
                    })
                ])
                : r.__bodyPromise;
            return Promise.resolve({
                ok: true,
                status: 200,
                json: () => body
            });
        }
        return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve(r)
        });
    }
    fetchStub.calls = calls;
    fetchStub.queue = (...fns) => { nextResponses = fns.slice(); };
    fetchStub.queueAppend = (fn) => { nextResponses.push(fn); };
    return fetchStub;
}

// Replace globals BEFORE require so module captures stubs.
globalThis.localStorage = makeLocalStorage();
globalThis.fetch = makeFetchStub();

require('../fx-rates.js');
const FX = globalThis.FxRates;

function resetState() {
    globalThis.localStorage._map.clear();
    globalThis.fetch.calls.length = 0;
    globalThis.fetch.queue();
}

// ---------------------------------------------------------------------------
// Cache behavior.
// ---------------------------------------------------------------------------

test('getRates: returns cached rate without hitting network', async () => {
    resetState();
    globalThis.localStorage.setItem('fxRates:v1:USD-EUR',
        JSON.stringify({ v: 1, rates: { '2024-03-12': 0.92 } }));
    const { rates, missing } = await FX.getRates(['2024-03-12']);
    assert.equal(rates['2024-03-12'], 0.92);
    assert.deepEqual(missing, []);
    assert.equal(globalThis.fetch.calls.length, 0);
});

test('getRates: timeseries call fills missing dates and persists to cache', async () => {
    resetState();
    globalThis.fetch.queue(
        () => ({ rates: { '2024-03-12': { EUR: 0.92 }, '2024-03-13': { EUR: 0.93 } } })
    );
    const { rates, missing } = await FX.getRates(['2024-03-12', '2024-03-13']);
    assert.equal(rates['2024-03-12'], 0.92);
    assert.equal(rates['2024-03-13'], 0.93);
    assert.deepEqual(missing, []);
    assert.equal(globalThis.fetch.calls.length, 1);
    assert.ok(/2024-03-12\.\.2024-03-13/.test(globalThis.fetch.calls[0]));
    // Persisted
    const stored = JSON.parse(globalThis.localStorage.getItem('fxRates:v1:USD-EUR'));
    assert.equal(stored.rates['2024-03-12'], 0.92);
});

test('getRates: weekend gap-fills via single-date call after timeseries', async () => {
    resetState();
    // Timeseries returns weekday only; weekend missing.
    globalThis.fetch.queue(
        () => ({ rates: { '2024-03-15': { EUR: 0.92 } } }), // weekday in range
        () => ({ rates: { EUR: 0.92 }, date: '2024-03-15' }) // per-date fallback for 2024-03-16 (Sat)
    );
    const { rates, missing } = await FX.getRates(['2024-03-15', '2024-03-16']);
    assert.equal(rates['2024-03-15'], 0.92);
    // 2024-03-16 (Sat) gets the rate stored under the REQUESTED date
    assert.equal(rates['2024-03-16'], 0.92);
    assert.deepEqual(missing, []);
    // First call timeseries, second per-date
    assert.equal(globalThis.fetch.calls.length, 2);
});

test('getRates: total network failure populates missing[]', async () => {
    resetState();
    globalThis.fetch.queue(() => null, () => null);
    const { rates, missing } = await FX.getRates(['2024-03-12']);
    assert.deepEqual(rates, {});
    assert.deepEqual(missing, ['2024-03-12']);
});

test('getRates: body that NEVER resolves is aborted by the request timeout', async () => {
    // The bug being guarded: clearTimeout used to fire as soon as
    // fetch() resolved, before res.json() began. A body that stalled
    // forever would then hang `getRates()` indefinitely. With the fix
    // the timer is held through res.json(); the AbortController abort
    // event propagates to the body promise (modeled in the stub via
    // signal-aware Promise.race) and `getRates` returns missing[].
    resetState();
    FX._internal.setTimeoutMs(50);
    try {
        globalThis.fetch.queueAppend(() => ({
            __bodyPromise: new Promise(() => {}) // never resolves
        }));
        const start = Date.now();
        const { rates, missing } = await FX.getRates(['2024-03-12']);
        const elapsed = Date.now() - start;
        assert.deepEqual(rates, {});
        assert.deepEqual(missing, ['2024-03-12']);
        assert.ok(elapsed >= 40 && elapsed < 2000,
            `expected ~50ms elapsed, got ${elapsed}ms`);
    } finally {
        FX._internal.setTimeoutMs(15000);
    }
});

test('getRates: timeseries outage does NOT cascade into per-date fallback', async () => {
    // Otherwise an api.frankfurter.app outage with N requested dates
    // would issue N extra single-date requests, each also failing.
    resetState();
    globalThis.fetch.queue(() => null);
    const dates = ['2024-03-12', '2024-03-13', '2024-03-14', '2024-03-15'];
    const { missing } = await FX.getRates(dates);
    assert.deepEqual(missing.sort(), dates.slice().sort());
    // Exactly one fetch (the timeseries call). No per-date fallback.
    assert.equal(globalThis.fetch.calls.length, 1);
});

test('getRates: concurrent calls do not lose each other\'s cache writes', async () => {
    resetState();
    // Two non-overlapping date sets, each fetched concurrently. Both
    // must end up in the cache after both resolve.
    globalThis.fetch.queueAppend(() => ({ rates: { '2024-03-12': { EUR: 0.92 } } }));
    globalThis.fetch.queueAppend(() => ({ rates: { '2024-04-15': { EUR: 0.93 } } }));
    const [a, b] = await Promise.all([
        FX.getRates(['2024-03-12']),
        FX.getRates(['2024-04-15'])
    ]);
    assert.equal(a.rates['2024-03-12'], 0.92);
    assert.equal(b.rates['2024-04-15'], 0.93);
    const cache = JSON.parse(globalThis.localStorage.getItem('fxRates:v1:USD-EUR'));
    assert.equal(cache.rates['2024-03-12'], 0.92, 'cache must retain A\'s write');
    assert.equal(cache.rates['2024-04-15'], 0.93, 'cache must retain B\'s write');
});

test('getRates: cache + network mix — only missing dates hit network', async () => {
    resetState();
    globalThis.localStorage.setItem('fxRates:v1:USD-EUR',
        JSON.stringify({ v: 1, rates: { '2024-03-12': 0.92 } }));
    globalThis.fetch.queue(
        () => ({ rates: { '2024-03-13': { EUR: 0.93 } } })
    );
    const { rates, missing } = await FX.getRates(['2024-03-12', '2024-03-13']);
    assert.equal(rates['2024-03-12'], 0.92);
    assert.equal(rates['2024-03-13'], 0.93);
    assert.deepEqual(missing, []);
    // Timeseries spans only the missing date
    assert.equal(globalThis.fetch.calls.length, 1);
    assert.ok(/2024-03-13\.\.2024-03-13/.test(globalThis.fetch.calls[0]));
});

test('getRates: dedupes input dates', async () => {
    resetState();
    globalThis.fetch.queue(
        () => ({ rates: { '2024-03-12': { EUR: 0.92 } } })
    );
    const { rates } = await FX.getRates(['2024-03-12', '2024-03-12', '2024-03-12']);
    assert.equal(rates['2024-03-12'], 0.92);
    assert.equal(globalThis.fetch.calls.length, 1);
});

test('getRates: rejects malformed date strings; valid date still fetched', async () => {
    resetState();
    globalThis.fetch.queue(
        () => ({ rates: { '2024-03-12': { EUR: 0.92 } } })
    );
    const { rates, missing } = await FX.getRates(['not-a-date', '2024/03/12', '2024-03-12']);
    assert.equal(rates['2024-03-12'], 0.92);
    assert.deepEqual(missing, []);
    // Malformed silently dropped; only the valid date hits network
    assert.equal(globalThis.fetch.calls.length, 1);
    assert.ok(/2024-03-12\.\.2024-03-12/.test(globalThis.fetch.calls[0]));
});

test('getRates: empty input returns empty result with no network', async () => {
    resetState();
    const { rates, missing } = await FX.getRates([]);
    assert.deepEqual(rates, {});
    assert.deepEqual(missing, []);
    assert.equal(globalThis.fetch.calls.length, 0);
});

// ---------------------------------------------------------------------------
// clear() / peek().
// ---------------------------------------------------------------------------

test('clear: removes the storage slot', () => {
    globalThis.localStorage.setItem('fxRates:v1:USD-EUR',
        JSON.stringify({ v: 1, rates: { '2024-03-12': 0.92 } }));
    FX.clear();
    assert.equal(globalThis.localStorage.getItem('fxRates:v1:USD-EUR'), null);
});

test('peek: returns parsed cache contents', () => {
    globalThis.localStorage.setItem('fxRates:v1:USD-EUR',
        JSON.stringify({ v: 1, rates: { '2024-03-12': 0.92 } }));
    const c = FX.peek();
    assert.equal(c.v, 1);
    assert.equal(c.rates['2024-03-12'], 0.92);
});

// ---------------------------------------------------------------------------
// getRatesForYear — ok flag distinguishes empty success from outage.
// ---------------------------------------------------------------------------

test('getRatesForYear: ok=true when fetch succeeds with rates', async () => {
    resetState();
    globalThis.fetch.queue(
        () => ({ rates: { '2024-03-15': { EUR: 0.92 } } })
    );
    const res = await FX.getRatesForYear(2024);
    assert.equal(res.ok, true);
    assert.equal(res.rates['2024-03-15'], 0.92);
});

test('getRatesForYear: ok=false when fetch fails (caller can distinguish from empty success)', async () => {
    resetState();
    globalThis.fetch.queue(() => null);
    const res = await FX.getRatesForYear(2024);
    assert.equal(res.ok, false);
    assert.deepEqual(res.rates, {});
});

test('getRatesForYear: invalid year returns ok=true, empty rates (not an outage)', async () => {
    resetState();
    const res = await FX.getRatesForYear('not-a-year');
    assert.equal(res.ok, true);
    assert.deepEqual(res.rates, {});
    // No fetch should have been issued
    assert.equal(globalThis.fetch.calls.length, 0);
});

test('getRatesForYear: partially-numeric strings rejected (not silently parsed)', async () => {
    resetState();
    const a = await FX.getRatesForYear('2024abc');
    const b = await FX.getRatesForYear('2024.5');
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.deepEqual(a.rates, {});
    assert.deepEqual(b.rates, {});
    // Neither malformed input should have hit the network
    assert.equal(globalThis.fetch.calls.length, 0);
});

test('getRates: impossible dates (2024-99-99 / 2024-02-30) rejected at validation', async () => {
    resetState();
    const { rates, missing } = await FX.getRates(['2024-99-99', '2024-02-30', '2024-13-01']);
    assert.deepEqual(rates, {});
    assert.deepEqual(missing, []);
    // No fetch — these are dropped before any network call
    assert.equal(globalThis.fetch.calls.length, 0);
});

test('peek: returns empty rates on missing/corrupt cache', () => {
    globalThis.localStorage.removeItem('fxRates:v1:USD-EUR');
    let c = FX.peek();
    assert.deepEqual(c.rates, {});
    globalThis.localStorage.setItem('fxRates:v1:USD-EUR', 'not-json');
    c = FX.peek();
    assert.deepEqual(c.rates, {});
});
