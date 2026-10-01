// Serves the synthetic sample-trader fixture in place of the dYdX indexer
// for Playwright specs.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The dashboard's own window.AppConstants, read from src/constants.js so
// specs build fixture timestamps from the same units the page uses.
export const AppConstants = (() => {
  const sandbox = { window: {} };
  runInNewContext(readFileSync(join(__dirname, '..', 'src', 'constants.js'), 'utf-8'), sandbox);
  return sandbox.window.AppConstants;
})();
export const fixture = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'sample-trader.json'), 'utf-8')
);
export const ADDRESS = fixture.address;
export const INDEXER_URL = /indexer\.dydx\.trade/;

// Map each indexer URL pattern to the fixture key whose JSON it should serve.
// Order matters: the more specific patterns must match before the more general
// /addresses/{addr} pattern (sub vs addressSubaccounts).
export const ROUTE_RULES = [
  { match: /\/v4\/addresses\/[^/]+\/subaccountNumber\/0(?:\?|$)/, key: 'subaccount' },
  { match: /\/v4\/addresses\/[^/?]+(?:\?|$)/,                       key: 'addressSubaccounts' },
  { match: /\/v4\/perpetualPositions[^?]*\?[^#]*status=OPEN/,       key: 'openPositions' },
  { match: /\/v4\/perpetualPositions[^?]*\?[^#]*status=CLOSED/,     key: 'closedPositions' },
  { match: /\/v4\/perpetualMarkets(?:\?|$)/,                        key: 'markets' },
  { match: /\/v4\/fills\?/,                                         key: 'fills' },
  { match: /\/v4\/fundingPayments\?/,                               key: 'fundingPayments' },
  { match: /\/v4\/historical-pnl\?/,                                key: 'historicalPnl' },
  // Market-wide endpoints used by the Market Structure tab's funding
  // history chart. Lazy-loaded on tab activation; the fixture has no
  // data for these so the smoke verifies the empty-state path doesn't
  // throw and doesn't log network errors.
  { match: /\/v4\/historicalFunding\//,                             empty: { historicalFunding: [] } },
  { match: /\/v4\/candles\/perpetualMarkets\//,                     empty: { candles: [] } },
];

// The fixture key an indexer URL maps to, or null for an unmapped URL.
export function fixtureKeyFor(url) {
  const rule = ROUTE_RULES.find(r => r.match.test(url));
  return rule ? (rule.key || null) : null;
}

// The indexer's page-mode /fills answer: fills in eventId-ascending (chain)
// order, `limit` per 1-indexed `page`. Fixture fill lists may give blocks in
// any order, but list the fills inside one block in chain order.
function pageModeFills(fillsBody, url) {
  const params = new URL(url).searchParams;
  const page = Number(params.get('page'));
  const limit = Number(params.get('limit'));
  const chainOrder = fillsBody.fills
    .map((fill, listed) => ({ fill, listed }))
    .sort((a, b) => Number(a.fill.createdAtHeight) - Number(b.fill.createdAtHeight) || a.listed - b.listed)
    .map(({ fill }) => fill);
  return { ...fillsBody, fills: chainOrder.slice((page - 1) * limit, page * limit) };
}

// The body the indexer answers `url` with, from the fixture-shaped `data`.
export function indexerBody(key, data, url) {
  const isPageModeFills = key === 'fills' && new URL(url).searchParams.has('page');
  return isPageModeFills ? pageModeFills(data.fills, url) : data[key];
}

export async function serveFixture(route) {
  const url = route.request().url();
  const rule = ROUTE_RULES.find(r => r.match.test(url));
  if (!rule) {
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  }
  const body = rule.key ? indexerBody(rule.key, fixture, url) : rule.empty;
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}
