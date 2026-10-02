// Market Structure tab: funding hero + KPI cards + per-asset funding
// analysis table. Funding window selector is persisted in localStorage
// so the user's window preference survives reloads.
//
// Depends on: window.AppConstants (TUNABLES.ALWAYS_SHOW_TICKERS,
// HOURS_PER_YEAR, MS_PER_MIN, MS_PER_HOUR, MS_PER_DAY,
// PERCENT, CENTS_PER_DOLLAR, FUNDING_CHART_MAX_DAYS), window.RiskMetrics
// (netSizeHistory, exactSum, wholeCents), window.Format (formatCents,
// CENTS, fmtNotional, groupDecimalText, fmtSignedPct,
// formatPercent, fmtDateTimeUTC, formatFundingApr, fundingAprClass,
// formatHourlyDetail, formatHourlyRate, signClass), window.AppDom (updateElement,
// updateMetric, appendCell, tagCells), window.DydxApi (BASE,
// fetchJsonWithRetry, fetchHistoricalFunding, fetchCandles).

(function () {
  'use strict';

  const FUNDING_WINDOW_KEY = 'fundingWindow';
  const FUNDING_WINDOWS = ['7', '30', '90', 'all'];
  const DEFAULT_FUNDING_WINDOW = '30';

  // Funded markets the funding table lists one per row; the rest share
  // one "N more markets" row, so the table still sums to the cards.
  const MAX_FUNDED_ROWS = 15;
  const UNKNOWN_TICKER = 'Unknown';
  const COLUMN_CURRENT = 1;
  const COLUMNS_FROM_PAYMENTS = ['RECEIVED', 'PAID', 'NET', 'STATUS'];
  const NET_EVEN_STATUS = 'EVEN';
  const COMBINED_ROW_RATE_NOTE = 'Several markets combined: rates are per market';
  const PREDICTED_RATE_NOT_A_NUMBER = 'Predicted rate is not a number';
  // /historicalFunding answers newest first; one row is the last settlement.
  const LATEST_SETTLEMENT_ROWS = 1;
  const SETTLED_RATE_NOTES = {
    idle: 'Last settled rate loads while this tab is open',
    loading: 'Fetching the last settled rate…',
    none: 'No settled funding for this market',
    failed: 'Last settled rate failed to load',
    unparsed: 'Last settled rate is not a number'
  };

  // The hero APR's text and its colour both read it at this precision.
  const HERO_APR_DECIMALS = 2;
  const UNPRICED_PAYMENT_REASON = 'A funding payment in the window has no size or oracle price';
  const NO_POSITION_REASON = 'No position held in the window';
  // Why the hours held without a payment row are not priced yet; 'short'
  // when the walk ended before the market's first such hour.
  const ORACLE_PRICE_NOTES = {
    idle: () => 'Settlement oracle prices load while this tab is open',
    loading: () => 'Fetching settlement oracle prices…',
    failed: () => 'Settlement oracle prices failed to load',
    short: (ticker, fromMs) => `${ticker} settlement history does not reach back to `
      + `${window.Format.fmtDateTimeUTC(fromMs)} UTC, its first hour with a position open and no funding payment`
  };
  // The reason shown when markets' settlement loads differ.
  const ORACLE_STATUS_PRECEDENCE = ['failed', 'short', 'loading', 'idle'];
  const UNPRICED_HERO = Object.freeze({ net: null, notionalHours: null, avgNotional: null, hourlyRate: null, apr: null });
  const HERO_IDS = ['fundingApr', 'fundingPeriod', 'fundingAvgNotional',
    'fundingHoursDeployed', 'fundingHourlyRate', 'fundingTimeInMarket'];
  const PRICED_HERO_IDS = ['fundingApr', 'fundingAvgNotional', 'fundingHourlyRate'];

  const PERIOD_DATE = { month: 'short', day: 'numeric', timeZone: 'UTC' };
  const PERIOD_DATE_WITH_YEAR = { ...PERIOD_DATE, year: 'numeric' };

  function getFundingWindowDays() {
    try {
      const v = localStorage.getItem(FUNDING_WINDOW_KEY);
      if (FUNDING_WINDOWS.includes(v)) return v;
    } catch (e) {}
    return DEFAULT_FUNDING_WINDOW;
  }

  // The All window starts at the first hour there is.
  const ALL_WINDOW_FIRST_HOUR = 0;

  // The window's first settlement hour. Every window ends at
  // lastSettledHour(), judged at the snapshot time (HeroState.snapshotAtMs),
  // when the payments and fills were fetched, never at the clock; a fixed
  // window is the days × 24 settlement hours ending there, whatever the
  // snapshot's minute, so 7D always holds 168 hours.
  function firstWindowHour() {
    const w = getFundingWindowDays();
    if (w === 'all') return ALL_WINDOW_FIRST_HOUR;
    const windowHours = parseInt(w, 10) * window.AppConstants.HOURS_PER_DAY;
    return lastSettledHour() - windowHours + 1;
  }

  function getFundingWindowLabel() {
    const w = getFundingWindowDays();
    return w === 'all' ? 'All time' : `Last ${w} days`;
  }

  function isMarketTabActive() {
    const tab = document.getElementById('market');
    return !!(tab && tab.classList.contains('active'));
  }

  function paymentTime(p) {
    return new Date(p.createdAt || p.effectiveAt).getTime();
  }

  function isUndated(p) {
    return isNaN(paymentTime(p));
  }

  // The funding payments of the selected window, the dated ones oldest
  // first: a payment belongs to it when its settlement hour lies in
  // [firstWindowHour(), lastSettledHour()], so a settlement that drifted
  // past the end of its hour stays with that hour. A payment
  // without a valid time follows them, since no window can be ruled out
  // for it. The hero, the cards and the table all read this one list.
  function paymentsInWindow(payments) {
    const first = firstWindowHour();
    const last = lastSettledHour();
    const dated = [];
    const undated = [];
    (payments || []).forEach(p => {
      if (isUndated(p)) { undated.push(p); return; }
      const hour = Math.floor(paymentTime(p) / window.AppConstants.MS_PER_HOUR);
      if (hour >= first && hour <= last) dated.push(p);
    });
    return dated.sort((a, b) => paymentTime(a) - paymentTime(b)).concat(undated);
  }

  // The payments whose amount does not parse (RiskMetrics.exactSum): their
  // funding is unknown, never $0.
  function unparsedPaymentCount(payments) {
    return payments.filter(p => window.RiskMetrics.exactSum([p.payment]) === null).length;
  }

  function undatedPaymentCount(payments) {
    return payments.filter(isUndated).length;
  }

  function paymentCountText(count) {
    return `${count} funding payment${count === 1 ? '' : 's'}`;
  }

  // Why a sum over the payments is unknown ('' when every amount parses
  // and every payment has a valid time).
  function unknownFundingReason(unparsedCount, undatedCount) {
    return [
      unparsedCount ? `${paymentCountText(unparsedCount)} in the window without a parseable amount` : '',
      undatedCount ? `${paymentCountText(undatedCount)} without a valid time` : ''
    ].filter(Boolean).join('; ');
  }

  function paymentsUnknownReason(payments) {
    return unknownFundingReason(unparsedPaymentCount(payments), undatedPaymentCount(payments));
  }

  function isUnknownFunding({ unparsedCount, undatedCount }) {
    return unparsedCount > 0 || undatedCount > 0;
  }

  // received = Σ positive payments, net = Σ payments, both exact
  // (RiskMetrics.exactSum); both null while an amount does not parse.
  function fundingTotals(payments) {
    const RM = window.RiskMetrics;
    const amounts = payments.map(p => p.payment);
    const net = RM.exactSum(amounts);
    if (net === null) return { received: null, net: null };
    return { received: RM.exactSum(amounts.filter(amount => RM.decimalNumberOf(amount) > 0)), net };
  }

  // 'Jun 19 → Sep 30', or 'Jun 19, 2025 → Sep 30, 2026' when the period
  // crosses a year boundary. UTC, the clock funding settles on.
  function formatFundingPeriod(startMs, endMs) {
    const crossesYear = new Date(startMs).getUTCFullYear() !== new Date(endMs).getUTCFullYear();
    const options = crossesYear ? PERIOD_DATE_WITH_YEAR : PERIOD_DATE;
    const date = ms => new Date(ms).toLocaleDateString('en-US', options);
    return `${date(startMs)} → ${date(endMs)}`;
  }

  function tickerOf(p) {
    return p.ticker || p.market || UNKNOWN_TICKER;
  }

  function groupByTicker(payments) {
    const byTicker = new Map();
    payments.forEach(p => {
      const ticker = tickerOf(p);
      if (!byTicker.has(ticker)) byTicker.set(ticker, []);
      byTicker.get(ticker).push(p);
    });
    return byTicker;
  }

  // A row's oracle price, or null when it has no positive, wholly numeric
  // one (RiskMetrics.decimalNumberOf).
  function rowPrice(p) {
    const price = window.RiskMetrics.decimalNumberOf(p.oraclePrice ?? p.price);
    return price !== null && price > 0 ? price : null;
  }

  // |size| × oracle price of a payment row, or null when either is missing
  // or not wholly numeric, or the size is 0 (a payment over no notional).
  function rowNotional(p) {
    const size = window.RiskMetrics.decimalNumberOf(p.size ?? p.positionSize);
    const price = rowPrice(p);
    return size !== null && size !== 0 && price !== null ? Math.abs(size) * price : null;
  }

  // The window's settled exposure, one entry per market per settlement
  // held: each settlement is its own exposure unit, so the settlements a
  // chain halt leaves to land together in one hour count one by one.
  // dYdX v4 settles funding at every hour; the indexer writes a
  // /fundingPayments row only when funding moved, so the settlements come
  // from the position, not the rows. A row is
  // { ticker, hour, atMs, notional }, its |size| × oracle price (null when
  // the row lacks either). A settlement without a row (paidSettlements)
  // is held when the fills put the market's net size
  // (RiskMetrics.netSizeHistory, the attribution's FIFO walk) off zero
  // just before its instant: { ticker, hour, atMs, size, price }, |net
  // size| at the settlement's own oracle price (hourSettlements); its
  // funding is 0. Once the settlements are loaded each is judged at its
  // own instant, so a settlement that drifted past a close is not held and
  // one that came after an open in its hour is; before they load each
  // hour is one settlement at the hour itself.
  function settledExposure(inWin, fills) {
    const C = window.AppConstants;
    const firstHour = firstWindowHour();
    const lastHour = lastSettledHour();
    const rowsByTicker = groupByTicker(inWin.filter(p => !isUndated(p)));
    const sizeHistory = window.RiskMetrics.netSizeHistory(fills || []);
    const exposure = [];
    const tickers = new Set([...rowsByTicker.keys(), ...Object.keys(sizeHistory)]);
    tickers.forEach(ticker => {
      const rowTimesByHour = new Map();
      (rowsByTicker.get(ticker) || []).forEach(p => {
        const atMs = paymentTime(p);
        const hour = Math.floor(atMs / C.MS_PER_HOUR);
        if (!rowTimesByHour.has(hour)) rowTimesByHour.set(hour, []);
        rowTimesByHour.get(hour).push(atMs);
        exposure.push({ ticker, hour, atMs, notional: rowNotional(p) });
      });
      const steps = sizeHistory[ticker] || [];
      if (!steps.length) return;
      let step = -1;
      const opened = Math.floor(steps[0].ms / C.MS_PER_HOUR);
      for (let hour = Math.max(firstHour, opened); hour <= lastHour; hour++) {
        const settlements = hourSettlements(ticker, hour);
        const paid = paidSettlements(settlements, rowTimesByHour.get(hour) || []);
        settlements.forEach(({ atMs, price }, i) => {
          while (step + 1 < steps.length && steps[step + 1].ms < atMs) step++;
          const size = step < 0 ? 0 : Math.abs(steps[step].netSize);
          if (!paid.has(i) && size !== 0) exposure.push({ ticker, hour, atMs, size, price });
        });
      }
    });
    return exposure;
  }

  // The indexes of an hour's settlements (oldest first) that its payment
  // rows pay, one each, rows oldest first: a row pays the latest unpaid
  // settlement at or before its own instant (a payment is written at its
  // settlement), else the earliest unpaid one.
  function paidSettlements(settlements, rowTimes) {
    const paid = new Set();
    [...rowTimes].sort((a, b) => a - b).forEach(t => {
      const unpaid = settlements.map((s, i) => i).filter(i => !paid.has(i));
      if (!unpaid.length) return;
      const before = unpaid.filter(i => settlements[i].atMs <= t);
      paid.add(before.length ? before[before.length - 1] : unpaid[0]);
    });
    return paid;
  }

  // The settlements a market held a position at, counted chain-wide:
  // markets held through one settlement count it once, so each hour
  // counts as many as the most any one market held in it.
  function settlementsHeld(exposure) {
    const byHour = new Map();
    exposure.forEach(({ hour, ticker }) => {
      if (!byHour.has(hour)) byHour.set(hour, new Map());
      const perTicker = byHour.get(hour);
      perTicker.set(ticker, (perTicker.get(ticker) || 0) + 1);
    });
    return [...byHour.values()].reduce((sum, perTicker) => sum + Math.max(...perTicker.values()), 0);
  }

  // The window's last settlement hour, the last whose settlement came at
  // or before the snapshot: judged by a loaded /historicalFunding walk
  // requested at or after the snapshot that reaches the snapshot's hour
  // (settlements are chain-wide, so any market's walk serves; one that
  // lists no settlement in that hour shows it had not happened), else by
  // the hour rule (the settlement at the hour itself).
  function lastSettledHour() {
    const snapshotAtMs = HeroState.snapshotAtMs;
    const hour = Math.floor(snapshotAtMs / window.AppConstants.MS_PER_HOUR);
    const walk = [...FundingHistory.byTicker.values()]
      .find(entry => isWalkSinceSnapshot(entry) && entry.reachedHour <= hour);
    if (!walk) return hour;
    const settled = walk.settlementsByHour.get(hour);
    return settled && settled[0].atMs <= snapshotAtMs ? hour : hour - 1;
  }

  // The market's settlements in `hour` at or before the snapshot, oldest
  // first, each { atMs, price }: its /historicalFunding rows' own
  // effectiveAt and oracle price (null without one) once a loaded walk
  // reaches back to that hour. None for an hour that the market's loaded
  // walk requested since the snapshot reaches but lists no settlement in:
  // the hour was not settled, whatever another market's walk shows. Else
  // one at the hour itself with price undefined (the hour rule): before
  // the settlements load, or for an hour no such walk reached.
  function hourSettlements(ticker, hour) {
    const entry = FundingHistory.byTicker.get(ticker);
    const reached = entry && entry.status === 'loaded' && entry.reachedHour <= hour;
    const listed = reached ? entry.settlementsByHour.get(hour) : undefined;
    if (listed) return listed.filter(s => s.atMs <= HeroState.snapshotAtMs);
    if (reached && isRequestedSinceSnapshot(entry)) return [];
    return [{ atMs: hour * window.AppConstants.MS_PER_HOUR, price: undefined }];
  }

  // Each market with a window hour, without a payment row, in which the
  // fills put its net size off zero at any moment → the start (ms) of its
  // earliest such hour: the /historicalFunding settlements the hero needs,
  // to price those hours and to judge each at its own settlement's
  // instant, which can fall inside a position opened and closed within
  // the hour although the position is flat at both hour marks. A market
  // whose every held hour has a payment row is not listed and its walk is
  // not loaded, so a rate-0 settlement a halt left in an hour that also
  // holds another settlement's row is not seen (a known limitation).
  function unrowedHoursFrom(inWin, fills) {
    const H = window.AppConstants.MS_PER_HOUR;
    const firstHour = firstWindowHour();
    const lastHour = lastSettledHour();
    const rowHoursByTicker = new Map();
    inWin.filter(p => !isUndated(p)).forEach(p => {
      const ticker = tickerOf(p);
      if (!rowHoursByTicker.has(ticker)) rowHoursByTicker.set(ticker, new Set());
      rowHoursByTicker.get(ticker).add(Math.floor(paymentTime(p) / H));
    });
    const fromByTicker = new Map();
    Object.entries(window.RiskMetrics.netSizeHistory(fills || [])).forEach(([ticker, steps]) => {
      if (!steps.length) return;
      const rowHours = rowHoursByTicker.get(ticker) || new Set();
      let entering = -1;
      for (let hour = Math.max(firstHour, Math.floor(steps[0].ms / H)); hour <= lastHour; hour++) {
        while (entering + 1 < steps.length && steps[entering + 1].ms < hour * H) entering++;
        if (!rowHours.has(hour) && offZeroBefore(steps, entering, (hour + 1) * H)) {
          fromByTicker.set(ticker, hour * H);
          return;
        }
      }
    });
    return fromByTicker;
  }

  // Whether the net size steps put a market off zero at any moment from
  // the step in effect when a period starts (index `entering`, −1 when no
  // fill came before it) until endMs.
  function offZeroBefore(steps, entering, endMs) {
    for (let i = Math.max(entering, 0); i < steps.length && (i <= entering || steps[i].ms < endMs); i++) {
      if (steps[i].netSize !== 0) return true;
    }
    return false;
  }

  // A market's settlements from fromMs: 'idle' before a walk covering
  // them starts, the walk's 'loading' or 'failed', 'short' when it loaded
  // but its oldest settlement is after fromMs's hour (it hit its page cap,
  // or the indexer had no older row), else 'loaded'.
  function settlementStatus(ticker, fromMs) {
    const entry = FundingHistory.byTicker.get(ticker);
    if (!coversFrom(entry, fromMs) || !isRequestedSinceSnapshot(entry)) return 'idle';
    if (entry.status !== 'loaded') return entry.status;
    return entry.reachedHour <= Math.floor(fromMs / window.AppConstants.MS_PER_HOUR) ? 'loaded' : 'short';
  }

  // Why those settlements cannot price the hero ('' once every market's
  // are loaded back to its first hour without a row): ORACLE_PRICE_NOTES by
  // ORACLE_STATUS_PRECEDENCE.
  function oraclePriceGap(fromByTicker) {
    const markets = [...fromByTicker].map(([ticker, fromMs]) => ({ ticker, fromMs, status: settlementStatus(ticker, fromMs) }));
    const first = ORACLE_STATUS_PRECEDENCE.map(s => markets.find(m => m.status === s)).find(Boolean);
    return first ? ORACLE_PRICE_NOTES[first.status](first.ticker, first.fromMs) : '';
  }

  // Whether an incomplete position's window ({ market, fromMs, toMs },
  // either end null when unknown or open) overlaps the hero's window.
  function overlapsWindow(w) {
    return (w.fromMs ?? -Infinity) <= HeroState.snapshotAtMs
      && (w.toMs ?? Infinity) >= firstWindowHour() * window.AppConstants.MS_PER_HOUR;
  }

  // The fill gaps (`fillGaps`, market → reason) of the markets the hero
  // covers, '; '-joined ('' when none): those the window's exposure covers
  // and those of an incomplete position whose window overlaps the hero's
  // (`incompleteWindows`), whose hours its fills cannot show. Those
  // markets' fills cannot say which hours were held.
  function coveredFillsGap(exposure, fillGaps, incompleteWindows) {
    const tickers = [...new Set([...exposure.map(e => e.ticker),
      ...incompleteWindows.filter(overlapsWindow).map(w => w.market)])].sort();
    return [...new Set(tickers.map(ticker => fillGaps.get(ticker)).filter(Boolean))].join('; ');
  }

  // Why the exposure cannot be priced from its settlements ('' when it
  // can): the earliest held settlement without a payment row that has no
  // oracle price (null: its row has none; undefined: the hour rule's).
  function pricelessSettlementGap(exposure) {
    const priceless = exposure.filter(e => e.size !== undefined && (e.price === null || e.price === undefined))
      .sort((a, b) => a.hour - b.hour)[0];
    return priceless
      ? `${priceless.ticker} settlement at `
        + `${window.Format.fmtDateTimeUTC(priceless.hour * window.AppConstants.MS_PER_HOUR)} UTC has no oracle price`
      : '';
  }

  // APR = (Σ payment / Σ notional over the settled exposure, one notional
  // per market per settlement held) × HOURS_PER_YEAR. hoursDeployed counts
  // distinct settlement hours, so markets held through the same hour, and
  // settlements a halt left to land in one hour, count once: timeInMarket
  // is the share of the window's settlement hours with any position open.
  // avgNotional is Σ notional ÷ settlementsHeld, the account's notional
  // per settlement held, so a constant position reads its own notional
  // whatever the hours its settlements landed in. The window's hours
  // are those paymentsInWindow and settledExposure place held hours in,
  // firstWindowHour() to lastSettledHour(), so
  // timeInMarket is at most 1. The All window opens an hour before its
  // first held settlement, when the interval that settlement pays for
  // began. A payment without a parseable amount or a valid time leaves
  // the net, so the priced figures, unknown.
  // Once the settlements are loaded, a held settlement without a
  // payment row is priced at its own oracle price, and a held hour with
  // no settlement listed leaves the exposure; a settlement without a
  // price stays in it, unpriced. With an unpriced row or
  // settlements not loaded (or loaded short of the first such hour), the
  // priced figures are null and unpricedReason says why (the net would
  // hold a payment the notional does not); so they are with no position
  // held in the window, where hoursDeployed and timeInMarket are 0, or
  // null (with windowHours and the period) in the All window, which then
  // has no start. While a market the exposure covers has a fill gap
  // (`fillGaps`, market → reason), the held hours themselves are unknown:
  // only { unavailableReason } is returned.
  function computeFundingHero(inWin, fills, fillGaps, incompleteWindows) {
    const C = window.AppConstants;
    const exposure = settledExposure(inWin, fills);
    const fillsGap = coveredFillsGap(exposure, fillGaps, incompleteWindows);
    if (fillsGap) return { unavailableReason: fillsGap };
    const oracleGap = oraclePriceGap(unrowedHoursFrom(inWin, fills));
    const priceGap = paymentsUnknownReason(inWin)
      || (exposure.some(e => e.notional === null) ? UNPRICED_PAYMENT_REASON : oracleGap)
      || pricelessSettlementGap(exposure);
    const isAllWindow = getFundingWindowDays() === 'all';
    const lastHour = lastSettledHour();
    if (!exposure.length) {
      const windowHours = isAllWindow ? null : lastHour - firstWindowHour() + 1;
      return { ...UNPRICED_HERO, unpricedReason: priceGap || NO_POSITION_REASON, periodStart: null, periodEnd: null,
               windowHours, hoursDeployed: windowHours === null ? null : 0,
               timeInMarket: windowHours === null ? null : 0 };
    }
    const atMs = exposure.map(e => e.atMs);
    const periodStart = Math.min(...atMs);
    const periodEnd = Math.max(...atMs);
    const heldHours = exposure.map(e => e.hour);
    const hoursDeployed = new Set(heldHours).size;
    const windowHours = isAllWindow
      ? lastHour - (Math.min(...heldHours) - 1)
      : lastHour - firstWindowHour() + 1;
    const timeInMarket = hoursDeployed / windowHours;
    const shared = { hoursDeployed, periodStart, periodEnd, windowHours, timeInMarket };
    if (priceGap) return { ...shared, ...UNPRICED_HERO, unpricedReason: priceGap };

    const notionalHours = exposure.reduce(
      (sum, e) => sum + (e.size === undefined ? e.notional : e.size * e.price), 0);
    const { net } = fundingTotals(inWin);
    const hourlyRate = net / notionalHours;
    return { ...shared, unpricedReason: '', netCents: fundingLedger(inWin).netCents, notionalHours,
             avgNotional: notionalHours / settlementsHeld(exposure), hourlyRate,
             apr: hourlyRate * C.HOURS_PER_YEAR };
  }

  const WHOLE_NUMBER = 0;

  // A whole count or quantity with thousands separators ('215,900,000').
  function groupedWhole(n) {
    return window.Format.groupDecimalText(window.Format.fmtFixed(n, WHOLE_NUMBER));
  }

  // metrics: computeFundingHero's, or { unavailableReason } when an input
  // the hero needs is missing (every figure '—', the reason as caption).
  function renderFundingHero(metrics) {
    const C = window.AppConstants;
    const F = window.Format;
    const D = window.AppDom;
    const apr = document.getElementById('fundingApr');
    if (!apr) return;
    apr.classList.remove('profit', 'loss', 'zero');
    if (metrics.unavailableReason) {
      HERO_IDS.forEach(id => D.updateElement(id, '—'));
      D.updateElement('fundingCaption', metrics.unavailableReason);
      return;
    }

    D.updateElement('fundingPeriod', metrics.periodStart === null
      ? '—' : formatFundingPeriod(metrics.periodStart, metrics.periodEnd));
    const windowKnown = metrics.windowHours !== null;
    D.updateElement('fundingHoursDeployed', windowKnown
      ? `${groupedWhole(metrics.hoursDeployed)} / ${groupedWhole(metrics.windowHours)} h` : '—');
    D.updateElement('fundingTimeInMarket', windowKnown ? F.formatPercent(metrics.timeInMarket * C.PERCENT) : '—');
    if (metrics.unpricedReason) {
      PRICED_HERO_IDS.forEach(id => D.updateElement(id, '—'));
      D.updateElement('fundingCaption', metrics.unpricedReason);
      return;
    }

    const aprPercent = metrics.apr * C.PERCENT;
    apr.textContent = F.fmtSignedPct(aprPercent, HERO_APR_DECIMALS);
    const tone = F.signClass(aprPercent, HERO_APR_DECIMALS);
    if (tone) apr.classList.add(tone);
    D.updateElement('fundingCaption',
      `${F.formatCents(metrics.netCents / C.CENTS_PER_DOLLAR)} net on ${groupedWhole(metrics.notionalHours)} dollar·hours`);
    D.updateElement('fundingAvgNotional', F.fmtNotional(metrics.avgNotional));
    D.updateElement('fundingHourlyRate', F.formatHourlyRate(metrics.hourlyRate * C.PERCENT));
  }

  // The hero's last inputs, so a settlement-price load can repaint it;
  // snapshotAtMs, when they were fetched, ends every window.
  const HeroState = { inWin: [], fills: null, gap: '', fillGaps: new Map(), incompleteWindows: [],
                      snapshotAtMs: null };

  function renderHero() {
    renderFundingHero(HeroState.gap ? { unavailableReason: HeroState.gap }
      : computeFundingHero(HeroState.inWin, HeroState.fills, HeroState.fillGaps, HeroState.incompleteWindows));
  }

  // Loads (or joins the load of) the settlements the hero's hours without
  // a payment row need, repainting the hero now and when each lands; none
  // while the hero cannot place those hours.
  function ensureHeroPricesLoaded() {
    const exposure = HeroState.gap ? [] : settledExposure(HeroState.inWin, HeroState.fills);
    if (!HeroState.gap && !coveredFillsGap(exposure, HeroState.fillGaps, HeroState.incompleteWindows)) {
      unrowedHoursFrom(HeroState.inWin, HeroState.fills).forEach((fromMs, ticker) => {
        loadFundingHistory(ticker, fromMs).then(renderHero, () => {
          console.warn(`[funding-hero] settlement prices for ${ticker} failed to load`);
          renderHero();
        });
      });
    }
    renderHero();
  }

  // The window's received / paid / net at whole cents. Each market's NET
  // is its exact net (RiskMetrics.exactSum of its payments) at cents by
  // RiskMetrics.wholeCents, the rule the profit ledger rounds each
  // market's funding by (RiskMetrics.profitLedger), so the same funding
  // reads the same cent in both; its RECEIVED is its exact Σ positive
  // payments at cents, and its PAID is RECEIVED − NET, so the row foots.
  // The "N more markets" row and the cards sum the markets' cents, so the
  // columns sum to the cards exactly as displayed. A market holding a
  // payment without a parseable amount or a valid time has unknown cents
  // (null) and those counts (unparsedCount, undatedCount), and so do the
  // totals, which then carry `gap`.
  // { byTicker: Map(ticker → cents), receivedCents, paidCents, netCents,
  // gap }.
  function fundingLedger(inWin) {
    const RM = window.RiskMetrics;
    const byTicker = new Map();
    let receivedCents = 0, paidCents = 0, netCents = 0;
    groupByTicker(inWin).forEach((payments, ticker) => {
      const counts = { unparsedCount: unparsedPaymentCount(payments), undatedCount: undatedPaymentCount(payments) };
      if (isUnknownFunding(counts)) {
        byTicker.set(ticker, { receivedCents: null, paidCents: null, netCents: null, ...counts });
        return;
      }
      const { received, net } = fundingTotals(payments);
      const entry = { receivedCents: RM.wholeCents(received), netCents: RM.wholeCents(net), ...counts };
      entry.paidCents = entry.receivedCents - entry.netCents;
      byTicker.set(ticker, entry);
      receivedCents += entry.receivedCents;
      paidCents += entry.paidCents;
      netCents += entry.netCents;
    });
    const gap = paymentsUnknownReason(inWin);
    return gap ? { byTicker, receivedCents: null, paidCents: null, netCents: null, gap }
      : { byTicker, receivedCents, paidCents, netCents, gap };
  }

  // Signed dollars at cents from whole cents, toned by the displayed value.
  function centsCell(cents) {
    const F = window.Format;
    const dollars = cents / window.AppConstants.CENTS_PER_DOLLAR;
    return { text: F.formatCents(dollars), tone: F.signClass(dollars, F.CENTS) };
  }

  function renderFundingKpiCards(ledger, paymentsGap) {
    const D = window.AppDom;
    const gap = paymentsGap || ledger.gap;
    const caption = gap || getFundingWindowLabel();
    ['fundingCapturedWindow', 'fundingPaidWindow', 'fundingNetPct']
      .forEach(id => D.updateElement(id, caption));
    if (gap) {
      ['fundingCaptured', 'fundingPaid', 'fundingNet'].forEach(id => D.updateMetric(id, '—'));
      return;
    }
    [['fundingCaptured', ledger.receivedCents], ['fundingPaid', -ledger.paidCents],
     ['fundingNet', ledger.netCents]].forEach(([id, cents]) => {
      const cell = centsCell(cents);
      D.updateMetric(id, cell.text, cell.tone);
    });
  }

  // The funding table's rows: every market with funding in the window,
  // largest |net| first (those whose net is unknown ahead of them; the
  // first MAX_FUNDED_ROWS on their own rows, the rest combined), then each
  // ALWAYS_SHOW ticker without funding. Built
  // from the payments' ledger, not /perpetualMarkets, so a market that
  // endpoint does not list still counts and the rows sum to the cards.
  function fundingTableRows(ledger) {
    const C = window.AppConstants;
    const funded = [...ledger.byTicker]
      .map(([ticker, cents]) => ({ ticker, ...cents }))
      .sort((a, b) => Number(isUnknownFunding(b)) - Number(isUnknownFunding(a))
        || Math.abs(b.netCents) - Math.abs(a.netCents) || a.ticker.localeCompare(b.ticker));
    const unfunded = C.TUNABLES.ALWAYS_SHOW_TICKERS
      .filter(ticker => !ledger.byTicker.has(ticker))
      .map(ticker => ({ ticker, receivedCents: 0, paidCents: 0, netCents: 0, unparsedCount: 0, undatedCount: 0 }));
    const rows = funded.slice(0, MAX_FUNDED_ROWS).concat(unfunded);
    const rest = funded.slice(MAX_FUNDED_ROWS);
    if (rest.length) {
      const sum = key => rest.reduce((s, e) => s + e[key], 0);
      rows.push({ ticker: `${rest.length} more markets`, combined: true,
                  receivedCents: sum('receivedCents'), paidCents: sum('paidCents'), netCents: sum('netCents'),
                  unparsedCount: sum('unparsedCount'), undatedCount: sum('undatedCount') });
    }
    return rows;
  }

  // PREDICTED (APR): the indexer's running estimate of the next hourly
  // settlement, /perpetualMarkets nextFundingRate.
  function appendPredictedRateCell(tr, marketsMap, ticker, marketsGap) {
    const F = window.Format;
    const D = window.AppDom;
    const m = marketsMap && marketsMap[ticker];
    const next = m ? m.nextFundingRate : null;
    const blank = next === null || next === undefined || next === '';
    if (!m || blank || F.fundingAprPercent(next) === null) {
      const td = D.appendCell(tr, '—', ['mono']);
      td.title = !m ? (marketsGap || `${ticker} is not listed by /perpetualMarkets`)
        : blank ? 'No predicted rate from /perpetualMarkets'
        : PREDICTED_RATE_NOT_A_NUMBER;
      return;
    }
    const td = D.appendCell(tr, F.formatFundingApr(next), ['mono', F.fundingAprClass(next)]);
    td.title = F.formatHourlyDetail(next);
  }

  function appendPaymentCells(tr, e, paymentsGap) {
    const D = window.AppDom;
    const gap = paymentsGap || unknownFundingReason(e.unparsedCount, e.undatedCount);
    if (gap) {
      COLUMNS_FROM_PAYMENTS.forEach(() => { D.appendCell(tr, '—', ['mono']).title = gap; });
      return;
    }
    [e.receivedCents, -e.paidCents, e.netCents].forEach(cents => {
      const cell = centsCell(cents);
      D.appendCell(tr, cell.text, ['mono', cell.tone]);
    });
    const netClass = centsCell(e.netCents).tone;
    D.appendCell(tr, netClass && netClass !== 'zero' ? netClass.toUpperCase() : NET_EVEN_STATUS, ['mono']);
  }

  // Tickers whose CURRENT cell the table last rendered.
  const TableState = { tickers: [] };

  function renderFundingAnalysis(ledger, marketsMap, gaps) {
    const D = window.AppDom;
    const body = document.getElementById('fundingAnalysisBody');
    if (!body) return;
    body.innerHTML = '';
    const rows = fundingTableRows(ledger);
    rows.forEach(e => {
      const tr = document.createElement('tr');
      D.appendCell(tr, e.ticker);
      if (e.combined) {
        D.appendCell(tr, '—', ['mono']).title = COMBINED_ROW_RATE_NOTE;
        D.appendCell(tr, '—', ['mono']).title = COMBINED_ROW_RATE_NOTE;
      } else {
        tr.dataset.ticker = e.ticker;
        paintSettledRate(D.appendCell(tr, '—', ['mono']), e.ticker);
        appendPredictedRateCell(tr, marketsMap, e.ticker, gaps.markets);
      }
      appendPaymentCells(tr, e, gaps.payments);
      body.appendChild(tr);
    });
    TableState.tickers = rows
      .filter(e => !e.combined && e.ticker !== UNKNOWN_TICKER)
      .map(e => e.ticker);
    D.tagCells('fundingAnalysisBody');
  }

  // ─────────────────────────────────────────────────────────────────
  // Last settled funding rate (CURRENT column)
  // ─────────────────────────────────────────────────────────────────
  // The newest /historicalFunding row per table market. Fetched only
  // while the Market tab is open, kept per ticker for
  // LIVE_DATA_FRESH_TTL_MS, dropped on every dashboard refresh; a result
  // that lands after a refresh dropped its cache is discarded.

  const LIVE_DATA_FRESH_TTL_MS = 10 * window.AppConstants.MS_PER_MIN;

  const SettledRates = {
    byTicker: new Map(), // ticker → { status, rate?, effectiveAt?, fetchedAt? }
    generation: 0
  };

  function isFresh(entry) {
    return !!entry && entry.fetchedAt !== undefined
      && (Date.now() - entry.fetchedAt) < LIVE_DATA_FRESH_TTL_MS;
  }

  // { status: 'loaded', rate, effectiveAt } from the newest dated row,
  // { status: 'unparsed' } when its rate is not wholly numeric
  // (RiskMetrics.decimalNumberOf), or { status: 'none' } without one.
  function newestSettlement(rows) {
    let newest = null;
    (rows || []).forEach(r => {
      const at = Date.parse(r.effectiveAt);
      if (isNaN(at)) return;
      if (!newest || at > newest.effectiveAt) newest = { rate: r.rate, effectiveAt: at };
    });
    if (!newest) return { status: 'none' };
    return window.RiskMetrics.decimalNumberOf(newest.rate) === null
      ? { status: 'unparsed' } : { status: 'loaded', ...newest };
  }

  function paintSettledRate(td, ticker) {
    const F = window.Format;
    const entry = SettledRates.byTicker.get(ticker);
    if (entry && entry.status === 'loaded') {
      td.textContent = F.formatFundingApr(entry.rate);
      td.className = ['mono', F.fundingAprClass(entry.rate)].filter(Boolean).join(' ');
      td.title = `Settled ${F.fmtDateTimeUTC(entry.effectiveAt)} UTC · ${F.formatHourlyDetail(entry.rate)}`;
      return;
    }
    td.textContent = '—';
    td.className = 'mono';
    td.title = SETTLED_RATE_NOTES[entry ? entry.status : 'idle'];
  }

  function repaintSettledRate(ticker) {
    const body = document.getElementById('fundingAnalysisBody');
    if (!body) return;
    Array.from(body.children)
      .filter(tr => tr.dataset.ticker === ticker)
      .forEach(tr => paintSettledRate(tr.children[COLUMN_CURRENT], ticker));
  }

  async function loadSettledRate(ticker) {
    const generation = SettledRates.generation;
    SettledRates.byTicker.set(ticker, { status: 'loading' });
    repaintSettledRate(ticker);
    let entry;
    try {
      const url = `${window.DydxApi.BASE}/historicalFunding/${encodeURIComponent(ticker)}?limit=${LATEST_SETTLEMENT_ROWS}`;
      const page = await window.DydxApi.fetchJsonWithRetry(url, { label: `historicalFunding:${ticker}` });
      entry = newestSettlement(page && page.historicalFunding);
    } catch (e) {
      console.warn(`[funding-table] last settled rate for ${ticker} failed to load`);
      entry = { status: 'failed' };
    }
    if (generation !== SettledRates.generation) return;
    SettledRates.byTicker.set(ticker, { ...entry, fetchedAt: Date.now() });
    repaintSettledRate(ticker);
  }

  function ensureSettledRatesLoaded() {
    TableState.tickers.forEach(ticker => {
      const entry = SettledRates.byTicker.get(ticker);
      if (entry && (entry.status === 'loading' || isFresh(entry))) return;
      loadSettledRate(ticker);
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // Settlement history (/historicalFunding), shared by chart and hero
  // ─────────────────────────────────────────────────────────────────
  // Per ticker: { status: 'loading' | 'loaded' | 'failed', fromMs,
  // requestedAt, promise?, rows?, settlementsByHour?, reachedHour?,
  // fetchedAt? }, the settlements the walk back towards fromMs returned;
  // reachedHour is the hour of the oldest one, which a capped walk leaves
  // after fromMs. Fresh for LIVE_DATA_FRESH_TTL_MS, dropped on every
  // dashboard refresh; a walk that lands after that drop is not kept.

  const FundingHistory = { byTicker: new Map(), generation: 0 };

  // Whether the walk in `entry` was requested at or after the snapshot
  // (any walk before the first render): only such a walk can show that a
  // settlement had not happened by the snapshot, since one requested
  // earlier cannot list a settlement that came between the two.
  function isRequestedSinceSnapshot(entry) {
    return !!entry && (HeroState.snapshotAtMs === null || entry.requestedAt >= HeroState.snapshotAtMs);
  }

  function isWalkSinceSnapshot(entry) {
    return isRequestedSinceSnapshot(entry) && entry.status === 'loaded';
  }

  // Whether the walk in `entry` serves the settlements from fromMs on: it
  // was asked for them, or it loaded and reached back to fromMs's hour.
  function coversFrom(entry, fromMs) {
    if (!entry) return false;
    const reached = entry.status === 'loaded'
      && entry.reachedHour <= Math.floor(fromMs / window.AppConstants.MS_PER_HOUR);
    return entry.fromMs <= fromMs || reached;
  }

  // The hour of the oldest settlement in rows (Infinity for none): how far
  // back the walk reached.
  function oldestHour(rows) {
    const C = window.AppConstants;
    return rows.reduce((oldest, r) => {
      const at = Date.parse(r.effectiveAt);
      return isNaN(at) ? oldest : Math.min(oldest, Math.floor(at / C.MS_PER_HOUR));
    }, Infinity);
  }

  // Settlement hour → [{ atMs, price }], oldest first: every settlement
  // whose instant falls in that hour (after a chain halt several land in
  // one), with its oracle price (null when the row has no positive one),
  // from every row with a valid effectiveAt: a listed settlement happened
  // whatever its price.
  function settlementsByHour(rows) {
    const C = window.AppConstants;
    const settlements = new Map();
    rows.forEach(r => {
      const atMs = Date.parse(r.effectiveAt);
      if (isNaN(atMs)) return;
      const hour = Math.floor(atMs / C.MS_PER_HOUR);
      if (!settlements.has(hour)) settlements.set(hour, []);
      settlements.get(hour).push({ atMs, price: rowPrice(r) });
    });
    settlements.forEach(list => list.sort((a, b) => a.atMs - b.atMs));
    return settlements;
  }

  // The ticker's settlements from fromMs on: the cached walk when one
  // covering them, requested at or after the snapshot, is in flight or
  // fresh, else one DydxApi.fetchHistoricalFunding walk back to fromMs,
  // kept unless a walk reaching further back, requested no earlier,
  // replaced it meanwhile. Resolves to the rows; rejects when the walk
  // fails.
  function loadFundingHistory(ticker, fromMs) {
    const C = window.AppConstants;
    const cached = FundingHistory.byTicker.get(ticker);
    if (coversFrom(cached, fromMs) && isRequestedSinceSnapshot(cached)) {
      if (cached.status === 'loading') return cached.promise;
      if (cached.status === 'loaded' && isFresh(cached)) return Promise.resolve(cached.rows);
    }
    const generation = FundingHistory.generation;
    const requestedAt = Date.now();
    // The walk pages back from the indexer's present, not the snapshot.
    const maxRows = Math.ceil((requestedAt - fromMs) / C.MS_PER_HOUR) + 1;
    const keep = (entry) => {
      const current = FundingHistory.byTicker.get(ticker);
      const replaces = !current || current.promise === promise
        || (current.fromMs > fromMs && current.requestedAt <= requestedAt);
      if (generation === FundingHistory.generation && replaces) {
        FundingHistory.byTicker.set(ticker, { ...entry, fromMs, requestedAt, fetchedAt: Date.now() });
      }
    };
    const promise = window.DydxApi.fetchHistoricalFunding(ticker, { maxRows }).then(page => {
      const rows = (page && page.historicalFunding) || [];
      keep({ status: 'loaded', rows, settlementsByHour: settlementsByHour(rows), reachedHour: oldestHour(rows) });
      repaintIfWindowMoved();
      return rows;
    }, err => {
      keep({ status: 'failed' });
      throw err;
    });
    FundingHistory.byTicker.set(ticker, { status: 'loading', fromMs, requestedAt, promise });
    return promise;
  }

  // ─────────────────────────────────────────────────────────────────
  // Funding rate · price history chart
  // ─────────────────────────────────────────────────────────────────
  // Lazy-loaded on tab activation. In-memory cache keyed by ticker so
  // switching markets or returning to the tab doesn't refetch within
  // the freshness window. Refetch is triggered by: picker change, tab
  // re-activation when stale, or explicit consumer call.

  const PRICE_OVERLAY_UNAVAILABLE = 'Price overlay unavailable: candles failed to load';

  const ChartState = {
    data: new Map(),     // ticker → { fundingRows, candleRows, candlesMissing, fetchedAt }
    currentTicker: null,
    activeRequest: null, // Symbol() — latest-token-wins. The underlying
                         // DydxApi helpers don't accept a signal, so we
                         // can't cancel the network; instead we tag each
                         // call with a token and discard the result if
                         // the token has been superseded by a newer call
                         // (rapid picker changes).
    pickerInit: false
  };

  function pickDefaultTicker(payments, marketsMap) {
    // Most-traded market by funding-payment count, scoped to tickers
    // still listed by /perpetualMarkets so we never offer a delisted
    // symbol the indexer will 404 on.
    const counts = new Map();
    (payments || []).forEach(p => {
      const tk = p.ticker || p.market;
      if (!tk || !marketsMap || !marketsMap[tk]) return;
      counts.set(tk, (counts.get(tk) || 0) + 1);
    });
    if (counts.size === 0) {
      if (marketsMap && marketsMap['ETH-USD']) return 'ETH-USD';
      const keys = Object.keys(marketsMap || {});
      return keys.length ? keys.sort()[0] : null;
    }
    let best = null, bestCount = -1;
    for (const [tk, c] of counts) {
      if (c > bestCount) { bestCount = c; best = tk; }
    }
    return best;
  }

  function populateChartPicker(payments, marketsMap) {
    const sel = document.getElementById('fundingChartTicker');
    if (!sel) return;
    const traded = new Set();
    (payments || []).forEach(p => {
      const tk = p.ticker || p.market;
      if (tk && marketsMap && marketsMap[tk]) traded.add(tk);
    });
    const all = Object.keys(marketsMap || {});
    const choices = Array.from(new Set([...traded, ...all])).sort();
    sel.innerHTML = '';
    // /perpetualMarkets failed (partial refresh) — no choices to
    // surface. Clear the selection so ensureChartLoaded doesn't fetch
    // against a ticker the user can't see, disable the picker, and
    // surface the empty-state caption on the canvas.
    if (choices.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No markets available';
      opt.disabled = true;
      opt.selected = true;
      sel.appendChild(opt);
      sel.disabled = true;
      ChartState.currentTicker = null;
      if (window.AppCharts && window.AppCharts.fundingRate) {
        window.AppCharts.fundingRate.clear();
      }
      setChartStatus('', null);
      setChartEmpty('No markets available');
      return;
    }
    sel.disabled = false;
    const prevSelection = ChartState.currentTicker || sel.value;
    choices.forEach(tk => {
      const opt = document.createElement('option');
      opt.value = tk;
      opt.textContent = tk;
      sel.appendChild(opt);
    });
    if (prevSelection && choices.includes(prevSelection)) {
      sel.value = prevSelection;
      ChartState.currentTicker = prevSelection;
    } else {
      const def = pickDefaultTicker(payments, marketsMap) || choices[0] || null;
      if (def) { sel.value = def; ChartState.currentTicker = def; }
    }
  }

  function initChartPicker() {
    const sel = document.getElementById('fundingChartTicker');
    if (!sel || ChartState.pickerInit) return;
    ChartState.pickerInit = true;
    sel.addEventListener('change', () => {
      loadChartForTicker(sel.value);
    });
  }

  function setChartStatus(text, mode) {
    const el = document.getElementById('fundingChartStatus');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('fetching', mode === 'fetching');
    el.classList.toggle('error', mode === 'error');
    // The status line is a one-line ellipsized label; a notice is a
    // sentence that must stay readable at phone width, so it wraps.
    el.style.whiteSpace = mode === 'notice' ? 'normal' : '';
  }

  function setChartEmpty(text) {
    const empty = document.getElementById('fundingChartEmpty');
    if (!empty) return;
    if (text) { empty.hidden = false; empty.textContent = text; }
    else      { empty.hidden = true;  empty.textContent = '—'; }
  }

  function currentChartCutoff() {
    const C = window.AppConstants;
    const w = getFundingWindowDays();
    const days = w === 'all'
      ? C.FUNDING_CHART_MAX_DAYS
      : Math.min(parseInt(w, 10), C.FUNDING_CHART_MAX_DAYS);
    return Date.now() - days * C.MS_PER_DAY;
  }

  // Returns whether funding bars were drawn.
  function renderChartFromCache(ticker) {
    if (!window.AppCharts || !window.AppCharts.fundingRate) return false;
    const entry = ChartState.data.get(ticker);
    if (!entry) { window.AppCharts.fundingRate.clear(); return false; }
    const cutoffMs = currentChartCutoff();
    setChartEmpty(null);
    // chart.render returns false when it could not draw (< 2 valid
    // funding bars after the cutoff filter). Defer to its decision so
    // the panel's empty-state condition can't drift from the chart's
    // internal threshold.
    const rendered = window.AppCharts.fundingRate.render({
      ticker,
      fundingRows: entry.fundingRows,
      candleRows: entry.candleRows,
      cutoffMs
    });
    if (!rendered) {
      setChartEmpty(`Not enough funding history for ${ticker} in window`);
    }
    return rendered;
  }

  // Draws the cached chart and settles the status line: bars drawn
  // without their price line say so instead of leaving it silently absent.
  function presentChartFromCache(ticker) {
    const rendered = renderChartFromCache(ticker);
    const entry = ChartState.data.get(ticker);
    const overlayMissing = rendered && entry && entry.candlesMissing;
    if (overlayMissing) setChartStatus(PRICE_OVERLAY_UNAVAILABLE, 'notice');
    else setChartStatus('', null);
  }

  async function fetchChartData(ticker) {
    const C = window.AppConstants;
    const fromMs = Date.now() - C.FUNDING_CHART_MAX_DAYS * C.MS_PER_DAY;
    // allSettled so a candles outage doesn't sink the whole chart.
    // Funding rate is the load-bearing signal; price is contextual
    // overlay. If funding fails, we treat the fetch as failed (caller
    // surfaces an error). If only candles fail, render bars without
    // the price line.
    const [fundingRes, candleRes] = await Promise.allSettled([
      loadFundingHistory(ticker, fromMs),
      window.DydxApi.fetchCandles(ticker, '1HOUR', { fromMs })
    ]);
    if (fundingRes.status === 'rejected') {
      throw fundingRes.reason || new Error('funding fetch failed');
    }
    if (candleRes.status === 'rejected') {
      console.warn('[funding-chart] candles fetch failed; rendering bars only',
        candleRes.reason && candleRes.reason.message);
    }
    return {
      fundingRows: fundingRes.value,
      candleRows: (candleRes.status === 'fulfilled' && candleRes.value && candleRes.value.candles) || [],
      candlesMissing: candleRes.status === 'rejected',
      fetchedAt: Date.now()
    };
  }

  async function loadChartForTicker(ticker) {
    if (!ticker) return;
    ChartState.currentTicker = ticker;
    const entry = ChartState.data.get(ticker);
    if (isFresh(entry)) {
      // Supersede any older in-flight fetch's token so when it
      // eventually resolves, its post-await guard treats itself as
      // stale and doesn't paint the wrong ticker onto the canvas.
      ChartState.activeRequest = null;
      presentChartFromCache(ticker);
      return;
    }
    const token = Symbol(ticker);
    ChartState.activeRequest = token;
    setChartStatus('Fetching…', 'fetching');
    setChartEmpty(null);
    try {
      const data = await fetchChartData(ticker);
      // Two-layer staleness guard: the symbol token catches racing
      // loadChartForTicker calls, and currentTicker catches the rare
      // case where activeRequest was cleared (by a cache-hit serve
      // for a different ticker) without superseding via token.
      if (ChartState.activeRequest !== token) return;
      if (ChartState.currentTicker !== ticker) return;
      ChartState.data.set(ticker, data);
      presentChartFromCache(ticker);
    } catch (e) {
      if (ChartState.activeRequest !== token) return;
      if (ChartState.currentTicker !== ticker) return;
      console.warn('[funding-chart] fetch failed', e && e.message);
      setChartStatus('Fetch failed', 'error');
      setChartEmpty('Fetch failed — try a different market');
    } finally {
      if (ChartState.activeRequest === token) ChartState.activeRequest = null;
    }
  }

  // Idempotent: re-renders from cache when the data is still fresh;
  // refetches when stale or absent.
  function ensureChartLoaded() {
    const tk = ChartState.currentTicker;
    if (!tk) return;
    const entry = ChartState.data.get(tk);
    if (isFresh(entry)) {
      presentChartFromCache(tk);
    } else {
      loadChartForTicker(tk);
    }
  }

  // Called by activateTab('market'): the chart, the funding table's last
  // settled rates and the hero's settlement prices, the tab's indexer
  // reads beyond the snapshot. The chart goes first, so the hero joins
  // its settlement walk when that one reaches back far enough.
  function ensureLiveDataLoaded() {
    ensureChartLoaded();
    ensureSettledRatesLoaded();
    ensureHeroPricesLoaded();
  }

  // Invoked by the dashboard's auto-refresh path. Drops the chart,
  // settlement-history and settled-rate caches so the next
  // render/tab-activation refetches.
  function invalidateLiveCache() {
    ChartState.data.clear();
    FundingHistory.byTicker.clear();
    FundingHistory.generation += 1;
    SettledRates.byTicker.clear();
    SettledRates.generation += 1;
  }

  // The inputs of the window's views (hero, cards, table) and the
  // window bounds their payments were picked for (null before a render).
  const WindowState = { payments: null, marketsMap: null, inputGaps: null, bounds: null };

  function windowBounds() {
    return { first: firstWindowHour(), last: lastSettledHour() };
  }

  // Picks the window's payments and paints the hero, the cards and the
  // table from them.
  function renderWindowViews() {
    const { payments, marketsMap, inputGaps } = WindowState;
    WindowState.bounds = windowBounds();
    const inWin = inputGaps.payments ? [] : paymentsInWindow(payments);
    HeroState.inWin = inWin;
    renderHero();
    const ledger = fundingLedger(inWin);
    renderFundingKpiCards(ledger, inputGaps.payments);
    renderFundingAnalysis(ledger, marketsMap, inputGaps);
  }

  // A settlement walk that lands can move the window's last settled hour,
  // and a fixed window's first hour with it: the views are repainted on
  // the payments of the moved window.
  function repaintIfWindowMoved() {
    if (!WindowState.bounds) return;
    const bounds = windowBounds();
    if (bounds.first === WindowState.bounds.first && bounds.last === WindowState.bounds.last) return;
    renderWindowViews();
    if (isMarketTabActive()) ensureSettledRatesLoaded();
  }

  // Single entry point for the Market Structure tab. `payments` is the
  // /fundingPayments rows, `fills` the /fills rows (the hero's exposure),
  // `gaps` why an input is missing ('' when loaded): { payments, markets,
  // fills, fillsByMarket, incompleteWindows }, fillsByMarket a Map of
  // market → why its fills are short, incompleteWindows the
  // { market, fromMs, toMs } of every position whose fill attribution is
  // incomplete (toMs null while open). With a payments gap every funding
  // figure reads '—' with that reason instead of $0; with a fills gap, or
  // a market fill gap in a market the hero covers (its window's exposure,
  // or an incomplete position whose window overlaps it), the hero does.
  // `snapshotAtMs` is when those inputs were fetched (processData's
  // snapshot time): every window ends there.
  function render(payments, marketsMap, gaps, fills, snapshotAtMs) {
    const inputGaps = { payments: '', markets: '', fills: '', fillsByMarket: new Map(), incompleteWindows: [],
                        ...(gaps || {}) };
    HeroState.snapshotAtMs = snapshotAtMs;
    HeroState.fills = fills;
    HeroState.gap = inputGaps.payments || inputGaps.fills;
    HeroState.fillGaps = inputGaps.fillsByMarket;
    HeroState.incompleteWindows = inputGaps.incompleteWindows;
    WindowState.payments = payments;
    WindowState.marketsMap = marketsMap;
    WindowState.inputGaps = inputGaps;
    renderWindowViews();
    populateChartPicker(payments, marketsMap);
    initChartPicker();
    // When Market tab is the currently-active tab, route through
    // ensureChartLoaded so the initial fetch fires AFTER the picker
    // has populated ChartState.currentTicker. (activateTab('market')
    // also calls ensureLiveDataLoaded, but it runs BEFORE loadDashboard
    // populates the picker and the table when 'market' is the restored
    // tab — the pre-render call no-ops on a null currentTicker and an
    // empty table, so this call is the one that actually starts the
    // loads.) For non-active tabs, just re-render from cache so pill
    // clicks still take effect.
    if (ChartState.currentTicker) {
      if (isMarketTabActive()) {
        ensureChartLoaded();
      } else {
        presentChartFromCache(ChartState.currentTicker);
      }
    }
    if (isMarketTabActive()) {
      ensureSettledRatesLoaded();
      ensureHeroPricesLoaded();
    }
  }

  // Window-toggle pills, plus the chart caption stating how far back the
  // All pill reaches. Takes a no-arg rerender callback so the panel
  // module does not have to reach back into the inline orchestration's
  // allData state.
  function initToggle(rerender) {
    window.AppDom.updateElement('fundingChartMaxDays',
      String(window.AppConstants.FUNDING_CHART_MAX_DAYS));
    const pills = document.querySelectorAll('.funding-hero__pill');
    if (!pills.length) return;
    const active = getFundingWindowDays();
    pills.forEach(p => p.classList.toggle('active', p.dataset.window === active));
    pills.forEach(p => {
      p.addEventListener('click', () => {
        try { localStorage.setItem(FUNDING_WINDOW_KEY, p.dataset.window); } catch (e) {}
        pills.forEach(x => x.classList.toggle('active', x === p));
        if (typeof rerender === 'function') rerender();
      });
    });
  }

  window.AppPanels = window.AppPanels || {};
  window.AppPanels.market = {
    render,
    initToggle,
    ensureLiveDataLoaded,
    invalidateLiveCache,
    _internal: { pickDefaultTicker }
  };
})();
