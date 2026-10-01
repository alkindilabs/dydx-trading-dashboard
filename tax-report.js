/**
 * Capital-gains tax-year report (Portugal, EUR-aware).
 * Exposes global `TaxReport` with pure helpers (no DOM, no network).
 *
 * Single source of truth for tax math. Mirrors the `risk-metrics.js`
 * pattern: row-level data is identical regardless of Portuguese fiscal
 * category — the category only changes totals-card labels and whether
 * the holding-days column renders. The 365-day exemption that applies
 * to spot crypto under Categoria G is NOT auto-applied to perp gains:
 * accountants decide on a case-by-case basis.
 *
 * Per-row realized P&L and fees come from
 * RiskMetrics.attributeFillsToPositions (one FIFO walk over /fills,
 * a flip fill's fee split by size between its two positions), not from
 * /perpetualPositions.realizedPnl — the indexer field is known to
 * undercount heavily-scaled accounts. FIFO over fills is the
 * dashboard-wide authoritative source for realized P&L.
 *
 * Depends on window.RiskMetrics (attributeFillsToPositions,
 * hasCompleteAttribution, isFifoUsableFill and timestampMs must be
 * available at runtime; tax-report.js loads after risk-metrics.js) and
 * window.AppConstants (SIZE_SIGNIFICANT_DIGITS for the export cells,
 * MS_PER_DAY for holding days).
 */

(function () {
    'use strict';

    const CLASSIFICATIONS = {
        E: {
            id: 'E',
            label: 'Categoria E (derivativos)',
            flatRate: 0.28,
            showHolding: false
        },
        G: {
            id: 'G',
            label: 'Categoria G (cripto-ativos)',
            flatRate: 0.28,
            showHolding: true,
            holdingExemptionDays: 365
        }
    };

    function isNumber(n) {
        return typeof n === 'number' && !isNaN(n) && isFinite(n);
    }

    function num(v) {
        const n = parseFloat(v);
        return isNumber(n) ? n : 0;
    }

    function tsMs(s) {
        return window.RiskMetrics.timestampMs(s);
    }

    function dateUTC(iso) {
        const t = tsMs(iso);
        if (t === null) return null;
        return new Date(t).toISOString().slice(0, 10);
    }

    function closedAtYearUTC(p) {
        const t = tsMs(p && p.closedAt);
        if (t === null) return null;
        return new Date(t).getUTCFullYear();
    }

    function availableYearsFromPositions(positions) {
        const seen = new Set();
        (positions || []).forEach(p => {
            if (!p || p.status !== 'CLOSED') return;
            const y = closedAtYearUTC(p);
            if (y !== null) seen.add(y);
        });
        return [...seen].sort((a, b) => b - a);
    }

    // The FIFO walk skips fills with invalid price/size/side
    // (RiskMetrics.isFifoUsableFill is the one definition), and such a
    // fill inside a position's window leaves its attribution incomplete.
    function allFillsFifoUsable(windowFills) {
        return windowFills.every(f => window.RiskMetrics.isFifoUsableFill(f));
    }

    function netRealizedPnl(realizedPnlUSD, netFundingUSD, feesUSD) {
        return num(realizedPnlUSD) + num(netFundingUSD) - num(feesUSD);
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

    // `attribution` is this position's RiskMetrics.attributeFillsToPositions
    // entry: realized + fees come from the market-wide FIFO walk, so year
    // totals reconcile to /historical-pnl. While that attribution is
    // incomplete they are null (the row reads '—' and blanks the year
    // totals) rather than a number that may hold another position's fills.
    // `windowFills` (the market's fills inside [createdAt, closedAt]) only
    // feed the fill count and the invalid-fill flag.
    function buildRowFromWindowFills(position, windowFills, overlap, attribution) {
        const complete = window.RiskMetrics.hasCompleteAttribution(attribution);
        const hasInvalidFill = !allFillsFifoUsable(windowFills);
        const realizedPnlUSD = complete ? attribution.realized : null;
        const feesUSD = complete ? attribution.fees : null;
        const netFundingUSD = num(position.netFunding);
        const netUSD = complete ? netRealizedPnl(realizedPnlUSD, netFundingUSD, feesUSD) : null;
        const { peakSize, entryPrice, exitPrice } = attributedSizeAndPrices(attribution);
        const openMs = tsMs(position.createdAt);
        const closeMs = tsMs(position.closedAt);
        const holdingDays = (openMs !== null && closeMs !== null && closeMs >= openMs)
            ? Math.floor((closeMs - openMs) / window.AppConstants.MS_PER_DAY)
            : null;
        return {
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
            fillCount: windowFills.length,
            realizedPnlEUR: undefined,
            netFundingEUR: undefined,
            feesEUR: undefined,
            netEUR: undefined,
            fxRate: undefined,
            holdingDays,
            // Flag name is historical: an audit hint that another closed
            // position's window touches this one (every reversal pair
            // does), covering fees and realized P&L alike (see CLAUDE.md
            // Tax-report section). The attributed values stay exact.
            _feeAttributionWarning: !!overlap,
            // Reason CSV consumers can branch on instead of guessing from
            // `fillCount`. One of: null | 'no-fills-in-window' |
            // 'invalid-fill-in-slice' | 'attribution-incomplete'.
            _realizedFillError: realizedFillError(complete, windowFills, hasInvalidFill),
            _hasInvalidFill: hasInvalidFill,
            // True when the fill attribution could not tie this position to
            // exactly its own fills; realized / fees / net are then null.
            _attributionIncomplete: !complete,
            _fxMissing: false
        };
    }

    // Idempotent: clears any prior EUR fields / _fxMissing flag before
    // re-applying so repeated calls on the same rows produce a clean
    // result regardless of order of (rate-present, rate-missing). The
    // missingFxDates array on `warnings` is also truncated upfront so
    // a previously-stale date does not linger after re-running with
    // rates that have since become available.
    function convertRowsToEur(rows, fxRates, warnings) {
        if (warnings) {
            if (Array.isArray(warnings.missingFxDates)) {
                warnings.missingFxDates.length = 0;
            } else {
                warnings.missingFxDates = [];
            }
        }
        const missing = (warnings && warnings.missingFxDates) || [];
        (rows || []).forEach(row => {
            row.fxRate = undefined;
            row.realizedPnlEUR = undefined;
            row.netFundingEUR = undefined;
            row.feesEUR = undefined;
            row.netEUR = undefined;
            row._fxMissing = false;
            const rate = fxRates && row.closedDateUTC ? fxRates[row.closedDateUTC] : undefined;
            if (isNumber(rate)) {
                const toEur = usd => (isNumber(usd) ? usd * rate : undefined);
                row.fxRate = rate;
                row.realizedPnlEUR = toEur(row.realizedPnlUSD);
                row.netFundingEUR = toEur(row.netFundingUSD);
                row.feesEUR = toEur(row.feesUSD);
                row.netEUR = toEur(row.netUSD);
            } else {
                row._fxMissing = true;
                if (row.closedDateUTC && missing.indexOf(row.closedDateUTC) === -1) {
                    missing.push(row.closedDateUTC);
                }
            }
        });
        if (warnings) warnings.missingFxDates = missing;
        return rows;
    }

    // EUR totals collapse to `undefined` when no row had a usable rate
    // — distinguishes "unconverted" from a real `€0.00` result.
    // All-or-nothing like the dashboard classifier: while any row has
    // incomplete fill attribution (`incompleteCount` > 0), every total that
    // needs fills (net, gross gains / losses, fees, in USD and EUR) is
    // `undefined`; funding and the row count stay. A partial year total
    // would under- or over-state what is owed.
    function summarize(rows, classification) {
        const cls = (classification && CLASSIFICATIONS[classification.id || classification])
            || CLASSIFICATIONS.E;
        let netUSD = 0, grossGainsUSD = 0, grossLossesUSD = 0;
        let feesUSD = 0, fundingUSD = 0;
        let netEUR = 0, grossGainsEUR = 0, grossLossesEUR = 0;
        let feesEUR = 0, fundingEUR = 0;
        let count = 0, winCount = 0, lossCount = 0, scratchCount = 0;
        let eurRowCount = 0;
        let eurMissingCount = 0;
        let incompleteCount = 0;
        (rows || []).forEach(row => {
            count++;
            fundingUSD += row.netFundingUSD;
            if (isNumber(row.fxRate)) fundingEUR += row.netFundingEUR;
            if (row._attributionIncomplete) {
                incompleteCount++;
                if (!isNumber(row.fxRate)) eurMissingCount++;
                return;
            }
            netUSD += row.netUSD;
            feesUSD += row.feesUSD;
            if (row.netUSD > 0) { grossGainsUSD += row.netUSD; winCount++; }
            else if (row.netUSD < 0) { grossLossesUSD += row.netUSD; lossCount++; }
            else { scratchCount++; }
            if (isNumber(row.fxRate)) {
                eurRowCount++;
                netEUR += row.netEUR;
                feesEUR += row.feesEUR;
                if (row.netEUR > 0) grossGainsEUR += row.netEUR;
                else if (row.netEUR < 0) grossLossesEUR += row.netEUR;
            } else {
                eurMissingCount++;
            }
        });
        const complete = incompleteCount === 0;
        const eurAvailable = eurRowCount > 0;
        const fillsTotal = (value, available = true) => (complete && available ? value : undefined);
        return {
            label: cls.label,
            classificationId: cls.id,
            netUSD: fillsTotal(netUSD),
            netEUR: fillsTotal(netEUR, eurAvailable),
            grossGainsUSD: fillsTotal(grossGainsUSD),
            grossGainsEUR: fillsTotal(grossGainsEUR, eurAvailable),
            grossLossesUSD: fillsTotal(grossLossesUSD),
            grossLossesEUR: fillsTotal(grossLossesEUR, eurAvailable),
            feesUSD: fillsTotal(feesUSD),
            feesEUR: fillsTotal(feesEUR, eurAvailable),
            fundingUSD,
            fundingEUR: eurAvailable ? fundingEUR : undefined,
            count,
            winCount,
            lossCount,
            scratchCount,
            incompleteCount,
            eurRowCount,
            eurMissingCount,
            eurPartial: eurMissingCount > 0 && eurRowCount > 0
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
    function sweepOverlapsPerMarket(closedByMarket, overlapSet) {
        Object.values(closedByMarket).forEach(list => {
            const items = [];
            for (let i = 0; i < list.length; i++) {
                const openMs = tsMs(list[i].createdAt);
                const closeMs = tsMs(list[i].closedAt);
                if (openMs === null || closeMs === null) continue;
                items.push({ p: list[i], openMs, closeMs, marked: false });
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

    // Pre-group fills by market AND pre-compute the per-market overlap
    // set in a single pass each. Within each market, fills are sorted
    // by parsed createdAt (ms) once and per-position window slicing uses binary
    // search for the lower/upper bounds, so per-row work stays
    // O(log marketFills + windowSize) instead of O(marketFills). For
    // accounts with thousands of fills in one market this avoids
    // freezing the Tax tab.
    function buildYearReport(positions, fills, year, fxRates) {
        const warnings = {
            feeAttributionAmbiguousCount: 0,
            missingFxDates: [],
            incompleteAttributionCount: 0
        };
        const closed = (positions || []).filter(p => p && p.status === 'CLOSED');
        const inYear = closed.filter(p => closedAtYearUTC(p) === year);

        const fillsByMarket = {};
        (fills || []).forEach(f => {
            if (!f || !f.market) return;
            const ms = tsMs(f.createdAt);
            if (ms === null) return;
            if (!fillsByMarket[f.market]) fillsByMarket[f.market] = [];
            fillsByMarket[f.market].push({ f, ms });
        });
        Object.values(fillsByMarket).forEach(arr => arr.sort((a, b) => a.ms - b.ms));

        // Every position (OPEN included) takes part in the attribution so a
        // fill belonging to a still-open position is never claimed by a
        // closed one.
        const attributionByPosition = window.RiskMetrics.attributeFillsToPositions(positions, fills);

        const overlapSet = new WeakSet();
        const closedByMarket = {};
        closed.forEach(p => {
            const m = p.market || 'Unknown';
            if (!closedByMarket[m]) closedByMarket[m] = [];
            closedByMarket[m].push(p);
        });
        sweepOverlapsPerMarket(closedByMarket, overlapSet);

        const rows = inYear.map(p => {
            const openMs = tsMs(p.createdAt);
            const closeMs = tsMs(p.closedAt);
            let windowFills = [];
            if (openMs !== null && closeMs !== null) {
                const indexed = fillsByMarket[p.market];
                if (indexed && indexed.length) {
                    const lo = lowerBound(indexed, openMs);
                    const hi = lowerBound(indexed, closeMs + 1);
                    windowFills = new Array(hi - lo);
                    for (let i = lo; i < hi; i++) windowFills[i - lo] = indexed[i].f;
                }
            }
            return buildRowFromWindowFills(p, windowFills, overlapSet.has(p), attributionByPosition.get(p));
        });
        rows.sort((a, b) => {
            const at = tsMs(a.closedAtISO) || 0;
            const bt = tsMs(b.closedAtISO) || 0;
            return bt - at;
        });
        rows.forEach(r => {
            if (r._feeAttributionWarning) warnings.feeAttributionAmbiguousCount++;
            if (r._attributionIncomplete) warnings.incompleteAttributionCount++;
        });
        if (fxRates) convertRowsToEur(rows, fxRates, warnings);
        const totals = summarize(rows, null);
        return { rows, totals, warnings };
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

    function fmtUsd(n) {
        return isNumber(n) ? n.toFixed(2) : '';
    }

    function fmtEur(n) {
        return isNumber(n) ? n.toFixed(2) : '';
    }

    // Size and price cells at the precision the Positions board shows
    // sizes in (AppConstants.SIZE_SIGNIFICANT_DIGITS), so the float noise
    // of summed fills (0.30000000000000004) stays out of the exports.
    function atSizePrecision(n) {
        return isNumber(n) ? Number(n.toPrecision(window.AppConstants.SIZE_SIGNIFICANT_DIGITS)) : n;
    }

    function exportRow(row) {
        return {
            ...row,
            peakSize: atSizePrecision(row.peakSize),
            entryPrice: atSizePrecision(row.entryPrice),
            exitPrice: atSizePrecision(row.exitPrice)
        };
    }

    function fmtSize(n) {
        return isNumber(n) ? atSizePrecision(n).toString() : '';
    }

    function toCsv(rows, classification, year) {
        const cls = (classification && CLASSIFICATIONS[classification.id || classification])
            || CLASSIFICATIONS.E;
        const header = [
            'closed_at_utc', 'opened_at_utc', 'market', 'side',
            'peak_size', 'entry_price', 'exit_price',
            'realized_pnl_usd', 'net_funding_usd', 'fees_usd', 'net_usd',
            'fx_rate_usd_eur',
            'realized_pnl_eur', 'net_funding_eur', 'fees_eur', 'net_eur',
            'holding_days',
            'fill_count', 'realized_fill_error',
            'invalid_fill_in_window',
            'attribution_warning', 'attribution_incomplete', 'fx_missing'
        ];
        const meta = `# Categoria ${cls.id} — ${cls.label} — Portugal tax year ${year}`;
        const out = [meta, header.map(csvEscape).join(',')];
        (rows || []).forEach(row => {
            out.push([
                row.closedAtISO || '',
                row.createdAtISO || '',
                row.market,
                row.side,
                fmtSize(row.peakSize),
                fmtSize(row.entryPrice),
                fmtSize(row.exitPrice),
                fmtUsd(row.realizedPnlUSD),
                fmtUsd(row.netFundingUSD),
                fmtUsd(row.feesUSD),
                fmtUsd(row.netUSD),
                isNumber(row.fxRate) ? row.fxRate.toFixed(6) : '',
                fmtEur(row.realizedPnlEUR),
                fmtEur(row.netFundingEUR),
                fmtEur(row.feesEUR),
                fmtEur(row.netEUR),
                row.holdingDays === null ? '' : String(row.holdingDays),
                typeof row.fillCount === 'number' ? String(row.fillCount) : '',
                row._realizedFillError || '',
                row._hasInvalidFill ? 'true' : 'false',
                row._feeAttributionWarning ? 'true' : 'false',
                row._attributionIncomplete ? 'true' : 'false',
                row._fxMissing ? 'true' : 'false'
            ].map(csvEscape).join(','));
        });
        return out.join('\r\n') + '\r\n';
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
    const EXPORT_SCHEMA_VERSION = 3;

    function toJson(rows, totals, classification, year) {
        const cls = (classification && CLASSIFICATIONS[classification.id || classification])
            || CLASSIFICATIONS.E;
        const payload = jsonNullifyUndefined({
            meta: {
                classification: cls.id,
                classificationLabel: cls.label,
                year,
                generatedAt: new Date().toISOString(),
                schemaVersion: EXPORT_SCHEMA_VERSION
            },
            totals,
            rows: Array.isArray(rows) ? rows.map(exportRow) : rows
        });
        return JSON.stringify(payload, null, 2);
    }

    window.TaxReport = {
        CLASSIFICATIONS,
        buildYearReport,
        netRealizedPnl,
        convertRowsToEur,
        summarize,
        toCsv,
        toJson,
        availableYearsFromPositions,
        closedAtYearUTC,
        _internal: { csvEscape }
    };
})();
