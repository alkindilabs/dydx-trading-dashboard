/**
 * USD→EUR FX rates from ECB (via api.frankfurter.app), cached indefinitely
 * in localStorage by YYYY-MM-DD. Historical reference rates never change,
 * so any cache hit is authoritative. Weekend/holiday close dates inherit
 * the nearest preceding business-day rate (frankfurter returns it when
 * asked for that calendar date) and are stored under the REQUESTED date
 * so close-date lookups always hit.
 *
 * Network is defensive: every request is try/catch'd, has a hard
 * AbortController timeout so a stalled third-party request cannot leave
 * the Tax tab stuck on "Fetching ECB rates…", and writeCache re-reads
 * fresh state before persisting so a slower concurrent caller cannot
 * clobber a faster caller's rates. Callers always receive a
 * `{rates, missing}` payload; no throws bubble up.
 */

;(function () {
    'use strict';

    const STORAGE_KEY = 'fxRates:v1:USD-EUR';
    const SCHEMA_VERSION = 1;
    const BASE = 'https://api.frankfurter.app';
    const FROM = 'USD';
    const TO = 'EUR';
    const CONCURRENCY = 4;
    // `let` so tests can drop the timeout to verify body-stall handling
    // without waiting 15s. Not part of the public API.
    let REQUEST_TIMEOUT_MS = 15000;

    function getStorage() {
        try {
            return (typeof localStorage !== 'undefined') ? localStorage : null;
        } catch (_) {
            return null;
        }
    }

    function readCache() {
        const storage = getStorage();
        if (!storage) return { v: SCHEMA_VERSION, rates: {} };
        try {
            const raw = storage.getItem(STORAGE_KEY);
            if (!raw) return { v: SCHEMA_VERSION, rates: {} };
            const parsed = JSON.parse(raw);
            if (!parsed || parsed.v !== SCHEMA_VERSION) {
                return { v: SCHEMA_VERSION, rates: {} };
            }
            // rates must be a plain object — a string/number/array from a
            // partially-corrupted localStorage entry would throw later
            // when mergeAndWriteCache assigns into it in strict mode,
            // breaking the module contract that FX failures never bubble.
            if (typeof parsed.rates !== 'object'
                    || parsed.rates === null
                    || Array.isArray(parsed.rates)) {
                return { v: SCHEMA_VERSION, rates: {} };
            }
            return parsed;
        } catch (_) {
            return { v: SCHEMA_VERSION, rates: {} };
        }
    }

    // Merge `newRates` into the LATEST cache snapshot before persisting.
    // Without the merge, two concurrent getRates() calls that both read
    // the cache at start and write at end would lose the slower writer's
    // additions for dates the faster writer didn't fetch.
    function mergeAndWriteCache(newRates) {
        const storage = getStorage();
        if (!storage) return;
        const current = readCache();
        Object.keys(newRates || {}).forEach(d => {
            if (typeof newRates[d] === 'number') current.rates[d] = newRates[d];
        });
        try {
            storage.setItem(STORAGE_KEY, JSON.stringify(current));
        } catch (_) {
            // Quota or disabled storage — silently drop. Next call refetches.
        }
    }

    // Match YYYY-MM-DD shape AND verify the parsed UTC date round-trips
    // to the same string — rejects nonsense like 2024-99-99 / 2024-02-30
    // that the regex alone would accept.
    function isValidIsoDate(s) {
        if (typeof s !== 'string') return false;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
        const d = new Date(s + 'T00:00:00Z');
        if (!Number.isFinite(d.getTime())) return false;
        return d.toISOString().slice(0, 10) === s;
    }

    // Returns { json, ok }. `ok=false` signals network/HTTP failure
    // (treat as opaque outage); `ok=true` with `json` returned means
    // the response was successfully parsed even if it carried no rates.
    async function fetchJson(url) {
        const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        const timer = (ctrl && typeof setTimeout !== 'undefined')
            ? setTimeout(() => { try { ctrl.abort(); } catch (_) {} }, REQUEST_TIMEOUT_MS)
            : null;
        const cancelTimer = () => { if (timer) clearTimeout(timer); };
        try {
            // Hold the timer through BOTH the headers fetch AND the body
            // read: res.json() can hang on a server that sends headers
            // and then stalls, so clearing the timeout after fetch()
            // returns would let the Tax tab get stuck on "Fetching ECB
            // rates…" despite a documented hard timeout.
            const res = await fetch(url, ctrl ? { signal: ctrl.signal } : undefined);
            if (!res || !res.ok) {
                cancelTimer();
                return { ok: false, json: null };
            }
            const json = await res.json();
            cancelTimer();
            return { ok: true, json };
        } catch (_) {
            cancelTimer();
            return { ok: false, json: null };
        }
    }

    // Returns { rates, ok }. `ok=false` means the request failed (caller
    // should NOT cascade into per-date fallbacks for every requested
    // date — that turns an outage into hundreds of duplicate requests).
    // `ok=true` with an empty rates map means the API succeeded but
    // returned no business-day data in the range (entire range was
    // weekend/holiday, which is when per-date fallback is appropriate).
    async function fetchTimeseries(startDate, endDate) {
        const url = `${BASE}/${startDate}..${endDate}?from=${FROM}&to=${TO}`;
        const { ok, json } = await fetchJson(url);
        if (!ok) return { rates: {}, ok: false };
        const flat = {};
        if (json && json.rates) {
            Object.keys(json.rates).forEach(d => {
                const rate = json.rates[d] && json.rates[d][TO];
                if (typeof rate === 'number' && isFinite(rate)) flat[d] = rate;
            });
        }
        return { rates: flat, ok: true };
    }

    // Returns the rate + the date Frankfurter actually served. When a
    // request date has no published ECB rate (weekend, holiday, or
    // current business day before the ~16:00 CET publish), Frankfurter
    // substitutes the nearest preceding business day's rate. The
    // caller uses `responseDate` to decide whether caching under the
    // REQUESTED date is safe (settled past date) or provisional
    // (current/future date that has not yet received its final rate).
    async function fetchSingleDate(date) {
        const { ok, json } = await fetchJson(`${BASE}/${date}?from=${FROM}&to=${TO}`);
        if (!ok || !json || !json.rates) return null;
        const rate = json.rates[TO];
        if (typeof rate !== 'number' || !isFinite(rate)) return null;
        const responseDate = typeof json.date === 'string' ? json.date : null;
        return { rate, responseDate };
    }

    // A requested date is "settled" when it is more than RECENT_THRESHOLD_MS
    // in the past. For a settled date Frankfurter cannot suddenly publish
    // a new rate, so caching the served rate under the requested date is
    // permanently correct (handles weekend/holiday close dates). For a
    // current-or-future date Frankfurter may serve yesterday's rate as
    // a provisional value until the ~16:00 CET publish; the caller must
    // NOT cache that under the requested date or the previous-day value
    // will be served forever.
    const RECENT_THRESHOLD_MS = 2 * 24 * 60 * 60 * 1000;
    function isSettledPastDate(dateStr) {
        const reqMs = Date.parse(dateStr + 'T00:00:00Z');
        if (!Number.isFinite(reqMs)) return false;
        return reqMs < Date.now() - RECENT_THRESHOLD_MS;
    }

    async function runWithConcurrency(items, worker, limit) {
        const results = new Array(items.length);
        let cursor = 0;
        async function pull() {
            while (true) {
                const i = cursor++;
                if (i >= items.length) return;
                results[i] = await worker(items[i], i);
            }
        }
        const workers = [];
        for (let i = 0; i < Math.min(limit, items.length); i++) workers.push(pull());
        await Promise.all(workers);
        return results;
    }

    async function getRates(dates) {
        // The module contract is no-throw: malformed callers (passing a
        // string, object, etc.) must get an empty result, not a rejected
        // promise. `.filter` on a non-array would throw before we ever
        // reach the validation pass.
        if (!Array.isArray(dates)) {
            return { rates: {}, missing: [] };
        }
        const cache = readCache();
        const want = dates.filter(isValidIsoDate);
        const uniq = [...new Set(want)];
        const result = { rates: {}, missing: [] };

        uniq.forEach(d => {
            if (typeof cache.rates[d] === 'number') result.rates[d] = cache.rates[d];
        });
        const stillMissing = uniq.filter(d => !(d in result.rates));
        if (!stillMissing.length) return result;

        const sorted = stillMissing.slice().sort();
        const ts = await fetchTimeseries(sorted[0], sorted[sorted.length - 1]);
        Object.keys(ts.rates).forEach(d => {
            if (uniq.indexOf(d) !== -1) result.rates[d] = ts.rates[d];
        });
        if (Object.keys(ts.rates).length) mergeAndWriteCache(ts.rates);

        // Weekend / holiday close dates are absent from the timeseries
        // response. Per-date fetch resolves them to the nearest preceding
        // business day; we store under the REQUESTED date. Skip the
        // fallback when the timeseries request itself failed — turning
        // an outage into one-request-per-date would be wasteful and
        // doesn't surface a single missing date faster.
        if (ts.ok) {
            const gapDates = stillMissing.filter(d => !(d in result.rates));
            if (gapDates.length) {
                const fetched = await runWithConcurrency(gapDates, fetchSingleDate, CONCURRENCY);
                const gained = {};
                gapDates.forEach((d, i) => {
                    const r = fetched[i];
                    if (!r) return;
                    // Cache the served rate under Frankfurter's response
                    // date when known — that one is always a real ECB
                    // business-day value.
                    if (r.responseDate) gained[r.responseDate] = r.rate;
                    // Cache under the REQUESTED date only when it is
                    // settled (>2 days old). For a current-or-future
                    // requested date, the rate may be provisional
                    // (yesterday's value served before today's publish);
                    // do not pin that under the requested date or the
                    // cache would serve the stale value indefinitely.
                    const sameDate = !r.responseDate || r.responseDate === d;
                    if (sameDate || isSettledPastDate(d)) {
                        gained[d] = r.rate;
                        result.rates[d] = r.rate;
                    }
                });
                if (Object.keys(gained).length) mergeAndWriteCache(gained);
            }
        }

        result.missing = uniq.filter(d => !(d in result.rates));
        return result;
    }

    // Year-warming convenience. `ok` distinguishes a successful empty
    // result (range entirely outside business-day data) from an outage,
    // since `missing` is unsuitable here — getRatesForYear is not
    // called with a specific date list and has no way to enumerate
    // which dates should have been present. Invalid input returns
    // `ok: true` so callers don't treat malformed years as outages.
    // Validation rejects partially-numeric strings (`2024abc`,
    // `2024.5`) that parseInt would silently accept — those are
    // caller bugs, not outages.
    async function getRatesForYear(year) {
        const isNumeric = typeof year === 'number'
            ? Number.isInteger(year)
            : (typeof year === 'string' && /^-?\d+$/.test(year));
        const y = isNumeric ? parseInt(year, 10) : NaN;
        if (!Number.isInteger(y) || y < 1999) {
            return { rates: {}, missing: [], ok: true };
        }
        const start = `${y}-01-01`;
        const end = `${y}-12-31`;
        const ts = await fetchTimeseries(start, end);
        if (Object.keys(ts.rates).length) mergeAndWriteCache(ts.rates);
        return { rates: Object.assign({}, ts.rates), missing: [], ok: ts.ok };
    }

    function clear() {
        const storage = getStorage();
        if (!storage) return;
        try { storage.removeItem(STORAGE_KEY); } catch (_) {}
    }

    function peek() {
        return readCache();
    }

    window.FxRates = {
        getRates,
        getRatesForYear,
        clear,
        peek,
        _internal: {
            setTimeoutMs: (ms) => {
                if (Number.isFinite(ms) && ms > 0) REQUEST_TIMEOUT_MS = ms;
            }
        }
    };
})();
