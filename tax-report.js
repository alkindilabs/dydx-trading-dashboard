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

    // Sum per-fill fees inside the position's [createdAt, closedAt] window
    // for the same market+side. Returns ambiguity flag when ANOTHER closed
    // position in the same (market, side) overlaps that window — pro-rata
    // splitting would fabricate; we keep the over-attributed total visible
    // and surface a warning the row inherits.
    function aggregateFeesForPosition(position, fills, closedPositions) {
        if (!position) return { totalFee: 0, fillCount: 0, warning: null };
        const market = position.market;
        const side = (position.side || '').toUpperCase();
        const openMs = tsMs(position.createdAt);
        const closeMs = tsMs(position.closedAt);
        if (openMs === null || closeMs === null) {
            return { totalFee: 0, fillCount: 0, warning: 'no-window' };
        }
        let totalFee = 0;
        let fillCount = 0;
        (fills || []).forEach(f => {
            if (!f) return;
            if (f.market !== market) return;
            if ((f.side || '').toUpperCase() !== side) return;
            const ms = tsMs(f.createdAt);
            if (ms === null || ms < openMs || ms > closeMs) return;
            totalFee += num(f.fee);
            fillCount++;
        });
        let warning = null;
        (closedPositions || []).forEach(other => {
            if (warning) return;
            if (!other || other === position) return;
            if (other.market !== market) return;
            if ((other.side || '').toUpperCase() !== side) return;
            const oOpen = tsMs(other.createdAt);
            const oClose = tsMs(other.closedAt);
            if (oOpen === null || oClose === null) return;
            if (oClose < openMs || oOpen > closeMs) return;
            warning = 'overlap';
        });
        return { totalFee, fillCount, warning };
    }

    // netUSD = realizedPnl + netFunding − (fees only when realizedPnl is the
    // VWAP-derived repair, which is provably gross). For indexer-supplied
    // realizedPnl the fee semantics are unverified — see _feeDoubleCountRisk
    // flag and the spot-check note in CLAUDE.md.
    function netRealizedPnl(realizedPnlUSD, netFundingUSD, feesUSD, derivedFlag) {
        const r = num(realizedPnlUSD);
        const f = num(netFundingUSD);
        const fee = num(feesUSD);
        return r + f - (derivedFlag ? fee : 0);
    }

    function buildRow(position, fills, closedPositions) {
        const realizedPnlUSD = num(position.realizedPnl);
        const netFundingUSD = num(position.netFunding);
        const derivedFlag = position._derivedRealizedPnl === true;
        const feeAgg = aggregateFeesForPosition(position, fills, closedPositions);
        const feesUSD = feeAgg.totalFee;
        const netUSD = netRealizedPnl(realizedPnlUSD, netFundingUSD, feesUSD, derivedFlag);
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
            realizedPnlEUR: undefined,
            netFundingEUR: undefined,
            feesEUR: undefined,
            netEUR: undefined,
            fxRate: undefined,
            holdingDays,
            _derivedRealizedPnl: derivedFlag,
            _feeAttributionWarning: feeAgg.warning === 'overlap',
            _fxMissing: false,
            _feeDoubleCountRisk: !derivedFlag && feesUSD !== 0
        };
    }

    function convertRowsToEur(rows, fxRates, warnings) {
        const missing = (warnings && warnings.missingFxDates) || [];
        (rows || []).forEach(row => {
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

    function summarize(rows, classification) {
        const cls = (classification && CLASSIFICATIONS[classification.id || classification])
            || CLASSIFICATIONS.E;
        const out = {
            label: cls.label,
            classificationId: cls.id,
            netUSD: 0,
            netEUR: 0,
            grossGainsUSD: 0,
            grossGainsEUR: 0,
            grossLossesUSD: 0,
            grossLossesEUR: 0,
            feesUSD: 0,
            feesEUR: 0,
            fundingUSD: 0,
            fundingEUR: 0,
            count: 0,
            winCount: 0,
            lossCount: 0,
            scratchCount: 0,
            eurPartial: false
        };
        (rows || []).forEach(row => {
            out.count++;
            out.netUSD += row.netUSD;
            out.feesUSD += row.feesUSD;
            out.fundingUSD += row.netFundingUSD;
            if (row.netUSD > 0) { out.grossGainsUSD += row.netUSD; out.winCount++; }
            else if (row.netUSD < 0) { out.grossLossesUSD += row.netUSD; out.lossCount++; }
            else { out.scratchCount++; }
            if (isNumber(row.fxRate)) {
                out.netEUR += row.netEUR;
                out.feesEUR += row.feesEUR;
                out.fundingEUR += row.netFundingEUR;
                if (row.netEUR > 0) out.grossGainsEUR += row.netEUR;
                else if (row.netEUR < 0) out.grossLossesEUR += row.netEUR;
            } else {
                out.eurPartial = true;
            }
        });
        return out;
    }

    function buildYearReport(positions, fills, year, fxRates) {
        const warnings = {
            derivedRealizedPnlCount: 0,
            feeAttributionAmbiguousCount: 0,
            feeDoubleCountRiskCount: 0,
            missingFxDates: []
        };
        const closed = (positions || []).filter(p => p && p.status === 'CLOSED');
        const inYear = closed.filter(p => closedAtYearUTC(p) === year);
        const rows = inYear.map(p => buildRow(p, fills, closed));
        rows.sort((a, b) => {
            const at = tsMs(a.closedAtISO) || 0;
            const bt = tsMs(b.closedAtISO) || 0;
            return bt - at;
        });
        rows.forEach(r => {
            if (r._derivedRealizedPnl) warnings.derivedRealizedPnlCount++;
            if (r._feeAttributionWarning) warnings.feeAttributionAmbiguousCount++;
            if (r._feeDoubleCountRisk) warnings.feeDoubleCountRiskCount++;
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
            'derived_realized_pnl', 'fee_attribution_warning', 'fx_missing', 'fee_double_count_risk'
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
                row._derivedRealizedPnl ? 'true' : 'false',
                row._feeAttributionWarning ? 'true' : 'false',
                row._fxMissing ? 'true' : 'false',
                row._feeDoubleCountRisk ? 'true' : 'false'
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
        netRealizedPnl,
        convertRowsToEur,
        summarize,
        toCsv,
        toJson,
        availableYearsFromPositions,
        closedAtYearUTC,
        _internal: { csvEscape, buildRow, dateUTC, tsMs }
    };
})();
