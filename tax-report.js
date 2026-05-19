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
 * Per-row realized P&L is derived from sliced /fills via FIFO
 * (RiskMetrics.computeRealizedFromFills), not from
 * /perpetualPositions.realizedPnl — the indexer field is known to
 * undercount heavily-scaled accounts and is also mutated upstream by
 * normalizeRealizedPnl, so its post-pipeline value is not a clean
 * reference. FIFO over fills is the dashboard-wide authoritative
 * source for realized P&L.
 *
 * Depends on window.RiskMetrics (computeRealizedFromFills must be
 * available at runtime; tax-report.js loads after risk-metrics.js).
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

    // Returns null for absent/invalid values so downstream code can
    // distinguish "field unavailable" from a legitimate zero. Used for
    // size/entry/exit columns where 0 has a real trading meaning and
    // must not be conflated with missing data.
    function maybeNum(v) {
        if (v === null || v === undefined || v === '') return null;
        const n = parseFloat(v);
        return isNumber(n) ? n : null;
    }

    function tsMs(s) {
        const t = Date.parse(s || '');
        return Number.isFinite(t) ? t : null;
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

    // Slice the fills array down to those in (same market,
    // [createdAt, closedAt] window). Side is intentionally NOT filtered:
    // /v4/fills sides are BUY/SELL while positions are LONG/SHORT, AND
    // both sides legitimately belong to a position's lifecycle (BUY
    // opens a LONG, SELL closes it; SELL opens a SHORT, BUY closes it).
    function fillsInWindow(position, fills) {
        if (!position) return [];
        const market = position.market;
        const openMs = tsMs(position.createdAt);
        const closeMs = tsMs(position.closedAt);
        if (openMs === null || closeMs === null) return [];
        return (fills || []).filter(f => {
            if (!f || f.market !== market) return false;
            const ms = tsMs(f.createdAt);
            return ms !== null && ms >= openMs && ms <= closeMs;
        });
    }

    // Internal slice helper: caller already filtered by market, so we
    // only check the time window. Used by the optimized batch path in
    // buildYearReport to avoid re-scanning the full global fills list
    // for every closed position.
    function fillsInWindowFromMarketSlice(position, marketFills) {
        const openMs = tsMs(position.createdAt);
        const closeMs = tsMs(position.closedAt);
        if (openMs === null || closeMs === null) return [];
        return (marketFills || []).filter(f => {
            if (!f) return false;
            const ms = tsMs(f.createdAt);
            return ms !== null && ms >= openMs && ms <= closeMs;
        });
    }

    function hasOverlapInMarket(position, closedPositions) {
        if (!position) return false;
        const market = position.market;
        const openMs = tsMs(position.createdAt);
        const closeMs = tsMs(position.closedAt);
        if (openMs === null || closeMs === null) return false;
        return (closedPositions || []).some(other => {
            if (!other || other === position) return false;
            if (other.market !== market) return false;
            const oOpen = tsMs(other.createdAt);
            const oClose = tsMs(other.closedAt);
            if (oOpen === null || oClose === null) return false;
            return !(oClose < openMs || oOpen > closeMs);
        });
    }

    function aggregateFeesForPosition(position, fills, closedPositions) {
        const sliced = fillsInWindow(position, fills);
        let totalFee = 0;
        sliced.forEach(f => { totalFee += num(f.fee); });
        return {
            totalFee,
            fillCount: sliced.length,
            warning: hasOverlapInMarket(position, closedPositions) ? 'overlap' : null
        };
    }

    function fifoRealizedForMarket(market, fills) {
        const RM = (typeof window !== 'undefined' && window.RiskMetrics) || null;
        if (!RM || typeof RM.computeRealizedFromFills !== 'function') {
            return { realized: 0, error: 'no-RiskMetrics' };
        }
        const fifo = RM.computeRealizedFromFills(fills);
        return { realized: (fifo.byMarket && fifo.byMarket[market]) || 0 };
    }

    // Unique-assigns each fill to the smallest-openMs closed position whose
    // [open, close] contains it (ties: smaller closeMs). Without this,
    // boundary fills land in two adjacent windows and double-count.
    //
    // fillsByMarket must be `{ [market]: [{ f, ms }] }` already sorted by
    // ms ascending — buildYearReport produces it once and shares.
    function buildFillOwnershipMap(closedPositions, fillsByMarket) {
        const owner = new Map();
        if (!Array.isArray(closedPositions) || !closedPositions.length) return owner;
        if (!fillsByMarket) return owner;

        const positionsByMarket = {};
        closedPositions.forEach(p => {
            if (!p || p.status !== 'CLOSED') return;
            const openMs = tsMs(p.createdAt);
            const closeMs = tsMs(p.closedAt);
            if (openMs === null || closeMs === null) return;
            const m = p.market || 'Unknown';
            if (!positionsByMarket[m]) positionsByMarket[m] = [];
            positionsByMarket[m].push({ p, openMs, closeMs });
        });
        Object.values(positionsByMarket).forEach(arr =>
            arr.sort((a, b) => a.openMs - b.openMs || a.closeMs - b.closeMs)
        );

        Object.entries(positionsByMarket).forEach(([market, plist]) => {
            const marketFills = fillsByMarket[market];
            if (!marketFills || !marketFills.length) return;
            let nextUnopenedIdx = 0;
            const activeByOpenMs = [];
            for (let i = 0; i < marketFills.length; i++) {
                const fm = marketFills[i].ms;
                while (nextUnopenedIdx < plist.length && plist[nextUnopenedIdx].openMs <= fm) {
                    activeByOpenMs.push(plist[nextUnopenedIdx]);
                    nextUnopenedIdx++;
                }
                for (let k = activeByOpenMs.length - 1; k >= 0; k--) {
                    if (activeByOpenMs[k].closeMs < fm) activeByOpenMs.splice(k, 1);
                }
                if (!activeByOpenMs.length) continue;
                owner.set(marketFills[i].f, activeByOpenMs[0].p);
            }
        });
        return owner;
    }

    // True iff the signed BUY/SELL sizes across the slice sum to ~0,
    // i.e. the slice contains a complete open + close history for the
    // position. Tolerance covers float drift on scaled trades.
    function fillsNetFlat(windowFills) {
        let netSize = 0;
        for (let i = 0; i < windowFills.length; i++) {
            const f = windowFills[i];
            const sz = Math.abs(parseFloat(f && f.size));
            if (!isNumber(sz) || sz <= 0) continue;
            const s = (f.side || '').toUpperCase();
            if (s === 'BUY') netSize += sz;
            else if (s === 'SELL') netSize -= sz;
        }
        return Math.abs(netSize) <= 1e-6;
    }

    // RiskMetrics.computeRealizedFromFills silently SKIPS fills with
    // invalid price/size/side. A flat slice can still contain such
    // fills; FIFO then returns 0 from the orphan inventory of the
    // SKIPPED fills, and the caller would have no way to know the
    // realized total is understated. Reject those slices explicitly
    // so the row drops to the no-FIFO warning path.
    function allFillsFifoUsable(windowFills) {
        for (let i = 0; i < windowFills.length; i++) {
            const f = windowFills[i];
            if (!f) return false;
            const sz = Math.abs(parseFloat(f.size));
            if (!isNumber(sz) || sz <= 0) return false;
            const px = parseFloat(f.price);
            if (!isNumber(px)) return false;
            const side = (f.side || '').toUpperCase();
            if (side !== 'BUY' && side !== 'SELL') return false;
        }
        return true;
    }

    function realizedFromSlicedFills(position, fills) {
        const sliced = fillsInWindow(position, fills);
        if (!sliced.length) {
            return { realized: 0, fillCount: 0, error: 'no-fills-in-window' };
        }
        // Same two gates buildYearReport uses:
        //   1) the slice must net flat (open + close fills both present)
        //   2) every fill must be FIFO-usable (valid price/size/side)
        // so the helper and the batch path return the same authoritative
        // / not-authoritative verdict and a future caller cannot
        // re-introduce a silent-zero by skipping either check.
        if (!fillsNetFlat(sliced)) {
            return { realized: 0, fillCount: sliced.length, error: 'partial-fill-slice' };
        }
        if (!allFillsFifoUsable(sliced)) {
            return { realized: 0, fillCount: sliced.length, error: 'invalid-fill-in-slice' };
        }
        const r = fifoRealizedForMarket(position.market, sliced);
        return { realized: r.realized, fillCount: sliced.length, error: r.error };
    }

    function netRealizedPnl(realizedPnlUSD, netFundingUSD, feesUSD) {
        return num(realizedPnlUSD) + num(netFundingUSD) - num(feesUSD);
    }

    // With `attribution`, realized + fees come from the continuous-FIFO
    // ownership map (year totals reconcile to /historical-pnl). Without
    // it (single-position callers), falls back to per-window FIFO with
    // gates that zero realized on suspect slices.
    function buildRowFromWindowFills(position, windowFills, overlap, attribution) {
        let realizedPnlUSD = 0;
        let realizedError = null;
        if (!windowFills.length) {
            realizedError = 'no-fills-in-window';
        } else if (!fillsNetFlat(windowFills)) {
            realizedError = 'partial-fill-slice';
        } else if (!allFillsFifoUsable(windowFills)) {
            realizedError = 'invalid-fill-in-slice';
        }
        let feesUSD = 0;
        if (attribution && attribution.realizedByFill && attribution.fillOwner) {
            const { realizedByFill, fillOwner } = attribution;
            windowFills.forEach(f => {
                if (!f) return;
                if (fillOwner.has(f) && fillOwner.get(f) !== position) return;
                if (realizedByFill.has(f)) realizedPnlUSD += realizedByFill.get(f);
                feesUSD += num(f.fee);
            });
        } else {
            if (!realizedError) {
                const r = fifoRealizedForMarket(position.market, windowFills);
                realizedPnlUSD = r.realized;
                if (r.error) realizedError = r.error;
            }
            windowFills.forEach(f => { feesUSD += num(f.fee); });
        }
        const netFundingUSD = num(position.netFunding);
        const netUSD = netRealizedPnl(realizedPnlUSD, netFundingUSD, feesUSD);
        // Preserve null when source fields are absent so the UI/exports
        // can render `—` instead of a misleading `0`. Do NOT fall back
        // to `position.size`: closed positions on the dYdX indexer have
        // `size: "0"` after close, which would turn an unavailable max
        // size into a hard 0.
        const rawMaxSize = maybeNum(position.maxSize)
            ?? maybeNum(position.sumOpen);
        const maxSize = rawMaxSize === null ? null : Math.abs(rawMaxSize);
        const entryPrice = maybeNum(position.entryPrice);
        const exitPrice = maybeNum(position.exitPrice);
        const openMs = tsMs(position.createdAt);
        const closeMs = tsMs(position.closedAt);
        const holdingDays = (openMs !== null && closeMs !== null && closeMs >= openMs)
            ? Math.floor((closeMs - openMs) / 86400000)
            : null;
        return {
            closedAtISO: position.closedAt || null,
            createdAtISO: position.createdAt || null,
            closedDateUTC: dateUTC(position.closedAt),
            market: position.market || '',
            side: (position.side || '').toUpperCase(),
            maxSize,
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
            // Flag name is historical; the same overlap makes BOTH fee
            // and realized P&L attribution ambiguous (see CLAUDE.md
            // Tax-report section). Downstream UI/CSV/JSON must treat it
            // as a combined attribution warning.
            _feeAttributionWarning: !!overlap,
            _realizedFromFills: !realizedError,
            // Reason that downstream renderers (panel tooltip, status
            // strip, CSV consumers) can branch on instead of guessing
            // from `fillCount`. One of: null | 'no-fills-in-window' |
            // 'partial-fill-slice' | 'invalid-fill-in-slice'.
            _realizedFillError: realizedError,
            _fxMissing: false
        };
    }

    // Back-compat wrapper for the optimized path: takes the full market
    // slice (unsorted, time-unfiltered) and slices to the window. Used
    // only by the public buildRow API; the batch path skips this step.
    function buildRowFromSlice(position, marketFills, overlap) {
        const windowFills = fillsInWindowFromMarketSlice(position, marketFills);
        return buildRowFromWindowFills(position, windowFills, overlap);
    }

    // Public buildRow keeps the old signature for backward compatibility
    // and unit tests. Internally uses the slice helper.
    function buildRow(position, fills, closedPositions) {
        const marketFills = (fills || []).filter(f => f && f.market === position.market);
        return buildRowFromSlice(
            position,
            marketFills,
            hasOverlapInMarket(position, closedPositions)
        );
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
                row.fxRate = rate;
                row.realizedPnlEUR = row.realizedPnlUSD * rate;
                row.netFundingEUR = row.netFundingUSD * rate;
                row.feesEUR = row.feesUSD * rate;
                row.netEUR = row.netUSD * rate;
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
        (rows || []).forEach(row => {
            count++;
            netUSD += row.netUSD;
            feesUSD += row.feesUSD;
            fundingUSD += row.netFundingUSD;
            if (row.netUSD > 0) { grossGainsUSD += row.netUSD; winCount++; }
            else if (row.netUSD < 0) { grossLossesUSD += row.netUSD; lossCount++; }
            else { scratchCount++; }
            if (isNumber(row.fxRate)) {
                eurRowCount++;
                netEUR += row.netEUR;
                feesEUR += row.feesEUR;
                fundingEUR += row.netFundingEUR;
                if (row.netEUR > 0) grossGainsEUR += row.netEUR;
                else if (row.netEUR < 0) grossLossesEUR += row.netEUR;
            } else {
                eurMissingCount++;
            }
        });
        const eurAvailable = eurRowCount > 0;
        return {
            label: cls.label,
            classificationId: cls.id,
            netUSD,
            netEUR: eurAvailable ? netEUR : undefined,
            grossGainsUSD,
            grossGainsEUR: eurAvailable ? grossGainsEUR : undefined,
            grossLossesUSD,
            grossLossesEUR: eurAvailable ? grossLossesEUR : undefined,
            feesUSD,
            feesEUR: eurAvailable ? feesEUR : undefined,
            fundingUSD,
            fundingEUR: eurAvailable ? fundingEUR : undefined,
            count,
            winCount,
            lossCount,
            scratchCount,
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
    // by createdAtMs once and per-position window slicing uses binary
    // search for the lower/upper bounds, so per-row work stays
    // O(log marketFills + windowSize) instead of O(marketFills). For
    // accounts with thousands of fills in one market this avoids
    // freezing the Tax tab.
    function buildYearReport(positions, fills, year, fxRates) {
        const warnings = {
            feeAttributionAmbiguousCount: 0,
            missingFxDates: [],
            positionsWithoutFifoCount: 0,
            positionsWithInvalidFillCount: 0
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

        const RM = (typeof window !== 'undefined' && window.RiskMetrics) || null;
        const byFillResult = (RM && typeof RM.computeRealizedByFill === 'function')
            ? RM.computeRealizedByFill(fills || [])
            : null;
        const realizedByFill = byFillResult ? byFillResult.byFill : null;
        const fillOwner = realizedByFill ? buildFillOwnershipMap(closed, fillsByMarket) : null;
        const attribution = (realizedByFill && fillOwner)
            ? { realizedByFill, fillOwner }
            : null;

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
            return buildRowFromWindowFills(p, windowFills, overlapSet.has(p), attribution);
        });
        rows.sort((a, b) => {
            const at = tsMs(a.closedAtISO) || 0;
            const bt = tsMs(b.closedAtISO) || 0;
            return bt - at;
        });
        rows.forEach(r => {
            if (r._feeAttributionWarning) warnings.feeAttributionAmbiguousCount++;
            if (!r._realizedFromFills) warnings.positionsWithoutFifoCount++;
            if (r._realizedFillError === 'invalid-fill-in-slice') warnings.positionsWithInvalidFillCount++;
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

    function fmtSize(n) {
        return isNumber(n) ? n.toString() : '';
    }

    function toCsv(rows, classification, year) {
        const cls = (classification && CLASSIFICATIONS[classification.id || classification])
            || CLASSIFICATIONS.E;
        const header = [
            'closed_at_utc', 'opened_at_utc', 'market', 'side',
            'max_size', 'entry_price', 'exit_price',
            'realized_pnl_usd', 'net_funding_usd', 'fees_usd', 'net_usd',
            'fx_rate_usd_eur',
            'realized_pnl_eur', 'net_funding_eur', 'fees_eur', 'net_eur',
            'holding_days',
            'fill_count', 'realized_from_fills', 'realized_fill_error',
            'attribution_warning', 'fx_missing'
        ];
        const meta = `# Categoria ${cls.id} — ${cls.label} — Portugal tax year ${year}`;
        const out = [meta, header.map(csvEscape).join(',')];
        (rows || []).forEach(row => {
            out.push([
                row.closedAtISO || '',
                row.createdAtISO || '',
                row.market,
                row.side,
                fmtSize(row.maxSize),
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
                row._realizedFromFills ? 'true' : 'false',
                row._realizedFillError || '',
                row._feeAttributionWarning ? 'true' : 'false',
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

    function toJson(rows, totals, classification, year) {
        const cls = (classification && CLASSIFICATIONS[classification.id || classification])
            || CLASSIFICATIONS.E;
        const payload = jsonNullifyUndefined({
            meta: {
                classification: cls.id,
                classificationLabel: cls.label,
                year,
                generatedAt: new Date().toISOString(),
                schemaVersion: 1
            },
            totals,
            rows
        });
        return JSON.stringify(payload, null, 2);
    }

    window.TaxReport = {
        CLASSIFICATIONS,
        buildYearReport,
        aggregateFeesForPosition,
        realizedFromSlicedFills,
        netRealizedPnl,
        convertRowsToEur,
        summarize,
        toCsv,
        toJson,
        availableYearsFromPositions,
        closedAtYearUTC,
        _internal: { csvEscape, buildRow, dateUTC, tsMs, fillsInWindow, hasOverlapInMarket }
    };
})();
