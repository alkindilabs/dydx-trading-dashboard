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

    function realizedFromSlicedFills(position, fills) {
        const sliced = fillsInWindow(position, fills);
        if (!sliced.length) {
            return { realized: 0, fillCount: 0, error: 'no-fills-in-window' };
        }
        const r = fifoRealizedForMarket(position.market, sliced);
        return { realized: r.realized, fillCount: sliced.length, error: r.error };
    }

    function netRealizedPnl(realizedPnlUSD, netFundingUSD, feesUSD) {
        return num(realizedPnlUSD) + num(netFundingUSD) - num(feesUSD);
    }

    // Build a row using pre-sliced fills (market filter already applied)
    // and a pre-computed overlap flag. Internal — see buildYearReport.
    function buildRowFromSlice(position, marketFills, overlap) {
        const windowFills = fillsInWindowFromMarketSlice(position, marketFills);
        let realizedPnlUSD = 0;
        let realizedError = null;
        if (!windowFills.length) {
            realizedError = 'no-fills-in-window';
        } else {
            const r = fifoRealizedForMarket(position.market, windowFills);
            realizedPnlUSD = r.realized;
            if (r.error) realizedError = r.error;
        }
        let feesUSD = 0;
        windowFills.forEach(f => { feesUSD += num(f.fee); });
        const netFundingUSD = num(position.netFunding);
        const netUSD = netRealizedPnl(realizedPnlUSD, netFundingUSD, feesUSD);
        const maxSize = Math.abs(num(position.maxSize || position.sumOpen || position.size));
        const entryPrice = num(position.entryPrice);
        const exitPrice = num(position.exitPrice);
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
            _feeAttributionWarning: !!overlap,
            _realizedFromFills: !realizedError,
            _fxMissing: false
        };
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
    // result regardless of order of (rate-present, rate-missing).
    function convertRowsToEur(rows, fxRates, warnings) {
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

    // Pre-group fills by market AND pre-compute the per-market overlap
    // set in a single pass each so per-row work stays O(market_fills + 1)
    // instead of O(total_fills + total_positions). For accounts with
    // thousands of fills across many positions this avoids freezing the
    // browser on the Tax tab.
    function buildYearReport(positions, fills, year, fxRates) {
        const warnings = {
            feeAttributionAmbiguousCount: 0,
            missingFxDates: [],
            positionsWithoutFifoCount: 0
        };
        const closed = (positions || []).filter(p => p && p.status === 'CLOSED');
        const inYear = closed.filter(p => closedAtYearUTC(p) === year);

        const fillsByMarket = {};
        (fills || []).forEach(f => {
            if (!f || !f.market) return;
            if (!fillsByMarket[f.market]) fillsByMarket[f.market] = [];
            fillsByMarket[f.market].push(f);
        });

        // Overlap detection: scan positions per-market only. Total work
        // = sum over markets of (per-market positions)² — much smaller
        // than total_closed² for users trading many markets.
        const overlapSet = new WeakSet();
        const closedByMarket = {};
        closed.forEach(p => {
            const m = p.market || 'Unknown';
            if (!closedByMarket[m]) closedByMarket[m] = [];
            closedByMarket[m].push(p);
        });
        Object.values(closedByMarket).forEach(list => {
            for (let i = 0; i < list.length; i++) {
                if (overlapSet.has(list[i])) continue;
                const aOpen = tsMs(list[i].createdAt);
                const aClose = tsMs(list[i].closedAt);
                if (aOpen === null || aClose === null) continue;
                for (let j = i + 1; j < list.length; j++) {
                    const bOpen = tsMs(list[j].createdAt);
                    const bClose = tsMs(list[j].closedAt);
                    if (bOpen === null || bClose === null) continue;
                    if (!(bClose < aOpen || bOpen > aClose)) {
                        overlapSet.add(list[i]);
                        overlapSet.add(list[j]);
                        break;
                    }
                }
            }
        });

        const rows = inYear.map(p => buildRowFromSlice(
            p,
            fillsByMarket[p.market] || [],
            overlapSet.has(p)
        ));
        rows.sort((a, b) => {
            const at = tsMs(a.closedAtISO) || 0;
            const bt = tsMs(b.closedAtISO) || 0;
            return bt - at;
        });
        rows.forEach(r => {
            if (r._feeAttributionWarning) warnings.feeAttributionAmbiguousCount++;
            if (!r._realizedFromFills) warnings.positionsWithoutFifoCount++;
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
            'fill_count', 'realized_from_fills', 'fee_attribution_warning', 'fx_missing'
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
                row._feeAttributionWarning ? 'true' : 'false',
                row._fxMissing ? 'true' : 'false'
            ].map(csvEscape).join(','));
        });
        return out.join('\r\n') + '\r\n';
    }

    function toJson(rows, totals, classification, year) {
        const cls = (classification && CLASSIFICATIONS[classification.id || classification])
            || CLASSIFICATIONS.E;
        const payload = {
            meta: {
                classification: cls.id,
                classificationLabel: cls.label,
                year,
                generatedAt: new Date().toISOString(),
                schemaVersion: 1
            },
            totals,
            rows
        };
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
