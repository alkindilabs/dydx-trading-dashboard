import { test, expect } from '@playwright/test';
import { ADDRESS, INDEXER_URL, fixture, fixtureKeyFor, serveFixture } from './indexer-fixture.mjs';

// End-to-end checks of what the page shows before it has a portfolio to
// show: a first visit with no address, and an address the indexer holds no
// account for. Also the Overview metrics grid's empty tracks. Only the
// indexer is faked.

const HTTP_NOT_FOUND = 404;
// A well-formed address the stub answers as the indexer answers an address
// with no dYdX v4 account.
const NO_ACCOUNT_ADDRESS = `dydx1${'z'.repeat(38)}`;

const IDLE_PROMPT = 'Enter a dYdX v4 address above to review its trading performance.';
const NO_ACCOUNT_NOTICE = 'No dYdX v4 account found for this address.';

const notFound = (route, msg) => route.fulfill({
  status: HTTP_NOT_FOUND,
  contentType: 'application/json',
  body: JSON.stringify({ errors: [{ msg }] }),
});

// The indexer's answers for an address without an account: the address and
// subaccount routes 404 with an error message, the list routes answer empty.
function serveNoAccount(route) {
  const url = route.request().url();
  switch (fixtureKeyFor(url)) {
    case 'addressSubaccounts':
      return notFound(route, `No subaccounts found for address ${NO_ACCOUNT_ADDRESS}`);
    case 'subaccount':
    case 'historicalPnl':
      return notFound(route, `No subaccount found with address ${NO_ACCOUNT_ADDRESS} and subaccountNumber 0`);
    case 'openPositions':
    case 'closedPositions':
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"positions":[]}' });
    case 'fills':
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"fills":[]}' });
    case 'fundingPayments':
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"fundingPayments":[]}' });
    default:
      return serveFixture(route);
  }
}

test.describe('first visit and no account', () => {
  test('with no address the page prompts for one, fetches nothing and claims no load', async ({ page }) => {
    const indexerRequests = [];
    await page.route(INDEXER_URL, (route) => {
      indexerRequests.push(route.request().url());
      return serveFixture(route);
    });

    await page.goto('/');

    await expect(page.locator('#addressNotice')).toHaveText(IDLE_PROMPT);
    await expect(page.locator('#addressNotice')).toBeVisible();
    await expect(page.locator('#statusBadge')).toBeHidden();
    await expect(page.locator('#totalPnLChange')).not.toContainText('Loading');
    await expect(page.locator('#addressDisplay')).toBeHidden();
    await expect(page.locator('#loadErrorBanner')).toBeHidden();
    expect(indexerRequests).toEqual([]);
  });

  test('an address loads with no prompt, the badge and the address shown', async ({ page }) => {
    await page.route(INDEXER_URL, serveFixture);

    await page.goto(`/?address=${ADDRESS}`);

    await expect(page.locator('#dataAge')).toBeVisible();
    await expect(page.locator('#statusBadge')).toHaveText('FRESH');
    await expect(page.locator('#statusBadge')).toBeVisible();
    await expect(page.locator('#addressDisplay')).toBeVisible();
    await expect(page.locator('#addressNotice')).toBeHidden();
  });

  test('an address with no dYdX v4 account says so, reports no endpoint failure and caches nothing', async ({ page }) => {
    await page.route(INDEXER_URL, serveNoAccount);

    await page.goto(`/?address=${NO_ACCOUNT_ADDRESS}`);

    await expect(page.locator('#addressNotice')).toHaveText(NO_ACCOUNT_NOTICE);
    await expect(page.locator('#addressNotice')).toBeVisible();
    await expect(page.locator('#loadErrorBanner')).toBeHidden();
    await expect(page.locator('#statusBadge')).toBeHidden();
    await expect(page.locator('#totalPnL')).not.toHaveText('$0.00');
    const storage = await page.evaluate(() => ({
      lastAddress: localStorage.getItem('lastAddress'),
      snapshot: localStorage.getItem(window.PortfolioCache.KEY),
    }));
    expect(storage).toEqual({ lastAddress: null, snapshot: null });
  });

  test('an empty track in a metrics grid is painted like a card, never in the hairline colour', async ({ page }) => {
    await page.route(INDEXER_URL, serveFixture);
    const widthsWithEmptyTrack = [];
    for (const width of [375, 768, 1280, 1440]) {
      await page.setViewportSize({ width, height: 1200 });
      await page.goto(`/?address=${ADDRESS}`);
      await expect(page.locator('#dataAge')).toBeVisible();
      await page.evaluate(() => Promise.all(document.getAnimations()
        .filter(a => a.effect && a.effect.getTiming().iterations !== Infinity)
        .map(a => a.finished)));
      await page.mouse.move(0, 0);

      const probe = await page.locator('#overview .metrics-grid').evaluate((grid) => {
        const cards = [...grid.children];
        const last = cards[cards.length - 1].getBoundingClientRect();
        const gridBox = grid.getBoundingClientRect();
        const emptyWidth = gridBox.right - last.right;
        const first = cards[1].getBoundingClientRect();
        const { scrollX, scrollY } = window;
        return {
          emptyTrack: emptyWidth > last.width / 2
            ? { x: scrollX + last.right + emptyWidth / 2, y: scrollY + last.top + last.height / 2 }
            : null,
          cardInside: { x: scrollX + first.left + 3, y: scrollY + first.top + 3 },
        };
      });
      if (!probe.emptyTrack) continue;
      widthsWithEmptyTrack.push(width);
      const pixel = ({ x, y }) => page.screenshot({ fullPage: true, clip: { x: Math.round(x), y: Math.round(y), width: 2, height: 2 } });
      const [empty, card] = [await pixel(probe.emptyTrack), await pixel(probe.cardInside)];
      expect(empty.equals(card), `empty track at ${width}px is not painted like a card`).toBe(true);
    }
    expect(widthsWithEmptyTrack.length, 'some width must leave the last row short').toBeGreaterThan(0);
  });
});
