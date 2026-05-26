import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'sample-trader.json'), 'utf-8')
);
const ADDRESS = fixture.address;

// Map each indexer URL pattern to the fixture key whose JSON it should serve.
// Order matters: the more specific patterns must match before the more general
// /addresses/{addr} pattern (sub vs addressSubaccounts).
const ROUTE_RULES = [
  { match: /\/v4\/addresses\/[^/]+\/subaccountNumber\/0(?:\?|$)/, key: 'subaccount' },
  { match: /\/v4\/addresses\/[^/?]+(?:\?|$)/,                       key: 'addressSubaccounts' },
  { match: /\/v4\/perpetualPositions[^?]*\?[^#]*status=OPEN/,       key: 'openPositions' },
  { match: /\/v4\/perpetualPositions[^?]*\?[^#]*status=CLOSED/,     key: 'closedPositions' },
  { match: /\/v4\/orders\?/,                                        key: 'orders' },
  { match: /\/v4\/perpetualMarkets(?:\?|$)/,                        key: 'markets' },
  { match: /\/v4\/fills\?/,                                         key: 'fills' },
  { match: /\/v4\/fundingPayments\?/,                               key: 'fundingPayments' },
  { match: /\/v4\/historical-pnl\?/,                                key: 'historicalPnl' },
  // Market-wide endpoints used by the Market Structure tab's funding
  // history chart. Lazy-loaded on tab activation; the fixture has no
  // data for these so the smoke verifies the empty-state path doesn't
  // throw and doesn't log network errors.
  { match: /\/v4\/historicalFunding\//,                             empty: { historicalFunding: [] } },
  { match: /\/v4\/candles\/perpetualMarkets\//,                     empty: { candles: [] } },
];

test.describe('dashboard smoke', () => {
  test.beforeEach(async ({ page }) => {
    await page.route(/indexer\.dydx\.trade/, async (route) => {
      const url = route.request().url();
      const rule = ROUTE_RULES.find(r => r.match.test(url));
      if (!rule) {
        return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
      }
      const body = rule.key ? fixture[rule.key] : rule.empty;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    });
    // Stub the ECB-proxy used by the Tax tab so the smoke run never
    // hits the live api.frankfurter.dev/v1 endpoint. Return a
    // real-looking rate for the fixture's single closed-position
    // close-date so the Tax tab's render exercises the success path
    // end-to-end.
    await page.route(/api\.frankfurter\.dev\/v1\//, async (route) => {
      const url = route.request().url();
      const body = url.includes('..')
        ? { rates: { '2024-03-16': { EUR: 0.92 } } }
        : { rates: { EUR: 0.92 }, date: '2024-03-16' };
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
});
