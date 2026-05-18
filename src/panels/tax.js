// Tax panel: Portuguese capital-gains report. All formulas live in
// tax-report.js (window.TaxReport); ECB daily rates in fx-rates.js
// (window.FxRates). This file is wiring + DOM only.
//
// Depends on: window.TaxReport, window.FxRates, window.Format, window.AppDom.

(function () {
  'use strict';

  let _wired = false;
  let _renderToken = 0;
  let _state = { positions: [], fills: [], lastReport: null };

  function getClassification() {
    const radio = document.querySelector('input[name="taxClass"]:checked');
    return (radio && radio.value === 'G') ? 'G' : 'E';
  }

  function populateYearSelect(positions) {
    const sel = document.getElementById('taxYear');
    if (!sel || !window.TaxReport) return;
    const years = window.TaxReport.availableYearsFromPositions(positions);
    const prior = sel.value;
    sel.innerHTML = '';
    if (!years.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No closed positions';
      sel.appendChild(opt);
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    let stored = null;
    try { stored = localStorage.getItem('taxSelectedYear'); } catch (_) {}
    const desired = (prior && years.indexOf(parseInt(prior, 10)) !== -1)
      ? parseInt(prior, 10)
      : (stored && years.indexOf(parseInt(stored, 10)) !== -1)
        ? parseInt(stored, 10)
        : years[0];
    years.forEach(y => {
      const opt = document.createElement('option');
      opt.value = String(y);
      opt.textContent = String(y);
      if (y === desired) opt.selected = true;
      sel.appendChild(opt);
    });
  }

  function fmtUsdSigned(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '—';
    const sign = n > 0 ? '+' : (n < 0 ? '-' : '');
    return sign + '$' + Math.abs(n).toFixed(2);
  }

  function fmtEurSigned(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '—';
    const sign = n > 0 ? '+' : (n < 0 ? '-' : '');
    return sign + '€' + Math.abs(n).toFixed(2);
  }

  function renderRows(rows, classification) {
    const D = window.AppDom;
    const F = window.Format;
    const body = document.getElementById('taxRowsBody');
    const holdHeader = document.getElementById('taxHoldingHeader');
    if (!body) return;
    const showHolding = classification === 'G';
    if (holdHeader) holdHeader.style.display = showHolding ? '' : 'none';
    body.innerHTML = '';

    if (!rows.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = showHolding ? 12 : 11;
      td.textContent = 'No closed positions in selected year.';
      td.style.textAlign = 'center';
      td.style.color = 'var(--ink-3)';
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }

    rows.forEach(row => {
      const tr = document.createElement('tr');
      const reasons = [];
      if (row._derivedRealizedPnl) reasons.push('Realized P&L derived from prices (gross of fees).');
      if (row._feeAttributionWarning) reasons.push('Another closed position overlaps this market+side window — fee attribution ambiguous.');
      if (row._fxMissing) reasons.push('FX rate unavailable for ' + (row.closedDateUTC || 'close date') + '.');
      if (row._feeDoubleCountRisk) reasons.push('Fees may already be netted into indexer realizedPnl — not subtracted to avoid double-count.');

      const closedTd = D.appendCell(tr, row.closedDateUTC || '—', ['mono']);
      if (reasons.length) {
        closedTd.textContent = (row.closedDateUTC || '—') + ' †';
        closedTd.title = reasons.join('\n');
        closedTd.style.cursor = 'help';
      }
      D.appendCell(tr, row.market || '—', ['mono']);
      D.appendCell(tr, row.side || '—', ['mono']);
      D.appendCell(tr, F.fmtNum(row.maxSize), ['mono']);
      D.appendCell(tr, F.formatPrice(row.entryPrice), ['mono']);
      D.appendCell(tr, F.formatPrice(row.exitPrice), ['mono']);
      D.appendCell(tr, fmtUsdSigned(row.realizedPnlUSD), ['mono', row.realizedPnlUSD >= 0 ? 'profit' : 'loss']);
      D.appendCell(tr, fmtUsdSigned(row.netFundingUSD), ['mono', row.netFundingUSD >= 0 ? 'profit' : 'loss']);
      D.appendCell(tr, fmtUsdSigned(row.feesUSD), ['mono']);
      D.appendCell(tr, fmtUsdSigned(row.netUSD), ['mono', row.netUSD >= 0 ? 'profit' : 'loss']);
      D.appendCell(tr,
        typeof row.netEUR === 'number' ? fmtEurSigned(row.netEUR) : '—',
        ['mono', typeof row.netEUR === 'number' && row.netEUR < 0 ? 'loss' : 'profit']);
      if (showHolding) D.appendCell(tr, row.holdingDays === null ? '—' : String(row.holdingDays), ['mono']);
      body.appendChild(tr);
    });
    D.tagCells('taxRowsBody');
  }

  function renderTotals(totals, classification) {
    const D = window.AppDom;
    const cls = window.TaxReport.CLASSIFICATIONS[classification] || window.TaxReport.CLASSIFICATIONS.E;
    D.updateElement('taxClassificationLabel', cls.label);
    D.updateElement('taxFlatRate', (cls.flatRate * 100).toFixed(0) + '%');

    const eurOrDash = n => (typeof n === 'number' && isFinite(n)) ? fmtEurSigned(n) : '—';
    const eurPartialNote = totals.eurPartial ? ' (partial — missing FX)' : '';

    D.updateElement('taxNetUsd', fmtUsdSigned(totals.netUSD));
    D.updateElement('taxNetUsdDetail', totals.count + ' trades');
    D.updateElement('taxNetEur', eurOrDash(totals.netEUR));
    D.updateElement('taxNetEurDetail', 'ECB daily rate' + eurPartialNote);
    D.updateElement('taxGrossGainsUsd', fmtUsdSigned(totals.grossGainsUSD));
    D.updateElement('taxGrossGainsEur', eurOrDash(totals.grossGainsEUR));
    D.updateElement('taxGrossLossesUsd', fmtUsdSigned(totals.grossLossesUSD));
    D.updateElement('taxGrossLossesEur', eurOrDash(totals.grossLossesEUR));
    D.updateElement('taxFeesUsd', fmtUsdSigned(totals.feesUSD));
    D.updateElement('taxFeesEur', eurOrDash(totals.feesEUR));
    D.updateElement('taxFundingUsd', fmtUsdSigned(totals.fundingUSD));
    D.updateElement('taxFundingEur', eurOrDash(totals.fundingEUR));
    D.updateElement('taxTradeCount', String(totals.count));
    D.updateElement('taxTradeBreakdown',
      totals.winCount + 'W / ' + totals.lossCount + 'L / ' + totals.scratchCount + 'S');
  }

  function renderStatus(year, warnings, rowCount) {
    const status = document.getElementById('taxStatus');
    if (status) {
      const parts = ['Year ' + year, rowCount + ' closed positions'];
      if (warnings.derivedRealizedPnlCount) parts.push(warnings.derivedRealizedPnlCount + ' derived P&L');
      if (warnings.feeAttributionAmbiguousCount) parts.push(warnings.feeAttributionAmbiguousCount + ' fee-ambiguous');
      if (warnings.missingFxDates.length) parts.push(warnings.missingFxDates.length + ' missing FX dates');
      if (warnings.feeDoubleCountRiskCount) parts.push(warnings.feeDoubleCountRiskCount + ' fee double-count risk');
      status.textContent = parts.join(' · ');
    }
    const strip = document.getElementById('taxWarningStrip');
    if (!strip) return;
    const halfDerived = rowCount > 0 && warnings.derivedRealizedPnlCount / rowCount > 0.5;
    if (halfDerived) {
      strip.style.display = '';
      strip.textContent = 'Most rows use realized P&L derived from VWAP prices (indexer reported $0). These values are gross of fees; the net column subtracts attributed fills-fees, but totals may still differ from broker-confirmed figures.';
    } else if (warnings.feeDoubleCountRiskCount > 0) {
      strip.style.display = '';
      strip.textContent = 'Indexer-supplied realizedPnl rows: fees NOT subtracted (uncertain whether indexer already netted them). See CLAUDE.md “Tax report” section; spot-check needed before relying on totals.';
    } else {
      strip.style.display = 'none';
      strip.textContent = '';
    }
  }

  async function refresh() {
    if (!window.TaxReport || !window.FxRates) return;
    const positions = _state.positions;
    const fills = _state.fills;
    populateYearSelect(positions);

    const sel = document.getElementById('taxYear');
    if (!sel || !sel.value) {
      renderRows([], 'E');
      renderTotals(window.TaxReport.summarize([], 'E'), 'E');
      const status = document.getElementById('taxStatus');
      if (status) status.textContent = positions.length
        ? 'No closed positions for any year.'
        : 'Load an address to populate.';
      return;
    }
    const year = parseInt(sel.value, 10);
    try { localStorage.setItem('taxSelectedYear', String(year)); } catch (_) {}
    const classification = getClassification();
    try { localStorage.setItem('taxClassification', classification); } catch (_) {}

    const dry = window.TaxReport.buildYearReport(positions, fills, year, {});
    const dates = [...new Set(dry.rows.map(r => r.closedDateUTC).filter(Boolean))];

    const status = document.getElementById('taxStatus');
    if (status) status.textContent = 'Fetching ECB rates for ' + dates.length + ' date(s)…';

    const token = ++_renderToken;
    const { rates } = await window.FxRates.getRates(dates);
    if (token !== _renderToken) return;

    const report = window.TaxReport.buildYearReport(positions, fills, year, rates);
    const totals = window.TaxReport.summarize(report.rows, classification);
    renderRows(report.rows, classification);
    renderTotals(totals, classification);
    renderStatus(year, report.warnings, report.rows.length);
    _state.lastReport = { rows: report.rows, totals, year, classification };
  }

  function downloadBlob(text, mime, filename) {
    const blob = new Blob([text], { type: mime + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function download(format) {
    const snap = _state.lastReport;
    if (!snap) return;
    const addr = String(window.currentAddress || 'wallet').slice(0, 10);
    const base = 'dydx-tax-' + addr + '-' + snap.year + '-cat' + snap.classification;
    if (format === 'csv') {
      downloadBlob(window.TaxReport.toCsv(snap.rows, snap.classification, snap.year),
        'text/csv', base + '.csv');
    } else {
      downloadBlob(window.TaxReport.toJson(snap.rows, snap.totals, snap.classification, snap.year),
        'application/json', base + '.json');
    }
  }

  function wireEvents() {
    if (_wired) return;
    const sel = document.getElementById('taxYear');
    if (!sel) return;
    _wired = true;
    sel.addEventListener('change', refresh);
    document.querySelectorAll('input[name="taxClass"]').forEach(r => {
      r.addEventListener('change', refresh);
    });
    let restored = null;
    try { restored = localStorage.getItem('taxClassification'); } catch (_) {}
    if (restored === 'G' || restored === 'E') {
      const target = document.querySelector('input[name="taxClass"][value="' + restored + '"]');
      if (target) target.checked = true;
    }
    const refreshBtn = document.getElementById('taxRefreshFx');
    if (refreshBtn) refreshBtn.addEventListener('click', () => {
      if (window.FxRates) window.FxRates.clear();
      refresh();
    });
    const csvBtn = document.getElementById('taxDownloadCsv');
    if (csvBtn) csvBtn.addEventListener('click', () => download('csv'));
    const jsonBtn = document.getElementById('taxDownloadJson');
    if (jsonBtn) jsonBtn.addEventListener('click', () => download('json'));
  }

  function render(positions, fills) {
    _state.positions = Array.isArray(positions) ? positions : [];
    _state.fills = Array.isArray(fills) ? fills : [];
    wireEvents();
    refresh();
  }

  window.AppPanels = window.AppPanels || {};
  window.AppPanels.tax = { render, refresh };
})();
