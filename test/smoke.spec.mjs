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
];

test.describe('dashboard smoke', () => {
  test.beforeEach(async ({ page }) => {
    await page.route(/indexer\.dydx\.trade/, async (route) => {
      const url = route.request().url();
      const rule = ROUTE_RULES.find(r => r.match.test(url));
      if (!rule) {
        return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(fixture[rule.key]),
      });
    });
    // Stub the ECB-proxy used by the Tax tab so the smoke run never hits
    // the live api.frankfurter.app endpoint.
    await page.route(/api\.frankfurter\.app/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ rates: {} }),
      });
    });
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
    page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

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

    expect(errors, errors.join('\n')).toHaveLength(0);
  });
});
