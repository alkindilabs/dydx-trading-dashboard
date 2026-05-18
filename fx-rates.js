/**
 * USD→EUR FX rates from ECB (via api.frankfurter.app), cached indefinitely
 * in localStorage by YYYY-MM-DD. Historical reference rates never change,
 * so any cache hit is authoritative. Weekend/holiday close dates inherit
 * the nearest preceding business-day rate (frankfurter returns it when
 * asked for that calendar date) and are stored under the REQUESTED date
 * so close-date lookups always hit.
 *
 * Network is defensive: every request is try/catch'd, callers receive
 * whatever is cached plus a `missing[]` array. No throws bubble up.
 */

;(function () {
    'use strict';

    const STORAGE_KEY = 'fxRates:v1:USD-EUR';
    const SCHEMA_VERSION = 1;
    const BASE = 'https://api.frankfurter.app';
    const FROM = 'USD';
    const TO = 'EUR';
    const CONCURRENCY = 4;

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
            if (!parsed || parsed.v !== SCHEMA_VERSION || !parsed.rates) {
                return { v: SCHEMA_VERSION, rates: {} };
            }
            return parsed;
        } catch (_) {
            return { v: SCHEMA_VERSION, rates: {} };
        }
    }

    function writeCache(cache) {
        const storage = getStorage();
        if (!storage) return;
        try {
            storage.setItem(STORAGE_KEY, JSON.stringify(cache));
        } catch (_) {
            // Quota or disabled storage — silently drop. Next call refetches.
        }
    }

    function isValidIsoDate(s) {
        return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
    }

    async function fetchJson(url) {
        try {
            const res = await fetch(url);
            if (!res.ok) return null;
            return await res.json();
        } catch (_) {
            return null;
        }
    }

    async function fetchTimeseries(startDate, endDate) {
        const url = `${BASE}/${startDate}..${endDate}?from=${FROM}&to=${TO}`;
        const json = await fetchJson(url);
        if (!json || !json.rates) return {};
        const flat = {};
        Object.keys(json.rates).forEach(d => {
            const rate = json.rates[d] && json.rates[d][TO];
            if (typeof rate === 'number' && isFinite(rate)) flat[d] = rate;
        });
        return flat;
    }

    async function fetchSingleDate(date) {
        const json = await fetchJson(`${BASE}/${date}?from=${FROM}&to=${TO}`);
        if (!json || !json.rates) return null;
        const rate = json.rates[TO];
        return (typeof rate === 'number' && isFinite(rate)) ? rate : null;
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
        const cache = readCache();
        const want = (dates || []).filter(isValidIsoDate);
        const uniq = [...new Set(want)];
        const result = { rates: {}, missing: [] };

        uniq.forEach(d => {
            if (typeof cache.rates[d] === 'number') result.rates[d] = cache.rates[d];
        });
        const stillMissing = uniq.filter(d => !(d in result.rates));
        if (!stillMissing.length) return result;

        const sorted = stillMissing.slice().sort();
        const flat = await fetchTimeseries(sorted[0], sorted[sorted.length - 1]);
        Object.assign(cache.rates, flat);
        Object.keys(flat).forEach(d => {
            if (uniq.indexOf(d) !== -1) result.rates[d] = flat[d];
        });
        writeCache(cache);

        // Weekend / holiday close dates are absent from the timeseries
        // response. Per-date fetch resolves them to the nearest preceding
        // business day; we store under the REQUESTED date.
        const gapDates = stillMissing.filter(d => !(d in result.rates));
        if (gapDates.length) {
            const fetched = await runWithConcurrency(gapDates, fetchSingleDate, CONCURRENCY);
            gapDates.forEach((d, i) => {
                const rate = fetched[i];
                if (typeof rate === 'number') {
                    cache.rates[d] = rate;
                    result.rates[d] = rate;
                }
            });
            writeCache(cache);
        }

        result.missing = uniq.filter(d => !(d in result.rates));
        return result;
    }

    async function getRatesForYear(year) {
        const y = parseInt(year, 10);
        if (!Number.isInteger(y) || y < 1999) {
            return { rates: {}, missing: [] };
        }
        const start = `${y}-01-01`;
        const end = `${y}-12-31`;
        const cache = readCache();
        const flat = await fetchTimeseries(start, end);
        Object.assign(cache.rates, flat);
        writeCache(cache);
        return { rates: Object.assign({}, flat), missing: [] };
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
        peek
    };
})();
