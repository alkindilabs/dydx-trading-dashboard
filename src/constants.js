// Centralized constants. Loaded before any inline script consumer.
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

  const MS_PER_MIN  = 60_000;
  const MS_PER_HOUR = 3_600_000;
  const MS_PER_DAY  = 86_400_000;

  const HOURS_PER_YEAR     = 8760;
  const CLIPBOARD_FLASH_MS = 1500;

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
    MS_PER_MIN, MS_PER_HOUR, MS_PER_DAY,
    HOURS_PER_YEAR,
    CLIPBOARD_FLASH_MS,
    TUNABLES
  };
})();
