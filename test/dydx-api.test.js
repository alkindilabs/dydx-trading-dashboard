'use strict';

// DydxApi pagination tests. Runs the real paginator against a stubbed
// `fetch` that plays the indexer: only the network is faked. Failing
// responses carry `Retry-After: 0` so the real retry loop runs every
// attempt without waiting out its backoff.

const test = require('node:test');
const assert = require('node:assert/strict');

globalThis.window = globalThis;
require('../src/constants.js');
require('../src/dydx-api.js');
const Api = globalThis.window.DydxApi;
const { FILLS_PAGE_LIMIT, HISTORICAL_FUNDING_PAGE_LIMIT, CANDLES_PAGE_LIMIT, CANDLES_MAX_PAGES, MS_PER_HOUR } = globalThis.window.AppConstants;

const HTTP_OK = 200;
const HTTP_SERVER_ERROR = 500;
const ADDRESS = 'dydx1testaddress';
const INCEPTION_MS = Date.parse('2025-01-01T00:00:00Z');

function jsonResponse(body) {
    return new Response(JSON.stringify(body), {
        status: HTTP_OK,
        headers: { 'Content-Type': 'application/json' }
    });
}

function serverError() {
    return new Response('indexer unavailable', {
        status: HTTP_SERVER_ERROR,
        headers: { 'Retry-After': '0' }
    });
}

function withFetch(handler, body) {
    const original = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (url) => {
        requests.push(String(url));
        return handler(String(url), requests.length);
    };
    return Promise.resolve()
        .then(() => body(requests))
        .finally(() => { globalThis.fetch = original; });
}

function fillRow(i) {
    return {
        id: `fill-${i}`,
        market: 'ETH-USD',
        side: 'BUY',
        size: '1',
        price: '2000',
        createdAt: new Date(INCEPTION_MS + i * MS_PER_HOUR).toISOString()
    };
}

// Plays /v4/fills in page mode: rows oldest first (eventId ascending),
// `limit` rows per 1-indexed `page`.
function pagedFills(chainOrder) {
    return (url) => {
        const params = new URL(url).searchParams;
        const page = Number(params.get('page'));
        const limit = Number(params.get('limit'));
        if (!(page >= 1)) return jsonResponse({ fills: chainOrder.slice().reverse().slice(0, limit) });
        return jsonResponse({ fills: chainOrder.slice((page - 1) * limit, page * limit) });
    };
}

const pageOf = (url) => new URL(url).searchParams.get('page');

test('fetchAllFills walks page mode in chain order and stops on the empty page after a full last page', async () => {
    const PAGES = 2;
    const chainOrder = Array.from({ length: PAGES * FILLS_PAGE_LIMIT }, (_, i) => fillRow(i));
    await withFetch(pagedFills(chainOrder), async (requests) => {
        const { fills } = await Api.fetchAllFills(ADDRESS);
        assert.deepEqual(fills.map(f => f.id), chainOrder.map(f => f.id));
        assert.deepEqual(requests.map(pageOf), ['1', '2', '3']);
        assert.ok(requests.every(u => u.includes(`limit=${FILLS_PAGE_LIMIT}`)));
    });
});

test('fetchAllFills stops after a short page without asking for another', async () => {
    const chainOrder = Array.from({ length: FILLS_PAGE_LIMIT + 1 }, (_, i) => fillRow(i));
    await withFetch(pagedFills(chainOrder), async (requests) => {
        const { fills } = await Api.fetchAllFills(ADDRESS);
        assert.equal(fills.length, chainOrder.length);
        assert.deepEqual(requests.map(pageOf), ['1', '2']);
    });
});

test('fetchAllFills rejects when a page after the first fails on every retry', async () => {
    const chainOrder = Array.from({ length: FILLS_PAGE_LIMIT + 1 }, (_, i) => fillRow(i));
    const servePage = pagedFills(chainOrder);
    await withFetch(
        (url) => (pageOf(url) === '1' ? servePage(url) : serverError()),
        async (requests) => {
            await assert.rejects(
                Api.fetchAllFills(ADDRESS),
                (e) => e.status === HTTP_SERVER_ERROR
            );
            const secondPageAttempts = requests.filter(u => pageOf(u) === '2').length;
            assert.ok(secondPageAttempts > 1,
                `the failing page must be retried before the walk gives up (attempts: ${secondPageAttempts})`);
        }
    );
});

test('fetchHistoricalFunding resolves when its maxRows cap stops a walk that still has pages', async () => {
    let served = 0;
    const endlessPage = () => ({
        historicalFunding: Array.from({ length: HISTORICAL_FUNDING_PAGE_LIMIT }, () => {
            served++;
            return {
                ticker: 'ETH-USD',
                rate: '0.00001',
                price: '2000',
                effectiveAt: new Date(INCEPTION_MS - served * MS_PER_HOUR).toISOString(),
                effectiveAtHeight: String(served)
            };
        })
    });
    await withFetch(
        () => jsonResponse(endlessPage()),
        async (requests) => {
            const { historicalFunding } = await Api.fetchHistoricalFunding('ETH-USD', {
                maxRows: HISTORICAL_FUNDING_PAGE_LIMIT
            });
            assert.ok(requests.length > 1, 'the cap must allow more than one page');
            assert.equal(historicalFunding.length, requests.length * HISTORICAL_FUNDING_PAGE_LIMIT);
        }
    );
});

test('fetchCandles rejects when a page after the first fails on every retry', async () => {
    const newestPage = {
        candles: Array.from({ length: CANDLES_PAGE_LIMIT }, (_, i) => ({
            ticker: 'ETH-USD',
            resolution: '1HOUR',
            close: '2000',
            startedAt: new Date(INCEPTION_MS - i * MS_PER_HOUR).toISOString()
        }))
    };
    await withFetch(
        (url) => (url.includes('toISO=') ? serverError() : jsonResponse(newestPage)),
        async (requests) => {
            await assert.rejects(
                Api.fetchCandles('ETH-USD', '1HOUR', { fromMs: 0 }),
                (e) => e.status === HTTP_SERVER_ERROR
            );
            const secondPageAttempts = requests.filter(u => u.includes('toISO=')).length;
            assert.ok(secondPageAttempts > 1,
                `the failing page must be retried before the walk gives up (attempts: ${secondPageAttempts})`);
        }
    );
});

function candleRow(hoursBeforeInception) {
    return {
        ticker: 'ETH-USD',
        resolution: '1HOUR',
        close: '2000',
        startedAt: new Date(INCEPTION_MS - hoursBeforeInception * MS_PER_HOUR).toISOString()
    };
}

function abortedByTimeout() {
    throw new DOMException('The operation was aborted.', 'AbortError');
}

async function captureRetryLogs(body) {
    const debugLines = [];
    const originalDebug = console.debug;
    console.debug = (...args) => { debugLines.push(args.join(' ')); };
    try {
        await body();
    } finally {
        console.debug = originalDebug;
    }
    return debugLines;
}

test('fetchCandles retry log after an HTTP error names the candles endpoint, not the request URL', async () => {
    const debugLines = await captureRetryLogs(() => withFetch(
        (_url, attempt) => (attempt === 1 ? serverError() : jsonResponse({ candles: [candleRow(0)] })),
        () => Api.fetchCandles('ETH-USD', '1HOUR', { fromMs: 0 })
    ));
    assert.equal(debugLines.length, 1, `one retry expected, got: ${JSON.stringify(debugLines)}`);
    assert.ok(debugLines[0].startsWith('[candles:ETH-USD] retry 1/'), debugLines[0]);
    assert.ok(debugLines[0].includes(`HTTP ${HTTP_SERVER_ERROR}`), debugLines[0]);
    assert.ok(!debugLines[0].includes(Api.BASE), `retry log must not carry the URL: ${debugLines[0]}`);
});

test('fetchAllFills retry log after a timeout names the fills endpoint, not the address-bearing URL', async () => {
    const chainOrder = [fillRow(0)];
    const servePage = pagedFills(chainOrder);
    const debugLines = await captureRetryLogs(() => withFetch(
        (url, attempt) => (attempt === 1 ? abortedByTimeout() : servePage(url)),
        () => Api.fetchAllFills(ADDRESS)
    ));
    assert.equal(debugLines.length, 1, `one retry expected, got: ${JSON.stringify(debugLines)}`);
    assert.ok(debugLines[0].startsWith('[fills] retry 1/'), debugLines[0]);
    assert.ok(/timeout/i.test(debugLines[0]), debugLines[0]);
    assert.ok(!debugLines[0].includes(Api.BASE), `retry log must not carry the URL: ${debugLines[0]}`);
    assert.ok(!debugLines[0].includes(ADDRESS), `retry log must not carry the address: ${debugLines[0]}`);
});

test('fetchJsonWithRetry retry log without a label does not fall back to the request URL', async () => {
    const url = `${Api.BASE}/addresses/${ADDRESS}`;
    const debugLines = await captureRetryLogs(() => withFetch(
        (_url, attempt) => (attempt === 1 ? serverError() : jsonResponse({})),
        () => Api.fetchJsonWithRetry(url)
    ));
    assert.equal(debugLines.length, 1, `one retry expected, got: ${JSON.stringify(debugLines)}`);
    assert.match(debugLines[0], /^\[[^\]]+\] retry 1\//, 'an unlabelled call still names an endpoint');
    assert.ok(!debugLines[0].includes(ADDRESS), `retry log must not carry the address: ${debugLines[0]}`);
});

test('retry log after a network error describes it without the error message, which carries the URL', async () => {
    const url = `${Api.BASE}/addresses/${ADDRESS}`;
    const debugLines = await captureRetryLogs(() => withFetch(
        (_url, attempt) => {
            if (attempt === 1) throw new TypeError(`Failed to fetch ${url}`);
            return jsonResponse({});
        },
        () => Api.fetchJsonWithRetry(url, { label: 'subaccount' })
    ));
    assert.equal(debugLines.length, 1, `one retry expected, got: ${JSON.stringify(debugLines)}`);
    assert.ok(debugLines[0].includes('network error'), debugLines[0]);
    assert.ok(!debugLines[0].includes(ADDRESS), `retry log must not carry the address: ${debugLines[0]}`);
});

test('fetchCandles stops at CANDLES_MAX_PAGES when the caller sets no page cap', async () => {
    let served = 0;
    const endlessPage = () => ({
        candles: Array.from({ length: CANDLES_PAGE_LIMIT }, () => candleRow(served++))
    });
    await withFetch(
        () => jsonResponse(endlessPage()),
        async (requests) => {
            const { candles } = await Api.fetchCandles('ETH-USD', '1HOUR', { fromMs: 0 });
            assert.equal(requests.length, CANDLES_MAX_PAGES);
            assert.equal(candles.length, CANDLES_MAX_PAGES * CANDLES_PAGE_LIMIT);
        }
    );
});
