import { test, expect } from '@playwright/test';
import { ADDRESS, INDEXER_URL, fixture, fixtureKeyFor, serveFixture } from './indexer-fixture.mjs';

// End-to-end checks of what loadDashboard tells the user about the data it
// fetched: the masthead status badge, the endpoint-failure banner and the
// cache write. Only the indexer is faked; failing responses carry
// `Retry-After: 0`, exposed to the cross-origin page, so the real retry
// loop runs without waiting out its backoff.

const HTTP_SERVICE_UNAVAILABLE = 503;
const TRANSIENT_FAILURES = 2;
const EVICTED_FIELDS = ['fills', 'fundingPayments'];

const FIRST_PAGE = '1';
const ORDERS_PATH = '/v4/orders';

// A full first page of /fills, so the page-mode walk asks for a second one.
function fullFillsPage(limit) {
  const [template] = fixture.fills.fills;
  return Array.from({ length: limit }, (_, i) => ({ ...template, id: `${template.id}-${i}` }));
}

function transientError(route) {
  return route.fulfill({
    status: HTTP_SERVICE_UNAVAILABLE,
    headers: { 'Retry-After': '0', 'Access-Control-Expose-Headers': 'Retry-After' },
    contentType: 'text/plain',
    body: 'indexer unavailable',
  });
}

async function mastheadGeometry(page) {
  return page.evaluate(() => {
    const box = (sel) => document.querySelector(sel).getBoundingClientRect();
    return {
      badgeWidth: box('#statusBadge').width,
      rightRailWidth: box('.header-right').width,
      leftColumnWidth: box('.masthead-left').width,
      mastheadHeight: box('.header').height,
    };
  });
}

test.describe('fetch status', () => {
  test('a single-page endpoint retries transient failures and the load ends FRESH', async ({ page }) => {
    let openPositionsRequests = 0;
    await page.route(INDEXER_URL, (route) => {
      if (fixtureKeyFor(route.request().url()) === 'openPositions') {
        openPositionsRequests++;
        if (openPositionsRequests <= TRANSIENT_FAILURES) return transientError(route);
      }
      return serveFixture(route);
    });

    await page.goto(`/?address=${ADDRESS}`);

    // The markup ships the badge IDLE, so FRESH means a load ended; the
    // data-age caption appears only once a load has rendered.
    await expect(page.locator('#dataAge')).toBeVisible();
    await expect(page.locator('#statusBadge')).toHaveText('FRESH');
    await expect(page.locator('#loadErrorBanner')).toBeHidden();
    expect(openPositionsRequests).toBe(TRANSIENT_FAILURES + 1);
  });

  test('a full load never requests /orders and caches no orders', async ({ page }) => {
    const ordersRequests = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === ORDERS_PATH) ordersRequests.push(request.url());
    });
    await page.route(INDEXER_URL, serveFixture);

    await page.goto(`/?address=${ADDRESS}`);

    await expect(page.locator('#dataAge')).toBeVisible();
    await expect(page.locator('#statusBadge')).toHaveText('FRESH');
    expect(ordersRequests).toEqual([]);
    const cached = await page.evaluate((address) => window.PortfolioCache.read(address), ADDRESS);
    expect(cached, 'a load with every endpoint answering must write the cache').not.toBeNull();
    expect(Object.keys(cached)).not.toContain('orders');
  });

  test('a fills page failing mid-walk marks the load partial, blanks the profit headline, skips the cache write, without reflow', async ({ page }) => {
    let releaseIndexer;
    const indexerReleased = new Promise(resolve => { releaseIndexer = resolve; });
    await page.route(INDEXER_URL, async (route) => {
      await indexerReleased;
      const url = route.request().url();
      const params = new URL(url).searchParams;
      if (fixtureKeyFor(url) !== 'fills' || !params.has('page')) return serveFixture(route);
      if (params.get('page') !== FIRST_PAGE) return transientError(route);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ fills: fullFillsPage(Number(params.get('limit'))) }),
      });
    });

    await page.goto(`/?address=${ADDRESS}`);
    const badge = page.locator('#statusBadge');
    await expect(badge).toHaveText('FETCHING');
    const fetchingGeometry = await mastheadGeometry(page);

    releaseIndexer();

    await expect(badge).toHaveText('FRESH · PARTIAL');
    await expect(badge).not.toHaveClass(/\bfresh\b/);
    expect(await badge.getAttribute('title')).toContain('failed: fills');
    await expect(page.locator('#loadErrorBanner')).toContainText('fills');
    expect(await mastheadGeometry(page)).toEqual(fetchingGeometry);
    await expect(page.locator('#totalPnL')).toHaveText('—');
    await expect(page.locator('#totalPnLChange')).toHaveText('Fills failed to load');
    const storage = await page.evaluate(() => ({
      lastAddress: localStorage.getItem('lastAddress'),
      snapshot: localStorage.getItem(window.PortfolioCache.KEY),
    }));
    expect(storage.lastAddress, 'the load must have completed').toBe(ADDRESS);
    expect(storage.snapshot).toBeNull();
  });

  test('an evicted cache snapshot reads CACHED · PARTIAL until fresh data arrives, without reflow', async ({ page }) => {
    let releaseIndexer;
    const indexerReleased = new Promise(resolve => { releaseIndexer = resolve; });
    await page.route(INDEXER_URL, async (route) => {
      await indexerReleased;
      return serveFixture(route);
    });

    await page.goto('/');
    await page.evaluate(({ address, fixture, evicted }) => {
      const data = {
        subaccount: fixture.subaccount,
        addressSubaccounts: fixture.addressSubaccounts,
        openPositions: fixture.openPositions,
        markets: fixture.markets,
        closedPositions: fixture.closedPositions,
        historicalPnl: fixture.historicalPnl,
        _cacheMeta: { evicted: true, evictedSteps: evicted },
      };
      const packed = { v: window.PortfolioCache.SCHEMA_VERSION, address, fetchedAt: Date.now(), data };
      localStorage.setItem(window.PortfolioCache.KEY, LZString.compressToUTF16(JSON.stringify(packed)));
    }, { address: ADDRESS, fixture, evicted: EVICTED_FIELDS });

    await page.goto(`/?address=${ADDRESS}`);

    const badge = page.locator('#statusBadge');
    await expect(badge).toHaveText('CACHED · PARTIAL');
    await expect(page.locator('#fetchCaption')).toHaveClass(/active/);
    const title = await badge.getAttribute('title');
    for (const field of EVICTED_FIELDS) expect(title).toContain(field);
    await expect(page.locator('#totalPnL')).toHaveText('—');
    await expect(page.locator('#totalPnLChange')).toHaveText('Fills not in cached snapshot');
    const cachedGeometry = await mastheadGeometry(page);

    releaseIndexer();

    await expect(badge).toHaveText('FRESH');
    expect(await badge.getAttribute('title')).not.toContain('cached snapshot');
    await expect(page.locator('#totalPnLChange')).toHaveText('All Time');
    expect(await mastheadGeometry(page)).toEqual(cachedGeometry);
  });
});
