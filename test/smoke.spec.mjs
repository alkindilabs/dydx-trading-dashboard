import { test, expect } from '@playwright/test';
import { ADDRESS, AppConstants, INDEXER_URL, fixture, serveFixture } from './indexer-fixture.mjs';

test.describe('dashboard smoke', () => {
  test.beforeEach(async ({ page }) => {
    await page.route(INDEXER_URL, serveFixture);
    // Stub the ECB-proxy used by the Tax tab so the smoke run never
    // hits the live api.frankfurter.dev/v1 endpoint. Return a
    // real-looking rate for the fixture's single closed-position
    // close-date so the Tax tab's render exercises the success path
    // end-to-end.
    await page.route(/api\.frankfurter\.dev\/v1\//, async (route) => {
      const url = route.request().url();
      const body = url.includes('..')
        ? { base: 'EUR', rates: { '2024-03-16': { USD: 1.0876 } } }
        : { base: 'EUR', rates: { USD: 1.0876 }, date: '2024-03-16' };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    });
    // Belt-and-braces: a regression that pointed back at frankfurter.app
    // or dropped the /v1 prefix would otherwise hit the live network
    // (flaky) or pass against a slow timeout. Route both to a hard
    // failure so the smoke run fails loudly on any URL drift.
    await page.route(/api\.frankfurter\.app/, route => route.fulfill({
      status: 410,
      contentType: 'text/plain',
      body: 'frankfurter.app retired — code must use frankfurter.dev/v1',
    }));
    await page.route(/api\.frankfurter\.dev(?!\/v1\/)/, route => route.fulfill({
      status: 410,
      contentType: 'text/plain',
      body: 'frankfurter.dev requires /v1 path prefix',
    }));
  });

  test('loads with no console errors and renders all 7 tabs', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

    await page.goto(`/?address=${ADDRESS}`);

    // Wait for the load lifecycle then a beat for the dashboard render to settle.
    await page.waitForLoadState('networkidle');

    const tabs = ['overview', 'performance', 'risk', 'positions', 'behavior', 'market', 'tax'];
    for (const id of tabs) {
      await expect(page.locator(`.nav-tab[data-tab="${id}"]`)).toBeVisible();
    }

    // Give the dashboard a beat to settle so any async render error has a
    // chance to surface in the console listener.
    await page.waitForTimeout(1500);

    expect(errors, errors.join('\n')).toHaveLength(0);
  });

  test('the heading names each tab by the label its tab shows', async ({ page }) => {
    await page.goto('/');
    const breadcrumb = page.locator('#breadcrumb');
    await expect(breadcrumb).toHaveText('Trade Review');
    for (const tab of await page.locator('.nav-tab').all()) {
      const label = (await tab.textContent()).trim();
      await tab.click();
      const expected = (await tab.getAttribute('data-tab')) === 'overview'
        ? 'Trade Review'
        : `Trade Review — ${label}`;
      await expect(breadcrumb).toHaveText(expected);
    }
  });

  test('tab switching mounts each panel without throwing', async ({ page }) => {
    const errors = [];
    const fxCalls = [];
    page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    page.on('request', req => {
      if (/api\.frankfurter\.dev\/v1\//.test(req.url())) fxCalls.push(req.url());
    });

    await page.goto(`/?address=${ADDRESS}`);
    await page.waitForLoadState('networkidle');

    for (const id of ['performance', 'risk', 'positions', 'behavior', 'market', 'tax', 'overview']) {
      await page.locator(`.nav-tab[data-tab="${id}"]`).click();
      await expect(page.locator(`#${id}.tab-content.active`)).toBeVisible();
    }

    // Tax tab activation kicks off an async FX fetch via window.FxRates.
    // Wait for a deterministic terminal state instead of a fixed timeout:
    // the status line transitions away from the "Fetching ECB rates…"
    // message once the post-await render fires (success, missing-rate,
    // or empty-state). This catches console errors that a fixed
    // waitForTimeout might miss on a slow CI runner.
    await expect(page.locator('#taxStatus')).not.toContainText('Fetching ECB rates', { timeout: 10000 });

    // The fixture has a single closed position with a 2024-03-16 close
    // date, so the Tax tab MUST have hit the FX route at least once to
    // resolve that date — guards against a regression where the panel
    // would silently skip the FX path (e.g. wrong fixture, deferred
    // render that never re-fires on tab activation).
    expect(fxCalls.length, `expected api.frankfurter.dev/v1 to be called, got ${fxCalls.length}`)
      .toBeGreaterThan(0);

    expect(errors, errors.join('\n')).toHaveLength(0);
  });

  test('the Tax CSV opens with a UTF-8 BOM and its header, and its file name carries the year and category', async ({ page }) => {
    await page.goto(`/?address=${ADDRESS}`);
    await page.waitForLoadState('networkidle');
    await page.locator('.nav-tab[data-tab="tax"]').click();
    await expect(page.locator('#taxStatus')).not.toContainText('Fetching ECB rates', { timeout: 10000 });
    const year = await page.locator('#taxYear').inputValue();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('#taxDownloadCsv').click(),
    ]);
    expect(download.suggestedFilename()).toMatch(new RegExp(`^dydx-tax-.+-${year}-catG\\.csv$`));
    const chunks = [];
    for await (const chunk of await download.createReadStream()) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const UTF8_BOM_BYTES = [0xef, 0xbb, 0xbf];
    expect([...bytes.subarray(0, UTF8_BOM_BYTES.length)]).toEqual(UTF8_BOM_BYTES);
    expect(bytes.subarray(UTF8_BOM_BYTES.length).toString('utf8')).toMatch(/^status,closed_at_utc,/);
  });

  test('the Tax JSON from a cached snapshot is dated by the snapshot, not by the clock', async ({ page }) => {
    // The clock reads three hours after the snapshot was fetched, and the
    // indexer never answers, so the page shows the cached snapshot.
    const SNAPSHOT_AGE_HOURS = 3;
    const nowMs = Date.parse('2026-03-02T12:00:00.000Z');
    const snapshotMs = nowMs - SNAPSHOT_AGE_HOURS * AppConstants.MS_PER_HOUR;
    await page.clock.setFixedTime(new Date(nowMs));
    await page.route(INDEXER_URL, () => new Promise(() => {}));
    await page.goto('/');
    await page.evaluate(({ address, fixture, snapshotMs }) => {
      const data = {
        subaccount: fixture.subaccount,
        addressSubaccounts: fixture.addressSubaccounts,
        openPositions: fixture.openPositions,
        markets: fixture.markets,
        closedPositions: fixture.closedPositions,
        fills: fixture.fills,
        fundingPayments: fixture.fundingPayments,
        historicalPnl: fixture.historicalPnl,
      };
      const packed = { v: window.PortfolioCache.SCHEMA_VERSION, address, fetchedAt: snapshotMs, data };
      localStorage.setItem(window.PortfolioCache.KEY, LZString.compressToUTF16(JSON.stringify(packed)));
    }, { address: ADDRESS, fixture, snapshotMs });
    await page.goto(`/?address=${ADDRESS}`);
    await page.locator('.nav-tab[data-tab="tax"]').click();
    await expect(page.locator('#taxStatus')).not.toContainText('Fetching ECB rates', { timeout: 10000 });

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('#taxDownloadJson').click(),
    ]);
    const chunks = [];
    for await (const chunk of await download.createReadStream()) chunks.push(chunk);
    const { meta } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    expect(meta.asOf).toBe(new Date(snapshotMs).toISOString());
  });
});
