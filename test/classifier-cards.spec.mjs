import { test, expect } from '@playwright/test';
import { ADDRESS, INDEXER_URL, fixture, fixtureKeyFor, indexerBody, serveFixture } from './indexer-fixture.mjs';

// End-to-end checks of how processData wires the classifier into the
// Overview cards and the Positions tab, the profit ledger into the Overview
// and Performance by Asset, and of the masthead clock, on synthetic
// accounts: a +$1000 BTC win and a -$400 ETH loss, and three trades whose
// components round at cents. Only the indexer (and, for the masthead, the
// clock) is faked.

const HTTP_SERVICE_UNAVAILABLE = 503;

const position = (fields) => ({
  status: 'CLOSED', size: '0', unrealizedPnl: '0', realizedPnl: '0', netFunding: '0', ...fields,
});
const fill = (id, market, side, size, price, createdAt, createdAtHeight) => ({
  id, market, side, size, price, fee: '0', liquidity: 'TAKER', createdAt, createdAtHeight, type: 'LIMIT',
});

const BTC_WIN = position({
  market: 'BTC-USD', side: 'LONG', maxSize: '1', sumOpen: '1', sumClose: '1',
  createdAt: '2025-03-01T00:00:00.000Z', createdAtHeight: '100', closedAt: '2025-03-02T00:00:00.000Z',
});
const ETH_LOSS = position({
  market: 'ETH-USD', side: 'LONG', maxSize: '10', sumOpen: '10', sumClose: '10',
  createdAt: '2025-04-01T00:00:00.000Z', createdAtHeight: '300', closedAt: '2025-04-01T05:00:00.000Z',
});
const WIN_FILLS = [
  fill('b1', 'BTC-USD', 'BUY',  '1', '100000', BTC_WIN.createdAt, '100'),
  fill('b2', 'BTC-USD', 'SELL', '1', '101000', BTC_WIN.closedAt, '200'),
];
const LOSS_FILLS = [
  fill('e1', 'ETH-USD', 'BUY',  '10', '2000', ETH_LOSS.createdAt, '300'),
  fill('e2', 'ETH-USD', 'SELL', '10', '1960', ETH_LOSS.closedAt, '400'),
];

const account = {
  ...fixture,
  markets: { markets: {
    'BTC-USD': { ...fixture.markets.markets['BTC-USD'], oraclePrice: '100000' },
    'ETH-USD': { ticker: 'ETH-USD', oraclePrice: '2000', marketType: 'CROSS', status: 'ACTIVE',
      initialMarginFraction: '0.05', maintenanceMarginFraction: '0.03', stepSize: '0.001', tickSize: '0.1' },
  } },
  openPositions: { positions: [] },
  closedPositions: { positions: [ETH_LOSS, BTC_WIN] },
  fills: { fills: [...LOSS_FILLS, ...WIN_FILLS] },
};
// A +$1999 win and a -$2000 loss: payoff 0.9995 reads 1.00 : 1, and
// Kelly (0.5 - 0.5 / 0.9995 = -0.025%) displays as zero.
const nearBreakevenAccount = {
  ...account,
  closedPositions: { positions: [ETH_LOSS, BTC_WIN] },
  fills: { fills: [
    LOSS_FILLS[0], { ...LOSS_FILLS[1], price: '1800' },
    WIN_FILLS[0], { ...WIN_FILLS[1], price: '101999' },
  ] },
};
// A +$400 win and a -$1000 loss: payoff 0.4, Kelly 0.5 - 0.5 / 0.4 = -75%.
const losingEdgeAccount = {
  ...account,
  fills: { fills: [
    LOSS_FILLS[0], { ...LOSS_FILLS[1], price: '1900' },
    WIN_FILLS[0], { ...WIN_FILLS[1], price: '100400' },
  ] },
};
const winsOnlyAccount = {
  ...account,
  closedPositions: { positions: [BTC_WIN] },
  fills: { fills: WIN_FILLS },
};

function serveAccount(failingKey, data = account) {
  return (route) => {
    const key = fixtureKeyFor(route.request().url());
    if (key && key === failingKey) {
      return route.fulfill({
        status: HTTP_SERVICE_UNAVAILABLE,
        headers: { 'Retry-After': '0', 'Access-Control-Expose-Headers': 'Retry-After' },
        contentType: 'text/plain',
        body: 'indexer unavailable',
      });
    }
    if (!key) return serveFixture(route);
    const body = indexerBody(key, data, route.request().url());
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  };
}

// The data-age caption appears only once a load has rendered.
async function loadAccount(page) {
  await page.goto(`/?address=${ADDRESS}`);
  await expect(page.locator('#dataAge')).toBeVisible();
}

async function openTab(page, tab) {
  await page.locator(`.nav-tab[data-tab="${tab}"]`).click();
}

test.describe('classifier cards and the Positions tab', () => {
  test('the Profit Factor caption and tooltip show the gross loss as a loss', async ({ page }) => {
    await page.route(INDEXER_URL, serveAccount(null));
    await loadAccount(page);

    await expect(page.locator('#profitFactor')).toHaveText('2.50');
    await expect(page.locator('#profitFactorDetail')).toHaveText('+$1,000 / -$400');
    await expect(page.locator('#profitFactorLabel')).toHaveAttribute('title', /Gross loss: -\$400$/);
  });

  test('with no losing trade the Payoff Ratio reads N/A and says which bucket is empty', async ({ page }) => {
    await page.route(INDEXER_URL, serveAccount(null, winsOnlyAccount));
    await loadAccount(page);

    await expect(page.locator('#riskRewardHero')).toHaveText('N/A');
    await expect(page.locator('#riskRewardHeroDetail')).toHaveText('No losses recorded');
    await expect(page.locator('#riskReward')).toHaveText('N/A');
  });

  test('the Payoff Ratio reads one way in every view, and a Kelly that displays as zero is unsigned', async ({ page }) => {
    await page.route(INDEXER_URL, serveAccount(null, nearBreakevenAccount));
    await loadAccount(page);

    for (const id of ['#riskRewardHero', '#riskReward', '#seImpliedRR']) {
      await expect(page.locator(id)).toHaveText('1.00 : 1');
    }
    await expect(page.locator('#kellyCriterion')).toHaveText('0.0%');
    await openTab(page, 'performance');
    await expect(page.locator('#avgRRR')).toHaveText('1.00 : 1');
  });

  test('a Kelly fraction that displays below zero is captioned as a negative edge, not as a size', async ({ page }) => {
    await page.route(INDEXER_URL, serveAccount(null, losingEdgeAccount));
    await loadAccount(page);

    await expect(page.locator('#kellyCriterion')).toHaveText('-75.0%');
    await expect(page.locator('#kellyCriterionDetail')).toHaveText('Negative edge: optimal size 0');
  });

  test('a Kelly fraction that displays as a size, or as zero, keeps the Optimal size caption', async ({ page }) => {
    await page.route(INDEXER_URL, serveAccount(null));
    await loadAccount(page);
    await expect(page.locator('#kellyCriterion')).toHaveText('30.0%');
    await expect(page.locator('#kellyCriterionDetail')).toHaveText('Optimal size');

    await page.unrouteAll();
    await page.route(INDEXER_URL, serveAccount(null, nearBreakevenAccount));
    await loadAccount(page);
    await expect(page.locator('#kellyCriterion')).toHaveText('0.0%');
    await expect(page.locator('#kellyCriterionDetail')).toHaveText('Optimal size');
  });

  test('the Payoff caption takes the expectancy\'s tone when the win rate and its breakeven display alike', async ({ page }) => {
    // WR 50.0% against a 50.0125% breakeven, both 50.0%; expectancy -$0.50 reads -$1.
    await page.route(INDEXER_URL, serveAccount(null, nearBreakevenAccount));
    await loadAccount(page);

    await expect(page.locator('#riskRewardHeroDetail')).toHaveText(/ · WR 50\.0% vs 50\.0% breakeven$/);
    await expect(page.locator('#riskRewardHeroDetail')).toHaveClass(/\bloss\b/);
  });

  test('a failed CLOSED list reads as its reason in the hold-time histogram and the history table', async ({ page }) => {
    await page.route(INDEXER_URL, serveAccount('closedPositions'));
    await loadAccount(page);
    await openTab(page, 'positions');

    const reason = 'Closed positions failed to load';
    await expect(page.locator('#holdTimeDistribution')).toHaveText(reason);
    await expect(page.locator('#positionsHistoryBody tr')).toHaveCount(1);
    await expect(page.locator('#positionsHistoryBody')).toHaveText(reason);
  });

  test('failed fills put their reason under Taker Share and on the blanked board cells', async ({ page }) => {
    await page.route(INDEXER_URL, serveAccount('fills'));
    await loadAccount(page);
    await openTab(page, 'positions');

    const reason = 'Fills failed to load';
    await expect(page.locator('#positionsTakerShare')).toHaveText('—');
    await expect(page.locator('#positionsTakerShareDetail')).toHaveText(reason);
    // CLOSED (UTC), ASSET, SIDE, SIZE, ENTRY, EXIT, PROFIT: the PROFIT cell.
    const profit = page.locator('#positionsHistoryBody tr').first().locator('td').nth(6);
    await expect(profit).toHaveText('—');
    await expect(profit).toHaveAttribute('title', reason);
  });
});

// One closed LONG per market whose realized (10.004), funding (0.004) and
// fees (0.3349) each round down at cents, so rows rounded on their own
// add up to less than the raw sums would display.
function roundingTrip(market, createdAt, closedAt, height) {
  return {
    position: position({
      market, side: 'LONG', maxSize: '1', sumOpen: '1', sumClose: '1',
      createdAt, createdAtHeight: String(height), closedAt, netFunding: '0.004',
    }),
    fills: [
      { ...fill(`${market}-open`, market, 'BUY', '1', '100', createdAt, String(height)), fee: '0.3349' },
      fill(`${market}-close`, market, 'SELL', '1', '110.004', closedAt, String(height + 1)),
    ],
  };
}
const ROUNDING_TRIPS = [
  roundingTrip('BTC-USD', '2025-05-01T00:00:00.000Z', '2025-05-01T01:00:00.000Z', 1000),
  roundingTrip('ETH-USD', '2025-05-02T00:00:00.000Z', '2025-05-02T01:00:00.000Z', 1010),
  roundingTrip('SOL-USD', '2025-05-03T00:00:00.000Z', '2025-05-03T01:00:00.000Z', 1020),
];
const roundingAccount = {
  ...account,
  closedPositions: { positions: ROUNDING_TRIPS.map(t => t.position) },
  fills: { fills: ROUNDING_TRIPS.flatMap(t => t.fills) },
};
// A LINK-USD round trip in the fills that no listed position owns.
const unlistedTradeAccount = {
  ...roundingAccount,
  fills: { fills: [
    ...roundingAccount.fills.fills,
    fill('link-open', 'LINK-USD', 'BUY', '1', '20', '2025-05-04T00:00:00.000Z', '1030'),
    fill('link-close', 'LINK-USD', 'SELL', '1', '21', '2025-05-04T01:00:00.000Z', '1031'),
  ] },
};
const [btcTrip, ...otherTrips] = ROUNDING_TRIPS;
const missingFundingAccount = {
  ...roundingAccount,
  closedPositions: { positions: [{ ...btcTrip.position, netFunding: undefined }, ...otherTrips.map(t => t.position)] },
};

// Signed cents of a displayed money cell ('+$1,234.56', '-$0.33', '$0.00').
function displayedCents(text) {
  const match = /^([+-]?)\$([\d,]+)\.(\d{2})$/.exec(text);
  expect(match, `money cell "${text}"`).not.toBeNull();
  const cents = Number(match[2].replace(/,/g, '')) * 100 + Number(match[3]);
  return match[1] === '-' ? -cents : cents;
}

// Performance by Asset: ASSET, PROFIT, FUNDING, FEES, ...
const ASSET_COLUMN = { PROFIT: 1, FUNDING: 2, FEES: 3 };

// The displayed asset rows' PROFIT / FUNDING / FEES, each column summed,
// and the displayed ledger.
async function displayedLedger(page) {
  const cell = async (id) => displayedCents(await page.locator(id).innerText());
  const ledger = {
    total: await cell('#totalPnL'),
    trading: await cell('#totalPnLTrading'),
    funding: await cell('#totalPnLFunding'),
    fees: await cell('#totalPnLFees'),
  };
  await openTab(page, 'performance');
  const rows = await page.locator('#assetPerformanceBody tr').evaluateAll(trs =>
    trs.map(tr => [...tr.children].map(td => td.textContent)));
  const columnSum = (column) => rows.reduce((sum, row) => sum + displayedCents(row[column]), 0);
  return {
    ledger,
    tickers: rows.map(row => row[0]),
    rows: { profit: columnSum(ASSET_COLUMN.PROFIT), funding: columnSum(ASSET_COLUMN.FUNDING), fees: columnSum(ASSET_COLUMN.FEES) },
  };
}

function expectRowsToAddUp({ ledger, rows }) {
  expect(ledger.trading + ledger.funding + ledger.fees).toBe(ledger.total);
  expect(rows.profit).toBe(ledger.total);
  expect(rows.funding).toBe(ledger.funding);
  expect(rows.fees).toBe(ledger.fees);
}

test.describe('profit ledger at cents', () => {
  test('the asset rows add up to the ledger, and the ledger to the headline, exactly as displayed', async ({ page }) => {
    await page.route(INDEXER_URL, serveAccount(null, roundingAccount));
    await loadAccount(page);

    // Raw sums would display +$30.01, +$0.01, -$1.00 and +$29.02.
    await expect(page.locator('#totalPnL')).toHaveText('+$29.01');
    const displayed = await displayedLedger(page);
    expect(displayed.ledger).toEqual({ total: 2901, trading: 3000, funding: 0, fees: -99 });
    expectRowsToAddUp(displayed);
    await expect(page.locator('#assetPerformanceBody tr', { hasText: 'BTC-USD' }).locator('td').nth(ASSET_COLUMN.PROFIT))
      .toHaveText('+$9.67');
  });

  test('a closed trade in the fills that no listed position owns blanks the classifier and the board with the reason, and still adds up', async ({ page }) => {
    await page.route(INDEXER_URL, serveAccount(null, unlistedTradeAccount));
    await loadAccount(page);

    const reason = 'Fills hold a closed trade no listed position owns in LINK-USD';
    await expect(page.locator('#winRate')).toHaveText('—');
    await expect(page.locator('#winRateDetail')).toHaveText(reason);
    await expect(page.locator('#profitFactor')).toHaveText('—');
    await expect(page.locator('#totalPnL')).toHaveText('+$30.01');
    const displayed = await displayedLedger(page);
    expect(displayed.tickers).toContain('LINK-USD');
    expectRowsToAddUp(displayed);

    await openTab(page, 'positions');
    await expect(page.locator('#positionsHistoryBody tr').first()).toHaveText(reason);
    await expect(page.locator('#positionsHistoryBody tr')).toHaveCount(1 + ROUNDING_TRIPS.length);
    await expect(page.locator('#holdTimeDistribution')).toHaveText(reason);
  });

  test('a position without netFunding blanks FUNDING, the headline and its market with the reason, never as $0', async ({ page }) => {
    await page.route(INDEXER_URL, serveAccount(null, missingFundingAccount));
    await loadAccount(page);

    const reason = 'No netFunding reported for 1 position';
    await expect(page.locator('#totalPnL')).toHaveText('—');
    await expect(page.locator('#totalPnLChange')).toHaveText(reason);
    await expect(page.locator('#totalPnLFunding')).toHaveText('—');
    await expect(page.locator('#totalPnLTrading')).toHaveText('+$30.00');
    await expect(page.locator('#totalPnLFees')).toHaveText('-$0.99');

    await openTab(page, 'performance');
    const btc = page.locator('#assetPerformanceBody tr', { hasText: 'BTC-USD' }).locator('td');
    for (const column of [ASSET_COLUMN.PROFIT, ASSET_COLUMN.FUNDING]) {
      await expect(btc.nth(column)).toHaveText('—');
      await expect(btc.nth(column)).toHaveAttribute('title', reason);
    }
    const eth = page.locator('#assetPerformanceBody tr', { hasText: 'ETH-USD' }).locator('td');
    await expect(eth.nth(ASSET_COLUMN.FUNDING)).toHaveText('$0.00');

    await openTab(page, 'positions');
    // CLOSED (UTC), ASSET, SIDE, SIZE, ENTRY, EXIT, PROFIT, PROFIT %, DURATION, FUNDING.
    const btcFunding = page.locator('#positionsHistoryBody tr', { hasText: 'BTC-USD' }).locator('td').nth(9);
    await expect(btcFunding).toHaveText('—');
    await expect(btcFunding).toHaveAttribute('title', 'No netFunding reported');
  });
});

test.describe('masthead date', () => {
  test('an open tab rolls the UTC date over at midnight without a reload', async ({ page }) => {
    await page.clock.install({ time: new Date('2025-12-31T23:59:30.000Z') });
    await page.goto('/');
    await expect(page.locator('#mastheadDate')).toHaveText('2025.12.31 UTC');

    await page.clock.fastForward('01:00');
    await expect(page.locator('#mastheadDate')).toHaveText('2026.01.01 UTC');
  });
});
