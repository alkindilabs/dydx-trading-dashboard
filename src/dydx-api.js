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
  async function fetchAllPaginated(opts) {
    const {
      urlBase, joiner = '&', dataKeys, keyFn,
      pageLimit, label, mode = 'cursor',
      onProgress = null
    } = opts;
    let cursor = null;
    let pageNum = 1;
    const all = [];
    const seen = new Set();
    let firstPageError = null;
    for (let i = 0; ; i++) {
      let extraParam = '';
      if (mode === 'cursor' && cursor) {
        extraParam = `&createdBeforeOrAt=${encodeURIComponent(cursor)}`;
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
        const ts = r.createdAt;
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
    parseRetryAfter,
    isTransientError
  };
})();
