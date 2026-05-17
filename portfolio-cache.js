// PortfolioCache: persists the last successfully-loaded dYdX address payload
// (the global `allData` object) into localStorage so subsequent page loads
// can render instantly from cache while a fresh fetch runs in the background.
//
// Storage shape (compressed via LZString.compressToUTF16):
//     { v: 1, address, fetchedAt, data: allData }
//
// The pure helpers `pack`, `unpack`, and `evictOnce` are exported on
// `PortfolioCache._internal` for unit testing without LZString or
// localStorage. The browser path also calls those helpers internally.
//
// Eviction order on QuotaExceededError (largest payloads first):
//   1. fills
//   2. fundingPayments
//   3. historicalPnl trimmed to last HISTORICAL_PNL_TRIM rows
//   4. closedPositions
;(function () {
    'use strict';

    const KEY = 'dydxCache:v1';
    const SCHEMA_VERSION = 1;
    const HISTORICAL_PNL_TRIM = 5000;
    const EVICTION_ORDER = ['fills', 'fundingPayments', 'historicalPnl', 'closedPositions'];

    function pack(address, data) {
        return {
            v: SCHEMA_VERSION,
            address: String(address || '').toLowerCase(),
            fetchedAt: Date.now(),
            data
        };
    }

    function unpack(parsed, expectedAddress) {
        if (!parsed || typeof parsed !== 'object') return null;
        if (parsed.v !== SCHEMA_VERSION) return null;
        if (!parsed.data || typeof parsed.data !== 'object') return null;
        const want = String(expectedAddress || '').toLowerCase();
        if (parsed.address !== want) return null;
        return parsed;
    }

    // Apply one eviction step. Returns a new packed object with the step
    // applied, or null if the step is a no-op for this payload (caller
    // should advance to the next step).
    function evictOnce(packed, step) {
        const key = EVICTION_ORDER[step];
        if (!key) return null;
        const data = packed.data || {};

        if (key === 'historicalPnl') {
            const cur = data.historicalPnl;
            const arr = (cur && Array.isArray(cur.historicalPnl)) ? cur.historicalPnl
                      : (Array.isArray(cur) ? cur : null);
            if (!arr || arr.length <= HISTORICAL_PNL_TRIM) return null;
            const trimmed = arr.slice(-HISTORICAL_PNL_TRIM);
            const nextHistorical = (cur && Array.isArray(cur.historicalPnl))
                ? Object.assign({}, cur, { historicalPnl: trimmed })
                : trimmed;
            return {
                v: packed.v,
                address: packed.address,
                fetchedAt: packed.fetchedAt,
                data: Object.assign({}, data, { historicalPnl: nextHistorical })
            };
        }

        if (data[key] === undefined) return null;
        const nextData = Object.assign({}, data);
        delete nextData[key];
        return {
            v: packed.v,
            address: packed.address,
            fetchedAt: packed.fetchedAt,
            data: nextData
        };
    }

    function isQuotaError(e) {
        if (!e) return false;
        if (e.name === 'QuotaExceededError') return true;
        if (e.name === 'NS_ERROR_DOM_QUOTA_REACHED') return true;
        if (e.code === 22 || e.code === 1014) return true;
        return false;
    }

    function getStorage() {
        try {
            return (typeof localStorage !== 'undefined') ? localStorage : null;
        } catch (_) {
            return null;
        }
    }

    function getLZ() {
        try {
            return (typeof LZString !== 'undefined') ? LZString : null;
        } catch (_) {
            return null;
        }
    }

    function read(address) {
        const storage = getStorage();
        const lz = getLZ();
        if (!storage || !lz) return null;
        let raw;
        try {
            raw = storage.getItem(KEY);
        } catch (_) {
            return null;
        }
        if (!raw) return null;
        try {
            const json = lz.decompressFromUTF16(raw);
            if (!json) throw new Error('decompress returned empty');
            const parsed = JSON.parse(json);
            const ok = unpack(parsed, address);
            return ok ? ok.data : null;
        } catch (e) {
            console.warn('[dydx-cache] read failed:', (e && e.message) || e);
            try { storage.removeItem(KEY); } catch (_) {}
            return null;
        }
    }

    function attemptStore(storage, lz, packed) {
        try {
            const json = JSON.stringify(packed);
            const compressed = lz.compressToUTF16(json);
            storage.setItem(KEY, compressed);
            return { ok: true };
        } catch (e) {
            if (isQuotaError(e)) return { ok: false, quota: true };
            return { ok: false, quota: false, error: e };
        }
    }

    function write(address, data) {
        const storage = getStorage();
        const lz = getLZ();
        if (!storage || !lz) return;
        let packed = pack(address, data);

        let result = attemptStore(storage, lz, packed);
        if (result.ok) return;
        if (!result.quota) {
            console.warn('[dydx-cache] write failed:', (result.error && result.error.message) || result.error);
            return;
        }

        // Stamp _cacheMeta on the data the moment we begin evicting so a
        // later read() can tell the snapshot is partial without re-running
        // any eviction logic. Without the marker, an evicted snapshot
        // looked complete and the dashboard might rely on dropped fields.
        const evictedSteps = [];
        for (let step = 0; step < EVICTION_ORDER.length; step++) {
            const evicted = evictOnce(packed, step);
            if (!evicted) continue;
            packed = evicted;
            evictedSteps.push(EVICTION_ORDER[step]);
            packed.data._cacheMeta = {
                evicted: true,
                evictedSteps: evictedSteps.slice()
            };
            result = attemptStore(storage, lz, packed);
            if (result.ok) {
                console.warn('[dydx-cache] payload exceeded quota; stored after evicting:',
                    evictedSteps.join(', '));
                return;
            }
            if (!result.quota) {
                console.warn('[dydx-cache] write failed during eviction:',
                    (result.error && result.error.message) || result.error);
                return;
            }
        }
        console.warn('[dydx-cache] payload exceeds quota even after eviction; cache skipped');
    }

    function clear() {
        const storage = getStorage();
        if (!storage) return;
        try { storage.removeItem(KEY); } catch (_) {}
    }

    const api = {
        read,
        write,
        clear,
        KEY,
        SCHEMA_VERSION,
        _internal: { pack, unpack, evictOnce, isQuotaError, EVICTION_ORDER, HISTORICAL_PNL_TRIM }
    };

    if (typeof window !== 'undefined') {
        window.PortfolioCache = api;
    }
})();
