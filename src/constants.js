// Centralized constants. Loaded before every other script (risk-metrics.js
// included), so any module may read window.AppConstants at load time.

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

  const MS_PER_SEC         = 1000;
  const SECONDS_PER_MINUTE = 60;
  const MINUTES_PER_HOUR   = 60;
  const HOURS_PER_DAY      = 24;
  const DAYS_PER_WEEK      = 7;
  const MONTHS_PER_YEAR    = 12;
  const MS_PER_MIN  = SECONDS_PER_MINUTE * MS_PER_SEC;
  const MS_PER_HOUR = MINUTES_PER_HOUR * MS_PER_MIN;
  const MS_PER_DAY  = HOURS_PER_DAY * MS_PER_HOUR;
  // Julian year, the convention the return, Sharpe and trade-based
  // annualizations use.
  const DAYS_PER_YEAR = 365.25;
  const MS_PER_YEAR = DAYS_PER_YEAR * MS_PER_DAY;

  // Funding APR deliberately annualizes over a simple 365-day year
  // (8760 h), the convention the CURRENT/PREDICTED (APR) column tooltips
  // describe.
  const DAYS_PER_FUNDING_YEAR = 365;
  const HOURS_PER_YEAR     = DAYS_PER_FUNDING_YEAR * HOURS_PER_DAY;
  // Fraction → percent.
  const PERCENT            = 100;
  const CLIPBOARD_FLASH_MS = 1500;

  // Enough significant digits for any exchange step size while dropping
  // the float noise that summing fill sizes leaves (0.30000000000000004).
  const SIZE_SIGNIFICANT_DIGITS = 12;

  // A double holds about 17 significant digits, and the arithmetic that
  // made a value leaves binary noise in the last of them (1.005 is stored
  // as 1.00499999999999989…, 3/2000 × 100 as 0.1499…). At this many
  // significant digits the noise is gone and the decimal remains: the
  // display core's rounding (Format) and RiskMetrics' test of returns
  // that are all alike read values at it.
  const NOISE_FREE_SIGNIFICANT_DIGITS = 15;

  // Dollar amounts the profit ledger shows and sums: whole cents.
  const CENT_DIGITS = 2;
  const CENTS_PER_DOLLAR = Math.pow(10, CENT_DIGITS);

  const TUNABLES = Object.freeze({
    TOP_MARKETS: 5,
    RECENT_DECISIVE_CAP: 50,
    RECENT_POSITIONS_CAP: 50,
    HOUR_MIN_SAMPLE: 5,
    DOUBLE_DOWN_GAP_HOURS: 1,
    DOUBLE_DOWN_SIZE_MULT: 1.2,
    LONG_HOLD_HOURS: 4,
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
    MS_PER_SEC, MS_PER_MIN, MS_PER_HOUR, MS_PER_DAY, MS_PER_YEAR,
    MINUTES_PER_HOUR, HOURS_PER_DAY, DAYS_PER_WEEK, MONTHS_PER_YEAR,
    HOURS_PER_YEAR,
    PERCENT,
    CLIPBOARD_FLASH_MS,
    SIZE_SIGNIFICANT_DIGITS, NOISE_FREE_SIGNIFICANT_DIGITS,
    CENT_DIGITS, CENTS_PER_DOLLAR,
    TUNABLES
  };
})();
