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
const { FILLS_PAGE_LIMIT, HISTORICAL_FUNDING_PAGE_LIMIT, CANDLES_PAGE_LIMIT } = globalThis.window.AppConstants;

const HTTP_OK = 200;
const HTTP_SERVER_ERROR = 500;
const ADDRESS = 'dydx1testaddress';
const INCEPTION_MS = Date.parse('2025-01-01T00:00:00Z');
const MS_PER_HOUR = 3_600_000;

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
