import { test, expect } from '@playwright/test';
import { fixture, fixtureKeyFor, indexerBody, serveFixture, INDEXER_URL } from './indexer-fixture.mjs';

// End-to-end check that a tone class ('profit' / 'loss' / 'zero' /
// 'warning') shows its colour wherever the dashboard sets one, in a real
// browser: on metric card values and captions, and on the Overview
// statistics column, whose own ink colours would otherwise outrank it.
// The expected colour of a tone is what the bare class renders as on a
// plain element, so the stylesheet stays the one place tones are defined.
// Synthetic accounts: a +$1000 BTC win and a -$400 ETH loss; the win alone
// on a rising /historical-pnl curve; and the pair with an open BTC long at
// 3x the account's equity.

const TONES = ['profit', 'loss', 'zero', 'warning'];
const TABS = ['overview', 'performance', 'risk', 'positions', 'behavior', 'market', 'tax'];
const EQUITY = '10000';
const BTC_ORACLE = '100000';
// 0.3 BTC at the oracle is $30,000 of notional on $10,000 of equity: 3.00x.
const ELEVATED_LEVERAGE_SIZE = '0.3';
// The browser's clock, after every synthetic row: the live point's date.
const NOW = '2025-06-01T00:00:00.000Z';

const position = (fields) => ({
  status: 'CLOSED', size: '0', unrealizedPnl: '0', realizedPnl: '0', netFunding: '0', ...fields,
});
const fill = (id, market, side, size, price, createdAt, createdAtHeight) => ({
  id, market, side, size, price, fee: '0', liquidity: 'TAKER', createdAt, createdAtHeight, type: 'LIMIT',
});
// A /historical-pnl row: cumulative trading P&L `totalPnl` at `createdAt`.
const histRow = (createdAt, totalPnl) => ({
  createdAt, blockTime: createdAt, blockHeight: '1', totalPnl: String(totalPnl), equity: EQUITY, netTransfers: '0',
});

const BTC_WIN = position({
  market: 'BTC-USD', side: 'LONG', maxSize: '1', sumOpen: '1', sumClose: '1',
  createdAt: '2025-03-01T00:00:00.000Z', createdAtHeight: '100', closedAt: '2025-03-02T00:00:00.000Z',
});
const ETH_LOSS = position({
  market: 'ETH-USD', side: 'LONG', maxSize: '10', sumOpen: '10', sumClose: '10',
  createdAt: '2025-04-01T00:00:00.000Z', createdAtHeight: '300', closedAt: '2025-04-01T05:00:00.000Z',
});
const BTC_OPEN = position({
  market: 'BTC-USD', side: 'LONG', status: 'OPEN', size: ELEVATED_LEVERAGE_SIZE, maxSize: ELEVATED_LEVERAGE_SIZE,
  sumOpen: ELEVATED_LEVERAGE_SIZE, sumClose: '0', entryPrice: BTC_ORACLE,
  createdAt: '2025-05-01T00:00:00.000Z', createdAtHeight: '500', closedAt: null,
});
const WIN_FILLS = [
  fill('b1', 'BTC-USD', 'BUY',  '1', BTC_ORACLE, BTC_WIN.createdAt, '100'),
  fill('b2', 'BTC-USD', 'SELL', '1', '101000', BTC_WIN.closedAt, '200'),
];
const LOSS_FILLS = [
  fill('e1', 'ETH-USD', 'BUY',  '10', '2000', ETH_LOSS.createdAt, '300'),
  fill('e2', 'ETH-USD', 'SELL', '10', '1960', ETH_LOSS.closedAt, '400'),
];

const winLossAccount = {
  ...fixture,
  subaccount: { subaccount: { ...fixture.subaccount.subaccount, equity: EQUITY } },
  markets: { markets: {
    'BTC-USD': { ...fixture.markets.markets['BTC-USD'], oraclePrice: BTC_ORACLE },
    'ETH-USD': { ticker: 'ETH-USD', oraclePrice: '2000', marketType: 'CROSS', status: 'ACTIVE',
      initialMarginFraction: '0.05', maintenanceMarginFraction: '0.03', stepSize: '0.001', tickSize: '0.1' },
  } },
  openPositions: { positions: [] },
  closedPositions: { positions: [ETH_LOSS, BTC_WIN] },
  fills: { fills: [...LOSS_FILLS, ...WIN_FILLS] },
};
// The win alone, on a curve that only rises to the +$1000 headline.
const atPeakAccount = {
  ...winLossAccount,
  closedPositions: { positions: [BTC_WIN] },
  fills: { fills: WIN_FILLS },
  historicalPnl: { historicalPnl: [
    histRow(BTC_WIN.closedAt, 1000),
    histRow(BTC_WIN.createdAt, 0),
  ] },
};
const leveragedAccount = {
  ...winLossAccount,
  openPositions: { positions: [BTC_OPEN] },
  fills: { fills: [
    ...winLossAccount.fills.fills,
    fill('b3', 'BTC-USD', 'BUY', ELEVATED_LEVERAGE_SIZE, BTC_ORACLE, BTC_OPEN.createdAt, '500'),
  ] },
};

function serveAccount(data) {
  return (route) => {
    const key = fixtureKeyFor(route.request().url());
    if (!key) return serveFixture(route);
    const body = indexerBody(key, data, route.request().url());
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  };
}

// An ECB rate for every requested date, so the Tax tab's EUR cards render.
const USD_PER_EUR = 1.25;
function serveFxRates(route) {
  const url = route.request().url();
  const body = url.includes('..')
    ? { base: 'EUR', rates: {} }
    : { base: 'EUR', rates: { USD: USD_PER_EUR }, date: new URL(url).pathname.split('/').pop() };
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

async function loadAccount(page, data) {
  await page.clock.setFixedTime(new Date(NOW));
  await page.route(INDEXER_URL, serveAccount(data));
  await page.route(/api\.frankfurter\.dev\/v1\//, serveFxRates);
  await page.goto(`/?address=${data.address}`);
  await expect(page.locator('#dataAge')).toBeVisible();
}

async function openTab(page, tab) {
  await page.locator(`.nav-tab[data-tab="${tab}"]`).click();
  await expect(page.locator(`#${tab}.tab-content.active`)).toBeVisible();
  if (tab === 'tax') {
    await expect(page.locator('#taxStatus')).not.toContainText('Fetching ECB rates');
  }
}

// Each tone's colour as the bare class renders it on a plain element.
function toneColours(page) {
  return page.evaluate((tones) => Object.fromEntries(tones.map(tone => {
    const probe = document.createElement('span');
    probe.className = tone;
    document.body.appendChild(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return [tone, colour];
  })), TONES);
}

// Every element in `tab` carrying a tone class, with its tone and colour.
function tonedElements(page, tab) {
  return page.evaluate(({ tab, tones }) => {
    const selector = tones.map(tone => `#${tab} .${tone}`).join(', ');
    return [...document.querySelectorAll(selector)].map(el => ({
      id: el.id || `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`,
      tone: tones.find(tone => el.classList.contains(tone)),
      colour: getComputedStyle(el).color,
    }));
  }, { tab, tones: TONES });
}

async function colour(page, id) {
  return page.locator(`#${id}`).evaluate(el => getComputedStyle(el).color);
}

test.describe('tone colours', () => {
  test('every toned value on every tab shows its tone\'s colour', async ({ page }) => {
    const seen = new Set();
    for (const data of [winLossAccount, atPeakAccount, leveragedAccount]) {
      await loadAccount(page, data);
      const expected = await toneColours(page);
      expect(new Set(Object.values(expected)).size).toBe(TONES.length);
      for (const tab of TABS) {
        await openTab(page, tab);
        const toned = await tonedElements(page, tab);
        const wrong = toned.filter(el => el.colour !== expected[el.tone]);
        expect(wrong, `tab ${tab}`).toEqual([]);
        toned.forEach(el => seen.add(el.tone));
      }
      await page.unrouteAll();
    }
    expect([...seen].sort()).toEqual([...TONES].sort());
  });

  test('metric cards show their tone: green at peak, red below it, neutral at zero, amber at elevated leverage', async ({ page }) => {
    await loadAccount(page, atPeakAccount);
    const tones = await toneColours(page);
    await expect(page.locator('#currentDrawdown')).toHaveText('$0');
    await expect(page.locator('#currentDrawdownDetail')).toHaveText(`At peak (${NOW.slice(0, 10)})`);
    expect(await colour(page, 'currentDrawdown')).toBe(tones.profit);
    await expect(page.locator('#maxDrawdown')).toHaveText('$0');
    expect(await colour(page, 'maxDrawdown')).toBe(tones.zero);
    expect(await colour(page, 'totalPnL')).toBe(tones.profit);
    await openTab(page, 'market');
    await expect(page.locator('#fundingNet')).toHaveText('$0.00');
    expect(await colour(page, 'fundingNet')).toBe(tones.zero);
    await page.unrouteAll();

    await loadAccount(page, leveragedAccount);
    await expect(page.locator('#currentDrawdown')).toHaveText('-$400');
    expect(await colour(page, 'currentDrawdown')).toBe(tones.loss);
    await expect(page.locator('#avgLoss')).toHaveText('-$400');
    expect(await colour(page, 'avgLoss')).toBe(tones.loss);
    await openTab(page, 'risk');
    await expect(page.locator('#leverageUtil')).toHaveText('3.00x');
    expect(await colour(page, 'leverageUtil')).toBe(tones.warning);
    await openTab(page, 'tax');
    await expect(page.locator('#taxGrossLossesUsd')).toHaveText('-$400.00');
    expect(await colour(page, 'taxGrossLossesUsd')).toBe(tones.loss);
  });
});
