'use strict';

// FxRates tests. The module hits a remote ECB-proxy
// (frankfurter.dev/v1), so the tests inject a controllable fetch stub
// and an in-memory localStorage before requiring the module. Covers:
// cache hits, timeseries miss + persist, weekend single-date fallback,
// network failure → missing[], and `clear()` semantics.
//
// Every rate is the ECB reference quote, USD per 1 EUR, as published.

const test = require('node:test');
const assert = require('node:assert/strict');

// The documented storage slot (ARCHITECTURE.md, Browser storage).
const FX_CACHE_KEY = 'fxRates:v2:EUR-USD';
const FX_CACHE_VERSION = 2;
// The slot that held Frankfurter's 5-decimal inverted USD→EUR rates.
const RETIRED_FX_CACHE_KEY = 'fxRates:v1:USD-EUR';

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

require('../src/constants.js');
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
    globalThis.localStorage.setItem(FX_CACHE_KEY,
        JSON.stringify({ v: FX_CACHE_VERSION, rates: { '2024-03-12': 1.0856 } }));
    const { rates, missing } = await FX.getRates(['2024-03-12']);
    assert.equal(rates['2024-03-12'], 1.0856);
    assert.deepEqual(missing, []);
    assert.equal(globalThis.fetch.calls.length, 0);
});

test('getRates: asks for the ECB quote (EUR base, USD per EUR) and returns it unrounded', async () => {
    // Frankfurter's from=USD&to=EUR serves round(1 / quote, 5), which
    // misstates EUR amounts by up to ~6e-6 relative; the ECB publishes
    // EUR/USD, so the rate is that quote exactly.
    resetState();
    globalThis.fetch.queue(
        () => ({ base: 'EUR', rates: { '2024-06-12': { USD: 1.2345 } } })
    );
    const { rates, missing } = await FX.getRates(['2024-06-12']);
    assert.equal(rates['2024-06-12'], 1.2345);
    assert.deepEqual(missing, []);
    assert.ok(/[?&]from=EUR(&|$)/.test(globalThis.fetch.calls[0]), globalThis.fetch.calls[0]);
    assert.ok(/[?&]to=USD(&|$)/.test(globalThis.fetch.calls[0]), globalThis.fetch.calls[0]);
});

test('getRates: the single-date fallback also asks for the EUR/USD quote', async () => {
    resetState();
    globalThis.fetch.queue(
        () => ({ rates: {} }),
        () => ({ base: 'EUR', rates: { USD: 1.0876 }, date: '2024-03-15' })
    );
    const { rates } = await FX.getRates(['2024-03-16']);
    assert.equal(rates['2024-03-16'], 1.0876);
    assert.equal(globalThis.fetch.calls.length, 2);
    assert.ok(/\/2024-03-16\?from=EUR&to=USD$/.test(globalThis.fetch.calls[1]), globalThis.fetch.calls[1]);
});

test('getRates: rates cached under the retired USD→EUR slot are never served', async () => {
    resetState();
    globalThis.localStorage.setItem(RETIRED_FX_CACHE_KEY,
        JSON.stringify({ v: 1, rates: { '2024-06-12': 0.81004 } }));
    globalThis.fetch.queue(
        () => ({ rates: { '2024-06-12': { USD: 1.2345 } } })
    );
    const { rates } = await FX.getRates(['2024-06-12']);
    assert.equal(rates['2024-06-12'], 1.2345);
    assert.equal(globalThis.fetch.calls.length, 1);
});

test('getRates: a zero quote is not a rate (EUR = USD / quote would be infinite)', async () => {
    resetState();
    globalThis.fetch.queue(
        () => ({ rates: { '2024-06-12': { USD: 0 } } }),
        () => ({ rates: { USD: 0 }, date: '2024-06-12' })
    );
    const { rates, missing } = await FX.getRates(['2024-06-12']);
    assert.deepEqual(rates, {});
    assert.deepEqual(missing, ['2024-06-12']);
    assert.equal(globalThis.localStorage.getItem(FX_CACHE_KEY), null, 'nothing cached');
});

test('getRates: a slot of the current key but an older schema version is discarded', async () => {
    resetState();
    globalThis.localStorage.setItem(FX_CACHE_KEY,
        JSON.stringify({ v: 1, rates: { '2024-06-12': 0.81004 } }));
    globalThis.fetch.queue(
        () => ({ rates: { '2024-06-12': { USD: 1.2345 } } })
    );
    const { rates } = await FX.getRates(['2024-06-12']);
    assert.equal(rates['2024-06-12'], 1.2345);
    assert.equal(globalThis.fetch.calls.length, 1);
});

test('getRates: timeseries call fills missing dates and persists to cache', async () => {
    resetState();
    globalThis.fetch.queue(
        () => ({ rates: { '2024-03-12': { USD: 1.0856 }, '2024-03-13': { USD: 1.0752 } } })
    );
    const { rates, missing } = await FX.getRates(['2024-03-12', '2024-03-13']);
    assert.equal(rates['2024-03-12'], 1.0856);
    assert.equal(rates['2024-03-13'], 1.0752);
    assert.deepEqual(missing, []);
    assert.equal(globalThis.fetch.calls.length, 1);
    assert.ok(/2024-03-12\.\.2024-03-13/.test(globalThis.fetch.calls[0]));
    // Persisted
    const stored = JSON.parse(globalThis.localStorage.getItem(FX_CACHE_KEY));
    assert.equal(stored.rates['2024-03-12'], 1.0856);
});

test('getRates: provisional same-day rate (response.date != requested) not cached under requested', async () => {
    // Setup: request a date in the future (recent / not settled).
    // Frankfurter returns a different date in the response — this is
    // the "current weekday before ECB publishes today's rate" scenario.
    // The implementation must:
    //   - cache the rate under the RESPONSE date (it's a real ECB value)
    //   - NOT cache under the REQUESTED date (the final rate hasn't published)
    //   - leave the requested date in `missing[]`
    // Otherwise the previous-day rate would be pinned under the future
    // date and served indefinitely on every later call.
    resetState();
    const futureDate = '2099-12-31';
    const earlierDate = '2099-12-28';
    globalThis.fetch.queueAppend(() => ({ rates: {} })); // timeseries (empty)
    globalThis.fetch.queueAppend(() => ({ rates: { USD: 1.0856 }, date: earlierDate }));
    const { rates, missing } = await FX.getRates([futureDate]);
    assert.deepEqual(rates, {}, 'requested date must not be in result rates');
    assert.deepEqual(missing, [futureDate], 'requested date stays missing');
    const cache = JSON.parse(globalThis.localStorage.getItem(FX_CACHE_KEY));
    assert.equal(cache.rates[earlierDate], 1.0856, 'response date IS cached');
    assert.equal(cache.rates[futureDate], undefined, 'requested date NOT cached under provisional rate');
});

test('getRates: settled past date with mismatched response.date still caches under requested', async () => {
    // Symmetric: a weekend close date from years ago. Frankfurter
    // returns Friday's rate; the requested Saturday is "settled" (too
    // old for ECB to publish a new value), so caching under the
    // requested date is permanently correct.
    resetState();
    const requested = '2020-03-21'; // Saturday, definitely past
    const responseDate = '2020-03-20'; // Friday
    globalThis.fetch.queueAppend(() => ({ rates: {} })); // timeseries
    globalThis.fetch.queueAppend(() => ({ rates: { USD: 1.0752 }, date: responseDate }));
    const { rates, missing } = await FX.getRates([requested]);
    assert.equal(rates[requested], 1.0752);
    assert.deepEqual(missing, []);
    const cache = JSON.parse(globalThis.localStorage.getItem(FX_CACHE_KEY));
    assert.equal(cache.rates[requested], 1.0752);
    assert.equal(cache.rates[responseDate], 1.0752);
});

test('getRates: a settled weekend after the range\'s last business day takes that day\'s quote, with no extra request', async () => {
    resetState();
    // Timeseries returns weekday only; weekend missing.
    globalThis.fetch.queue(
        () => ({ rates: { '2024-03-15': { USD: 1.0856 } } }) // weekday in range
    );
    const { rates, missing } = await FX.getRates(['2024-03-15', '2024-03-16']);
    assert.equal(rates['2024-03-15'], 1.0856);
    // 2024-03-16 (Sat) gets the rate stored under the REQUESTED date
    assert.equal(rates['2024-03-16'], 1.0856);
    assert.deepEqual(missing, []);
    assert.equal(globalThis.fetch.calls.length, 1, 'the range request alone answers the weekend');
    const cache = JSON.parse(globalThis.localStorage.getItem(FX_CACHE_KEY));
    assert.equal(cache.rates['2024-03-16'], 1.0856);
});

test('getRates: holidays and weekends inside the range take the preceding business day from the one range request', async () => {
    // A year of event dates must not cost one request per non-publishing
    // day. Good Friday to Easter Monday is the longest ECB closure.
    resetState();
    globalThis.fetch.queue(
        () => ({ rates: { '2025-04-17': { USD: 1.1 }, '2025-04-22': { USD: 1.2 } } })
    );
    const dates = ['2025-04-17', '2025-04-18', '2025-04-19', '2025-04-20', '2025-04-21', '2025-04-22'];
    const { rates, missing } = await FX.getRates(dates);
    assert.equal(globalThis.fetch.calls.length, 1);
    assert.deepEqual(missing, []);
    for (const d of ['2025-04-17', '2025-04-18', '2025-04-19', '2025-04-20', '2025-04-21']) {
        assert.equal(rates[d], 1.1, d);
    }
    assert.equal(rates['2025-04-22'], 1.2);
});

test('getRates: a recent date after the range\'s last business day is not pinned to that day\'s quote', async () => {
    // The range ends on a weekday whose rate is published while the
    // later requested date may still get its own: the range must not
    // answer for it, and the provisional single-date answer is not kept.
    resetState();
    globalThis.fetch.queue(
        () => ({ rates: { '2099-12-28': { USD: 1.08 } } }),
        () => ({ rates: { USD: 1.08 }, date: '2099-12-28' })
    );
    const { rates, missing } = await FX.getRates(['2099-12-28', '2099-12-31']);
    assert.equal(rates['2099-12-28'], 1.08);
    assert.deepEqual(missing, ['2099-12-31']);
    const cache = JSON.parse(globalThis.localStorage.getItem(FX_CACHE_KEY));
    assert.equal(cache.rates['2099-12-31'], undefined);
});

// Fri 2030-06-07, Sat 06-08, Sun 06-09; the clock reads Monday 06-10
// 10:00Z, before that Monday's publish, so the weekend is under two days
// old and not yet "settled".
const FRIDAY = '2030-06-07';
const SATURDAY = '2030-06-08';
const SUNDAY = '2030-06-09';
const MONDAY_MORNING_MS = Date.parse('2030-06-10T10:00:00Z');

async function atClock(nowMs, fn) {
    const realNow = Date.now;
    Date.now = () => nowMs;
    try {
        return await fn();
    } finally {
        Date.now = realNow;
    }
}

test('getRates: on Monday morning a weekend takes its Friday\'s quote from the range response, final', async () => {
    // A Saturday or Sunday has no fixing of its own: once the range holds
    // the Friday just before it, that quote cannot change.
    resetState();
    globalThis.fetch.queue(
        () => ({ rates: { [FRIDAY]: { USD: 1.16 } } })
    );
    const { rates, missing } = await atClock(MONDAY_MORNING_MS, () => FX.getRates([SATURDAY, SUNDAY]));
    assert.deepEqual(missing, []);
    assert.equal(rates[SATURDAY], 1.16);
    assert.equal(rates[SUNDAY], 1.16);
    assert.equal(globalThis.fetch.calls.length, 1, 'the range request alone answers the weekend');
    const cache = JSON.parse(globalThis.localStorage.getItem(FX_CACHE_KEY));
    assert.equal(cache.rates[SUNDAY], 1.16, 'pinned under the requested date');
});

test('getRates: on Monday morning a weekend answered by its Friday in the single-date request is final', async () => {
    resetState();
    globalThis.fetch.queue(
        () => ({ rates: {} }),
        () => ({ rates: { USD: 1.16 }, date: FRIDAY })
    );
    const { rates, missing } = await atClock(MONDAY_MORNING_MS, () => FX.getRates([SUNDAY]));
    assert.deepEqual(missing, []);
    assert.equal(rates[SUNDAY], 1.16);
    const cache = JSON.parse(globalThis.localStorage.getItem(FX_CACHE_KEY));
    assert.equal(cache.rates[SUNDAY], 1.16);
});

test('getRates: on Monday morning a weekend answered by an earlier day than its Friday stays provisional', async () => {
    // Thursday's quote for a Sunday means Friday had no fixing yet (or
    // was a holiday, which only a TARGET calendar could tell): not final
    // until the date settles.
    resetState();
    globalThis.fetch.queue(
        () => ({ rates: {} }),
        () => ({ rates: { USD: 1.15 }, date: '2030-06-06' })
    );
    const { rates, missing } = await atClock(MONDAY_MORNING_MS, () => FX.getRates([SUNDAY]));
    assert.deepEqual(missing, [SUNDAY]);
    assert.equal(rates[SUNDAY], undefined);
});

test('getRates: a gap longer than any ECB closure is not filled from the range', async () => {
    // Good Friday to Easter Monday (4 days) is the longest run without a
    // reference rate; a longer hole in the response is the provider's,
    // so the date asks for its own rate rather than take a stale one.
    resetState();
    globalThis.fetch.queue(
        () => ({ rates: { '2024-03-01': { USD: 1.08 }, '2024-03-20': { USD: 1.09 } } }),
        () => ({ rates: { USD: 1.085 }, date: '2024-03-11' })
    );
    const { rates, missing } = await FX.getRates(['2024-03-01', '2024-03-11', '2024-03-20']);
    assert.equal(rates['2024-03-11'], 1.085);
    assert.deepEqual(missing, []);
    assert.equal(globalThis.fetch.calls.length, 2);
});

test('getRates: a settled weekday whose single-date answer is older than any ECB closure reads missing and stays uncached', async () => {
    // The range has a provider hole around Tue 2025-03-11, and the
    // single-date request answers with the quote of 8 days earlier: no
    // ECB closure is that long, so it is not that date's reference rate.
    resetState();
    const requested = '2025-03-11';
    const staleResponseDate = '2025-03-03';
    globalThis.fetch.queue(
        () => ({ rates: { '2025-03-03': { USD: 1.05 }, '2025-03-17': { USD: 1.09 } } }),
        () => ({ rates: { USD: 1.05 }, date: staleResponseDate })
    );
    const { rates, missing } = await FX.getRates(['2025-03-03', requested, '2025-03-17']);
    assert.equal(rates[requested], undefined);
    assert.deepEqual(missing, [requested]);
    const cache = JSON.parse(globalThis.localStorage.getItem(FX_CACHE_KEY));
    assert.equal(cache.rates[requested], undefined, 'stale quote NOT cached under the requested date');
    assert.equal(cache.rates[staleResponseDate], 1.05, 'the quote stays cached under its own date');
});

test('getRates: a date before the range\'s first business day still asks for its own date', async () => {
    resetState();
    globalThis.fetch.queue(
        () => ({ rates: { '2024-03-18': { USD: 1.09 } } }),           // Mon in range
        () => ({ rates: { USD: 1.0856 }, date: '2024-03-15' })          // Sat 2024-03-16 alone
    );
    const { rates, missing } = await FX.getRates(['2024-03-16', '2024-03-18']);
    assert.equal(rates['2024-03-16'], 1.0856, 'the Friday before, not the Monday after');
    assert.equal(rates['2024-03-18'], 1.09);
    assert.deepEqual(missing, []);
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
    // Otherwise an api.frankfurter.dev outage with N requested dates
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
    globalThis.fetch.queueAppend(() => ({ rates: { '2024-03-12': { USD: 1.0856 } } }));
    globalThis.fetch.queueAppend(() => ({ rates: { '2024-04-15': { USD: 1.0752 } } }));
    const [a, b] = await Promise.all([
        FX.getRates(['2024-03-12']),
        FX.getRates(['2024-04-15'])
    ]);
    assert.equal(a.rates['2024-03-12'], 1.0856);
    assert.equal(b.rates['2024-04-15'], 1.0752);
    const cache = JSON.parse(globalThis.localStorage.getItem(FX_CACHE_KEY));
    assert.equal(cache.rates['2024-03-12'], 1.0856, 'cache must retain A\'s write');
    assert.equal(cache.rates['2024-04-15'], 1.0752, 'cache must retain B\'s write');
});

test('getRates: cache + network mix — only missing dates hit network', async () => {
    resetState();
    globalThis.localStorage.setItem(FX_CACHE_KEY,
        JSON.stringify({ v: FX_CACHE_VERSION, rates: { '2024-03-12': 1.0856 } }));
    globalThis.fetch.queue(
        () => ({ rates: { '2024-03-13': { USD: 1.0752 } } })
    );
    const { rates, missing } = await FX.getRates(['2024-03-12', '2024-03-13']);
    assert.equal(rates['2024-03-12'], 1.0856);
    assert.equal(rates['2024-03-13'], 1.0752);
    assert.deepEqual(missing, []);
    // Timeseries spans only the missing date
    assert.equal(globalThis.fetch.calls.length, 1);
    assert.ok(/2024-03-13\.\.2024-03-13/.test(globalThis.fetch.calls[0]));
});

test('getRates: dedupes input dates', async () => {
    resetState();
    globalThis.fetch.queue(
        () => ({ rates: { '2024-03-12': { USD: 1.0856 } } })
    );
    const { rates } = await FX.getRates(['2024-03-12', '2024-03-12', '2024-03-12']);
    assert.equal(rates['2024-03-12'], 1.0856);
    assert.equal(globalThis.fetch.calls.length, 1);
});

test('getRates: rejects malformed date strings; valid date still fetched', async () => {
    resetState();
    globalThis.fetch.queue(
        () => ({ rates: { '2024-03-12': { USD: 1.0856 } } })
    );
    const { rates, missing } = await FX.getRates(['not-a-date', '2024/03/12', '2024-03-12']);
    assert.equal(rates['2024-03-12'], 1.0856);
    assert.deepEqual(missing, []);
    // Malformed silently dropped; only the valid date hits network
    assert.equal(globalThis.fetch.calls.length, 1);
    assert.ok(/2024-03-12\.\.2024-03-12/.test(globalThis.fetch.calls[0]));
});

test('getRates: non-array input returns empty result without throwing', async () => {
    resetState();
    const a = await FX.getRates('2024-03-12');         // string
    const b = await FX.getRates({ date: '2024-03-12' }); // object
    const c = await FX.getRates(undefined);
    const d = await FX.getRates(null);
    for (const r of [a, b, c, d]) {
        assert.deepEqual(r.rates, {});
        assert.deepEqual(r.missing, []);
    }
    assert.equal(globalThis.fetch.calls.length, 0);
});

test('getRates: empty input returns empty result with no network', async () => {
    resetState();
    const { rates, missing } = await FX.getRates([]);
    assert.deepEqual(rates, {});
    assert.deepEqual(missing, []);
    assert.equal(globalThis.fetch.calls.length, 0);
});

// ---------------------------------------------------------------------------
// clear().
// ---------------------------------------------------------------------------

test('clear: removes the storage slot', () => {
    globalThis.localStorage.setItem(FX_CACHE_KEY,
        JSON.stringify({ v: FX_CACHE_VERSION, rates: { '2024-03-12': 1.0856 } }));
    FX.clear();
    assert.equal(globalThis.localStorage.getItem(FX_CACHE_KEY), null);
});

test('getRates: impossible dates (2024-99-99 / 2024-02-30) rejected at validation', async () => {
    resetState();
    const { rates, missing } = await FX.getRates(['2024-99-99', '2024-02-30', '2024-13-01']);
    assert.deepEqual(rates, {});
    assert.deepEqual(missing, []);
    // No fetch — these are dropped before any network call
    assert.equal(globalThis.fetch.calls.length, 0);
});

test('getRates: a corrupt cache slot is ignored, the rate fetched and the slot rewritten as valid JSON', async () => {
    resetState();
    globalThis.localStorage.setItem(FX_CACHE_KEY, 'not-json');
    globalThis.fetch.queue(
        () => ({ rates: { '2024-03-12': { USD: 1.0856 } } })
    );
    const { rates, missing } = await FX.getRates(['2024-03-12']);
    assert.equal(rates['2024-03-12'], 1.0856);
    assert.deepEqual(missing, []);
    assert.equal(globalThis.fetch.calls.length, 1);
    const stored = JSON.parse(globalThis.localStorage.getItem(FX_CACHE_KEY));
    assert.deepEqual(stored, { v: FX_CACHE_VERSION, rates: { '2024-03-12': 1.0856 } });
});
