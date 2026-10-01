import { test, expect } from '@playwright/test';
import { ADDRESS, INDEXER_URL, fixture, fixtureKeyFor, indexerBody, serveFixture } from './indexer-fixture.mjs';

// End-to-end checks of the Positions board against a synthetic account
// whose indexer rows carry the known defects: realizedPnl of 0, a SHORT
// whose maxSize is the least-negative signed size, a LONG→SHORT reversal
// in one fill, and an OPEN row for a position the CLOSED list already
// holds. Only the indexer is faked; the browser runs in New York so the
// UTC time column is distinguishable from local time.

const HTTP_SERVICE_UNAVAILABLE = 503;

const position = (fields) => ({
  status: 'CLOSED', size: '0', unrealizedPnl: '0', realizedPnl: '0', netFunding: '0', ...fields,
});
const fill = (id, market, side, size, price, fee, liquidity, createdAt, createdAtHeight) => ({
  id, market, side, size, price, fee, liquidity, createdAt, createdAtHeight, type: 'LIMIT',
});

const ETH_LONG = position({
  market: 'ETH-USD', side: 'LONG', maxSize: '10', sumOpen: '10', sumClose: '10',
  entryPrice: '2000', exitPrice: '2100', netFunding: '-12.5',
  createdAt: '2025-03-01T10:00:00.000Z', createdAtHeight: '100', closedAt: '2025-03-02T12:00:00.000Z',
});
const ETH_SHORT = position({
  market: 'ETH-USD', side: 'SHORT', maxSize: '-0.5', sumOpen: '6', sumClose: '6',
  entryPrice: '2100', exitPrice: '2050', netFunding: '-0.04',
  createdAt: '2025-03-02T12:00:00.000Z', createdAtHeight: '200', closedAt: '2025-03-05T08:30:00.000Z',
});
const BTC_SCRATCH = position({
  market: 'BTC-USD', side: 'LONG', maxSize: '1', sumOpen: '1', sumClose: '1',
  entryPrice: '100000', exitPrice: '100000',
  createdAt: '2025-04-01T00:00:00.000Z', createdAtHeight: '400', closedAt: '2025-04-01T00:12:00.000Z',
});
const BTC_SCRATCH_STALE_OPEN = { ...BTC_SCRATCH, status: 'OPEN', size: '1', closedAt: null };
const BTC_OPEN = position({
  market: 'BTC-USD', side: 'LONG', status: 'OPEN', size: '2', maxSize: '2', sumOpen: '2', sumClose: '0',
  entryPrice: '99000', unrealizedPnl: '2000',
  createdAt: '2025-05-01T00:00:00.000Z', createdAtHeight: '500', closedAt: null,
});

const account = {
  ...fixture,
  markets: { markets: {
    'BTC-USD': { ...fixture.markets.markets['BTC-USD'], oraclePrice: '100000' },
    'ETH-USD': { ticker: 'ETH-USD', oraclePrice: '2000', marketType: 'CROSS', status: 'ACTIVE',
      initialMarginFraction: '0.05', maintenanceMarginFraction: '0.03', stepSize: '0.001', tickSize: '0.1' },
  } },
  openPositions: { positions: [BTC_SCRATCH_STALE_OPEN, BTC_OPEN] },
  closedPositions: { positions: [BTC_SCRATCH, ETH_SHORT, ETH_LONG] },
  fills: { fills: [
    fill('b3', 'BTC-USD', 'BUY',  '2',  '99000',  '1',   'TAKER', '2025-05-01T00:00:00.000Z', '500'),
    fill('b2', 'BTC-USD', 'SELL', '1',  '100000', '0',   'MAKER', '2025-04-01T00:12:00.000Z', '410'),
    fill('b1', 'BTC-USD', 'BUY',  '1',  '100000', '0',   'MAKER', '2025-04-01T00:00:00.000Z', '400'),
    fill('e3', 'ETH-USD', 'BUY',  '6',  '2050',   '1.2', 'MAKER', '2025-03-05T08:30:00.000Z', '300'),
    fill('e2', 'ETH-USD', 'SELL', '16', '2100',   '3.2', 'TAKER', '2025-03-02T12:00:00.000Z', '200'),
    fill('e1', 'ETH-USD', 'BUY',  '10', '2000',   '2',   'TAKER', '2025-03-01T10:00:00.000Z', '100'),
  ] },
};

// `account` without its stale OPEN copy: no OPEN/CLOSED collision, so
// the OPEN rows stay known without fills.
const noCollisionAccount = { ...account, openPositions: { positions: [BTC_OPEN] } };

// A LONG opened and reversed into a SHORT within one block: the CLOSED
// LONG and the OPEN SHORT share market and createdAtHeight. The LONG
// loses 0.1% of its notional, a return that belongs in a loss bin.
const SAME_BLOCK_AT = '2025-06-01T00:00:00.000Z';
const SAME_BLOCK_LONG = position({
  market: 'BTC-USD', side: 'LONG', maxSize: '1', sumOpen: '1', sumClose: '1',
  entryPrice: '100000', exitPrice: '99900',
  createdAt: SAME_BLOCK_AT, createdAtHeight: '600', closedAt: SAME_BLOCK_AT,
});
const SAME_BLOCK_SHORT = position({
  market: 'BTC-USD', side: 'SHORT', status: 'OPEN', size: '-1', maxSize: '0', sumOpen: '1', sumClose: '0',
  entryPrice: '99900', unrealizedPnl: '-100',
  createdAt: SAME_BLOCK_AT, createdAtHeight: '600', closedAt: null,
});
const sameBlockAccount = {
  ...account,
  openPositions: { positions: [SAME_BLOCK_SHORT] },
  closedPositions: { positions: [SAME_BLOCK_LONG] },
  // Chain order: the BUY, then the reversing SELL. Their ids sort the
  // other way, as a fill id is a hash that carries no order.
  fills: { fills: [
    fill('f7c1', 'BTC-USD', 'BUY',  '1', '100000', '1', 'TAKER', SAME_BLOCK_AT, '600'),
    fill('0a3e', 'BTC-USD', 'SELL', '2', '99900',  '2', 'TAKER', SAME_BLOCK_AT, '600'),
  ] },
};

// A LONG closed and reopened on the same side within one block: the
// CLOSED LONG and the OPEN LONG share market, side and createdAtHeight,
// and the fills still hold the reopened LONG of 2.
const REOPEN_AT = '2025-08-01T00:00:00.000Z';
const REOPENED_CLOSED = position({
  market: 'BTC-USD', side: 'LONG', maxSize: '1', sumOpen: '1', sumClose: '1',
  entryPrice: '100000', exitPrice: '100100',
  createdAt: REOPEN_AT, createdAtHeight: '800', closedAt: REOPEN_AT,
});
const REOPENED_OPEN = position({
  market: 'BTC-USD', side: 'LONG', status: 'OPEN', size: '2', maxSize: '2', sumOpen: '2', sumClose: '0',
  entryPrice: '100200', unrealizedPnl: '-400',
  createdAt: REOPEN_AT, createdAtHeight: '800', closedAt: null,
});
const reopenedAccount = {
  ...account,
  openPositions: { positions: [REOPENED_OPEN] },
  closedPositions: { positions: [REOPENED_CLOSED] },
  fills: { fills: [
    fill('r1', 'BTC-USD', 'BUY',  '1', '100000', '0', 'TAKER', REOPEN_AT, '800'),
    fill('r2', 'BTC-USD', 'SELL', '1', '100100', '0', 'TAKER', REOPEN_AT, '800'),
    fill('r3', 'BTC-USD', 'BUY',  '2', '100200', '0', 'TAKER', REOPEN_AT, '800'),
  ] },
};

// The fills end the BTC market on a LONG of 2 while the OPEN row holds 3:
// a BTC fill is missing, so every BTC FIFO total is off. ETH is intact.
const sizeMismatchAccount = {
  ...account,
  openPositions: { positions: [BTC_SCRATCH_STALE_OPEN, { ...BTC_OPEN, size: '3' }] },
};

// The fills still end the BTC market on a LONG of 2, but no BTC position is
// OPEN any more (the stale copy is dropped by the merge): a closing fill is
// missing, so the open lots the walk would mark at the oracle are phantom.
const phantomLotsAccount = {
  ...account,
  openPositions: { positions: [BTC_SCRATCH_STALE_OPEN] },
};

// The BTC fills hold a fill whose price does not parse inside the OPEN
// position's window. The walk skips it and still ends at the OPEN row's
// size, but the skipped trade leaves every BTC FIFO total unknown.
const unusableFillAccount = {
  ...noCollisionAccount,
  fills: { fills: [
    { ...fill('b4', 'BTC-USD', 'BUY', '1', '100500', '0', 'TAKER', '2025-05-02T00:00:00.000Z', '510'), price: 'NaN' },
    ...account.fills.fills,
  ] },
};

// The BTC fills reverse a LONG into the OPEN SHORT, but the CLOSED list
// holds no LONG closing at the reversal: the fills that opened it are
// missing, so every BTC FIFO total is off though the SHORT's size agrees.
const REVERSAL_LONG_AT = '2025-06-01T00:00:00.000Z';
const REVERSAL_AT = '2025-06-02T00:00:00.000Z';
const UNPARTNERED_SHORT = position({
  market: 'BTC-USD', side: 'SHORT', status: 'OPEN', size: '-2', maxSize: '0', sumOpen: '2', sumClose: '0',
  entryPrice: '100000', createdAt: REVERSAL_AT, createdAtHeight: '610', closedAt: null,
});
const unpartneredReversalAccount = {
  ...account,
  openPositions: { positions: [UNPARTNERED_SHORT] },
  fills: { fills: [
    fill('u2', 'BTC-USD', 'SELL', '3', '100000', '0', 'TAKER', REVERSAL_AT, '610'),
    fill('u1', 'BTC-USD', 'BUY',  '1', '99000',  '0', 'TAKER', REVERSAL_LONG_AT, '600'),
    ...account.fills.fills.filter(f => f.id !== 'b3'),
  ] },
};

// The account's subaccount with its equity replaced.
const withEquity = (data, equity) => ({
  ...data,
  subaccount: { subaccount: { ...data.subaccount.subaccount, equity } },
});

// The reopened OPEN row carries funding; without fills the collision
// cannot keep it, so the merged list holds only the CLOSED copy.
const reopenedWithFundingAccount = {
  ...reopenedAccount,
  openPositions: { positions: [{ ...REOPENED_OPEN, netFunding: '-7' }] },
};

// A market whose only position is OPEN: with the OPEN list missing, its
// open count is unknown rather than zero.
const SOL_OPEN_AT = '2025-09-01T00:00:00.000Z';
const SOL_OPEN = position({
  market: 'SOL-USD', side: 'LONG', status: 'OPEN', size: '10', maxSize: '10', sumOpen: '10', sumClose: '0',
  entryPrice: '100', createdAt: SOL_OPEN_AT, createdAtHeight: '900', closedAt: null,
});
const solOpenAccount = {
  ...account,
  openPositions: { positions: [...account.openPositions.positions, SOL_OPEN] },
  fills: { fills: [
    fill('s1', 'SOL-USD', 'BUY', '10', '100', '0', 'TAKER', SOL_OPEN_AT, '900'),
    ...account.fills.fills,
  ] },
};

// solOpenAccount whose open SOL lot has no entry price either, so neither
// an oracle nor an entry price values it.
const unpricedOpenAccount = {
  ...solOpenAccount,
  openPositions: { positions: [...account.openPositions.positions, { ...SOL_OPEN, entryPrice: undefined }] },
};

// The ETH wins (+$996, +$298 net of fees) plus a -$2000 SOL loss: the
// average trade loses money.
const SOL_LOSS_AT = '2025-07-01T00:00:00.000Z';
const SOL_LOSS_CLOSED_AT = '2025-07-02T00:00:00.000Z';
const SOL_LOSS = position({
  market: 'SOL-USD', side: 'LONG', maxSize: '100', sumOpen: '100', sumClose: '100',
  entryPrice: '100', exitPrice: '80',
  createdAt: SOL_LOSS_AT, createdAtHeight: '700', closedAt: SOL_LOSS_CLOSED_AT,
});
const losingAccount = {
  ...account,
  openPositions: { positions: [] },
  closedPositions: { positions: [SOL_LOSS, ETH_SHORT, ETH_LONG] },
  fills: { fills: [
    fill('l2', 'SOL-USD', 'SELL', '100', '80',  '0', 'TAKER', SOL_LOSS_CLOSED_AT, '710'),
    fill('l1', 'SOL-USD', 'BUY',  '100', '100', '0', 'TAKER', SOL_LOSS_AT, '700'),
    ...account.fills.fills.filter(f => f.market === 'ETH-USD'),
  ] },
};

// A second, smaller SOL loss (-$500) beside the -$2000 one: each asset's
// best and worst trade differ from its average win and average loss.
const SOL_SMALL_LOSS_AT = '2025-07-03T00:00:00.000Z';
const SOL_SMALL_LOSS_CLOSED_AT = '2025-07-04T00:00:00.000Z';
const SOL_SMALL_LOSS = position({
  market: 'SOL-USD', side: 'LONG', maxSize: '50', sumOpen: '50', sumClose: '50',
  entryPrice: '100', exitPrice: '90',
  createdAt: SOL_SMALL_LOSS_AT, createdAtHeight: '720', closedAt: SOL_SMALL_LOSS_CLOSED_AT,
});
// The SOL loss without its fills: the ETH trades stay complete, the
// account classifier does not.
const solWithoutFillsAccount = {
  ...losingAccount,
  fills: { fills: losingAccount.fills.fills.filter(f => f.market !== 'SOL-USD') },
};
const twoLossAccount = {
  ...losingAccount,
  closedPositions: { positions: [SOL_SMALL_LOSS, ...losingAccount.closedPositions.positions] },
  fills: { fills: [
    fill('l4', 'SOL-USD', 'SELL', '50', '90',  '0', 'TAKER', SOL_SMALL_LOSS_CLOSED_AT, '730'),
    fill('l3', 'SOL-USD', 'BUY',  '50', '100', '0', 'TAKER', SOL_SMALL_LOSS_AT, '720'),
    ...losingAccount.fills.fills,
  ] },
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

// The masthead markup ships reading FRESH before any fetch, so the badge
// alone cannot tell a finished load from one not yet begun. The data-age
// caption appears only once a load has rendered.
async function loadAccount(page) {
  await page.goto(`/?address=${ADDRESS}`);
  await expect(page.locator('#dataAge')).toBeVisible();
  await expect(page.locator('#statusBadge')).toHaveText(/^FRESH/);
}

async function openTab(page, tab) {
  await page.locator(`.nav-tab[data-tab="${tab}"]`).click();
}

async function openPositionsTab(page) {
  await loadAccount(page);
  await openTab(page, 'positions');
}

const rowCells = (page, index) => page.locator('#positionsHistoryBody tr').nth(index).locator('td');
const assetCells = (page, ticker) => page.locator('#assetPerformanceBody tr', { hasText: ticker }).locator('td');

// The Overview market chart's label and tooltip lines for `market`.
function marketChartEntry(page, market) {
  return page.evaluate((m) => {
    const chart = Chart.getChart(document.getElementById('marketDistributionChart'));
    const dataIndex = chart.data.labels.findIndex(l => l.startsWith(`${m} `));
    return {
      label: chart.data.labels[dataIndex],
      tooltip: chart.config.options.plugins.tooltip.callbacks.label({ dataIndex }),
    };
  }, market);
}

test.use({ timezoneId: 'America/New_York' });

test.describe('positions board', () => {
  test('rows show fill-attributed size, prices and net profit, with flips tagged', async ({ page }) => {
    await page.route(INDEXER_URL, serveAccount(null));
    await openPositionsTab(page);

    await expect(page.locator('#positionsHistoryBody tr')).toHaveCount(3);
    await expect(page.locator('#positions thead th').first()).toHaveText('CLOSED (UTC)');

    // CLOSED (UTC), ASSET, SIDE, SIZE, ENTRY, EXIT, PROFIT, PROFIT %, DURATION, FUNDING
    await expect(rowCells(page, 0)).toHaveText([
      '2025-04-01 00:12', 'BTC-USD', 'LONG', '1 BTC', '$100000', '$100000', '$0', '0.00%', '12m', '$0',
    ]);
    await expect(rowCells(page, 1)).toHaveText([
      '2025-03-05 08:30', 'ETH-USD', 'SHORT⇄', '6 ETH', '$2100', '$2050', '+$298', '+2.36%', '2d 20h', '$0',
    ]);
    await expect(rowCells(page, 2)).toHaveText([
      '2025-03-02 12:00', 'ETH-USD', 'LONG⇄', '10 ETH', '$2000', '$2100', '+$996', '+4.98%', '1d 2h', '-$13',
    ]);

    await expect(rowCells(page, 0).nth(6)).toHaveClass(/\bzero\b/);
    await expect(rowCells(page, 1).nth(9)).toHaveClass(/\bzero\b/);
    await expect(rowCells(page, 2).nth(9)).toHaveClass(/\bloss\b/);
    await expect(rowCells(page, 1).locator('.flip-tag')).toHaveAttribute('title',
      "Opened by reversing a LONG in one order; the reversing fill's size and fee are split between both rows.");
    await expect(rowCells(page, 2).locator('.flip-tag')).toHaveAttribute('title',
      "Closed by reversing into a SHORT in one order; the reversing fill's size and fee are split between both rows.");
  });

  test('cards dedupe the stale OPEN row, value open notional at oracle, and show taker share', async ({ page }) => {
    await page.route(INDEXER_URL, serveAccount(null));
    await openPositionsTab(page);

    await expect(page.locator('#positionsActiveCount')).toHaveText('1');
    await expect(page.locator('#positionsActiveNotional')).toHaveText('$200,000 notional');
    await expect(page.locator('#positionsTakerShare')).toHaveText('50.0%');
    await expect(page.locator('#holdTimeDistribution')).toContainText('0–1h');
    await expect(page.locator('#holdTimeDistribution')).toContainText('1–3d');
  });

  test('the cached snapshot keeps the raw indexer rows', async ({ page }) => {
    await page.route(INDEXER_URL, serveAccount(null));
    await openPositionsTab(page);

    const cachedShort = await page.evaluate((address) => window.PortfolioCache.readMeta(address)
      .data.closedPositions.positions.find(p => p.side === 'SHORT'), ADDRESS);
    expect(cachedShort).toEqual(ETH_SHORT);
  });

  test('a failed open-positions endpoint reads — rather than zero', async ({ page }) => {
    await page.route(INDEXER_URL, serveAccount('openPositions'));
    await openPositionsTab(page);

    await expect(page.locator('#positionsActiveCount')).toHaveText('—');
    await expect(page.locator('#positionsActiveNotional')).toHaveText('Open positions failed to load');
  });

  test('a failed open-positions endpoint reads — on the Risk tab with the reason', async ({ page }) => {
    let failingKey = 'openPositions';
    await page.route(INDEXER_URL, (route) => serveAccount(failingKey)(route));
    await loadAccount(page);
    await openTab(page, 'risk');

    const reason = 'Open positions failed to load';
    await expect(page.locator('#leverageUtil')).toHaveText('—');
    await expect(page.locator('#leverageUtil')).not.toHaveClass(/\bprofit\b/);
    await expect(page.locator('#leverageUtilDetail')).toHaveText(reason);
    await expect(page.locator('#liquidationRiskBody tr')).toHaveText([reason]);

    failingKey = null;
    await page.evaluate(() => refreshDashboard({ skipCache: true }));

    await expect(page.locator('#statusBadge')).toHaveText('FRESH');
    await expect(page.locator('#leverageUtilDetail')).toHaveText('Notional ÷ equity');
    await expect(page.locator('#liquidationRiskBody tr').first().locator('td').first()).toHaveText('BTC-USD LONG');
  });

  test('without fills every profit-derived number reads — with the reason', async ({ page }) => {
    await page.route(INDEXER_URL, serveAccount('fills'));
    await openPositionsTab(page);

    await expect(rowCells(page, 1)).toHaveText([
      '2025-03-05 08:30', 'ETH-USD', 'SHORT', '—', '—', '—', '—', '—', '2d 20h', '$0',
    ]);
    await expect(page.locator('#positionsTakerShare')).toHaveText('—');
    await expect(page.locator('#winRate')).toHaveText('—');
    await expect(page.locator('#winRateDetail')).toHaveText('3 positions missing fill data');
    await expect(page.locator('#expectancy')).toHaveText('—');
    await expect(page.locator('#riskRewardHero')).toHaveText('—');
    await expect(page.locator('#riskRewardHeroDetail')).toHaveText('3 positions missing fill data');
    await expect(page.locator('#riskReward')).toHaveText('—');
    await expect(page.locator('#seVerdictDesc')).toContainText('3 positions missing fill data');
    await expect(page.locator('#kellyCriterion')).toHaveText('—');
    await expect(page.locator('#kellyCriterionDetail')).toHaveText('3 positions missing fill data');
  });

  test('a failed closed-positions endpoint reads — with the reason, not as an account without trades', async ({ page }) => {
    await page.route(INDEXER_URL, serveAccount('closedPositions'));
    await loadAccount(page);

    const reason = 'Closed positions failed to load';
    await expect(page.locator('#winRate')).toHaveText('—');
    await expect(page.locator('#winRateDetail')).toHaveText(reason);
    await expect(page.locator('#profitFactor')).toHaveText('—');
    await expect(page.locator('#profitFactorDetail')).toHaveText(reason);
    await expect(page.locator('#avgWin')).toHaveText('—');
    await expect(page.locator('#expectancy')).toHaveText('—');
    await expect(page.locator('#seVerdictDesc')).toContainText(reason);
    await expect(page.locator('#kellyCriterionDetail')).toHaveText(reason);

    await openTab(page, 'tax');
    await expect(page.locator('#taxStatus')).toHaveText(`${reason}.`);
  });

  test('an open position reversed out of a closed one in the same block is kept', async ({ page }) => {
    await page.route(INDEXER_URL, serveAccount(null, sameBlockAccount));
    await openPositionsTab(page);

    await expect(page.locator('#positionsActiveCount')).toHaveText('1');
    await expect(page.locator('#positionsActiveNotional')).toHaveText('$100,000 notional');
    // CLOSED (UTC), ASSET, SIDE, SIZE, ENTRY, EXIT, PROFIT: the LONG keeps
    // only its own fills (the reversing fill's fee split 1:1).
    await expect(rowCells(page, 0).nth(3)).toHaveText('1 BTC');
    await expect(rowCells(page, 0).nth(6)).toHaveText('-$102');
  });

  test('an open position reopened on the same side in its predecessor\'s closing block is kept', async ({ page }) => {
    await page.route(INDEXER_URL, serveAccount(null, reopenedAccount));
    await openPositionsTab(page);

    await expect(page.locator('#positionsActiveCount')).toHaveText('1');
    await expect(page.locator('#positionsActiveNotional')).toHaveText('$200,000 notional');
    await expect(page.locator('#positionsHistoryBody tr')).toHaveCount(1);
  });

  test('without fills an OPEN/CLOSED collision cannot be resolved, so the open-position cards read — with the reason', async ({ page }) => {
    // The ETH row does not collide; without the gap it alone would still
    // be counted and levered. dYdX holds one open position per market per
    // subaccount, so it is in another market than REOPENED_OPEN.
    const ethOpen = { ...BTC_OPEN, market: 'ETH-USD', entryPrice: '2000', unrealizedPnl: '0' };
    const unresolvable = {
      ...reopenedAccount,
      openPositions: { positions: [REOPENED_OPEN, ethOpen] },
    };
    await page.route(INDEXER_URL, serveAccount('fills', unresolvable));
    await openPositionsTab(page);

    const reason = 'Fills failed to load';
    await expect(page.locator('#positionsActiveCount')).toHaveText('—');
    await expect(page.locator('#positionsActiveNotional')).toHaveText(reason);

    await openTab(page, 'risk');
    await expect(page.locator('#leverageUtil')).toHaveText('—');
    await expect(page.locator('#leverageUtilDetail')).toHaveText(reason);
    await expect(page.locator('#liquidationRiskBody tr')).toHaveText([reason]);
  });

  test('without fills and without a collision the open-position cards still read the OPEN list', async ({ page }) => {
    await page.route(INDEXER_URL, serveAccount('fills', noCollisionAccount));
    await openPositionsTab(page);

    await expect(page.locator('#positionsActiveCount')).toHaveText('1');
    await expect(page.locator('#positionsActiveNotional')).toHaveText('$200,000 notional');

    await openTab(page, 'risk');
    await expect(page.locator('#leverageUtil')).toHaveText('20.00x');
    await expect(page.locator('#leverageUtilDetail')).toHaveText('Notional ÷ equity');
    await expect(page.locator('#liquidationRiskBody tr').first().locator('td').first()).toHaveText('BTC-USD LONG');
  });

  test('the win/loss distribution bins a small loss as a loss, labelled by range', async ({ page }) => {
    await page.route(INDEXER_URL, serveAccount(null, sameBlockAccount));
    await loadAccount(page);
    await openTab(page, 'performance');

    const rows = page.locator('#winLossDistribution');
    const label = rows.locator('.distribution-label', { hasText: /^-2% to 0%$/ });
    await expect(label).toHaveCount(1);
    const bar = label.locator('xpath=following-sibling::div[1]').locator('.distribution-bar');
    await expect(bar).toHaveClass(/\bis-loss\b/);
    await expect(label.locator('xpath=following-sibling::span[1]')).toHaveText('1');
    await expect(page.locator('#winLossTitle')).toHaveText('Win/Loss Distribution (1 decisive trades)');
  });

  test('a refresh that brings the fills back clears the missing-fill-data captions', async ({ page }) => {
    let failingKey = 'fills';
    await page.route(INDEXER_URL, (route) => serveAccount(failingKey)(route));
    await loadAccount(page);
    await expect(page.locator('#riskRewardHeroDetail')).toHaveText('3 positions missing fill data');

    failingKey = null;
    await page.evaluate(() => refreshDashboard({ skipCache: true }));

    await expect(page.locator('#statusBadge')).toHaveText('FRESH');
    await expect(page.locator('#winRate')).toHaveText('100.0%');
    // The account has no losing trade, so there is still no payoff ratio.
    await expect(page.locator('#riskRewardHero')).toHaveText('—');
    await expect(page.locator('#riskRewardHeroDetail')).toHaveText('avg win / avg loss');
  });

  test('the Tax tab shows a complete reversal pair\'s overlap as an audit hint, without a †', async ({ page }) => {
    await page.route(INDEXER_URL, serveAccount(null));
    // Every close date gets an ECB rate, so the status line reports no
    // FX gap and the FX lookup never leaves the machine.
    const EUR_PER_USD = 0.92;
    const closeDates = ['2025-03-02', '2025-03-05', '2025-04-01'];
    await page.route(/api\.frankfurter\.dev/, route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ rates: Object.fromEntries(closeDates.map(d => [d, { EUR: EUR_PER_USD }])) }),
    }));
    await loadAccount(page);
    await openTab(page, 'tax');

    // The ETH LONG and the SHORT its reversing fill opened share that
    // fill, so the two windows touch; both rows are still fully
    // attributed, so neither carries a †, and the overlap stays a hint.
    await expect(page.locator('#taxStatus')).toHaveText(
      "Year 2025 · 3 closed positions · 2 rows overlap another position's window");
    await expect(page.locator('#taxRowsBody td', { hasText: '†' })).toHaveCount(0);
    const ethDates = page.locator('#taxRowsBody tr', { hasText: 'ETH-USD' }).locator('td:first-child');
    await expect(ethDates).toHaveCount(2);
    for (const cell of await ethDates.all()) {
      await expect(cell).toHaveAttribute('title', /overlaps this window/);
    }
    await expect(page.locator('#taxWarningStrip')).toBeVisible();
    await expect(page.locator('#taxWarningStrip')).not.toContainText('approximate');
    await expect(page.locator('#taxWarningStrip')).toContainText('audit hint');
  });

  test('one incomplete position blanks the classifier ratios of every month together', async ({ page }) => {
    await page.route(INDEXER_URL, serveAccount('fills', losingAccount));
    await loadAccount(page);
    await openTab(page, 'performance');

    // MONTH, PROFIT, WIN RATE, TRADES: July holds one of the three.
    const julyRow = page.locator('#monthlyPerformanceBody tr', { hasText: 'July 2025' }).locator('td');
    await expect(julyRow.nth(2)).toHaveText('—');
    await expect(julyRow.nth(3)).toHaveText('1');
    await expect(julyRow.nth(3)).toHaveAttribute('title', '3 positions missing fill data');
  });

  test('a negative expectancy and the average loss read as losses', async ({ page }) => {
    await page.route(INDEXER_URL, serveAccount(null, losingAccount));
    await loadAccount(page);

    await expect(page.locator('#expectancy')).toHaveText('-$235');
    await expect(page.locator('#expectancy')).toHaveClass(/\bloss\b/);
    await expect(page.locator('#expectancy')).not.toHaveClass(/\bprofit\b/);
    await expect(page.locator('#riskRewardHeroDetail'))
      .toHaveText('+$647 / -$2000 · WR 66.7% vs 75.6% breakeven');
  });

  test('without fills the profit headline and its fills-built ledger cells read — with the reason', async ({ page }) => {
    await page.route(INDEXER_URL, serveAccount('fills', noCollisionAccount));
    await loadAccount(page);

    await expect(page.locator('#totalPnL')).toHaveText('—');
    await expect(page.locator('#totalPnLChange')).toHaveText('Fills failed to load');
    await expect(page.locator('#totalPnLTrading')).toHaveText('—');
    await expect(page.locator('#totalPnLFees')).toHaveText('—');
    // Funding comes from the position lists, which did load.
    await expect(page.locator('#totalPnLFunding')).toHaveText('-$13');

    await openTab(page, 'performance');
    const ethRow = page.locator('#assetPerformanceBody tr', { hasText: 'ETH-USD' }).locator('td');
    // ASSET, PROFIT, FUNDING, FEES, TRADES: the trade count is known, its
    // decisive / scratch split is not. The classifier is all-or-nothing
    // account-wide, so the reason counts every incomplete position.
    await expect(ethRow.nth(1)).toHaveText('—');
    await expect(ethRow.nth(2)).toHaveText('-$13');
    await expect(ethRow.nth(3)).toHaveText('—');
    await expect(ethRow.nth(4)).toHaveText('2');
    await expect(ethRow.nth(4)).toHaveAttribute('title', '3 positions missing fill data');

    await openTab(page, 'tax');
    await expect(page.locator('#taxNetUsd')).toHaveText('—');
    await expect(page.locator('#taxFeesUsd')).toHaveText('—');
    await expect(page.locator('#taxWarningStrip')).toContainText('Fills failed to load');
  });

  test('fills that end with open lots in a market with no OPEN row blank the headline, TRADING and that market\'s profit', async ({ page }) => {
    await page.route(INDEXER_URL, serveAccount(null, phantomLotsAccount));
    await loadAccount(page);

    const reason = 'Fills do not match open positions';
    await expect(page.locator('#totalPnL')).toHaveText('—');
    await expect(page.locator('#totalPnLChange')).toHaveText(reason);
    await expect(page.locator('#totalPnLTrading')).toHaveText('—');
    await expect.poll(async () => (await marketChartEntry(page, 'ETH-USD')).tooltip)
      .toContain('Profit (incl. funding − fees): +$1281');

    await openTab(page, 'performance');
    await expect(assetCells(page, 'BTC-USD').nth(1)).toHaveText('—');
  });

  test('fills that end at the OPEN row\'s size leave the headline, TRADING and each market\'s profit numeric', async ({ page }) => {
    await page.route(INDEXER_URL, serveAccount(null));
    await loadAccount(page);

    // TRADING: ETH realizes 1000 + 300, BTC holds 2 bought at 99000 marked
    // at 100000. FUNDING -12.54, FEES 7.4 paid.
    await expect(page.locator('#totalPnL')).toHaveText('+$3280');
    await expect(page.locator('#totalPnLChange')).toHaveText('All Time');
    await expect(page.locator('#totalPnLTrading')).toHaveText('+$3300');
    await expect.poll(async () => (await marketChartEntry(page, 'BTC-USD')).tooltip)
      .toContain('Profit (incl. funding − fees): +$1999');

    await openTab(page, 'performance');
    await expect(assetCells(page, 'BTC-USD').nth(1)).toHaveText('+$1999');
  });

  test('fills that end at a different size than an OPEN row blank the headline, TRADING and that market\'s profit', async ({ page }) => {
    await page.route(INDEXER_URL, serveAccount(null, sizeMismatchAccount));
    await loadAccount(page);

    const reason = 'Fills do not match open positions';
    await expect(page.locator('#totalPnL')).toHaveText('—');
    await expect(page.locator('#totalPnLChange')).toHaveText(reason);
    await expect(page.locator('#totalPnLTrading')).toHaveText('—');
    // Funding and fees do not depend on how the fills add up.
    await expect(page.locator('#totalPnLFunding')).toHaveText('-$13');
    await expect(page.locator('#totalPnLFees')).toHaveText('-$7');
    await expect.poll(async () => (await marketChartEntry(page, 'BTC-USD')).tooltip)
      .toContain(`Profit (incl. funding − fees): — (${reason})`);
    expect((await marketChartEntry(page, 'ETH-USD')).tooltip)
      .toContain('Profit (incl. funding − fees): +$1281');

    await openTab(page, 'performance');
    await expect(assetCells(page, 'BTC-USD').nth(1)).toHaveText('—');
    await expect(assetCells(page, 'BTC-USD').nth(1)).toHaveAttribute('title', reason);
    await expect(assetCells(page, 'ETH-USD').nth(1)).toHaveText('+$1281');
  });

  test('an unusable fill inside an OPEN position blanks the headline, TRADING and that market\'s profit, naming the cause', async ({ page }) => {
    await page.route(INDEXER_URL, serveAccount(null, unusableFillAccount));
    await loadAccount(page);

    const reason = 'Unusable fill in BTC-USD';
    await expect(page.locator('#totalPnL')).toHaveText('—');
    await expect(page.locator('#totalPnLChange')).toHaveText(reason);
    await expect(page.locator('#totalPnLTrading')).toHaveText('—');
    await expect.poll(async () => (await marketChartEntry(page, 'BTC-USD')).tooltip)
      .toContain(`Profit (incl. funding − fees): — (${reason})`);
    expect((await marketChartEntry(page, 'ETH-USD')).tooltip)
      .toContain('Profit (incl. funding − fees): +$1281');

    await openTab(page, 'performance');
    await expect(assetCells(page, 'BTC-USD').nth(1)).toHaveText('—');
    await expect(assetCells(page, 'BTC-USD').nth(1)).toHaveAttribute('title', reason);
    await expect(assetCells(page, 'ETH-USD').nth(1)).toHaveText('+$1281');
  });

  test('an OPEN position opened by a reversal with no partner listed blanks the headline, TRADING and that market\'s profit, naming the cause', async ({ page }) => {
    await page.route(INDEXER_URL, serveAccount(null, unpartneredReversalAccount));
    await loadAccount(page);

    const reason = 'Reversal partner missing in BTC-USD';
    await expect(page.locator('#totalPnL')).toHaveText('—');
    await expect(page.locator('#totalPnLChange')).toHaveText(reason);
    await expect(page.locator('#totalPnLTrading')).toHaveText('—');
    await expect.poll(async () => (await marketChartEntry(page, 'BTC-USD')).tooltip)
      .toContain(`Profit (incl. funding − fees): — (${reason})`);

    await openTab(page, 'performance');
    await expect(assetCells(page, 'BTC-USD').nth(1)).toHaveAttribute('title', reason);
    await expect(assetCells(page, 'ETH-USD').nth(1)).toHaveText('+$1281');
  });

  test('a market with open lots and no oracle price blanks the headline and TRADING but only its own profit', async ({ page }) => {
    // The markets map has no SOL-USD entry, so the open SOL lot is unpriced.
    await page.route(INDEXER_URL, serveAccount(null, solOpenAccount));
    await loadAccount(page);

    const reason = 'No oracle price for SOL-USD';
    await expect(page.locator('#totalPnL')).toHaveText('—');
    await expect(page.locator('#totalPnLChange')).toHaveText(reason);
    await expect(page.locator('#totalPnLTrading')).toHaveText('—');
    await expect.poll(async () => (await marketChartEntry(page, 'SOL-USD')).tooltip)
      .toContain(`Profit (incl. funding − fees): — (${reason})`);
    expect((await marketChartEntry(page, 'ETH-USD')).tooltip)
      .toContain('Profit (incl. funding − fees): +$1281');
    expect((await marketChartEntry(page, 'BTC-USD')).tooltip)
      .toContain('Profit (incl. funding − fees): +$1999');

    await openTab(page, 'performance');
    await expect(assetCells(page, 'SOL-USD').nth(1)).toHaveText('—');
    await expect(assetCells(page, 'SOL-USD').nth(1)).toHaveAttribute('title', reason);
    await expect(assetCells(page, 'ETH-USD').nth(1)).toHaveText('+$1281');
    await expect(assetCells(page, 'BTC-USD').nth(1)).toHaveText('+$1999');
  });

  test('with no open position and known equity the Leverage card reads 0.00x', async ({ page }) => {
    await page.route(INDEXER_URL, serveAccount(null, losingAccount));
    await loadAccount(page);
    await openTab(page, 'risk');

    await expect(page.locator('#leverageUtil')).toHaveText('0.00x');
    await expect(page.locator('#leverageUtilDetail')).toHaveText('No open positions');
  });

  test('without equity the Leverage card reads — with the reason', async ({ page }) => {
    await page.route(INDEXER_URL, serveAccount('subaccount', noCollisionAccount));
    await loadAccount(page);
    await openTab(page, 'risk');

    await expect(page.locator('#leverageUtil')).toHaveText('—');
    await expect(page.locator('#leverageUtilDetail')).toHaveText('Equity unavailable');
  });

  test('with zero equity the Leverage card reads — with the reason, even without open positions', async ({ page }) => {
    await page.route(INDEXER_URL, serveAccount(null, withEquity(losingAccount, '0')));
    await loadAccount(page);
    await openTab(page, 'risk');

    await expect(page.locator('#leverageUtil')).toHaveText('—');
    await expect(page.locator('#leverageUtilDetail')).toHaveText('Equity unavailable');
  });

  test('an open position with no notional leaves the Leverage card — with the reason, beside a priced one', async ({ page }) => {
    await page.route(INDEXER_URL, serveAccount(null, unpricedOpenAccount));
    await loadAccount(page);
    await openTab(page, 'risk');

    await expect(page.locator('#leverageUtil')).toHaveText('—');
    await expect(page.locator('#leverageUtilDetail')).toHaveText('Open position notional unavailable');
  });

  test('a failed OPEN list keeps precedence over missing equity on the Leverage card', async ({ page }) => {
    await page.route(INDEXER_URL, serveAccount('openPositions', withEquity(account, '0')));
    await loadAccount(page);
    await openTab(page, 'risk');

    await expect(page.locator('#leverageUtil')).toHaveText('—');
    await expect(page.locator('#leverageUtilDetail')).toHaveText('Open positions failed to load');
  });

  test('without fills an unresolved collision blanks FUNDING and the open counts, which may miss the reopened OPEN row', async ({ page }) => {
    await page.route(INDEXER_URL, serveAccount('fills', reopenedWithFundingAccount));
    await loadAccount(page);

    const reason = 'Fills failed to load';
    await expect(page.locator('#totalPnLFunding')).toHaveText('—');
    await expect.poll(async () => (await marketChartEntry(page, 'BTC-USD')).label)
      .toBe('BTC-USD (1 closed + — open)');
    expect((await marketChartEntry(page, 'BTC-USD')).tooltip).toContain(`Open Positions: — (${reason})`);

    await openTab(page, 'performance');
    await expect(assetCells(page, 'BTC-USD').nth(2)).toHaveText('—');
    await expect(assetCells(page, 'BTC-USD').nth(2)).toHaveAttribute('title', reason);
  });

  test('without the OPEN list a market holding only an open position still gets its asset row', async ({ page }) => {
    await page.route(INDEXER_URL, serveAccount('openPositions', solOpenAccount));
    await loadAccount(page);
    await openTab(page, 'performance');

    // ASSET, PROFIT, FUNDING: its funding is on the missing OPEN row.
    await expect(assetCells(page, 'SOL-USD').nth(2)).toHaveText('—');
    await expect(assetCells(page, 'SOL-USD').nth(2)).toHaveAttribute('title', 'Open positions failed to load');
  });

  test('Performance by Asset shows each asset\'s single best and worst trade', async ({ page }) => {
    await page.route(INDEXER_URL, serveAccount(null, twoLossAccount));
    await loadAccount(page);
    await openTab(page, 'performance');

    const headers = page.locator('table:has(#assetPerformanceBody) thead th');
    await expect(headers).toHaveText([
      'ASSET', 'PROFIT', 'FUNDING', 'FEES', 'TRADES', 'WIN RATE', 'AVG PROFIT', 'BEST', 'WORST', 'SHARPE',
    ]);
    const assetRow = (ticker) => page.locator('#assetPerformanceBody tr', { hasText: ticker }).locator('td');
    // ETH wins +$996 and +$298 (average +$647) and never loses.
    await expect(assetRow('ETH-USD').nth(7)).toHaveText('+$996');
    await expect(assetRow('ETH-USD').nth(7)).toHaveClass(/\bprofit\b/);
    await expect(assetRow('ETH-USD').nth(8)).toHaveText('—');
    // SOL loses $2000 and $500 (average -$1250) and never wins.
    await expect(assetRow('SOL-USD').nth(7)).toHaveText('—');
    await expect(assetRow('SOL-USD').nth(8)).toHaveText('-$2000');
    await expect(assetRow('SOL-USD').nth(8)).toHaveClass(/\bloss\b/);
  });

  test('one incomplete position blanks every asset\'s best and worst trade', async ({ page }) => {
    await page.route(INDEXER_URL, serveAccount(null, solWithoutFillsAccount));
    await loadAccount(page);
    await openTab(page, 'performance');

    // ASSET … TRADES, WIN RATE, AVG PROFIT, BEST, WORST: ETH's own trades
    // are complete, but the classifier is all-or-nothing account-wide.
    const ethRow = page.locator('#assetPerformanceBody tr', { hasText: 'ETH-USD' }).locator('td');
    await expect(ethRow.nth(4)).toHaveAttribute('title', '1 position missing fill data');
    await expect(ethRow.nth(7)).toHaveText('—');
    await expect(ethRow.nth(8)).toHaveText('—');
  });
});
