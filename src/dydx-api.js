// dYdX v4 indexer client. Owns base URL, per-endpoint fetchers,
// exponential-backoff retry on transient failures, and pagination
// walking to inception.
//
// Depends on: window.AppConstants (FETCH_TIMEOUT_MS, HIST_PAGE_LIMIT,
// POS_PAGE_LIMIT, FILLS_PAGE_LIMIT, FUNDING_PAGE_LIMIT).

(function () {
  'use strict';

  const DYDX_API = 'https://indexer.dydx.trade/v4';

  // Retry-After can be "<seconds>" or an HTTP-date. Returns ms or null.
  function parseRetryAfter(header) {
    if (!header) return null;
    const seconds = parseFloat(header);
    if (!isNaN(seconds) && seconds >= 0) return seconds * 1000;
    const t = Date.parse(header);
    if (!isNaN(t)) return Math.max(0, t - Date.now());
    return null;
  }

  function isTransientError(e) {
    if (!e) return false;
    if (e.transient) return true; // timeout
    if (e.status === 429) return true;
    if (e.status >= 500 && e.status < 600) return true;
    // Network-level fetch failure (TypeError: Failed to fetch).
    if (e instanceof TypeError) return true;
    return false;
  }

  async function fetchJson(url, timeoutMs) {
    const C = window.AppConstants;
    const t = timeoutMs != null ? timeoutMs : C.FETCH_TIMEOUT_MS;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), t);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
        err.status = res.status;
        err.retryAfter = parseRetryAfter(res.headers.get('Retry-After'));
        throw err;
      }
      return await res.json();
    } catch (e) {
      if (e && e.name === 'AbortError') {
        const tErr = new Error(`Timeout (${t}ms) for ${url}`);
        tErr.transient = true;
        throw tErr;
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  // Exponential backoff with full jitter. Honors Retry-After on 429/503.
  // base ms 500, factor 2, max 16s, tries 6 (7 total fetch attempts).
  const RETRY_BASE_MS   = 500;
  const RETRY_FACTOR    = 2;
  const RETRY_MAX_DELAY = 16000;
  const RETRY_TRIES     = 6;

  async function fetchJsonWithRetry(url, opts = {}) {
    const tries = opts.tries != null ? opts.tries : RETRY_TRIES;
    let lastError = null;
    for (let attempt = 0; attempt <= tries; attempt++) {
      try {
        return await fetchJson(url);
      } catch (e) {
        lastError = e;
        if (!isTransientError(e) || attempt === tries) throw e;
        let delay;
        if (e.retryAfter != null) {
          delay = e.retryAfter;
        } else {
          const ceil = Math.min(
            RETRY_BASE_MS * Math.pow(RETRY_FACTOR, attempt),
            RETRY_MAX_DELAY
          );
          delay = Math.random() * ceil;
        }
        if (opts.onRetry) {
          try { opts.onRetry(attempt + 1, delay, e); } catch (_) {}
        }
        await new Promise(r => setTimeout(r, delay));
      }
    }
    throw lastError;
  }

  // Generic paginator over a dYdX indexer collection endpoint. Walks to
  // inception governed by natural termination signals (empty page, short
  // page in offset mode, dedup cycle, unadvancing cursor). No artificial
  // page cap.
  //
  // cursorField (cursor mode only): which row field carries the
  // chronological cursor value. Defaults to 'createdAt' (fills,
  // historical-pnl, closed positions). /historicalFunding rows use
  // 'effectiveAt' instead.
  //
  // cursorParam: the query-string key that carries the cursor value
  // on the next request. Defaults to 'createdBeforeOrAt' (the indexer
  // convention for /fills, /historical-pnl, /perpetualPositions).
  // /historicalFunding requires 'effectiveBeforeOrAt' — the
  // createdBeforeOrAt name is silently ignored on that endpoint, so
  // the paginator stalls after page 1. Both fields and the matching
  // param must move together.
  async function fetchAllPaginated(opts) {
    const {
      urlBase, joiner = '&', dataKeys, keyFn,
      pageLimit, label, mode = 'cursor',
      cursorField = 'createdAt',
      cursorParam = 'createdBeforeOrAt',
      onProgress = null,
      maxPages = null
    } = opts;
    let cursor = null;
    let pageNum = 1;
    const all = [];
    const seen = new Set();
    let firstPageError = null;
    for (let i = 0; ; i++) {
      if (maxPages != null && i >= maxPages) break;
      let extraParam = '';
      if (mode === 'cursor' && cursor) {
        extraParam = `&${cursorParam}=${encodeURIComponent(cursor)}`;
      } else if (mode === 'page') {
        extraParam = `&page=${pageNum}`;
      }
      const url = `${urlBase}${joiner}limit=${pageLimit}${extraParam}`;
      if (onProgress) {
        try { onProgress(label, i + 1); } catch (_) {}
      }
      let page;
      try {
        page = await fetchJsonWithRetry(url, {
          onRetry: (attempt, delay, e) => {
            console.debug(
              `[${label}] retry ${attempt}/${RETRY_TRIES} after ` +
              `${Math.round(delay)}ms (${e && (e.status || e.message)})`
            );
          }
        });
      } catch (e) {
        if (i === 0) firstPageError = e;
        console.warn(`[${label}] pagination stopped at page ${i}:`, e && e.message);
        break;
      }
      let rows = null;
      for (const k of dataKeys) {
        if (page && Array.isArray(page[k])) { rows = page[k]; break; }
      }
      if (!rows || !rows.length) break;
      let newCount = 0;
      let oldest = null;
      rows.forEach(r => {
        const key = keyFn(r);
        if (key == null || seen.has(key)) return;
        seen.add(key);
        all.push(r);
        newCount++;
        const ts = r[cursorField];
        if (ts && (!oldest || ts < oldest)) oldest = ts;
      });
      if (newCount === 0) break; // dedup cycle → reached inception
      if (mode === 'cursor') {
        if (!oldest) break;    // cursor cannot advance
        cursor = oldest;
      } else {
        pageNum++;
        if (rows.length < pageLimit) break;
      }
    }
    if (firstPageError && all.length === 0) throw firstPageError;
    return all;
  }

  // /historical-pnl rows have no canonical id; use createdAt+blockHeight.
  async function fetchAllHistoricalPnl(encodedAddress, onProgress) {
    const all = await fetchAllPaginated({
      urlBase: `${DYDX_API}/historical-pnl?address=${encodedAddress}&subaccountNumber=0`,
      joiner: '&',
      dataKeys: ['historicalPnl'],
      keyFn: r => `${r.createdAt}|${r.blockHeight}`,
      pageLimit: window.AppConstants.HIST_PAGE_LIMIT,
      label: 'historical-pnl',
      onProgress
    });
    return { historicalPnl: all };
  }

  // /perpetualPositions?status=CLOSED has no exposed id; the indexer
  // orders by openEventId DESC, which is monotonic with createdAt.
  async function fetchAllClosedPositions(encodedAddress, onProgress) {
    const all = await fetchAllPaginated({
      urlBase: `${DYDX_API}/perpetualPositions?address=${encodedAddress}&subaccountNumber=0&status=CLOSED`,
      joiner: '&',
      dataKeys: ['positions', 'perpetualPositions'],
      keyFn: r => `${r.createdAt}|${r.createdAtHeight || ''}|${r.market}|${r.side}|${r.entryPrice}`,
      pageLimit: window.AppConstants.POS_PAGE_LIMIT,
      label: 'closedPositions',
      onProgress
    });
    return { positions: all };
  }

  // /fills rows expose a UUID id.
  async function fetchAllFills(encodedAddress, onProgress) {
    const all = await fetchAllPaginated({
      urlBase: `${DYDX_API}/fills?address=${encodedAddress}&subaccountNumber=0`,
      joiner: '&',
      dataKeys: ['fills'],
      keyFn: r => r.id || `${r.createdAt}|${r.market}|${r.side}|${r.size}|${r.price}`,
      pageLimit: window.AppConstants.FILLS_PAGE_LIMIT,
      label: 'fills',
      onProgress
    });
    return { fills: all };
  }

  // /historicalFunding/{ticker} returns market-wide published hourly
  // funding rates: { historicalFunding: [{ ticker, rate, price,
  // effectiveAt, effectiveAtHeight }] }. Cursor-paged on effectiveAt.
  // Caller passes maxRows to bound the walk (the funding chart caps
  // its window at FUNDING_CHART_MAX_DAYS so an unbounded walk to
  // ticker inception would be wasted bandwidth).
  async function fetchHistoricalFunding(ticker, opts) {
    const o = opts || {};
    const limit = window.AppConstants.HISTORICAL_FUNDING_PAGE_LIMIT;
    // Bound page count via maxRows ÷ pageLimit so we walk only as far
    // back as the chart needs. +1 lets the last page include a row at
    // the exact boundary without truncation.
    const maxPages = o.maxRows ? Math.ceil(o.maxRows / limit) + 1 : null;
    const encoded = encodeURIComponent(ticker);
    const all = await fetchAllPaginated({
      urlBase: `${DYDX_API}/historicalFunding/${encoded}?`,
      joiner: '',
      dataKeys: ['historicalFunding'],
      keyFn: r => `${r.effectiveAt}|${r.effectiveAtHeight || ''}`,
      pageLimit: limit,
      label: `historicalFunding:${ticker}`,
      cursorField: 'effectiveAt',
      cursorParam: 'effectiveBeforeOrAt',
      maxPages,
      onProgress: o.onProgress || null
    });
    return { historicalFunding: all };
  }

  // /candles/perpetualMarkets/{ticker}?resolution=… walks backward via
  // toISO instead of createdBeforeOrAt — the generic paginator's URL
  // shape doesn't fit, so this is a bespoke loop. Stops when fromMs is
  // crossed, the page is empty, or maxPages is hit.
  async function fetchCandles(ticker, resolution, opts) {
    const o = opts || {};
    const limit = window.AppConstants.CANDLES_PAGE_LIMIT;
    const fromMs = o.fromMs || 0;
    const maxPages = o.maxPages || 50;
    const onProgress = o.onProgress || null;
    const encoded = encodeURIComponent(ticker);
    const all = [];
    const seen = new Set();
    let toISO = null;
    let firstPageError = null;
    for (let i = 0; i < maxPages; i++) {
      const params = new URLSearchParams({ resolution, limit: String(limit) });
      if (toISO) params.set('toISO', toISO);
      const url = `${DYDX_API}/candles/perpetualMarkets/${encoded}?${params}`;
      if (onProgress) {
        try { onProgress(`candles:${ticker}`, i + 1); } catch (_) {}
      }
      let page;
      try {
        page = await fetchJsonWithRetry(url);
      } catch (e) {
        if (i === 0) firstPageError = e;
        console.warn(`[candles:${ticker}] pagination stopped at page ${i}:`, e && e.message);
        break;
      }
      const rows = page && Array.isArray(page.candles) ? page.candles : null;
      if (!rows || !rows.length) break;
      let oldestStartedAt = null;
      let newCount = 0;
      for (const r of rows) {
        const key = `${r.startedAt}|${r.resolution}`;
        if (seen.has(key)) continue;
        seen.add(key);
        all.push(r);
        newCount++;
        if (!oldestStartedAt || r.startedAt < oldestStartedAt) {
          oldestStartedAt = r.startedAt;
        }
      }
      if (newCount === 0) break;
      if (!oldestStartedAt) break;
      // Stop once we've walked past the requested window.
      const oldestMs = Date.parse(oldestStartedAt);
      if (!isNaN(oldestMs) && oldestMs <= fromMs) break;
      // Indexer treats toISO as exclusive upper bound; passing the
      // oldest startedAt makes the next page strictly older.
      toISO = oldestStartedAt;
      if (rows.length < limit) break;
    }
    if (firstPageError && all.length === 0) throw firstPageError;
    return { candles: all };
  }

  // /fundingPayments uses 1-indexed offset pagination via page=N.
  async function fetchAllFundingPayments(encodedAddress, onProgress) {
    const all = await fetchAllPaginated({
      urlBase: `${DYDX_API}/fundingPayments?address=${encodedAddress}&subaccountNumber=0`,
      joiner: '&',
      dataKeys: ['fundingPayments'],
      keyFn: r => `${r.createdAt}|${r.ticker || r.market}|${r.payment}|${r.side || ''}|${r.rate || ''}`,
      pageLimit: window.AppConstants.FUNDING_PAGE_LIMIT,
      label: 'fundingPayments',
      mode: 'page',
      onProgress
    });
    return { fundingPayments: all };
  }

  window.DydxApi = {
    BASE: DYDX_API,
    fetchJson,
    fetchJsonWithRetry,
    fetchAllHistoricalPnl,
    fetchAllClosedPositions,
    fetchAllFills,
    fetchAllFundingPayments,
    fetchHistoricalFunding,
    fetchCandles,
    parseRetryAfter,
    isTransientError
  };
})();
