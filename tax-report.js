/**
 * Capital-gains tax-year report (Portugal, EUR-aware).
 * Exposes global `TaxReport` with pure helpers (no DOM, no network).
 *
 * Single source of truth for tax math. Gains count when each operation
 * happens (CIRS art. 10.º n.º 3): every fill portion's FIFO realized P&L
 * and fee count in the UTC year of its fill, and every funding payment in
 * the UTC year it was paid, for CLOSED and still-OPEN positions alike. A
 * row is one position, holding only that position's events of the year.
 * EUR figures convert each event at the ECB EUR/USD quote of its own UTC
 * date (CIRS art. 23.º).
 *
 * Per-portion realized P&L and fees come from
 * RiskMetrics.attributeFillsToPositions (one FIFO walk over /fills,
 * a flip fill's fee split by size between its two positions), not from
 * /perpetualPositions.realizedPnl — the indexer field is known to
 * undercount heavily-scaled accounts. FIFO over fills is the
 * dashboard-wide authoritative source for realized P&L. Funding comes
 * from the /fundingPayments rows, each tied to the position that held it.
 *
 * Every amount is at cents (RiskMetrics.wholeCents, half away from zero
 * on the decimal the amount stands for): a row's USD realized P&L, funding
 * and fees are each rounded once from their exact sum (fees and funding
 * added as decimals, RiskMetrics.exactSum), its EUR ones per event date
 * (each date's USD at cents ÷ that date's quote, rounded to cents once
 * from the exact quotient by RiskMetrics.quotientCents, then summed), its net
 * derives from those rounded parts, and every year total sums the rows'
 * cents. The screen, the CSV and the JSON all carry these figures, so a
 * column foots to its total as shown.
 *
 * Depends on window.RiskMetrics (attributeFillsToPositions,
 * hasCompleteAttribution, isFifoUsableFill, timestampMs, exactSum,
 * portionFeesTotal, wholeCents and quotientCents must be available at runtime; tax-report.js loads after
 * risk-metrics.js), window.Format (fmtFixed, the one display rounding of
 * the money and price cells, at runtime) and window.AppConstants
 * (SIZE_SIGNIFICANT_DIGITS for the export cells, CENT_DIGITS,
 * CENTS_PER_DOLLAR).
 */

(function () {
    'use strict';

    // Perpetual futures are derivative operations: mais-valias under
    // Categoria G, CIRS art. 10.º n.º 1 e). The one category the report
    // uses; the note travels with it to the tab and the exports.
    const CLASSIFICATION = Object.freeze({
        id: 'G',
        label: 'Categoria G — mais-valias, operações com instrumentos derivados (art. 10.º n.º 1 e) CIRS)',
        flatRate: 0.28,
        note: 'Confirm the classification with an accountant.'
    });

    // How the exports state the year and FX rules they were built on.
    const EVENT_BASIS = 'Each fill\'s realized P&L and fee in the UTC year of the fill; each funding payment in the UTC year it was paid';
    const FX_BASIS = 'EUR = USD / ECB EUR/USD reference quote of each event\'s UTC date (preceding business day on weekends and holidays)';

    // A row's position is still open, or has closed (possibly in a later
    // year than the one reported).
    const ROW_STATUS = Object.freeze({ OPEN: 'open', CLOSED: 'closed' });

    function isNumber(n) {
        return typeof n === 'number' && !isNaN(n) && isFinite(n);
    }

    function tsMs(s) {
        return window.RiskMetrics.timestampMs(s);
    }

    function dateUTC(iso) {
        const t = tsMs(iso);
        if (t === null) return null;
        return new Date(t).toISOString().slice(0, 10);
    }

    // The UTC year of an ISO timestamp, null when unparseable. It equals
    // mainland Portugal's civil year at the 31 Dec / 1 Jan boundary (WET =
    // UTC+0), and the viewer's browser timezone must not move events.
    function yearUTC(iso) {
        const t = tsMs(iso);
        if (t === null) return null;
        return new Date(t).getUTCFullYear();
    }

    // The UTC years of the records' createdAt, as a Set.
    function yearsOf(records) {
        const seen = new Set();
        (records || []).forEach(r => {
            const y = r ? yearUTC(r.createdAt) : null;
            if (y !== null) seen.add(y);
        });
        return seen;
    }

    // Every UTC year a report can hold a row in, newest first: each year
    // holding a fill, a funding payment, a close or a position's open, and
    // every year an incomplete position's window spans (positionInYear),
    // so each year an incomplete row reads '—' in is selectable.
    function availableYears(positions, fills, fundingPayments) {
        const list = (positions || []).filter(Boolean);
        const seen = new Set([...yearsOf(fills), ...yearsOf(fundingPayments), ...yearsOf(list)]);
        list.forEach(p => {
            const y = p.status === 'CLOSED' ? yearUTC(p.closedAt) : null;
            if (y !== null) seen.add(y);
        });
        const attribution = window.RiskMetrics.attributeFillsToPositions(list, fills || []);
        const lastYear = latestEventYear(fills, fundingPayments);
        list.filter(p => !window.RiskMetrics.hasCompleteAttribution(attribution.get(p))).forEach(p => {
            const span = incompleteWindowYears(p, lastYear);
            for (let y = span.first; y <= span.last; y++) seen.add(y);
        });
        return [...seen].sort((a, b) => b - a);
    }

    // The latest UTC year of any fill or funding payment, null without
    // one: where an open position's window ends.
    function latestEventYear(fills, fundingPayments) {
        const years = [...yearsOf(fills), ...yearsOf(fundingPayments)];
        return years.length ? Math.max(...years) : null;
    }

    // The FIFO walk skips fills with invalid price/size/side
    // (RiskMetrics.isFifoUsableFill is the one definition), and such a
    // fill inside a position's window leaves its attribution incomplete.
    function allFillsFifoUsable(windowFills) {
        return windowFills.every(f => window.RiskMetrics.isFifoUsableFill(f));
    }

    // realized + funding − fees; null while any part is not a finite
    // number: an unknown amount is unknown, never $0.
    function netRealizedPnl(realizedPnlUSD, netFundingUSD, feesUSD) {
        const parts = [realizedPnlUSD, netFundingUSD, feesUSD];
        if (!parts.every(isNumber)) return null;
        return realizedPnlUSD + netFundingUSD - feesUSD;
    }

    function cents(amount) {
        return window.RiskMetrics.wholeCents(amount);
    }

    function fromCents(wholeCents) {
        return wholeCents / window.AppConstants.CENTS_PER_DOLLAR;
    }

    function atCents(amount) {
        return fromCents(cents(amount));
    }

    // Net of parts already at cents, added as whole cents so it is exactly
    // the cent their displayed values add up to.
    function netAtCents(realized, funding, fees) {
        const netCents = netRealizedPnl(cents(realized), cents(funding), cents(fees));
        return netCents === null ? null : fromCents(netCents);
    }

    // Peak size and VWAP prices from the fill attribution, the same values
    // the Positions board shows; null while the attribution is incomplete.
    function attributedSizeAndPrices(attribution) {
        if (!window.RiskMetrics.hasCompleteAttribution(attribution)) {
            return { peakSize: null, entryPrice: null, exitPrice: null };
        }
        return {
            peakSize: attribution.peakSize,
            entryPrice: attribution.entryVwap,
            exitPrice: attribution.exitVwap
        };
    }

    // Why a row's fill attribution is incomplete, most specific first; null
    // when it is complete.
    function realizedFillError(complete, windowFills, hasInvalidFill) {
        if (complete) return null;
        if (!windowFills.length) return 'no-fills-in-window';
        if (hasInvalidFill) return 'invalid-fill-in-slice';
        return 'attribution-incomplete';
    }

    // A position's window: [createdAt, closedAt], open-ended while it has
    // no parseable closedAt. null without a parseable createdAt.
    function positionWindow(p) {
        const openMs = tsMs(p.createdAt);
        if (openMs === null) return null;
        const closeMs = tsMs(p.closedAt);
        return { openMs, endMs: closeMs === null ? Infinity : closeMs };
    }

    function paymentMarket(payment) {
        return payment.ticker || payment.market || 'Unknown';
    }

    // Why a row's funding is unknown when a payment it could hold cannot
    // be placed (attributeFundingPayments' `unplaced`).
    const UNPLACEABLE_FUNDING_REASON = 'A funding payment cannot be placed: a closed position has no valid close time';

    // Ties each /fundingPayments row to the position that held it: the
    // position in its market whose window holds the payment's createdAt,
    // on the payment's side when the row names one, the earliest-created
    // when several qualify. Only an OPEN position's window is open-ended:
    // a CLOSED position without a parseable closedAt could hold any
    // payment at or after its createdAt, so such a payment cannot be
    // placed. Returns { byPosition: Map<position, payment[]>, unattributed:
    // payment[], unplaced: Map<position, payment[]> }; a payment without a
    // parseable createdAt, that no listed position held, or that cannot be
    // placed is unattributed, and one that cannot be placed is also listed
    // under every position that could hold it (`unplaced`).
    function attributeFundingPayments(positions, payments) {
        const byPosition = new Map();
        const unplaced = new Map();
        const unattributed = [];
        const windowsByMarket = {};
        const listUnder = (map, p, payment) => {
            if (!map.has(p)) map.set(p, []);
            map.get(p).push(payment);
        };
        positions.forEach(p => {
            const w = positionWindow(p);
            if (!w) return;
            const m = p.market || 'Unknown';
            if (!windowsByMarket[m]) windowsByMarket[m] = [];
            const closeUnknown = p.status !== 'OPEN' && tsMs(p.closedAt) === null;
            windowsByMarket[m].push({ p, ...w, closeUnknown, side: (p.side || '').toUpperCase() });
        });
        Object.values(windowsByMarket).forEach(list => list.sort((a, b) => a.openMs - b.openMs));
        payments.forEach(payment => {
            if (!payment) return;
            const ms = tsMs(payment.createdAt);
            const side = (payment.side || '').toUpperCase();
            const candidates = ms === null ? [] : (windowsByMarket[paymentMarket(payment)] || [])
                .filter(w => w.openMs <= ms && ms <= w.endMs && (!side || w.side === side));
            if (!candidates.length) {
                unattributed.push(payment);
            } else if (candidates.some(w => w.closeUnknown)) {
                unattributed.push(payment);
                candidates.forEach(w => listUnder(unplaced, w.p, payment));
            } else {
                listUnder(byPosition, candidates[0].p, payment);
            }
        });
        return { byPosition, unattributed, unplaced };
    }

    // Records of `year` that cannot be placed in a row: dated in the year,
    // or undated (they could belong to any year).
    function countInYearOrUndated(records, year) {
        return records.filter(r => {
            const y = yearUTC(r.createdAt);
            return y === null || y === year;
        }).length;
    }

    // Fills that no position's attribution holds a portion of, except an
    // unusable fill (RiskMetrics.isFifoUsableFill) inside a listed
    // position's window in its market (an undated one is inside every
    // window there): the walk gives it no portion, and that position's
    // row is already incomplete for it.
    function unattributedFills(fills, attributionByPosition) {
        const attributed = new Set();
        const windowsByMarket = {};
        attributionByPosition.forEach((a, p) => {
            (a.portions || []).forEach(part => attributed.add(part.fill));
            const w = positionWindow(p);
            if (!w) return;
            const m = p.market || 'Unknown';
            (windowsByMarket[m] = windowsByMarket[m] || []).push(w);
        });
        const insideListedWindow = f => {
            const ms = tsMs(f.createdAt);
            return (windowsByMarket[f.market || 'Unknown'] || [])
                .some(w => ms === null || (w.openMs <= ms && ms <= w.endMs));
        };
        return (fills || []).filter(f => f && !attributed.has(f)
            && (window.RiskMetrics.isFifoUsableFill(f) || !insideListedWindow(f)));
    }

    // Σ the portions' FIFO realized P&L (computed, not indexer decimals),
    // the exact decimal sum (RiskMetrics.exactSum) like the attribution's
    // own realized.
    function realizedSum(portions) {
        return window.RiskMetrics.exactSum(portions.map(part => part.realized));
    }

    // A position's year-`year` events by UTC date, oldest first. Each date
    // carries its realized P&L and fees (from the fill portions) and its
    // funding (from the payments), each that date's sum at cents;
    // convertRowsToEur adds its quote and its EUR amounts, converted from
    // those cents and rounded to cents.
    function eventsByDate(portions, payments) {
        const RM = window.RiskMetrics;
        const byDate = new Map();
        const on = iso => {
            const date = dateUTC(iso);
            if (!byDate.has(date)) byDate.set(date, { date, portions: [], payments: [] });
            return byDate.get(date);
        };
        portions.forEach(part => { on(part.fill.createdAt).portions.push(part); });
        payments.forEach(fp => { on(fp.createdAt).payments.push(fp.payment); });
        return [...byDate.values()]
            .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
            .map(day => ({
                date: day.date,
                realizedUSD: atCents(realizedSum(day.portions)),
                feesUSD: atCents(RM.portionFeesTotal(day.portions)),
                fundingUSD: atCents(RM.exactSum(day.payments)),
                usdPerEur: undefined, realizedEUR: undefined, feesEUR: undefined, fundingEUR: undefined
            }));
    }

    // True when the position belongs in `year`'s report: it has a fill
    // portion or a funding payment dated in the year. A position whose
    // attribution is incomplete has no trustworthy portions, so it also
    // appears in every year its window spans (an open window running to
    // `lastYear`), reading '—' there.
    function positionInYear(p, complete, portions, payments, year, lastYear) {
        if (portions.length || payments.length) return true;
        if (complete) return false;
        const span = incompleteWindowYears(p, lastYear);
        return span.first <= year && year <= span.last;
    }

    // The UTC years { first, last } an incomplete position's row appears
    // in: its open year to its close year, or, while it is open, to
    // `lastYear` (the latest year of any fill or payment); its close year
    // alone without a valid open, and none (first > last) without either.
    function incompleteWindowYears(p, lastYear) {
        const openYear = yearUTC(p.createdAt);
        const closeYear = yearUTC(p.closedAt);
        if (openYear === null) {
            return closeYear === null ? { first: Infinity, last: -Infinity } : { first: closeYear, last: closeYear };
        }
        const endYear = closeYear !== null ? closeYear : Math.max(openYear, lastYear === null ? openYear : lastYear);
        return { first: openYear, last: endYear };
    }

    // `portions` are this position's attribution portions whose fill is
    // dated in the year; realized + fees are their sums at cents, so year
    // totals reconcile to the year's fills to the cent per row, and the
    // fill count is the distinct fills among them (a reversing fill counts
    // in both of its rows). While the attribution is incomplete realized
    // and fees are null (the row reads '—' and blanks the year totals)
    // rather than a number that may hold another position's fills.
    // `payments` are the position's funding payments dated in the year,
    // or null when /fundingPayments did not load; funding is then unknown,
    // never $0, as it is when a payment's amount does not parse, or when
    // the position could hold a payment of the year that cannot be placed
    // (`unplaced`, UNPLACEABLE_FUNDING_REASON). The net that needs it is
    // null too.
    // `windowFills` (the market's fills inside the position's window)
    // feed only the invalid-fill flag and the no-fills reason.
    function buildRow(position, { attribution, portions, payments, unplaced, windowFills, overlap, eventYears }) {
        const RM = window.RiskMetrics;
        const complete = RM.hasCompleteAttribution(attribution);
        const hasInvalidFill = !allFillsFifoUsable(windowFills);
        const realizedPnlUSD = complete ? atCents(realizedSum(portions)) : null;
        const feesUSD = complete ? atCents(RM.portionFeesTotal(portions)) : null;
        const fundingUnplaced = unplaced.length > 0;
        const funding = payments && !fundingUnplaced ? RM.exactSum(payments.map(fp => fp.payment)) : null;
        const fundingMissing = funding === null;
        const netFundingUSD = fundingMissing ? null : atCents(funding);
        const netUSD = complete && !fundingMissing
            ? netAtCents(realizedPnlUSD, netFundingUSD, feesUSD)
            : null;
        const { peakSize, entryPrice, exitPrice } = attributedSizeAndPrices(attribution);
        return {
            status: position.status === 'OPEN' ? ROW_STATUS.OPEN : ROW_STATUS.CLOSED,
            closedAtISO: position.closedAt || null,
            createdAtISO: position.createdAt || null,
            closedDateUTC: dateUTC(position.closedAt),
            market: position.market || '',
            side: (position.side || '').toUpperCase(),
            peakSize,
            entryPrice,
            exitPrice,
            realizedPnlUSD,
            netFundingUSD,
            feesUSD,
            netUSD,
            fillCount: new Set(portions.map(part => part.fill)).size,
            eventsByDate: eventsByDate(complete ? portions : [], fundingMissing ? [] : payments),
            realizedPnlEUR: undefined,
            netFundingEUR: undefined,
            feesEUR: undefined,
            netEUR: undefined,
            // Flag name is historical: an audit hint that another
            // position's window in the market (open-ended while OPEN)
            // touches this one (every reversal pair does), covering fees
            // and realized P&L alike (see CLAUDE.md Tax-report section).
            // The attributed values stay exact.
            _feeAttributionWarning: !!overlap,
            // Reason CSV consumers can branch on instead of guessing from
            // `fillCount`. One of: null | 'no-fills-in-window' |
            // 'invalid-fill-in-slice' | 'attribution-incomplete'.
            _realizedFillError: realizedFillError(complete, windowFills, hasInvalidFill),
            _hasInvalidFill: hasInvalidFill,
            // True when the fill attribution could not tie this position to
            // exactly its own fills; realized / fees / net are then null.
            _attributionIncomplete: !complete,
            _fundingMissing: fundingMissing,
            // Why funding is unknown when the row says (null otherwise, and
            // while /fundingPayments did not load: the caller has that
            // reason). Not exported.
            _fundingMissingReason: fundingUnplaced ? UNPLACEABLE_FUNDING_REASON : null,
            // The first and last UTC year holding any of the whole
            // position's fill portions or funding payments (null without
            // one): a row of a position spanning years holds only the
            // year's amounts beside the position's own SIZE (PEAK), ENTRY,
            // EXIT and CLOSED. Not exported.
            _eventYears: eventYears,
            _fxMissing: false,
            _fxConverted: false
        };
    }

    function usableQuote(q) {
        return isNumber(q) && q > 0 ? q : undefined;
    }

    // `usdPerEurByDate` maps a date to the ECB EUR/USD reference quote
    // (USD per 1 EUR, FxRates.getRates), so EUR = USD / quote. Each of a
    // row's event dates converts at its own quote (written onto the event
    // as `usdPerEur`, with its EUR amounts at cents: its USD cents ÷ the
    // quote, rounded once from the exact quotient); the row's EUR
    // realized / funding / fees sum its dates' cents and its net EUR
    // derives from those. A row missing any of its quotes converts none
    // (`_fxMissing`), its EUR cells read '—' and the date joins
    // `warnings.missingFxDates`. `_fxConverted` marks a row whose EUR
    // figures are final.
    // Idempotent: clears any prior EUR fields / flags before re-applying,
    // and truncates warnings.missingFxDates upfront so a date that has
    // since gained a rate does not linger.
    function convertRowsToEur(rows, usdPerEurByDate, warnings) {
        if (warnings) {
            if (Array.isArray(warnings.missingFxDates)) {
                warnings.missingFxDates.length = 0;
            } else {
                warnings.missingFxDates = [];
            }
        }
        const missing = (warnings && warnings.missingFxDates) || [];
        (rows || []).forEach(row => {
            row.realizedPnlEUR = undefined;
            row.netFundingEUR = undefined;
            row.feesEUR = undefined;
            row.netEUR = undefined;
            row._fxMissing = false;
            row._fxConverted = false;
            const events = row.eventsByDate || [];
            events.forEach(e => {
                e.usdPerEur = usableQuote(usdPerEurByDate && usdPerEurByDate[e.date]);
                const toEur = usd => (e.usdPerEur === undefined
                    ? undefined
                    : fromCents(window.RiskMetrics.quotientCents(usd, e.usdPerEur)));
                e.realizedEUR = toEur(e.realizedUSD);
                e.fundingEUR = toEur(e.fundingUSD);
                e.feesEUR = toEur(e.feesUSD);
            });
            const unquoted = events.filter(e => e.usdPerEur === undefined).map(e => e.date);
            if (unquoted.length) {
                row._fxMissing = true;
                unquoted.forEach(d => { if (missing.indexOf(d) === -1) missing.push(d); });
                return;
            }
            const sumEur = (usd, key) => (isNumber(usd)
                ? fromCents(events.reduce((s, e) => s + cents(e[key]), 0))
                : undefined);
            row.realizedPnlEUR = sumEur(row.realizedPnlUSD, 'realizedEUR');
            row.netFundingEUR = sumEur(row.netFundingUSD, 'fundingEUR');
            row.feesEUR = sumEur(row.feesUSD, 'feesEUR');
            row.netEUR = isNumber(row.netUSD)
                ? netAtCents(row.realizedPnlEUR, row.netFundingEUR, row.feesEUR)
                : undefined;
            row._fxConverted = true;
        });
        missing.sort();
        if (warnings) warnings.missingFxDates = missing;
        return rows;
    }

    // Every UTC date the rows need an ECB quote for, oldest first.
    function fxDates(rows) {
        const dates = new Set();
        (rows || []).forEach(row => (row.eventsByDate || []).forEach(e => dates.add(e.date)));
        return [...dates].sort();
    }

    // All-or-nothing like the dashboard classifier: a year total is
    // `undefined` while any input it sums is unknown, never a partial
    // sum that would under- or over-state what is owed.
    //   - incomplete fill attribution (`incompleteCount`) or a fill of the
    //     year no position holds (`gaps.unattributedFillCount`) blanks net,
    //     gross gains / losses and fees;
    //   - unknown funding (`fundingMissingCount`) or a funding payment of
    //     the year no position held (`gaps.unattributedFundingCount`)
    //     blanks funding, net and gross gains / losses;
    //   - a row without FX (`eurMissingCount`) blanks every EUR total, so
    //     `undefined` also separates "unconverted" from €0.00; with every
    //     row converted (`eurComplete`) an EUR total is as known as its
    //     USD one.
    // `gaps` is the report's `warnings`. W / L / S count only rows whose
    // net is known.
    // Every total sums the rows' amounts as whole cents, so it is exactly
    // the sum of the cells shown. Gross gains / losses and W / L / S bucket
    // a row by the sign of its NET USD at cents (a net that shows $0.00 is
    // a scratch); the EUR gross lines bucket it by the sign of its own NET
    // EUR, so with per-event quotes one row can be a USD gain and an EUR
    // loss.
    function summarize(rows, gaps) {
        const unattributedFillCount = (gaps && gaps.unattributedFillCount) || 0;
        const unattributedFundingCount = (gaps && gaps.unattributedFundingCount) || 0;
        let netUSD = 0, grossGainsUSD = 0, grossLossesUSD = 0;
        let feesUSD = 0, fundingUSD = 0;
        let netEUR = 0, grossGainsEUR = 0, grossLossesEUR = 0;
        let feesEUR = 0, fundingEUR = 0;
        let count = 0, openCount = 0, winCount = 0, lossCount = 0, scratchCount = 0;
        let eurRowCount = 0;
        let eurMissingCount = 0;
        let incompleteCount = 0;
        let fundingMissingCount = 0;
        (rows || []).forEach(row => {
            count++;
            if (row.status === ROW_STATUS.OPEN) openCount++;
            const hasFx = row._fxConverted === true;
            if (!hasFx) eurMissingCount++;
            if (isNumber(row.netFundingUSD)) {
                fundingUSD += cents(row.netFundingUSD);
                if (hasFx) fundingEUR += cents(row.netFundingEUR);
            } else {
                fundingMissingCount++;
            }
            if (row._attributionIncomplete) {
                incompleteCount++;
                return;
            }
            feesUSD += cents(row.feesUSD);
            if (hasFx) {
                eurRowCount++;
                feesEUR += cents(row.feesEUR);
            }
            if (!isNumber(row.netUSD)) return;
            const rowNetUSD = cents(row.netUSD);
            netUSD += rowNetUSD;
            if (rowNetUSD > 0) { grossGainsUSD += rowNetUSD; winCount++; }
            else if (rowNetUSD < 0) { grossLossesUSD += rowNetUSD; lossCount++; }
            else { scratchCount++; }
            if (hasFx) {
                const rowNetEUR = cents(row.netEUR);
                netEUR += rowNetEUR;
                if (rowNetEUR > 0) grossGainsEUR += rowNetEUR;
                else if (rowNetEUR < 0) grossLossesEUR += rowNetEUR;
            }
        });
        const fillsKnown = incompleteCount === 0 && unattributedFillCount === 0;
        const fundingKnown = fundingMissingCount === 0 && unattributedFundingCount === 0;
        const netKnown = fillsKnown && fundingKnown;
        const eurComplete = count > 0 && eurMissingCount === 0;
        const usdTotal = (wholeCents, known) => (known ? fromCents(wholeCents) : undefined);
        const eurTotal = (wholeCents, known) => (known && eurComplete ? fromCents(wholeCents) : undefined);
        return {
            netUSD: usdTotal(netUSD, netKnown),
            netEUR: eurTotal(netEUR, netKnown),
            grossGainsUSD: usdTotal(grossGainsUSD, netKnown),
            grossGainsEUR: eurTotal(grossGainsEUR, netKnown),
            grossLossesUSD: usdTotal(grossLossesUSD, netKnown),
            grossLossesEUR: eurTotal(grossLossesEUR, netKnown),
            feesUSD: usdTotal(feesUSD, fillsKnown),
            feesEUR: eurTotal(feesEUR, fillsKnown),
            fundingUSD: usdTotal(fundingUSD, fundingKnown),
            fundingEUR: eurTotal(fundingEUR, fundingKnown),
            count,
            openCount,
            winCount,
            lossCount,
            scratchCount,
            incompleteCount,
            fundingMissingCount,
            unattributedFillCount,
            unattributedFundingCount,
            eurRowCount,
            eurMissingCount,
            eurComplete,
            eurPartial: eurMissingCount > 0 && eurMissingCount < count
        };
    }

    // Binary search: smallest index where arr[i].ms >= target.
    function lowerBound(arr, target) {
        let lo = 0, hi = arr.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (arr[mid].ms < target) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

    // Sweep-based overlap detection. Sort by createdAt; per cur:
    //   1. prune expired actives via in-place compaction (only when
    //      `minActiveClose < cur.openMs`, so non-expiring iterations
    //      cost O(1) instead of O(active.length))
    //   2. if any active remains, all of them overlap cur — mark cur,
    //      then walk only the `unmarkedActive` sub-list to mark any
    //      still-unmarked entries (avoids re-walking already-marked
    //      ones on every iteration)
    //
    // Each item is pushed to active and unmarkedActive once, removed
    // from each at most once, and marked at most once, so total sweep
    // work is O(n) amortized. With the per-market sort that gives
    // O(n log n) overall — even on degenerate "all positions overlap"
    // datasets that previously degraded to O(n²) work in two places
    // (the linear expiry scan + the linear active-mark walk).
    // Windows are positionWindow's, so an OPEN position's runs on to
    // Infinity and touches the closed position its reversing fill closed.
    function sweepOverlapsPerMarket(positionsByMarket, overlapSet) {
        Object.values(positionsByMarket).forEach(list => {
            const items = [];
            for (let i = 0; i < list.length; i++) {
                const w = positionWindow(list[i]);
                if (!w) continue;
                items.push({ p: list[i], openMs: w.openMs, closeMs: w.endMs, marked: false });
            }
            items.sort((a, b) => a.openMs - b.openMs);

            const active = [];           // every currently-active item
            const unmarkedActive = [];   // sub-list still not in overlapSet
            let minActiveClose = Infinity;

            for (let i = 0; i < items.length; i++) {
                const cur = items[i];
                if (active.length > 0 && minActiveClose < cur.openMs) {
                    // In-place compaction. Each kept item gets copied
                    // forward to writeIdx; expired items are dropped.
                    let writeIdx = 0;
                    let newMin = Infinity;
                    for (let k = 0; k < active.length; k++) {
                        const a = active[k];
                        if (a.closeMs >= cur.openMs) {
                            active[writeIdx++] = a;
                            if (a.closeMs < newMin) newMin = a.closeMs;
                        }
                    }
                    active.length = writeIdx;
                    minActiveClose = newMin;
                    // Same compaction on unmarkedActive
                    let uw = 0;
                    for (let k = 0; k < unmarkedActive.length; k++) {
                        if (unmarkedActive[k].closeMs >= cur.openMs) {
                            unmarkedActive[uw++] = unmarkedActive[k];
                        }
                    }
                    unmarkedActive.length = uw;
                }
                if (active.length > 0) {
                    overlapSet.add(cur.p);
                    cur.marked = true;
                    if (unmarkedActive.length > 0) {
                        for (let k = 0; k < unmarkedActive.length; k++) {
                            const u = unmarkedActive[k];
                            if (!u.marked) {
                                overlapSet.add(u.p);
                                u.marked = true;
                            }
                        }
                        unmarkedActive.length = 0;
                    }
                }
                active.push(cur);
                if (cur.closeMs < minActiveClose) minActiveClose = cur.closeMs;
                if (!cur.marked) unmarkedActive.push(cur);
            }
        });
    }

    // Fills grouped by market, each list sorted by parsed createdAt (ms)
    // once, so a position's window slices by binary search.
    function indexFillsByMarket(fills) {
        const fillsByMarket = {};
        (fills || []).forEach(f => {
            if (!f || !f.market) return;
            const ms = tsMs(f.createdAt);
            if (ms === null) return;
            if (!fillsByMarket[f.market]) fillsByMarket[f.market] = [];
            fillsByMarket[f.market].push({ f, ms });
        });
        Object.values(fillsByMarket).forEach(arr => arr.sort((a, b) => a.ms - b.ms));
        return fillsByMarket;
    }

    // The market's fills inside the position's window (both ends
    // inclusive, open-ended while OPEN): O(log marketFills + windowSize).
    function windowFillsOf(p, fillsByMarket) {
        const w = positionWindow(p);
        const indexed = fillsByMarket[p.market];
        if (!w || !indexed || !indexed.length) return [];
        const lo = lowerBound(indexed, w.openMs);
        const hi = w.endMs === Infinity ? indexed.length : lowerBound(indexed, w.endMs + 1);
        const out = new Array(hi - lo);
        for (let i = lo; i < hi; i++) out[i - lo] = indexed[i].f;
        return out;
    }

    // Open rows first (newest opened first), then closed rows by close
    // time, newest first, closes in one millisecond in the reverse of
    // their closing fills' chain order (RiskMetrics.byClosingOrder over
    // `closing`, each row's { closedAt, portions } of its whole position).
    function compareRows(closing, fills) {
        const oldestCloseFirst = window.RiskMetrics.byClosingOrder(fills);
        return (a, b) => {
            const aOpen = a.status === ROW_STATUS.OPEN;
            const bOpen = b.status === ROW_STATUS.OPEN;
            if (aOpen !== bOpen) return aOpen ? -1 : 1;
            const key = row => tsMs(aOpen ? row.createdAtISO : row.closedAtISO) || 0;
            return (key(b) - key(a)) || (aOpen ? 0 : oldestCloseFirst(closing.get(b), closing.get(a)));
        };
    }

    // `fundingPayments` is the /fundingPayments rows, or null when they did
    // not load (every row's funding is then unknown). The fill attribution
    // runs once over every position (OPEN included, so a fill of a
    // still-open position is never claimed by a closed one) and every
    // fill; the funding attribution once over every payment.
    function buildYearReport(positions, fills, fundingPayments, year, usdPerEurByDate) {
        const list = (positions || []).filter(Boolean);
        const paymentsLoaded = Array.isArray(fundingPayments);
        const attributionByPosition = window.RiskMetrics.attributeFillsToPositions(list, fills);
        const funding = attributeFundingPayments(list, paymentsLoaded ? fundingPayments : []);
        const fillsByMarket = indexFillsByMarket(fills);
        const lastYear = latestEventYear(fills, fundingPayments);
        const inYear = record => yearUTC(record.createdAt) === year;

        const overlapSet = new WeakSet();
        const positionsByMarket = {};
        list.forEach(p => {
            const m = p.market || 'Unknown';
            if (!positionsByMarket[m]) positionsByMarket[m] = [];
            positionsByMarket[m].push(p);
        });
        sweepOverlapsPerMarket(positionsByMarket, overlapSet);

        const rows = [];
        const closing = new Map();
        list.forEach(p => {
            const attribution = attributionByPosition.get(p);
            const complete = window.RiskMetrics.hasCompleteAttribution(attribution);
            const allPortions = attribution.portions || [];
            const allPayments = paymentsLoaded ? (funding.byPosition.get(p) || []) : [];
            const portions = allPortions.filter(part => inYear(part.fill));
            const payments = paymentsLoaded ? allPayments.filter(inYear) : null;
            const allUnplaced = funding.unplaced.get(p) || [];
            const unplaced = allUnplaced.filter(inYear);
            if (!positionInYear(p, complete, portions, [...(payments || []), ...unplaced], year, lastYear)) return;
            const row = buildRow(p, {
                attribution, portions, payments, unplaced,
                windowFills: windowFillsOf(p, fillsByMarket),
                overlap: overlapSet.has(p),
                eventYears: eventYearSpan([...allPortions.map(part => part.fill), ...allPayments, ...allUnplaced])
            });
            closing.set(row, { closedAt: p.closedAt, portions: allPortions });
            rows.push(row);
        });
        rows.sort(compareRows(closing, fills));

        const warnings = {
            feeAttributionAmbiguousCount: rows.filter(r => r._feeAttributionWarning).length,
            missingFxDates: [],
            incompleteAttributionCount: rows.filter(r => r._attributionIncomplete).length,
            unattributedFillCount: countInYearOrUndated(unattributedFills(fills, attributionByPosition), year),
            unattributedFundingCount: countInYearOrUndated(funding.unattributed, year)
        };
        if (usdPerEurByDate) convertRowsToEur(rows, usdPerEurByDate, warnings);
        const totals = summarize(rows, warnings);
        return { rows, totals, warnings };
    }

    // The first and last UTC year of the records' createdAt, null for none.
    function eventYearSpan(records) {
        const years = records.map(record => yearUTC(record.createdAt)).filter(y => y !== null);
        return years.length ? { first: Math.min(...years), last: Math.max(...years) } : null;
    }

    // RFC 4180: quote a field iff it contains comma, quote, CR, or LF.
    // Embedded quotes double up. Line terminator is CRLF.
    function csvEscape(value) {
        const s = value === undefined || value === null ? '' : String(value);
        if (/[",\r\n]/.test(s)) {
            return '"' + s.replace(/"/g, '""') + '"';
        }
        return s;
    }

    // A USD or EUR cell at cents through the one display rounding
    // (Format.fmtFixed); an amount that rounds to zero is written unsigned,
    // as the screen shows it.
    function fmtMoney(n) {
        return isNumber(n) ? window.Format.fmtFixed(n, window.AppConstants.CENT_DIGITS) : '';
    }

    // A size or price cell of the exports as a plain decimal, never in
    // exponent form ('0.000000406473'), at the precision the Positions
    // board shows sizes in (AppConstants.SIZE_SIGNIFICANT_DIGITS), rounded
    // once by the one display rule (Format.fmtSignificant), so the float
    // noise of summed fills (0.30000000000000004) stays out of the
    // exports. '' for no number.
    function exportDecimalText(n) {
        return isNumber(n) ? window.Format.fmtSignificant(n, window.AppConstants.SIZE_SIGNIFICANT_DIGITS) : '';
    }

    // The JSON export writes a size or price as the same plain decimal,
    // still a JSON number: the row carries it as a marked string that
    // toJson unquotes after JSON.stringify (the mark is a private-use
    // character JSON.stringify leaves as is, and only decimal text
    // follows it).
    const PLAIN_DECIMAL_MARK = '\uE000';
    const MARKED_PLAIN_DECIMAL = /"\uE000(-?\d+(?:\.\d+)?)"/g;

    function exportDecimal(n) {
        return isNumber(n) ? PLAIN_DECIMAL_MARK + exportDecimalText(n) : n;
    }

    function exportRow(row) {
        const { _eventYears, _fundingMissingReason, ...exported } = row;
        return {
            ...exported,
            peakSize: exportDecimal(row.peakSize),
            entryPrice: exportDecimal(row.entryPrice),
            exitPrice: exportDecimal(row.exitPrice)
        };
    }

    const PRICE_DECIMALS = 4;

    // Trailing zeros of a decimal fraction, with the point when nothing
    // is left after it ('3100.5000' → '3100.5', '10.0000' → '10').
    const TRAILING_FRACTION_ZEROS = /\.?0+$/;

    // A price at PRICE_DECIMALS for the on-screen table, trailing zeros
    // trimmed, rounded once by the one display rounding (Format.fmtFixed)
    // from the decimal the price stands for: the attribution's VWAP is the
    // exact decimal VWAP at the display core's 15 significant digits, so a
    // 4-decimal tie rounds up. null for no number.
    function priceText(price) {
        if (!isNumber(price)) return null;
        const rounded = window.Format.fmtFixed(price, PRICE_DECIMALS);
        return rounded.includes('.') ? rounded.replace(TRAILING_FRACTION_ZEROS, '') : rounded;
    }

    // The UTF-8 byte order mark the CSV opens with, so a spreadsheet
    // (Excel) reads the file as UTF-8 rather than a legacy codepage. The
    // year, category and basis the export was built on are in the JSON
    // export's meta and the file name, not in the CSV, whose first record
    // is the header.
    const UTF8_BOM = '\uFEFF';

    function toCsv(rows) {
        const header = [
            'status', 'closed_at_utc', 'opened_at_utc', 'market', 'side',
            'peak_size', 'entry_price', 'exit_price',
            'realized_pnl_usd', 'net_funding_usd', 'fees_usd', 'net_usd',
            'realized_pnl_eur', 'net_funding_eur', 'fees_eur', 'net_eur',
            'fill_count', 'realized_fill_error',
            'invalid_fill_in_window',
            'attribution_warning', 'attribution_incomplete', 'funding_missing', 'fx_missing'
        ];
        const out = [header.map(csvEscape).join(',')];
        (rows || []).forEach(row => {
            out.push([
                row.status || '',
                row.closedAtISO || '',
                row.createdAtISO || '',
                row.market,
                row.side,
                exportDecimalText(row.peakSize),
                exportDecimalText(row.entryPrice),
                exportDecimalText(row.exitPrice),
                fmtMoney(row.realizedPnlUSD),
                fmtMoney(row.netFundingUSD),
                fmtMoney(row.feesUSD),
                fmtMoney(row.netUSD),
                fmtMoney(row.realizedPnlEUR),
                fmtMoney(row.netFundingEUR),
                fmtMoney(row.feesEUR),
                fmtMoney(row.netEUR),
                typeof row.fillCount === 'number' ? String(row.fillCount) : '',
                row._realizedFillError || '',
                row._hasInvalidFill ? 'true' : 'false',
                row._feeAttributionWarning ? 'true' : 'false',
                row._attributionIncomplete ? 'true' : 'false',
                row._fundingMissing ? 'true' : 'false',
                row._fxMissing ? 'true' : 'false'
            ].map(csvEscape).join(','));
        });
        return UTF8_BOM + out.join('\r\n') + '\r\n';
    }

    // JSON.stringify silently drops object properties whose value is
    // undefined, so the export schema would otherwise vary with FX
    // coverage (missing EUR fields disappear instead of reading null).
    // Recursively replace undefined with explicit null so downstream
    // consumers see a stable shape and can tell "absent" from
    // "not part of this schema".
    function jsonNullifyUndefined(value) {
        if (value === undefined) return null;
        if (Array.isArray(value)) return value.map(jsonNullifyUndefined);
        if (value !== null && typeof value === 'object') {
            const out = {};
            Object.keys(value).forEach(k => { out[k] = jsonNullifyUndefined(value[k]); });
            return out;
        }
        return value;
    }

    // Bump when a CSV/JSON column is added, removed, renamed or changes meaning.
    // 2: max_size → peak_size (peak |net size| from fills), entry/exit are
    // fill VWAPs, a reversing fill's fee is split by size, rows with
    // incomplete fill attribution export empty profit cells with
    // attribution_incomplete = true, and realized_from_fills /
    // realized_fill_error follow that attribution's completeness (no
    // per-window net-flat check, no 'partial-fill-slice' value).
    // 3: realized_from_fills / _realizedFromFills dropped (always the
    // inverse of attribution_incomplete); realized_fill_error is the
    // reason column for attribution_incomplete = true.
    // 4: fx_rate_usd_eur / fxRate (Frankfurter's rounded USD→EUR inverse)
    // → fx_usd_per_eur / fxUsdPerEur, the ECB EUR/USD quote (EUR = USD /
    // quote); funding_missing / _fundingMissing added (unknown netFunding
    // exports empty funding and net cells); totals carry
    // fundingMissingCount, and every EUR total is null while any row
    // lacks FX.
    // 5: amounts by event date — a row holds only its position's fills and
    // funding payments dated in the year, OPEN positions included;
    // status / status column ('open' | 'closed') added; funding from
    // /fundingPayments rows; EUR converts each event at its own date's
    // quote, so fx_usd_per_eur / fxUsdPerEur give way to the per-date
    // eventsByDate (JSON); holding_days / holdingDays dropped with the
    // Categoria E / G choice (meta.classification is always 'G', with
    // classificationNote, eventBasis, fxBasis); totals carry openCount,
    // unattributedFillCount and unattributedFundingCount and drop
    // label / classificationId.
    // 6: every amount at cents (EUR per event date), net from the rounded
    // parts and totals summing the rows' cents; each eventsByDate entry
    // (JSON) carries realizedEUR / feesEUR / fundingEUR at cents; the
    // overlap flag (attribution_warning / _feeAttributionWarning) also
    // covers an OPEN position's open-ended window.
    // 7: fill_count / fillCount counts the distinct fills the row's year
    // portions hold (the attribution), not the fills in its window; each
    // eventsByDate entry's realizedUSD / feesUSD / fundingUSD is that
    // date's sum at cents, and its EUR converts from those cents; the CSV
    // meta line holds no comma.
    // 8: the CSV has no meta line (the header is its first record) and
    // opens with a UTF-8 BOM; each event's EUR is its USD cents ÷ quote
    // rounded to cents once from the exact quotient.
    // 9: JSON meta.asOf, when the figures were read (the snapshot), beside
    // generatedAt, when the file was written.
    const EXPORT_SCHEMA_VERSION = 9;

    // asOfMs: when the figures were read (the dashboard's snapshot time);
    // meta.asOf is null without a valid one.
    function toJson(rows, totals, year, asOfMs) {
        const asOf = Number.isFinite(asOfMs) ? new Date(asOfMs).toISOString() : undefined;
        const payload = jsonNullifyUndefined({
            meta: {
                classification: CLASSIFICATION.id,
                classificationLabel: CLASSIFICATION.label,
                classificationNote: CLASSIFICATION.note,
                eventBasis: EVENT_BASIS,
                fxBasis: FX_BASIS,
                year,
                asOf,
                generatedAt: new Date().toISOString(),
                schemaVersion: EXPORT_SCHEMA_VERSION
            },
            totals,
            rows: Array.isArray(rows) ? rows.map(exportRow) : rows
        });
        return JSON.stringify(payload, null, 2).replace(MARKED_PLAIN_DECIMAL, '$1');
    }

    window.TaxReport = {
        CLASSIFICATION,
        ROW_STATUS,
        buildYearReport,
        netRealizedPnl,
        convertRowsToEur,
        fxDates,
        summarize,
        toCsv,
        toJson,
        availableYears,
        yearUTC,
        priceText,
        _internal: { csvEscape }
    };
})();
