# dydx.review

**Trading Performance Review**: independent, read-only trading performance analytics for dYdX v4 addresses.

Live at <https://dydx.review>.

Enter a dYdX v4 address and the page builds a review of its trading from public chain data:

- **Overview**: a profit ledger split into trading, funding and fees, with win rate, profit factor, payoff and the cumulative profit curve.
- **Performance**: monthly and per-market breakdowns, time-weighted returns, Sharpe, Sortino and Calmar.
- **Risk Analysis**: drawdowns and drawdown periods, leverage, cross-margin liquidation prices, value at risk and expected shortfall.
- **Behavior**: hold times, entry timing and trading patterns such as doubling down after a loss.
- **Positions**: every closed position with its size, entry and exit prices, profit and funding, rebuilt from fills.
- **Market Structure**: funding rates and the funding the account paid and received.
- **Tax**: a per-year realized profit report for Portugal, converted to EUR at ECB reference rates, exportable as CSV and JSON.

The review covers subaccount 0 of the address; positions held in isolated-margin child subaccounts are not included.

## Independence

dydx.review is independent, third-party trading performance analytics for dYdX v4 traders. It is not affiliated with, endorsed by, sponsored by, or operated by dYdX Trading Inc., dYdX Operations Services Ltd., the dYdX Foundation, or dydx.trade. The official dYdX sites are [dydx.xyz](https://dydx.xyz) and [dydx.trade](https://dydx.trade). "dYdX" and related marks are property of their respective owners and appear here for purposes of accurate description only.

The site is strictly read-only: it never holds private keys, never custodies funds, never signs transactions and never routes orders.

Nothing on the site or in this repository is investment, financial, legal, trading or tax advice. The Tax tab's classification is a starting point to confirm with an accountant.

## How it works

dydx.review is a static page with no backend. The visitor's browser reads the account's history directly from the public dYdX v4 indexer (`https://indexer.dydx.trade/v4`) and computes every figure locally; the Tax tab additionally fetches ECB EUR/USD reference rates from the Frankfurter API (`https://api.frankfurter.dev`). Charting libraries load from jsDelivr, pinned by version and Subresource Integrity hash. The page runs no analytics or tracking scripts. The last loaded address, a snapshot of its data and fetched FX rates are kept in the browser's `localStorage`, and the Forget button clears the address and its snapshot. The files are served by Cloudflare as static assets.

## Running locally

Requires Node.js 22 and Python 3.

```sh
npm ci            # install the pinned dev dependencies (Playwright, Wrangler)
npm start         # serve the repository at http://127.0.0.1:8000
```

Then open <http://127.0.0.1:8000/?address=YOUR_DYDX_ADDRESS>.

## Tests

```sh
npm test                              # unit and panel suites (node --test test/*.test.js)
npx playwright install chromium       # once, for the end-to-end suite
npm run test:e2e                      # Playwright specs against synthetic fixtures
```

The end-to-end suite starts its own server through `test/static-server.py` on port 8123; set `E2E_PORT` to use another port.

## Documentation

- [`ARCHITECTURE.md`](ARCHITECTURE.md): how the system is built: module layout, indexer access, the load cycle, browser storage, deployment and the test architecture.
- [`CLAUDE.md`](CLAUDE.md), section "Metric Definitions": the metric-definition document. Despite its name, it is the single source of truth for every formula on the site (profit attribution, drawdowns, returns and ratios, funding, liquidation prices, the tax report), and the code and tests are kept in step with it.

## License

[MIT](LICENSE) © al-Kindi LDA
