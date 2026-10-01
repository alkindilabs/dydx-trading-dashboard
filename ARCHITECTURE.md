# Architecture

The architectural decisions currently in effect for the dYdX trading dashboard, by subsystem. What each metric means and how it is computed is defined in `CLAUDE.md`.

## System shape

A static single-page application with no backend. The browser loads `index.html` and its scripts from Cloudflare's edge, then talks directly to two public HTTP APIs that need no credentials:

- the dYdX v4 indexer (`DydxApi.BASE` in `src/dydx-api.js`) for every account and market figure;
- Frankfurter (`BASE` in `fx-rates.js`), an ECB reference-rate service, for USD → EUR rates on the Tax tab.

There is no server-side state or cache. Each visitor's browser walks the indexer itself, back to the account's inception, on every load, and everything that persists lives in that browser's `localStorage` (see Browser storage). Indexer response shapes and defects are therefore handled in the client.

**One account, subaccount 0.** The dashboard analyses one dYdX address at a time, and only its subaccount 0. dYdX keeps isolated-margin positions in child subaccounts (128 and above by convention), each with its own fills and P&L, and nothing computed from subaccount 0 can see them. Every load fetches `/addresses/{address}`, which lists every subaccount; `RiskMetrics.activeChildSubaccounts` returns the children holding equity, open positions or asset balances. When any exist, `processData()` logs a `console.warn` naming them, and the reconciliation guard's error payload lists them as a likely cause of a gap. Nothing on screen marks the headline as partial: the blind spot is surfaced to the operator, not the user.

## Page and module layout

There is no bundler, transpiler or module system: the repository's files are the files served. `index.html` holds the markup, classic `<script>` tags and one inline application script. Every other script is an IIFE that publishes one namespace on `window` and reaches its dependencies through `window`:

| Namespace | File | Role |
|---|---|---|
| `AppConstants` | `src/constants.js` | named constants and tunables |
| `RiskMetrics` | `risk-metrics.js` | every metric definition, the FIFO fill walks, per-position attribution |
| `PortfolioCache` | `portfolio-cache.js` | last-address snapshot in `localStorage` |
| `FxRates` | `fx-rates.js` | ECB USD → EUR rates: network and `localStorage` |
| `TaxReport` | `tax-report.js` | tax-year rows, totals, CSV / JSON |
| `Format` | `src/format.js` | display formatting |
| `AppCharts.*` | files under `src/charts/` | Chart.js renderers |
| `AppDom` | `src/dom.js` | DOM write helpers |
| `AppPanels.*` | files under `src/panels/` | one per tab: wiring and DOM |
| `DydxApi` | `src/dydx-api.js` | indexer client |

**Load order is the dependency mechanism.** The `<script>` order in `index.html` is a constraint, not a convention:

1. In `<head>`, the CDN libraries: Chart.js, its date adapter and financial plugin, and LZString, each pinned to an exact version with a Subresource Integrity hash.
2. `src/constants.js` first among the local scripts, because modules read `AppConstants` while loading: `risk-metrics.js` destructures `PERCENT` and its time units, `fx-rates.js` derives its settled-date threshold from `MS_PER_DAY`, `src/panels/overview.js` destructures `PERCENT`, and `src/panels/market.js` derives its chart-cache freshness from `MS_PER_MIN`.
3. `risk-metrics.js`, `portfolio-cache.js`, `fx-rates.js`, `tax-report.js` (it resolves `RiskMetrics` at call time, so its position relative to `risk-metrics.js` is not a load-time constraint), `src/format.js`, the charts, `src/dom.js`, the panels, then `src/dydx-api.js`.
4. The inline application script last: it destructures `DydxApi`, `AppConstants`, `Format` and `AppDom` as it starts.

Apart from those `AppConstants` reads, charts and panels read other namespaces only when called, which is why their order among themselves is free and why `src/dydx-api.js` can follow the panels that call it.

**Layers.** `RiskMetrics`, `TaxReport` and `Format` touch neither the DOM nor the network, which is what lets the unit tests run them in Node. Panels and charts render. The inline script owns application state and orchestration: address handling, the load cycle, the fetch-progress and freshness controllers (`FetchProgress`, `DataFreshness`) and `processData()`.

**Trade-off.** Nothing checks the globals or the load order: a module that reads a namespace while loading breaks if it is moved ahead of that namespace's script. In return the site deploys with no build step, and the same files run unmodified in Node once `window` is aliased to `globalThis`.

## Indexer access

`src/dydx-api.js` owns the indexer base URL, retries and pagination. The inline script builds the single-request URLs from `DydxApi.BASE` and calls the module's walkers for the rest.

**Endpoints.** Each load requests these concurrently, all for subaccount 0:

- single requests: `/addresses/{address}/subaccountNumber/0` (equity), `/addresses/{address}` (every subaccount, for the isolated-margin guard), `/perpetualPositions` with `status=OPEN`, `/perpetualMarkets` (oracle prices, margin fractions). Nothing the dashboard shows reads orders, so `/orders` is not requested. The OPEN list is a single page (`limit=100`) on the assumption that a subaccount never holds more open positions than that;
- walked to inception: `/perpetualPositions` with `status=CLOSED` and `/historical-pnl` in cursor mode, `/fills` and `/fundingPayments` in page mode.

The Market tab's funding chart reads two more for the selected ticker, only while that tab is active: `/historicalFunding/{ticker}` (cursor mode on `effectiveAt`, bounded to `AppConstants.FUNDING_CHART_MAX_DAYS`) and `/candles/perpetualMarkets/{ticker}` (`DydxApi.fetchCandles`, its own loop walking back with `toISO`).

**Retries.** Every request, whether a single endpoint or one page of a walk, goes through `DydxApi.fetchJsonWithRetry`: a per-attempt timeout (`AppConstants.FETCH_TIMEOUT_MS`), then retries of transient failures only (timeout, HTTP 429, 5xx, network error) with exponential backoff and full jitter (the `RETRY_*` constants in `src/dydx-api.js`), waiting for `Retry-After` instead when the server sends one. Any other HTTP error fails at once. A walk retries the failing page; it never restarts from page 1.

**Retry logs carry no address.** The request URL holds the account address, so the per-retry `console.debug` line names the endpoint by the caller's `label` (`dydx-api` when there is none) and describes the error without its message: `HTTP <status>`, `timeout after <ms>ms`, `network error`, or the error's name. The rule covers the retry line only: the `console.warn` logged when a page or endpoint finally fails prints the error's message, which still names the URL.

**Pagination modes.** `fetchAllPaginated`, private to `src/dydx-api.js`, walks a collection in one of two modes:

- cursor mode passes the oldest timestamp seen so far as the next request's upper bound (`createdBeforeOrAt`, or `effectiveBeforeOrAt` on `/historicalFunding`, which ignores the former). Rows are deduplicated by a per-endpoint key, so the overlap at the cursor boundary is harmless. The walk ends on an empty page, a page with no new rows, or a cursor that cannot advance;
- page mode requests `page=1, 2, …` and ends on an empty page, a page with no new rows, or right after a short one.

A `maxPages` cap (the funding chart's window) stops a walk by design and resolves normally.

**Why `/fills` uses page mode.** In page mode the indexer orders fills by `eventId` ascending (block height, transaction index, event index): exact chain order, oldest first, including the order of fills inside one block, which the FIFO walks depend on (see Per-position attribution). Cursor mode orders only by block height and leaves a block's fills in arbitrary order, so `/fills` never uses it. New fills append, so earlier pages never shift during a walk. A fill's `id` is a hash of its event id: usable for deduplication, meaningless for order. `/fundingPayments` is also walked in page mode, the indexer's pagination for that endpoint.

**Page-mode offset cap.** The dYdX indexer source caps the page-mode offset (`MAX_PAGINATION_OFFSET`, 25,000 by default). Where an indexer enforces it, an account with more than about 26,000 fills, or as many funding payments, gets a failed endpoint (the rejected page fails the walk, below) rather than wrong numbers. No fallback exists.

**A lost page fails the endpoint.** A walk rejects when any page still fails after its retries, not only the first. Resolving with the rows read so far would hand every consumer a truncated history that looks complete; rejecting turns it into a failed endpoint, which the load cycle reports and never caches. `fetchCandles` applies the same rule, so the funding chart never draws a price line over part of its window. Its page cap defaults to `AppConstants.CANDLES_MAX_PAGES` when the caller passes none.

**Funding chart.** `src/panels/market.js` fetches a ticker's funding history and candles with `Promise.allSettled`. Funding is the chart's subject: if it fails, the chart shows "Fetch failed". Candles are an overlay: if they fail, the funding bars draw without a price line, a `console.warn` is logged, and the chart's cache entry records `candlesMissing`, which every draw from that entry states in a caption (`#fundingChartStatus`). Whether the price axis and the "Close price" legend entry show is decided by the chart module (`src/charts/funding-rate-chart.js`) from the line it actually draws, not from `candlesMissing`: with no price points in the window, whether the candles failed or loaded empty, both are hidden. Every draw from the chart cache goes through one function, `presentChartFromCache`, which sets the caption from the entry it draws, so a chart and its caption cannot disagree; clearing the chart clears its caption. The chart cache is in memory, per ticker, fresh for `CHART_FRESH_TTL_MS`, and dropped on every dashboard refresh. `DydxApi` takes no abort signal, so a superseded chart request is not cancelled; a per-request token discards a result that arrives for a ticker no longer selected.

## Load cycle and application state

**Where state lives.**

- `allData` (inline script): the raw indexer responses for the loaded address, keyed by endpoint (`subaccount`, `addressSubaccounts`, `openPositions`, `markets`, `closedPositions`, `fills`, `fundingPayments`, `historicalPnl`), with `null` for an endpoint that failed. It is never pre-initialised with placeholder data.
- `allData.positions`: derived, the merged OPEN and CLOSED positions carrying their fill attribution. `processData()` rebuilds it on every render and it is never persisted.
- `currentAddress`: the loaded address.
- The page URL's `?address=` parameter, the shareable source of the address; `lastAddress` in `localStorage` is the fallback.
- Panel-local state inside each panel module (the Tax panel's last report, the funding chart's cache).

**Address.** `?address=` wins, else `lastAddress`. The address is lower-cased and checked against `AppConstants.ADDRESS_RE` before any network call; an invalid one shows the error banner and nothing is fetched. Loading another address, or Forget, navigates (rewrites `?address=` and reloads), so one page lifetime serves one address. `lastAddress` is written only after a load in which at least one endpoint succeeded, so a typo never replaces a known-good address. Forget clears `lastAddress` and the portfolio cache.

**`loadDashboard()`** runs one stale-while-revalidate cycle:

1. Hydrate: unless called with `skipCache`, read the cached snapshot for the address and render it before any network call, setting the freshness clock from the snapshot's `fetchedAt` and the badge's eviction state. A snapshot that throws while rendering is cleared and dropped without showing the banner, so a poisoned cache never blocks the fetch that follows.
2. Fetch every endpoint concurrently under `Promise.allSettled`, reporting each settlement to `FetchProgress`.
3. If every endpoint failed: show the banner (noting the cached snapshot when one is on screen), set the badge to OFFLINE and leave `allData` and the screen as they were.
4. Otherwise replace `allData` wholesale with the fresh map. A failed endpoint is `null` in it; values are never carried over from the cached snapshot, so a partial refresh deliberately replaces a complete cached screen with one that reads `—` where inputs are missing. Render; set the badge; mark the freshness clock; write `lastAddress`; write the cache snapshot only if every endpoint succeeded.

**Refresh.** `refreshDashboard()` wraps `loadDashboard()` with a re-entrance guard (a refresh requested while one is in flight is dropped) and drops the funding chart's cache first. After the first load, a poll every `REFRESH_POLL_MS`, and a return to a visible browser tab, refresh when the page is visible and `DataFreshness.isStale()` reports the data older than its private `REFRESH_INTERVAL_MS` (the same constant states the interval in the `#dataAge` tooltip). Auto-refresh passes `skipCache`, so it never repaints an older snapshot before the fresh one. There is no streaming connection: data is static between fetches.

**`processData()`** is the single render orchestrator. It never mutates the raw response objects: each position it renders is a shallow copy `{ ...raw, ...attribution }`, so `allData`, and the snapshot written from it, hold exactly what the indexer returned. It computes every shared result once per render (the merged positions and their attribution, the classifier result, per-market profit, the drawdown source, the gap reasons below) and passes them to the panels, so no two cards derive the same figure two ways. Work behind a third-party or extra indexer request runs only when its tab is active: the Tax tab's FX fetch and the Market tab's funding chart.

**OPEN / CLOSED merge.** The OPEN and CLOSED lists are fetched concurrently, so a position can come back in both. `mergeOpenAndClosed(openList, closedList, fills)` in `index.html` keys rows by `market` + `side` + `createdAtHeight`, falling back to `createdAt`. `side` is in the key because a position opened and reversed within one block shares its height with the position the reversal opens, while a stale copy of a position never changes side. A position opened, closed and reopened on the same side within one block shares its predecessor's key too, so on a collision the OPEN row stays only while `RiskMetrics.isOpenInFills(position, fills)` holds: the market's last fill segment is still open, on the position's side, and started at the position's `createdAt`. Otherwise the CLOSED copy wins. The rule trusts `/fills` to be at least as fresh as the position lists: fills read before a close that the CLOSED list already shows keep the stale OPEN copy as a duplicate. The merge returns `{ positions, hasCollision }`.

`openPositionsGap` is the one statement of whether the OPEN rows are known: the OPEN list's own gap reason, or, when a collision exists and fills are unavailable (so the collision cannot be resolved and a reopened OPEN row may be missing), the fills' gap reason. The profit ledger's FUNDING and open-position gate, the Overview chart's open count, Performance by Asset, the Positions board's Active Positions card and the Risk tab read it rather than the OPEN list's own reason. The Tax tab's gap is the exception: it reads the OPEN list's own reason after the fills and CLOSED reasons, which covers the same cases because missing fills already blank the Tax tab.

## Per-position attribution

**Fills are the single source of per-position values.** Every per-position number the dashboard shows (profit, size, entry and exit price, return) comes from `/fills`, not from the `/perpetualPositions` row, which is wrong in known ways: `realizedPnl` undercounts scaled positions and is sometimes 0; `maxSize` on a SHORT is the least-negative signed size (what was left before the last closing fill), not the peak; and a reversal in one order comes back as two rows that split the reversing fill's quantity wrongly.

**One attribution function, two runs per render.** `processData()` runs `RiskMetrics.attributeFillsToPositions(positions, fills)` over the merged OPEN and CLOSED list and every fill, and merges each position's result onto its shallow copy. The classifier, drawdown fallback, per-trade return and the Performance, Behavior and Positions panels read the attribution's fields (`profit`, `peakSize`, `entryVwap`, `exitVwap`, `complete`, `incompleteCause`, the flip flags), never `realizedPnl` or `maxSize`. The Tax panel passes those same positions and fills to `TaxReport.buildYearReport`, which runs `attributeFillsToPositions` again over them; the function is deterministic, so its rows hold the same figures the other panels show. One indexer-field reader remains, off every production path: `marketPnL`'s `realizedPnl` / `unrealizedPnl` fallbacks, which production never takes because it always passes the FIFO maps.

**Completeness is part of the contract.** The attribution says, per position, whether its numbers can be trusted (`complete` / `incompleteCause`, defined in `CLAUDE.md`). A consumer shows `—` for an incomplete position's values, never the partial segment values the attribution may still carry; aggregates over positions are all-or-nothing, so one incomplete position blanks them rather than producing a sum over the rest.

**Fill order.** Every FIFO walk (`computeRealizedFromFills`, `computeUnrealizedFromFills`, `attributeFillsToPositions`, `isOpenInFills`) sorts a market's fills with one private comparator, `compareFillsChronologically`: `createdAt`, then `createdAtHeight` (equivalent on real rows, since block times never decrease; `createdAt` first keeps a fill missing its height in place). `isOpenInFills` walks the same timestamped fills `attributeFillsToPositions` does. The sort is stable, so fills inside one block keep their input order, which is chain order only because `/fills` is fetched in page mode (see Indexer access). The fill `id` plays no part in ordering. The same assumption holds for cached fills: a portfolio-cache snapshot is version-checked (see Browser storage), and the fill order it holds must be the order this walk assumes.

## Missing inputs

A figure whose inputs did not load renders `—` with a reason; it never treats missing data as empty. "Did not load" has one definition, `missingDataReason(data, key, label)` in `index.html`: the endpoint failed (`allData[key] == null`, reason "<label> failed to load"), or the cache evicted that field from the snapshot on screen (`PortfolioCache.evictionOf`, reason "<label> not in cached snapshot"). `processData()` derives the per-input reasons once (`inputGaps(allData)`: fills, open, closed), derives `openPositionsGap` and the per-metric gaps from them, and passes those reasons to the panels, so every card blanked by the same missing input shows the same reason. Which inputs each metric needs is defined with the metric in `CLAUDE.md`.

## Browser storage

All persistence is per browser, in `localStorage`. Every module reaches storage inside `try`/`catch` and treats it as optional: with storage disabled or full, the dashboard works without persistence.

| Key | Owner | Holds |
|---|---|---|
| `lastAddress` | inline script | last address that loaded |
| `dydxCache:v1` | `PortfolioCache` | snapshot of the last address's raw responses |
| `fxRates:v1:USD-EUR` | `FxRates` | USD → EUR rates by date |
| `activeTab` | inline script | tab to restore |
| `fundingWindow` | `src/panels/market.js` | funding window selection |
| `taxSelectedYear`, `taxClassification` | `src/panels/tax.js` | Tax tab selections |

**Portfolio cache (`portfolio-cache.js`).** One slot, keyed `dydxCache:v1`, holding a single address; loading a different address overwrites it. The `v1` is part of the key's name and does not track the schema.

- Envelope: `{ v: SCHEMA_VERSION, address, fetchedAt, data }`, `data` being the raw response map under the endpoint keys of `allData`, compressed with `LZString.compressToUTF16`. Derived fields such as `allData.positions` are not stored; `processData()` rebuilds them on hydrate.
- A snapshot whose `v` differs from `SCHEMA_VERSION`, or whose address differs, reads as a miss; one that fails to decompress or parse is removed. A snapshot read as current holds every cached field in the shape and row order the current code expects, including `/fills` in the chain order the FIFO walks assume.
- Persistence rule: the snapshot is written only when every endpoint of a refresh succeeded, so a partial fetch never replaces a complete snapshot with a degraded one. A walk that lost a page counts as a failed endpoint, so a truncated history is never cached as complete.
- Eviction: on a quota error the write retries after each step of `EVICTION_ORDER`, largest payloads first: drop `fills`, drop `fundingPayments`, trim `historicalPnl` to its last `HISTORICAL_PNL_TRIM` rows, drop `closedPositions`. If it still does not fit, the write is skipped. An evicted snapshot carries `data._cacheMeta = { evicted: true, evictedSteps }`; `PortfolioCache.evictionOf(data)` turns that into `{ dropped, trimmed }` (or `null` for a complete snapshot), which feeds both the missing-input reasons and the CACHED · PARTIAL badge.
- LZString comes from the CDN; if it did not load, `PortfolioCache` no-ops and the dashboard behaves as if no cache existed.

**FX cache (`fx-rates.js`).** `fxRates:v1:USD-EUR` maps ISO dates to rates with no expiry, since historical reference rates never change, and it is independent of the portfolio cache so Forget keeps rates gathered across years. Rates are stored under Frankfurter's response date, and under the requested date too when that date is settled (more than two days old) or was served as itself; a recent date answered with an earlier business day's provisional rate is not pinned. Writes go through `mergeAndWriteCache`, which re-reads the latest stored map before persisting, so concurrent `getRates()` calls do not overwrite each other's additions. The Tax tab's "Clear FX cache" button wipes the whole slot, and its tooltip says so.

## Status badge

The masthead badge is a snapshot-freshness indicator, not a streaming signal. `FetchProgress` in `index.html` sets it:

- **FETCHING**: a fetch is in flight (gold pulse, faster cadence);
- **FRESH**: the last fetch returned every endpoint;
- **FRESH · PARTIAL**: the fetch completed with some endpoints failed, and the dashboard renders with those inputs missing. Warn-tinted like CACHED · PARTIAL (not the green FRESH style), with a tooltip naming the failed endpoints (`FetchProgress.end('partial', failed)`);
- **OFFLINE**: every endpoint failed, or the fresh data failed to render;
- **CACHED · PARTIAL**: the data on screen is a cached snapshot from which the cache evicted fields; the tooltip names the dropped and trimmed fields. This state describes the data, not the fetch, so it holds through FETCHING and through a refresh in which every endpoint fails (the tooltip adds "Latest refresh failed."). It clears only when `loadDashboard()` swaps fresh data into `allData`, or a hydrate paints a complete snapshot.

The pulsing dot is decorative. The markup ships the badge reading FRESH, before any load; `#dataAge` ("Updated … ago", from `DataFreshness`) appears only once a load has rendered.

**Masthead geometry.** The error banner (`#loadErrorBanner`) is a row of its own below the masthead, outside the right rail, so showing it pushes the page content down but never resizes the masthead. The badge has a fixed width in `src/styles.css`, sized for "CACHED · PARTIAL" plus font-fallback slack, so changing state never reflows the masthead: right-rail width, left-column width and masthead height are identical in every state, at desktop and phone widths. The width must stay a fixed length: the right rail sizes itself from its children's intrinsic widths, where a percentage floor such as `min(10rem, 100%)` counts as zero and lets each state's text shift the breadcrumb column.

## Tax report and FX

`tax-report.js` (`TaxReport`) is pure: positions, fills and a year in; rows, totals and CSV / JSON out. `src/panels/tax.js` gathers inputs, calls it and renders. The report takes its per-position figures from the same fill attribution as the rest of the dashboard and applies the same completeness rule, and its missing-input reason comes from `processData()` like every panel's (`CLAUDE.md`, Tax report, gives both in detail).

**FX.** Rates come from Frankfurter: one range request covering every close date still missing from the cache, then single-date requests (at most four in parallel) for dates the range did not cover: weekends, holidays, and recent dates whose rate is not yet published. `FxRates` never throws: a failure surfaces as dates missing from its result, which the report renders as missing rates. Every request has an `AbortController` timeout (`REQUEST_TIMEOUT_MS`) held through the body read, so a stalled provider cannot leave the tab on "Fetching ECB rates…". When the range request itself fails, the single-date fallback is skipped, so an outage is not multiplied into one request per date. The panel calls `FxRates.getRates` only while the Tax tab is active, on render or on switching to the tab, so a visitor who never opens it makes no third-party request; a render counter discards an FX result that arrives after a newer render.

## Deployment

The site is a Cloudflare Worker with static assets only and no Worker script (`wrangler.jsonc`). The asset directory is the repository root, so a file is public unless `.assetsignore` excludes it; that file keeps tests, tooling and its configuration (`package.json`, the lockfile, `.npmrc`), CI configuration, every Markdown file, PNG, JPEG and WebP images and `.DS_Store` off the edge. The Cloudflare account is pinned in `wrangler.jsonc`, which declares no route or custom domain: hostname binding is Cloudflare account configuration, outside this repository. `not_found_handling` serves `404.html`, which redirects to `/` keeping the query string and hash, so a deep link with `?address=` still loads the dashboard.

**Response headers.** `_headers` applies to every asset response: a Content-Security-Policy, `X-Frame-Options: DENY`, `nosniff`, a referrer policy and a permissions policy. The CSP's `connect-src` is the allow-list of origins the page may call and names the indexer and the FX provider. `script-src` admits the CDN host and `'unsafe-inline'`, which the inline application script and the inline redirect in `404.html` require. Only Cloudflare's edge applies `_headers`; `test/static-server.py` serves without it, so a policy that blocks an origin the code calls passes every browser spec. The unit suite's `test/csp.test.js` is therefore the only check of the policy before deploy.

**Pipeline.** `.github/workflows/deploy.yml` deploys on every push to `main` (and on manual dispatch) with `wrangler-action` and the `CLOUDFLARE_API_TOKEN` secret, after `npm ci` and `npm test` pass in the same job; a newer push cancels an in-flight deploy. The Playwright suite is not part of that gate: it runs in `.github/workflows/e2e.yml`, and the unit suite again in `.github/workflows/test.yml`, on every push and pull request. Every workflow runs on Node 22 with a read-only `contents` token and pins its actions by commit SHA.

**Supply chain.** The only npm dependencies are two devDependencies, `@playwright/test` and `wrangler`, pinned to exact versions in `package.json` (the page's CDN libraries are pinned separately, by version and Subresource Integrity hash). The workflows that install packages use `npm ci`, so the lockfile is the integrity manifest. `.npmrc` sets `ignore-scripts=true`, so no package's install-time lifecycle script runs, locally or in CI; scripts invoked by name (`npm test`, `npm run test:e2e`) still run. Nothing depends on an install script: wrangler's `workerd` and `esbuild` binaries arrive as optional platform packages, and the e2e workflow installs Playwright's browser with an explicit `npx playwright install` step. `.github/dependabot.yml` proposes npm and GitHub Actions updates weekly, holding each new version back for 7 days after publication (`cooldown`); the npm entry uses `versioning-strategy: increase`, so an update moves an exact pin to another exact pin rather than widening it into a range. Dependabot offers no prerelease filter; the repository relies on its default of not proposing a prerelease while the current version is a stable one.

## Test architecture

**Unit suites (`npm test`, Node's built-in runner).** The browser modules are loaded unmodified: a suite aliases `window` to `globalThis`, installs whatever the module reaches outside itself, `require`s the module files in page order (`src/constants.js` first where they read it) and reads the namespaces they publish. `test/setup.js` and `test/format-setup.js` do this for `RiskMetrics` and `Format`. Stubs stand in for the network and the browser: `fetch` for `DydxApi` and `FxRates`, `localStorage` and LZString for `PortfolioCache` and `FxRates`. The funding-chart suite tests only pure helpers: it loads the real `src/constants.js` and stubs Chart.js, `Format`, `AppDom`, `document` and `localStorage`, which its two modules use only when rendering or fetching, never while loading.

**Browser specs (`npm run test:e2e`, Playwright, Chromium).** `playwright.config.mjs` starts `test/static-server.py` to serve the repository root on its own port (`DEFAULT_E2E_PORT`; the `E2E_PORT` environment variable overrides it), and the base URL and readiness check derive from the same port. It is a threaded static server bound to 127.0.0.1 with a deep accept queue, because `python3 -m http.server` listens with a backlog of 5, which the parallel workers' page loads overflow, resetting connections. `npm start` (and its alias `npm run dev`) runs the same server on port 8000 for local use, so a running local server and the suite do not collide. The specs intercept every indexer request with `page.route`, so no spec reaches the real indexer. `test/indexer-fixture.mjs` maps indexer URLs to keys of a synthetic account (`test/fixtures/sample-trader.json`, or a spec's own account in the same shape), and its `indexerBody(key, data, url)` answers a page-mode `/fills` request the way the indexer does: fills in chain order (by `createdAtHeight`, listing order inside a block), sliced by `page` and `limit`. Every spec's account goes through it, so a fixture lists the fills of one block in chain order. The module also exports the page's own `AppConstants`, evaluated from `src/constants.js`, so a spec can build fixture timestamps from the units the page uses. The market-wide funding and candles endpoints answer empty unless a spec routes them itself.
