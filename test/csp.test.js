'use strict';

// The Content-Security-Policy in _headers is applied only by Cloudflare's
// edge: the local and e2e servers ignore it, so a policy that blocks a host
// the code calls passes every other test and breaks only in production.
// These tests capture the origins the real modules fetch, and the external
// scripts and stylesheets index.html loads, and require the policy to allow
// each one.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const HTTP_OK = 200;

globalThis.window = globalThis;
globalThis.localStorage = (() => {
    const map = new Map();
    return {
        getItem: k => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => { map.set(k, String(v)); },
        removeItem: k => { map.delete(k); }
    };
})();
require('../src/constants.js');
require('../src/dydx-api.js');
require('../fx-rates.js');

function cspDirectives() {
    const headers = fs.readFileSync(path.join(ROOT, '_headers'), 'utf8');
    const line = headers.split('\n').find(l => /^\s*Content-Security-Policy:/i.test(l));
    assert.ok(line, '_headers must declare a Content-Security-Policy');
    const policy = line.slice(line.indexOf(':') + 1);
    const directives = {};
    policy.split(';').forEach(part => {
        const [name, ...sources] = part.trim().split(/\s+/);
        if (name) directives[name] = sources;
    });
    return directives;
}

function assertAllowed(directives, directive, origin) {
    const sources = directives[directive] || directives['default-src'] || [];
    assert.ok(sources.includes(origin),
        `${directive} must allow ${origin}; it lists: ${sources.join(' ')}`);
}

async function originsFetchedBy(calls) {
    const original = globalThis.fetch;
    const urls = [];
    globalThis.fetch = async (url) => {
        urls.push(String(url));
        return new Response(JSON.stringify({ fills: [], rates: {} }), {
            status: HTTP_OK,
            headers: { 'Content-Type': 'application/json' }
        });
    };
    try {
        await calls();
    } finally {
        globalThis.fetch = original;
    }
    return [...new Set(urls.map(u => new URL(u).origin))];
}

function externalOrigins(html, tagPattern) {
    return [...new Set([...html.matchAll(tagPattern)].map(m => new URL(m[1] || m[2]).origin))];
}

test('connect-src allows every origin the indexer client and the FX client fetch', async () => {
    const origins = await originsFetchedBy(async () => {
        await window.DydxApi.fetchAllFills('dydx1test');
        await window.FxRates.getRates(['2025-01-02']);
    });
    assert.ok(origins.length >= 2, `expected the indexer and FX origins, got ${origins.join(', ')}`);
    const directives = cspDirectives();
    origins.forEach(origin => assertAllowed(directives, 'connect-src', origin));
});

test('script-src and style-src allow every external script and stylesheet index.html loads', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const directives = cspDirectives();
    const scripts = externalOrigins(html, /<script[^>]+src="(https:[^"]+)"/g);
    const styles = externalOrigins(html, /<link[^>]+rel="stylesheet"[^>]+href="(https:[^"]+)"|<link[^>]+href="(https:[^"]+)"[^>]+rel="stylesheet"/g);
    assert.ok(scripts.length > 0, 'index.html loads external scripts');
    scripts.forEach(origin => assertAllowed(directives, 'script-src', origin));
    styles.forEach(origin => assertAllowed(directives, 'style-src', origin));
});
