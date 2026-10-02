import { test, expect } from '@playwright/test';
import { fixture, fixtureKeyFor, indexerBody, serveFixture, INDEXER_URL } from './indexer-fixture.mjs';

// Post-Loss Double Down in the real page on a synthetic account whose
// positions share an entry and a close millisecond: in one block BUY 1 opens
// LONG A, SELL 2 reverses it into SHORT B and BUY 1 closes B, both at a loss;
// ten minutes later SELL 2 opens SHORT C at twice B's peak notional. The
// CLOSED list gives B before A, so only the fills' chain order makes B, not
// A, C's predecessor.

const BLOCK_AT = '2025-07-02T10:00:00.000Z';
const BLOCK_HEIGHT = '100';
const REENTRY_AT = '2025-07-02T10:10:00.000Z';
const REENTRY_HEIGHT = '200';

const position = (side, status, createdAt, closedAt, size) => ({
  market: 'BTC-USD', side, status, size, maxSize: size, sumOpen: '1', sumClose: '1',
  unrealizedPnl: '0', realizedPnl: '0', netFunding: '0', createdAt, createdAtHeight: BLOCK_HEIGHT, closedAt,
});
const fill = (id, side, size, price, createdAt, createdAtHeight) => ({
  id, market: 'BTC-USD', side, size, price, fee: '0', liquidity: 'TAKER', type: 'LIMIT', createdAt, createdAtHeight,
});

const LONG_A = position('LONG', 'CLOSED', BLOCK_AT, BLOCK_AT, '0');
const SHORT_B = position('SHORT', 'CLOSED', BLOCK_AT, BLOCK_AT, '0');
const SHORT_C = { ...position('SHORT', 'OPEN', REENTRY_AT, null, '-2'), createdAtHeight: REENTRY_HEIGHT };

const account = {
  ...fixture,
  subaccount: { subaccount: { ...fixture.subaccount.subaccount, equity: '10000' } },
  markets: { markets: { 'BTC-USD': { ...fixture.markets.markets['BTC-USD'], oraclePrice: '100' } } },
  openPositions: { positions: [SHORT_C] },
  closedPositions: { positions: [SHORT_B, LONG_A] },
  fills: { fills: [
    fill('a1', 'BUY', '1', '100', BLOCK_AT, BLOCK_HEIGHT),
    fill('a2', 'SELL', '2', '99', BLOCK_AT, BLOCK_HEIGHT),
    fill('b1', 'BUY', '1', '100', BLOCK_AT, BLOCK_HEIGHT),
    fill('c1', 'SELL', '2', '100', REENTRY_AT, REENTRY_HEIGHT),
  ] },
  historicalPnl: { historicalPnl: [] },
};

function serveAccount(route) {
  const key = fixtureKeyFor(route.request().url());
  if (!key) return serveFixture(route);
  const body = indexerBody(key, account, route.request().url());
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

test('Post-Loss Double Down pairs a loser closed in its entry block by the fills\' chain order, not the listing order', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2025-07-03T00:00:00.000Z'));
  await page.route(INDEXER_URL, serveAccount);
  await page.goto(`/?address=${account.address}`);

  await page.locator('.nav-tab[data-tab="behavior"]').click();
  const doubleDown = page.locator('#patternsBody tr', { hasText: 'Post-Loss Double Down' });
  await expect(doubleDown).toHaveCount(1);
  await expect(doubleDown.locator('td').nth(1)).toHaveText('1');
});
