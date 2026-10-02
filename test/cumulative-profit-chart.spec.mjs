import { test, expect } from '@playwright/test';
import { fixture, fixtureKeyFor, indexerBody, serveFixture, INDEXER_URL, ADDRESS } from './indexer-fixture.mjs';

// The Overview's Cumulative Profit chart in the real page. Its series is
// /historical-pnl: when that is unknown (the endpoint failed, or it holds
// no rows) the chart draws nothing and says why, and a later load never
// keeps the candles an earlier load (or the cached snapshot) drew.

const HTTP_SERVICE_UNAVAILABLE = 503;
const MIN_CANDLES = 2;

// A /historical-pnl row: cumulative trading P&L `totalPnl` at `createdAt`.
const histRow = (createdAt, totalPnl) => ({
  createdAt, blockTime: createdAt, blockHeight: '1', totalPnl: String(totalPnl), equity: '10000', netTransfers: '0',
});
const ROWS = [
  histRow('2025-01-01T00:00:00.000Z', 0),
  histRow('2025-01-02T00:00:00.000Z', 500),
  histRow('2025-01-03T00:00:00.000Z', 200),
  histRow('2025-01-04T00:00:00.000Z', 300),
];
const withRows = (rows) => ({ ...fixture, historicalPnl: { historicalPnl: rows } });

function serveAccount(data, failingKey = null) {
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

// The candles on the chart's canvas, or null without a Chart.js instance.
const candleCount = (page) => page.evaluate(() => {
  const chart = window.Chart.getChart(document.getElementById('pnlCumulativeChart'));
  return chart ? chart.data.datasets[0].data.length : null;
});

const empty = (page) => page.locator('#pnlCumulativeChartEmpty');

async function loadAccount(page) {
  await page.goto(`/?address=${ADDRESS}`);
  await expect(page.locator('#dataAge')).toBeVisible();
}

test.describe('Cumulative Profit chart', () => {
  test('a reload whose /historical-pnl fails clears the earlier candles and shows the reason', async ({ page }) => {
    await page.route(INDEXER_URL, serveAccount(withRows(ROWS)));
    await loadAccount(page);
    await expect.poll(() => candleCount(page)).toBeGreaterThanOrEqual(MIN_CANDLES);
    await expect(empty(page)).toBeHidden();

    await page.unroute(INDEXER_URL);
    await page.route(INDEXER_URL, serveAccount(withRows(ROWS), 'historicalPnl'));
    await page.reload();
    await expect(page.locator('#statusBadge')).toHaveText(/PARTIAL/);
    await expect.poll(() => candleCount(page)).toBeNull();
    await expect(empty(page)).toBeVisible();
    await expect(empty(page)).toContainText('Historical profit failed to load');
  });

  test('each candle hands the plugin its colour by its open and close as displayed', async ({ page }) => {
    // Day 1 rises 0 → 1000, day 2 falls 900 → 500, day 3 moves 500 →
    // 500.4, which both read $500; the clock puts the live point alone on
    // day 4, a candle whose open is its close.
    await page.clock.setFixedTime(new Date('2025-01-04T12:00:00.000Z'));
    await page.route(INDEXER_URL, serveAccount(withRows([
      histRow('2025-01-01T00:00:00.000Z', 0), histRow('2025-01-01T12:00:00.000Z', 1000),
      histRow('2025-01-02T00:00:00.000Z', 900), histRow('2025-01-02T12:00:00.000Z', 500),
      histRow('2025-01-03T00:00:00.000Z', 500), histRow('2025-01-03T12:00:00.000Z', 500.4),
    ])));
    await loadAccount(page);
    await expect.poll(() => candleCount(page)).toBe(4);
    // The options chartjs-chart-financial draws each candle from.
    const [up, down, shownFlat, flat] = await page.evaluate(() => {
      const chart = window.Chart.getChart(document.getElementById('pnlCumulativeChart'));
      return chart.getDatasetMeta(0).data.map(candle => ({
        border: candle.options.borderColors,
        fill: candle.options.backgroundColors && candle.options.backgroundColors.up,
      }));
    });
    expect(typeof flat.border).toBe('string');
    expect(typeof flat.fill).toBe('string');
    expect(shownFlat).toEqual(flat);
    expect(new Set([up.border, down.border, flat.border]).size).toBe(3);
    expect(new Set([up.fill, down.fill, flat.fill]).size).toBe(3);
  });

  test('an account without /historical-pnl rows draws no chart and says so', async ({ page }) => {
    await page.route(INDEXER_URL, serveAccount(withRows([])));
    await loadAccount(page);
    await expect(empty(page)).toBeVisible();
    await expect(empty(page)).toContainText('No /historical-pnl rows');
    expect(await candleCount(page)).toBeNull();
  });
});
