import { test, expect } from '@playwright/test';
import { AppConstants, fixture, fixtureKeyFor, indexerBody, serveFixture, INDEXER_URL } from './indexer-fixture.mjs';

// A subaccount whose /historical-pnl disagrees with its fills: no fill and
// no position, yet its totalPnl climbs $80 an hour on $1,000 of equity
// (the profit transferred out each hour), the shape of a vault's main
// subaccount. The fills say $0.00; the rows say +$79,320. Neither the
// headline nor a live point at it may stand, and returns built from the
// rows are no measure of trading.

const ROWS = 1000;
const START_MS = Date.parse('2025-01-01T00:00:00.000Z');
const NOW = '2025-02-15T00:00:00.000Z';
const EQUITY = '1000';
const HOURLY_PROFIT = 80;
const DIP_ROW = 500;
const DIP = 600;

const totalPnlAt = i => HOURLY_PROFIT * i - (i >= DIP_ROW ? DIP : 0);
const rows = Array.from({ length: ROWS }, (_, i) => ({
  createdAt: new Date(START_MS + i * AppConstants.MS_PER_HOUR).toISOString(),
  equity: EQUITY,
  totalPnl: String(totalPnlAt(i)),
  netTransfers: i === 0 ? EQUITY : String(-(totalPnlAt(i) - totalPnlAt(i - 1))),
}));

const account = {
  ...fixture,
  subaccount: { subaccount: { ...fixture.subaccount.subaccount, equity: EQUITY, openPerpetualPositions: {} } },
  openPositions: { positions: [] },
  closedPositions: { positions: [] },
  fills: { fills: [] },
  fundingPayments: { fundingPayments: [] },
  historicalPnl: { historicalPnl: rows },
};

const REASON = 'Fills disagree with /historical-pnl by -$79,320: fills may be incomplete, '
  + 'or /historical-pnl may count flows that are not trades';
const MONTHLY_COLUMNS = { PROFIT: 1, MAX_DD: 7, SHARPE: 8 };

function serveAccount(route) {
  const key = fixtureKeyFor(route.request().url());
  if (!key) return serveFixture(route);
  const body = indexerBody(key, account, route.request().url());
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

test.describe('a fills-based headline that disagrees with /historical-pnl', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(new Date(NOW));
    await page.route(INDEXER_URL, serveAccount);
    await page.goto(`/?address=${account.address}`);
    await expect(page.locator('#dataAge')).not.toBeEmpty();
  });

  test('Total Profit reads — with the disagreement as its caption', async ({ page }) => {
    await expect(page.locator('#totalPnL')).toHaveText('—');
    await expect(page.locator('#totalPnLChange')).toHaveText(REASON);
  });

  test('the drawdown views end at the last hourly row, not at a $0 live point', async ({ page }) => {
    // The rows' own drawdown is the dip at row 500 (+$39,920 → +$39,400);
    // a live point at the $0 headline would read -$79,320.
    await expect(page.locator('#maxDrawdown')).toHaveText('-$520');
    await expect(page.locator('#currentDrawdown')).toHaveText('$0');
    await expect(page.locator('#currentDrawdownDetail'))
      .toHaveText(/last hourly row \(Total Profit unavailable\)$/);
    const months = page.locator('#monthlyPerformanceBody tr');
    // February (newest first) ends at its last row: +$80 × the hours since January's end.
    await expect(months.nth(0).locator('td').nth(MONTHLY_COLUMNS.PROFIT)).toHaveText(/^\+\$/);
    await expect(months.nth(0).locator('td').nth(MONTHLY_COLUMNS.MAX_DD)).toHaveText('$0');
  });

  test('the time-series ratios read — with the disagreement, never returns compounded from the rows', async ({ page }) => {
    for (const id of ['sharpeRatio', 'sortinoRatio', 'calmarRatio', 'var95', 'expectedShortfall']) {
      await expect(page.locator(`#${id}`), id).toHaveText('—');
    }
    expect(await page.locator('#sharpeMeta').getAttribute('title')).toContain(REASON);
    expect(await page.locator('#var95').getAttribute('title')).toBe(REASON);
    const months = page.locator('#monthlyPerformanceBody tr');
    expect(await months.count()).toBe(2);
    for (const tr of await months.all()) {
      const cell = tr.locator('td').nth(MONTHLY_COLUMNS.SHARPE);
      await expect(cell).toHaveText('—');
      expect(await cell.getAttribute('title')).toBe(REASON);
    }
  });
});
