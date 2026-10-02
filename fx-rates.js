/**
 * ECB EUR/USD reference quotes (USD per 1 EUR, via api.frankfurter.dev/v1),
 * cached indefinitely in localStorage by YYYY-MM-DD. The quote is kept as
 * the ECB publishes it; a USD amount converts as `usd / quote`. Asking
 * Frankfurter for USD→EUR instead returns the inverse rounded to 5
 * decimals, which misstates EUR amounts at cent level. Historical reference rates
 * never change, so any cache hit is authoritative. One range request
 * covers every uncached date; weekend/holiday dates inherit the nearest
 * preceding business-day rate, taken from that range response when it
 * holds one (else from a single-date request, which frankfurter answers
 * with that rate), and are stored under the REQUESTED date so event-date
 * lookups always hit.
 *
 * Network is defensive: every request is try/catch'd, has a hard
 * AbortController timeout so a stalled third-party request cannot leave
 * the Tax tab stuck on "Fetching ECB rates…", and mergeAndWriteCache
 * re-reads fresh state before persisting so a slower concurrent caller
 * cannot clobber a faster caller's rates. Callers always receive a
 * `{rates, missing}` payload; no throws bubble up.
 *
 * Depends on: window.AppConstants (MS_PER_DAY, DAYS_PER_WEEK), read at
 * load time.
 */

;(function () {
    'use strict';

    // v1 (`fxRates:v1:USD-EUR`) held Frankfurter's rounded USD→EUR
    // inverses; the new key leaves them unread.
    const STORAGE_KEY = 'fxRates:v2:EUR-USD';
    const SCHEMA_VERSION = 2;
    // frankfurter.app served 301 → frankfurter.dev/v1 in 2026. The legacy
    // host stopped returning JSON, which silently emptied the rates map
    // and tripped _fxMissing on every row.
    const BASE = 'https://api.frankfurter.dev/v1';
    const FROM = 'EUR';
    const TO = 'USD';
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

    // A quote is a divisor, so zero or a negative value is no rate.
    function isUsableQuote(q) {
        return typeof q === 'number' && isFinite(q) && q > 0;
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
            if (isUsableQuote(newRates[d])) current.rates[d] = newRates[d];
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
                if (isUsableQuote(rate)) flat[d] = rate;
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
        if (!isUsableQuote(rate)) return null;
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
    const RECENT_THRESHOLD_DAYS = 2;
    const RECENT_THRESHOLD_MS = RECENT_THRESHOLD_DAYS * window.AppConstants.MS_PER_DAY;
    function isSettledPastDate(dateStr) {
        const reqMs = Date.parse(dateStr + 'T00:00:00Z');
        if (!Number.isFinite(reqMs)) return false;
        return reqMs < Date.now() - RECENT_THRESHOLD_MS;
    }

    // The longest run of days without an ECB reference rate: Good Friday
    // to Easter Monday, so Easter Monday's preceding business day is the
    // Thursday four days before. A longer hole in a range response is the
    // provider's, not a closure.
    const LONGEST_ECB_CLOSURE_DAYS = 4;
    const LONGEST_ECB_CLOSURE_MS = LONGEST_ECB_CLOSURE_DAYS * window.AppConstants.MS_PER_DAY;

    function daysApartMs(fromDate, toDate) {
        return Date.parse(toDate + 'T00:00:00Z') - Date.parse(fromDate + 'T00:00:00Z');
    }

    function isWithinEcbClosure(quoteDate, date) {
        return daysApartMs(quoteDate, date) <= LONGEST_ECB_CLOSURE_MS;
    }

    const FRIDAY = 5;
    const SATURDAY = 6;
    const SUNDAY = 0;

    // A Saturday or Sunday has no ECB fixing of its own, so once the quote
    // answering it is the Friday just before, that quote is final however
    // recent the date. A weekend answered by an earlier day (Friday not yet
    // published, or a Friday holiday, which only a TARGET calendar could
    // tell apart) stays provisional until it is settled.
    function isWeekendAnsweredByItsFriday(date, quoteDate) {
        const dayMs = Date.parse(date + 'T00:00:00Z');
        const weekday = new Date(dayMs).getUTCDay();
        if (weekday !== SATURDAY && weekday !== SUNDAY) return false;
        const daysSinceFriday = (weekday - FRIDAY + window.AppConstants.DAYS_PER_WEEK) % window.AppConstants.DAYS_PER_WEEK;
        const friday = new Date(dayMs - daysSinceFriday * window.AppConstants.MS_PER_DAY).toISOString().slice(0, 10);
        return quoteDate === friday;
    }

    // Whether a quote served for `date` from `quoteDate` (an earlier
    // business day) may stand as `date`'s final rate.
    function isFinalForDate(date, quoteDate) {
        return isSettledPastDate(date) || isWeekendAnsweredByItsFriday(date, quoteDate);
    }

    // Fills the requested dates the range response skipped (weekends and
    // ECB holidays) with the quote of the latest business day before them
    // in that response, at most LONGEST_ECB_CLOSURE_DAYS earlier. Such a
    // date is final when the response also holds a later business day, or
    // isFinalForDate holds (settled, or a weekend answered by its Friday);
    // any other recent date at the end of the range may still get its own
    // rate, so it is left for the single-date request, as is any date the
    // range cannot answer. `sortedDates` and the
    // response's dates are walked together once. Returns { date: quote }
    // for the dates filled.
    function fillFromPrecedingBusinessDay(sortedDates, rangeRates) {
        const published = Object.keys(rangeRates).sort();
        const lastPublished = published[published.length - 1];
        const filled = {};
        let next = 0;
        let preceding = null;
        sortedDates.forEach(d => {
            while (next < published.length && published[next] < d) preceding = published[next++];
            if (d in rangeRates || preceding === null) return;
            if (!isWithinEcbClosure(preceding, d)) return;
            if (lastPublished > d || isFinalForDate(d, preceding)) filled[d] = rangeRates[preceding];
        });
        return filled;
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
            if (isUsableQuote(cache.rates[d])) result.rates[d] = cache.rates[d];
        });
        const stillMissing = uniq.filter(d => !(d in result.rates));
        if (!stillMissing.length) return result;

        const sorted = stillMissing.slice().sort();
        const ts = await fetchTimeseries(sorted[0], sorted[sorted.length - 1]);
        const wanted = new Set(uniq);
        Object.keys(ts.rates).forEach(d => {
            if (wanted.has(d)) result.rates[d] = ts.rates[d];
        });
        const fromRange = fillFromPrecedingBusinessDay(sorted, ts.rates);
        Object.assign(result.rates, fromRange);
        const rangeGained = { ...ts.rates, ...fromRange };
        if (Object.keys(rangeGained).length) mergeAndWriteCache(rangeGained);

        // Dates the range could not settle (before its first business day,
        // or recent ones after its last) get a per-date fetch, which
        // resolves them to the nearest preceding business day; we store
        // under the REQUESTED date. Skip the fallback when the timeseries
        // request itself failed — turning an outage into one-request-per-
        // date would be wasteful and doesn't surface a single missing date
        // faster.
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
                    // Cache under the REQUESTED date only when the rate is
                    // final for it (isFinalForDate) and its date is no
                    // further back than an ECB closure (an older quote is a
                    // hole in the provider's data). For a current-or-future
                    // requested weekday, the rate may be provisional
                    // (yesterday's value served before today's publish);
                    // do not pin that under the requested date or the
                    // cache would serve the stale value indefinitely.
                    const sameDate = !r.responseDate || r.responseDate === d;
                    if (sameDate || (isWithinEcbClosure(r.responseDate, d) && isFinalForDate(d, r.responseDate))) {
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

    function clear() {
        const storage = getStorage();
        if (!storage) return;
        try { storage.removeItem(STORAGE_KEY); } catch (_) {}
    }

    window.FxRates = {
        getRates,
        clear,
        _internal: {
            setTimeoutMs: (ms) => {
                if (Number.isFinite(ms) && ms > 0) REQUEST_TIMEOUT_MS = ms;
            }
        }
    };
})();
