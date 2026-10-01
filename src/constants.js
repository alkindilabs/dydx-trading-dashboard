// Centralized constants. Loaded before every other script (risk-metrics.js
// included), so any module may read window.AppConstants at load time.
// Per CLAUDE.md "No magic numbers; use named constants."

(function () {
  'use strict';

  // Bech32 dydx HRP + separator + 38-58 data chars (32 program + 6 checksum;
  // module-account variants run longer).
  const ADDRESS_RE = /^dydx1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{38,58}$/;

  const FETCH_TIMEOUT_MS = 30000;

  // Page sizes for /historical-pnl, /perpetualPositions, /fills,
  // /fundingPayments. No artificial page-count cap — pagination loops
  // walk to inception via natural termination (empty/short page,
  // dedup-cycle detection). Rate-limit handling lives in
  // fetchJsonWithRetry, not here.
  const HIST_PAGE_LIMIT    = 1000;
  const POS_PAGE_LIMIT     = 100;   // indexer-side cap
  const FILLS_PAGE_LIMIT   = 1000;
  const FUNDING_PAGE_LIMIT = 1000;
  // Indexer caps /historicalFunding at 100 rows/page and /candles at 100.
  const HISTORICAL_FUNDING_PAGE_LIMIT = 100;
  const CANDLES_PAGE_LIMIT            = 100;
  // Default page cap for /candles walks. At CANDLES_PAGE_LIMIT hourly
  // candles per page it reaches well past FUNDING_CHART_MAX_DAYS.
  const CANDLES_MAX_PAGES             = 50;
  // Funding chart cap. 90 days at 1HOUR resolution = 2160 datapoints per
  // dataset — Chart.js renders that comfortably and avoids unbounded
  // fetches against the indexer.
  const FUNDING_CHART_MAX_DAYS = 90;

  const MS_PER_MIN  = 60_000;
  const MS_PER_HOUR = 3_600_000;
  const MS_PER_DAY  = 86_400_000;
  // Julian year, the convention every annualization in the dashboard uses.
  const DAYS_PER_YEAR = 365.25;
  const MS_PER_YEAR = DAYS_PER_YEAR * MS_PER_DAY;

  const HOURS_PER_YEAR     = 8760;
  // Fraction → percent.
  const PERCENT            = 100;
  const CLIPBOARD_FLASH_MS = 1500;

  // Enough significant digits for any exchange step size while dropping
  // the float noise that summing fill sizes leaves (0.30000000000000004).
  const SIZE_SIGNIFICANT_DIGITS = 12;

  const TUNABLES = Object.freeze({
    TOP_MARKETS: 5,
    RECENT_DECISIVE_CAP: 50,
    RECENT_POSITIONS_CAP: 50,
    HOUR_MIN_SAMPLE: 3,
    DOUBLE_DOWN_GAP_HOURS: 1,
    DOUBLE_DOWN_SIZE_MULT: 1.2,
    TREND_HOLD_HOURS: 4,
    FLIP_HOLD_HOURS: 0.25,
    ASSET_SHARPE_MIN_N: 5,
    PATTERN_MIN_N: 10,
    ALWAYS_SHOW_TICKERS: ['BTC-USD', 'ETH-USD', 'SOL-USD']
  });

  window.AppConstants = {
    ADDRESS_RE,
    FETCH_TIMEOUT_MS,
    HIST_PAGE_LIMIT, POS_PAGE_LIMIT, FILLS_PAGE_LIMIT, FUNDING_PAGE_LIMIT,
    HISTORICAL_FUNDING_PAGE_LIMIT, CANDLES_PAGE_LIMIT, CANDLES_MAX_PAGES, FUNDING_CHART_MAX_DAYS,
    MS_PER_MIN, MS_PER_HOUR, MS_PER_DAY, MS_PER_YEAR,
    HOURS_PER_YEAR,
    PERCENT,
    CLIPBOARD_FLASH_MS,
    SIZE_SIGNIFICANT_DIGITS,
    TUNABLES
  };
})();
