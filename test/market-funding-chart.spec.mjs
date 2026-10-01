import { test, expect } from '@playwright/test';
import { ADDRESS, INDEXER_URL, fixture, serveFixture } from './indexer-fixture.mjs';

// The Market tab's funding chart when /candles fails: funding bars are the
// load-bearing signal and still render, while the missing price line is
// called out instead of silently absent. Only the indexer is faked.

const HTTP_SERVICE_UNAVAILABLE = 503;
const MS_PER_HOUR = 3_600_000;
const HOURS_PER_DAY = 24;
const MS_PER_DAY = HOURS_PER_DAY * MS_PER_HOUR;
const FUNDING_HOURS = 48;
// Older than the 7D window yet inside 90D, so toggling between the two
// pills flips the chart between its empty state and drawn bars.
const STALE_FUNDING_AGE_DAYS = 10;
const FUNDING_WINDOW_KEY = 'fundingWindow';
const OVERLAY_UNAVAILABLE = 'Price overlay unavailable: candles failed to load';

// One fixed series per test: the cursor walk's next page repeats it, so
// the paginator stops on the dedup cycle with exactly FUNDING_HOURS rows.
function hourlyFundingRows(ticker, newestAt) {
  return Array.from({ length: FUNDING_HOURS }, (_, i) => ({
    ticker,
    rate: i % 2 ? '0.00001' : '-0.00001',
    price: '100000',
    effectiveAt: new Date(newestAt - i * MS_PER_HOUR).toISOString(),
    effectiveAtHeight: String(FUNDING_HOURS - i),
  }));
}

const candleOutage = (route) => route.fulfill({
  status: HTTP_SERVICE_UNAVAILABLE,
  headers: { 'Retry-After': '0', 'Access-Control-Expose-Headers': 'Retry-After' },
  contentType: 'text/plain',
  body: 'indexer unavailable',
});
// A healthy /candles answer that holds no candles: the price line is empty
// although nothing failed.
const noCandles = (route) => route.fulfill({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify({ candles: [] }),
});

async function serveFunding(page, serveCandles, { ageDays = 0 } = {}) {
  const newestAt = Date.now() - ageDays * MS_PER_DAY;
  await page.route(INDEXER_URL, (route) => {
    const url = route.request().url();
    const funding = url.match(/\/v4\/historicalFunding\/([^?]+)/);
    if (funding) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ historicalFunding: hourlyFundingRows(decodeURIComponent(funding[1]), newestAt) }),
      });
    }
    if (/\/v4\/candles\/perpetualMarkets\//.test(url)) return serveCandles(route);
    return serveFixture(route);
  });
}

async function openMarketTab(page) {
  await page.goto(`/?address=${ADDRESS}`);
  await expect(page.locator('#dataAge')).toBeVisible();
  await page.locator('.nav-tab[data-tab="market"]').click();
}

function fundingChartDatasets(page) {
  return page.evaluate(() => {
    const chart = Chart.getChart(document.getElementById('fundingRateChart'));
    return chart ? chart.data.datasets.map(d => ({ type: d.type, points: d.data.length })) : null;
  });
}

async function expectBarsWithoutPriceLine(page) {
  await expect.poll(() => fundingChartDatasets(page)).not.toBeNull();
  const datasets = await fundingChartDatasets(page);
  expect(datasets.find(d => d.type === 'bar').points).toBe(FUNDING_HOURS);
  expect(datasets.find(d => d.type === 'line').points).toBe(0);
  await expect(page.locator('#fundingChartEmpty')).toHaveAttribute('hidden', '');
}

async function expectOverlayCaptionInFull(page) {
  const caption = page.locator('#fundingChartStatus');
  await expect(caption).toHaveText(OVERLAY_UNAVAILABLE);
  await expect(caption).toBeVisible();
  const ellipsized = await caption.evaluate(el => el.scrollWidth > el.clientWidth);
  expect(ellipsized, 'caption must be readable in full').toBe(false);
}

test('a candles outage keeps the funding bars and captions the missing price overlay', async ({ page }) => {
  await serveFunding(page, candleOutage);
  await openMarketTab(page);
  await expectOverlayCaptionInFull(page);
  await expectBarsWithoutPriceLine(page);
});

test.describe('at phone width', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('the price overlay caption wraps instead of being cut off', async ({ page }) => {
    await serveFunding(page, candleOutage);
    await openMarketTab(page);
    await expectOverlayCaptionInFull(page);
  });
});

test('candles that load but hold no rows leave no overlay caption', async ({ page }) => {
  await serveFunding(page, noCandles);
  await openMarketTab(page);
  await expectBarsWithoutPriceLine(page);
  await expect(page.locator('#fundingChartStatus')).toHaveText('');
});

async function startOnFundingWindow(page, days) {
  await page.addInitScript(([key, value]) => {
    try { localStorage.setItem(key, value); } catch (e) {}
  }, [FUNDING_WINDOW_KEY, days]);
}

const NOT_ENOUGH_HISTORY = /^Not enough funding history/;

async function expectNotEnoughHistory(page) {
  await expect(page.locator('#fundingChartEmpty')).not.toHaveAttribute('hidden');
  await expect(page.locator('#fundingChartEmpty')).toHaveText(NOT_ENOUGH_HISTORY);
}

async function pickFundingWindow(page, days) {
  await page.locator(`.funding-hero__pill[data-window="${days}"]`).click();
}

test.describe('the overlay caption follows every redraw when the window changes', () => {
  test('widening from an empty 7D window to 90D draws the bars and captions the missing overlay', async ({ page }) => {
    await startOnFundingWindow(page, '7');
    await serveFunding(page, candleOutage, { ageDays: STALE_FUNDING_AGE_DAYS });
    await openMarketTab(page);
    await expectNotEnoughHistory(page);
    await expect(page.locator('#fundingChartStatus')).toHaveText('');

    await pickFundingWindow(page, '90');
    await expectBarsWithoutPriceLine(page);
    await expectOverlayCaptionInFull(page);
  });

  test('narrowing from 90D to an empty 7D window clears the overlay caption', async ({ page }) => {
    await startOnFundingWindow(page, '90');
    await serveFunding(page, candleOutage, { ageDays: STALE_FUNDING_AGE_DAYS });
    await openMarketTab(page);
    await expectOverlayCaptionInFull(page);

    await pickFundingWindow(page, '7');
    await expectNotEnoughHistory(page);
    await expect(page.locator('#fundingChartStatus')).toHaveText('');
  });
});

test('a refresh while another tab is open clears the overlay caption with the chart it described', async ({ page }) => {
  await serveFunding(page, candleOutage);
  await openMarketTab(page);
  await expectOverlayCaptionInFull(page);

  await page.locator('.nav-tab[data-tab="overview"]').click();
  await page.evaluate(() => refreshDashboard({ skipCache: true }));
  await expect(page.locator('#statusBadge')).toHaveText('FRESH');

  expect(await fundingChartDatasets(page)).toBeNull();
  await expect(page.locator('#fundingChartStatus')).toHaveText('');
});

// Registered after serveFunding, so it is consulted first; every other
// request falls through to the funding/fixture handler.
const MARKETS_URL = /\/v4\/perpetualMarkets(?:\?|$)/;

test('markets failing on refresh clear the overlay caption with the chart', async ({ page }) => {
  await serveFunding(page, candleOutage);
  await openMarketTab(page);
  await expectOverlayCaptionInFull(page);

  await page.route(INDEXER_URL, (route) => (MARKETS_URL.test(route.request().url())
    ? candleOutage(route) : route.fallback()));
  await page.evaluate(() => refreshDashboard({ skipCache: true }));
  await expect(page.locator('#fundingChartEmpty')).toHaveText('No markets available');
  await expect(page.locator('#fundingChartStatus')).toHaveText('');
});

test('returning to a cached market restores its overlay caption', async ({ page }) => {
  const SECOND_TICKER = 'ETH-USD';
  await serveFunding(page, (route) => (route.request().url().includes(SECOND_TICKER)
    ? noCandles(route) : candleOutage(route)));
  const markets = fixture.markets.markets;
  const [firstTicker] = Object.keys(markets);
  await page.route(INDEXER_URL, (route) => (MARKETS_URL.test(route.request().url())
    ? route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ markets: { ...markets, [SECOND_TICKER]: { ...markets[firstTicker], ticker: SECOND_TICKER } } }),
    })
    : route.fallback()));
  await openMarketTab(page);

  // Load both markets once, so the final switch back is a cache hit.
  const picker = page.locator('#fundingChartTicker');
  await picker.selectOption(firstTicker);
  await expectOverlayCaptionInFull(page);
  await picker.selectOption(SECOND_TICKER);
  await expect(page.locator('#fundingChartStatus')).toHaveText('');
  await picker.selectOption(firstTicker);
  await expectOverlayCaptionInFull(page);
});
