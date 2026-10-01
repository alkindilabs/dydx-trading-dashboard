import { test, expect } from '@playwright/test';
import { ADDRESS, AppConstants, INDEXER_URL, fixture, serveFixture } from './indexer-fixture.mjs';

// The Market tab's funding chart when /candles fails: funding bars are the
// load-bearing signal and still render, while the missing price line is
// called out instead of silently absent. Only the indexer is faked.

const HTTP_SERVICE_UNAVAILABLE = 503;
const { MS_PER_HOUR, MS_PER_DAY } = AppConstants;
const FUNDING_HOURS = 48;
// Older than the 7D window yet inside 90D, so toggling between the two
// pills flips the chart between its empty state and drawn bars.
const STALE_FUNDING_AGE_DAYS = 10;
const FUNDING_WINDOW_KEY = 'fundingWindow';
const OVERLAY_UNAVAILABLE = 'Price overlay unavailable: candles failed to load';

const ALTERNATING_RATES = ['-0.00001', '0.00001'];
// The spread of hourly funding rates dYdX markets settle at.
const REALISTIC_HOURLY_RATES = ['0.000001', '0.0000035', '0.0000125', '0.00002', '0.000008'];

// One fixed series per test: the cursor walk's next page repeats it, so
// the paginator stops on the dedup cycle with exactly FUNDING_HOURS rows.
function hourlyFundingRows(ticker, newestAt, rates) {
  return Array.from({ length: FUNDING_HOURS }, (_, i) => ({
    ticker,
    rate: rates[i % rates.length],
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

const CANDLE_CLOSE_BASE = 65000;
const CANDLE_CLOSE_STEP = 37.5;
// Healthy hourly candles at a realistic BTC price level.
const hourlyCandles = (route) => {
  const newestAt = Date.now();
  const candles = Array.from({ length: FUNDING_HOURS }, (_, i) => ({
    startedAt: new Date(newestAt - i * MS_PER_HOUR).toISOString(),
    close: String(CANDLE_CLOSE_BASE + i * CANDLE_CLOSE_STEP),
  }));
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ candles }) });
};

async function serveFunding(page, serveCandles, { ageDays = 0, rates = ALTERNATING_RATES } = {}) {
  const newestAt = Date.now() - ageDays * MS_PER_DAY;
  await page.route(INDEXER_URL, (route) => {
    const url = route.request().url();
    const funding = url.match(/\/v4\/historicalFunding\/([^?]+)/);
    if (funding) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ historicalFunding: hourlyFundingRows(decodeURIComponent(funding[1]), newestAt, rates) }),
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

// Pixel width of a y-axis as laid out: 0 when the axis is not drawn.
function scaleWidth(page, scaleId) {
  return page.evaluate((id) => Chart.getChart(document.getElementById('fundingRateChart')).scales[id].width, scaleId);
}

function scaleTickLabels(page, scaleId) {
  return page.evaluate((id) => Chart.getChart(document.getElementById('fundingRateChart')).scales[id].ticks.map(t => t.label), scaleId);
}

const priceLegendEntry = (page) => page.locator('.funding-chart__legend-item:has(.funding-chart__swatch--price)');

async function expectBarsWithoutPriceLine(page) {
  await expect.poll(() => fundingChartDatasets(page)).not.toBeNull();
  const datasets = await fundingChartDatasets(page);
  expect(datasets.find(d => d.type === 'bar').points).toBe(FUNDING_HOURS);
  expect(datasets.find(d => d.type === 'line').points).toBe(0);
  await expect(page.locator('#fundingChartEmpty')).toBeHidden();
  expect(await scaleWidth(page, 'yPrice'), 'no price line, so no price axis').toBe(0);
  await expect(priceLegendEntry(page)).toBeHidden();
}

async function expectBarsWithPriceLine(page) {
  await expect.poll(() => fundingChartDatasets(page)).not.toBeNull();
  const datasets = await fundingChartDatasets(page);
  expect(datasets.find(d => d.type === 'bar').points).toBe(FUNDING_HOURS);
  expect(datasets.find(d => d.type === 'line').points).toBe(FUNDING_HOURS);
}

// Hovering fails with "intercepts pointer events" if anything covers the canvas.
async function hoverChartTooltipLines(page) {
  await page.locator('#fundingRateChart').hover();
  await expect.poll(() => page.evaluate(() =>
    Chart.getChart(document.getElementById('fundingRateChart')).tooltip.getActiveElements().length)).toBeGreaterThan(0);
  return page.evaluate(() =>
    Chart.getChart(document.getElementById('fundingRateChart')).tooltip.body.flatMap(b => b.lines));
}

const UNSIGNED_DOLLARS = /^\$\d/;

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
  await expect(page.locator('#fundingChartEmpty')).toBeVisible();
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

test.describe('with funding bars and the price line both drawn', () => {
  test('the hidden empty-state placeholder neither shows nor blocks the tooltip', async ({ page }) => {
    await serveFunding(page, hourlyCandles);
    await openMarketTab(page);
    await expectBarsWithPriceLine(page);

    await expect(page.locator('#fundingChartEmpty')).toBeHidden();
    const lines = await hoverChartTooltipLines(page);
    expect(lines.some(l => l.startsWith('Funding (1h):'))).toBe(true);
  });

  test('the price axis and its legend entry are shown', async ({ page }) => {
    await serveFunding(page, hourlyCandles);
    await openMarketTab(page);
    await expectBarsWithPriceLine(page);

    expect(await scaleWidth(page, 'yPrice')).toBeGreaterThan(0);
    await expect(priceLegendEntry(page)).toBeVisible();
  });

  test('prices on the right axis and in the tooltip carry no profit sign', async ({ page }) => {
    await serveFunding(page, hourlyCandles);
    await openMarketTab(page);
    await expectBarsWithPriceLine(page);

    const axisLabels = await scaleTickLabels(page, 'yPrice');
    expect(axisLabels.length).toBeGreaterThan(0);
    for (const label of axisLabels) expect(label).toMatch(UNSIGNED_DOLLARS);

    const priceLine = (await hoverChartTooltipLines(page)).find(l => l.startsWith('Price:'));
    expect(priceLine.replace(/^Price:\s+/, '')).toMatch(UNSIGNED_DOLLARS);
  });

  test('funding-rate axis labels stay distinct at realistic hourly rates', async ({ page }) => {
    await serveFunding(page, hourlyCandles, { rates: REALISTIC_HOURLY_RATES });
    await openMarketTab(page);
    await expectBarsWithPriceLine(page);

    const labels = await scaleTickLabels(page, 'yRate');
    expect(labels.length).toBeGreaterThan(1);
    expect(new Set(labels).size, `labels: ${labels.join(', ')}`).toBe(labels.length);
  });
});

test('the chart caption states how many days the All window reaches', async ({ page }) => {
  await serveFunding(page, candleOutage);
  await openMarketTab(page);
  await expect(page.locator('#fundingChartMaxDays')).toHaveText(String(AppConstants.FUNDING_CHART_MAX_DAYS));
});
