import { test, expect } from '@playwright/test';
import { fixture, fixtureKeyFor, indexerBody, serveFixture, INDEXER_URL } from './indexer-fixture.mjs';

// The closed-trade drawdown fallback (no /historical-pnl rows) in the real
// page: two positions closed in one block enter the cumulative series in
// their fills' chain order, not in the order the CLOSED list gives them,
// and the series ends now, so the time below peak runs to the clock.
// Synthetic account: +$1000 on BTC; then in one block an ETH loss of $400
// (first in the chain) and a BTC win of $400 (listed first); then an ETH
// loss of $100. Cumulative profit 0 → 1000 → 600 → 1000 → 900.

const NOW = '2025-06-01T00:00:00.000Z';
const SAME_BLOCK_AT = '2025-04-01T05:00:00.000Z';
const SAME_BLOCK_HEIGHT = '400';

const position = (market, createdAt, createdAtHeight, closedAt, size) => ({
  market, side: 'LONG', status: 'CLOSED', size: '0', maxSize: size, sumOpen: size, sumClose: size,
  unrealizedPnl: '0', realizedPnl: '0', netFunding: '0', createdAt, createdAtHeight, closedAt,
});
const fill = (id, market, side, size, price, createdAt, createdAtHeight) => ({
  id, market, side, size, price, fee: '0', liquidity: 'TAKER', type: 'LIMIT', createdAt, createdAtHeight,
});

const BTC_WIN = position('BTC-USD', '2025-03-01T00:00:00.000Z', '100', '2025-03-02T00:00:00.000Z', '1');
const ETH_LOSS = position('ETH-USD', '2025-03-15T00:00:00.000Z', '250', SAME_BLOCK_AT, '10');
const BTC_SAME_BLOCK_WIN = position('BTC-USD', '2025-03-20T00:00:00.000Z', '260', SAME_BLOCK_AT, '1');
const ETH_LATE_LOSS = position('ETH-USD', '2025-04-20T00:00:00.000Z', '500', '2025-05-01T00:00:00.000Z', '10');

const account = {
  ...fixture,
  subaccount: { subaccount: { ...fixture.subaccount.subaccount, equity: '10000' } },
  markets: { markets: {
    'BTC-USD': { ...fixture.markets.markets['BTC-USD'], oraclePrice: '100000' },
    'ETH-USD': { ticker: 'ETH-USD', oraclePrice: '2000', marketType: 'CROSS', status: 'ACTIVE',
      initialMarginFraction: '0.05', maintenanceMarginFraction: '0.03', stepSize: '0.001', tickSize: '0.1' },
  } },
  openPositions: { positions: [] },
  closedPositions: { positions: [ETH_LATE_LOSS, BTC_SAME_BLOCK_WIN, ETH_LOSS, BTC_WIN] },
  fills: { fills: [
    fill('b1', 'BTC-USD', 'BUY', '1', '100000', BTC_WIN.createdAt, '100'),
    fill('b2', 'BTC-USD', 'SELL', '1', '101000', BTC_WIN.closedAt, '200'),
    fill('e1', 'ETH-USD', 'BUY', '10', '2000', ETH_LOSS.createdAt, '250'),
    fill('b3', 'BTC-USD', 'BUY', '1', '100000', BTC_SAME_BLOCK_WIN.createdAt, '260'),
    fill('e2', 'ETH-USD', 'SELL', '10', '1960', SAME_BLOCK_AT, SAME_BLOCK_HEIGHT),
    fill('b4', 'BTC-USD', 'SELL', '1', '100400', SAME_BLOCK_AT, SAME_BLOCK_HEIGHT),
    fill('e3', 'ETH-USD', 'BUY', '10', '2000', ETH_LATE_LOSS.createdAt, '500'),
    fill('e4', 'ETH-USD', 'SELL', '10', '1990', ETH_LATE_LOSS.closedAt, '600'),
  ] },
  historicalPnl: { historicalPnl: [] },
};

function serveAccount(route) {
  const key = fixtureKeyFor(route.request().url());
  if (!key) return serveFixture(route);
  const body = indexerBody(key, account, route.request().url());
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

test('the closed-trade drawdown orders a block\'s closes by chain and runs its time below peak to now', async ({ page }) => {
  await page.clock.setFixedTime(new Date(NOW));
  await page.route(INDEXER_URL, serveAccount);
  await page.goto(`/?address=${account.address}`);

  // Peak $1000 regained in the block at 05:00 on Apr 1; $900 since May 1.
  await expect(page.locator('#currentDrawdown')).toHaveText('-$100');
  await expect(page.locator('#currentDrawdownDetail')).toHaveText(/^Closed-trade profit · 60d 19h below peak \(since 2025-04-01\)/);
  await expect(page.locator('#maxDrawdown')).toHaveText('-$400');
  // The cards' tooltips describe the closed-trade series they show.
  for (const id of ['maxDrawdownCard', 'currentDrawdownCard', 'recoveryFactorLabel']) {
    expect(await page.locator(`#${id}`).getAttribute('title'), id).toMatch(/closed-trade profit/);
  }

  await page.locator('.nav-tab[data-tab="risk"]').click();
  await expect(page.locator('#drawdownPeriodsTitle')).toHaveText('Historical Drawdown Periods (2, deepest first)');
  const rows = page.locator('#drawdownPeriodsBody tr');
  await expect(rows.nth(0).locator('td').nth(0)).toHaveText('2025-03-02 → 2025-04-01');
  await expect(rows.nth(1).locator('td').nth(0)).toHaveText('2025-04-01 → ongoing');
  await expect(rows.nth(1).locator('td').nth(2)).toHaveText('60d 19h');
});

// The same account with one CLOSED row whose closedAt is missing or does
// not parse: its place in the cumulative series is unknown, so every
// drawdown view reads — with RiskMetrics.closeTimeGap's reason rather than
// a series over the other trades (or a crash on the unparsed time).
for (const [label, badClose] of [['a missing', undefined], ['an unparseable', 'garbage']]) {
  test(`a closed position with ${label} close time leaves every closed-trade drawdown view — with the reason`, async ({ page }) => {
    const reason = '1 closed position without a valid close time';
    const untimed = { ...account, closedPositions: { positions: [{ ...ETH_LATE_LOSS, closedAt: badClose }, BTC_SAME_BLOCK_WIN, ETH_LOSS, BTC_WIN] } };
    await page.clock.setFixedTime(new Date(NOW));
    await page.route(INDEXER_URL, route => {
      const key = fixtureKeyFor(route.request().url());
      if (!key) return serveFixture(route);
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify(indexerBody(key, untimed, route.request().url())) });
    });
    await page.goto(`/?address=${account.address}`);

    for (const id of ['maxDrawdown', 'currentDrawdown']) {
      await expect(page.locator(`#${id}`)).toHaveText('—');
      await expect(page.locator(`#${id}Detail`)).toHaveText(reason);
    }
    await expect(page.locator('#recoveryFactor')).toHaveText('—');

    await page.locator('.nav-tab[data-tab="risk"]').click();
    await expect(page.locator('#drawdownPeriodsBody')).toHaveText(reason);
  });
}
