import { test, expect } from '@playwright/test';
import { ADDRESS, AppConstants, INDEXER_URL, fixture } from './indexer-fixture.mjs';

// A cached snapshot whose /historical-pnl the cache trimmed to its newest
// rows does not reach inception, so the all-time time-series ratios
// (Sharpe, Sortino, Calmar, VaR / Expected Shortfall) cannot be measured
// from it and read — with the cut reason. The indexer is held so the
// cached paint is what the page shows.

const ROWS = 1000;
const EQUITY = 100000;
const START_MS = Date.parse('2025-01-01T00:00:00.000Z');

// Hourly rows on constant equity with a totalPnl that moves both ways, so
// every adequacy rule passes and the ratios have a value when not cut.
const hourlyRows = Array.from({ length: ROWS }, (_, i) => ({
  createdAt: new Date(START_MS + i * AppConstants.MS_PER_HOUR).toISOString(),
  equity: String(EQUITY),
  totalPnl: String(i * 2 + (i % 2 ? 50 : 0)),
  netTransfers: '0',
}));

// Funded, idle hourly rows: every return is 0, so they pass the adequacy
// gate but have no spread for a Sharpe or Sortino.
const idleRows = hourlyRows.map(row => ({ ...row, totalPnl: '0' }));

async function paintCachedSnapshot(page, evictedSteps, rows = hourlyRows) {
  await page.route(INDEXER_URL, () => new Promise(() => {}));
  await page.goto('/');
  await page.evaluate(({ address, fixture, rows, evictedSteps }) => {
    const data = {
      subaccount: fixture.subaccount,
      addressSubaccounts: fixture.addressSubaccounts,
      openPositions: fixture.openPositions,
      markets: fixture.markets,
      closedPositions: fixture.closedPositions,
      fills: fixture.fills,
      fundingPayments: fixture.fundingPayments,
      historicalPnl: { historicalPnl: rows },
      ...(evictedSteps ? { _cacheMeta: { evicted: true, evictedSteps } } : {}),
    };
    const packed = { v: window.PortfolioCache.SCHEMA_VERSION, address, fetchedAt: Date.now(), data };
    localStorage.setItem(window.PortfolioCache.KEY, LZString.compressToUTF16(JSON.stringify(packed)));
  }, { address: ADDRESS, fixture, rows, evictedSteps });
  await page.goto(`/?address=${ADDRESS}`);
}

test.describe('time-series ratios on a cached /historical-pnl', () => {
  test('complete rows give the ratios a value', async ({ page }) => {
    await paintCachedSnapshot(page, null);
    await expect(page.locator('#sharpeRatio')).toHaveText(/^-?\d+\.\d{2}$/);
    await expect(page.locator('#var95')).toHaveText(/\$/);
  });

  test('returns that pass the gate but never move read — with "Returns have no spread"', async ({ page }) => {
    await paintCachedSnapshot(page, null, idleRows);
    for (const id of ['sharpe', 'sortino']) {
      await expect(page.locator(`#${id}Ratio`), id).toHaveText('—');
      await expect(page.locator(`#${id}Meta`), id).toHaveText('Returns have no spread ⓘ');
      expect(await page.locator(`#${id}Meta`).getAttribute('title'), id).toBe('Returns have no spread');
    }
  });

  test('rows the cache trimmed read — with the cut reason, not values from the kept rows', async ({ page }) => {
    await paintCachedSnapshot(page, ['historicalPnl']);
    const reason = /^Historical profit before .* not in cached snapshot$/;
    for (const id of ['sharpeRatio', 'sortinoRatio', 'calmarRatio', 'var95', 'expectedShortfall']) {
      await expect(page.locator(`#${id}`), id).toHaveText('—');
    }
    expect(await page.locator('#sharpeMeta').getAttribute('title')).toMatch(reason);
    expect(await page.locator('#sortinoMeta').getAttribute('title')).toMatch(reason);
    expect(await page.locator('#var95').getAttribute('title')).toMatch(reason);
    expect(await page.locator('#expectedShortfall').getAttribute('title')).toMatch(reason);
    await expect(page.locator('#calmarDetail')).toHaveText(reason);
    expect(await page.locator('#calmarDetail').getAttribute('title')).toMatch(reason);
  });
});

// A /historical-pnl row whose time or amount does not parse leaves every
// view built on the rows unknown: never a series reordered around it or
// one that drops it.
const ROW_GAP_REASON = '1 /historical-pnl row without a valid time or amount';
const BAD_ROW = 500;
const MONTHLY_COLUMNS = { PROFIT: 1, MAX_DD: 7, SHARPE: 8 };

test.describe('a /historical-pnl row without a valid time or amount', () => {
  for (const [name, patch] of [
    ['an unparseable createdAt', { createdAt: 'not-a-time' }],
    ['an empty totalPnl', { totalPnl: '' }],
  ]) {
    test(`${name} reads — with the reason in every view built on the rows`, async ({ page }) => {
      const rows = hourlyRows.map((row, i) => (i === BAD_ROW ? { ...row, ...patch } : row));
      await paintCachedSnapshot(page, null, rows);
      for (const id of ['sharpeRatio', 'sortinoRatio', 'calmarRatio', 'var95', 'expectedShortfall',
        'maxDrawdown', 'currentDrawdown', 'recoveryFactor']) {
        await expect(page.locator(`#${id}`), id).toHaveText('—');
      }
      expect(await page.locator('#sharpeMeta').getAttribute('title')).toBe(ROW_GAP_REASON);
      expect(await page.locator('#var95').getAttribute('title')).toBe(ROW_GAP_REASON);
      await expect(page.locator('#calmarDetail')).toHaveText(ROW_GAP_REASON);
      await expect(page.locator('#maxDrawdownDetail')).toHaveText(ROW_GAP_REASON);
      await expect(page.locator('#currentDrawdownDetail')).toHaveText(ROW_GAP_REASON);
      await expect(page.locator('#drawdownPeriodsBody')).toHaveText(ROW_GAP_REASON);
      await expect(page.locator('#pnlCumulativeChartEmpty')).toHaveText(`— ${ROW_GAP_REASON}`);
      const months = page.locator('#monthlyPerformanceBody tr');
      expect(await months.count()).toBeGreaterThan(0);
      for (const tr of await months.all()) {
        for (const column of Object.values(MONTHLY_COLUMNS)) {
          const cell = tr.locator('td').nth(column);
          await expect(cell).toHaveText('—');
          expect(await cell.getAttribute('title')).toBe(ROW_GAP_REASON);
        }
      }
    });
  }
});
