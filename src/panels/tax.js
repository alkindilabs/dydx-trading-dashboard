// Tax panel: Portuguese capital-gains report. All formulas live in
// tax-report.js (window.TaxReport); ECB daily rates in fx-rates.js
// (window.FxRates). This file is wiring + DOM only.
//
// FX is fetched lazily — render() seeds state but only fires refresh()
// when the Tax tab is currently active. The activateTab hook in
// index.html invokes refresh() on tab switch so users who never open
// the Tax tab never trigger a third-party ECB request.
//
// Depends on: window.TaxReport, window.FxRates, window.Format, window.AppDom,
// window.AppConstants (PERCENT).

(function () {
  'use strict';

  let _wired = false;
  let _renderToken = 0;
  // dataGap: '' when fills and both position lists loaded, else why one
  // did not (processData's missingDataReason). Without fills no realized
  // P&L, fee or net figure can be computed; without a position list the
  // fills cannot be tied to the right rows. Either way those cells and
  // totals read '—'.
  let _state = { positions: [], fills: [], address: '', dataGap: '', lastReport: null };

  // Price formatter that preserves cents and finer ticks. Format.formatPrice
  // rounds prices |value| >= 1 to whole dollars, so a perp entry/exit at
  // $76902.55 would render as $76903 in the tax table while the CSV/JSON
  // export keeps the raw value. Up to 4 decimals above $1, 6 sig-digits
  // below for micro-priced perps (mirrors the sub-dollar branch in
  // Format.formatPrice).
  function fmtPricePrecise(value) {
    if (value === null || value === undefined || value === '') return '—';
    const n = typeof value === 'number' ? value : parseFloat(value);
    if (!isFinite(n)) return '—';
    const a = Math.abs(n);
    if (a === 0) return '$0';
    const sign = n < 0 ? '-' : '';
    if (a >= 1) {
      const rounded = Number(a.toFixed(4));
      return sign + '$' + String(rounded);
    }
    return sign + '$' + Number(a.toPrecision(6)).toString();
  }

  function isTaxTabActive() {
    const el = document.getElementById('tax');
    return !!(el && el.classList && el.classList.contains('active'));
  }

  function clearWarningStrip() {
    const strip = document.getElementById('taxWarningStrip');
    if (strip) {
      strip.style.display = 'none';
      strip.textContent = '';
    }
  }

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

  const CENTS = 2;
  const SIGN_BY_CLASS = { profit: '+', loss: '-' };

  // Signed from the value as displayed (Format.signClass), so an amount
  // that rounds to $0.00 is neither signed nor coloured.
  function fmtUsdSigned(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '—';
    return (SIGN_BY_CLASS[window.Format.signClass(n, CENTS)] || '') + '$' + Math.abs(n).toFixed(CENTS);
  }

  // Fees follow the dYdX convention: positive = paid (cost),
  // negative = maker rebate (income). Render paid fees without a `+`
  // (a leading `+` reads as income), but keep the `-` sign on rebates
  // so they read distinctly and agree with the CSV/JSON exports and
  // the net P&L math (which adds rebates back).
  // A rebate that rounds to 0.00 reads unsigned, like every other cell.
  function fmtFee(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '—';
    const rebate = window.Format.signClass(n, CENTS) === 'loss';
    return (rebate ? '-$' : '$') + Math.abs(n).toFixed(CENTS);
  }

  function fmtFeeEur(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '—';
    const rebate = window.Format.signClass(n, CENTS) === 'loss';
    return (rebate ? '-€' : '€') + Math.abs(n).toFixed(CENTS);
  }

  function fmtEurSigned(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '—';
    return (SIGN_BY_CLASS[window.Format.signClass(n, CENTS)] || '') + '€' + Math.abs(n).toFixed(CENTS);
  }

  function incompleteRowsText(count) {
    return count + (count === 1 ? ' row' : ' rows') + ' missing fill data';
  }

  function renderRows(rows, classification, dataGap = '') {
    const F = window.Format;
    const D = window.AppDom;
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
      // Warnings mark the row with †: its values are missing or its EUR
      // conversion is. Audit hints only explain a row whose values stand.
      const warnings = [];
      if (dataGap) {
        warnings.push(dataGap + ' — realized P&L, fees and net cannot be computed.');
      } else if (row._attributionIncomplete) {
        warnings.push('The fill history does not tie to exactly this position (fills missing, unparseable, or shared with a position absent from the list), so realized P&L, fees and net cannot be computed.');
      }
      if (!dataGap && row._hasInvalidFill) {
        warnings.push('At least one fill in this window carries an invalid price / size / side, which the FIFO walk cannot use.');
      }
      if (row._fxMissing) warnings.push('FX rate unavailable for ' + (row.closedDateUTC || 'close date') + '.');
      const hints = [];
      if (row._feeAttributionWarning) hints.push('Another closed position in this market overlaps this window; the two rows of a reversal always touch at the reversing fill (audit hint). The FIFO walk still assigns each fill\'s realized P&L and fee to exactly one position.');

      const dateText = row.closedDateUTC || '—';
      const closedTd = D.appendCell(tr, warnings.length ? dateText + ' †' : dateText, ['mono']);
      const notes = warnings.concat(hints);
      if (notes.length) {
        closedTd.title = notes.join('\n');
        closedTd.style.cursor = 'help';
        // Accessibility: a `title` tooltip alone is not reliably exposed
        // to keyboard or screen-reader users. Make the cell focusable
        // and announce the text via aria-label. Do NOT override
        // role — `<td>` already has the implicit `cell` role and assistive
        // tech relies on it for table-grid navigation; an explicit role
        // here (e.g. `note`) would strip those semantics.
        closedTd.setAttribute('tabindex', '0');
        closedTd.setAttribute(
          'aria-label',
          dateText + (warnings.length ? ' — warning: ' : ' — note: ') + notes.join(' ')
        );
      }
      D.appendCell(tr, row.market || '—', ['mono']);
      D.appendCell(tr, row.side || '—', ['mono']);
      D.appendCell(tr, F.fmtAssetSize(row.peakSize, row.market), ['mono']);
      D.appendCell(tr, fmtPricePrecise(row.entryPrice), ['mono']);
      D.appendCell(tr, fmtPricePrecise(row.exitPrice), ['mono']);
      const signed = (n) => (dataGap ? null : n);
      D.appendCell(tr, fmtUsdSigned(signed(row.realizedPnlUSD)), ['mono', F.signClass(signed(row.realizedPnlUSD), CENTS)]);
      D.appendCell(tr, fmtUsdSigned(row.netFundingUSD), ['mono', F.signClass(row.netFundingUSD, CENTS)]);
      // Fees follow the dYdX convention: positive = paid, negative =
      // maker rebate. fmtFee preserves the sign on rebates so the row
      // value agrees with net P&L (which adds rebates back).
      D.appendCell(tr, fmtFee(signed(row.feesUSD)), ['mono']);
      D.appendCell(tr, fmtUsdSigned(signed(row.netUSD)), ['mono', F.signClass(signed(row.netUSD), CENTS)]);
      D.appendCell(tr, fmtEurSigned(signed(row.netEUR)), ['mono', F.signClass(signed(row.netEUR), CENTS)]);
      if (showHolding) D.appendCell(tr, row.holdingDays === null ? '—' : String(row.holdingDays), ['mono']);
      body.appendChild(tr);
    });
    D.tagCells('taxRowsBody');
  }

  function renderTotals(totals, classification) {
    const D = window.AppDom;
    const cls = window.TaxReport.CLASSIFICATIONS[classification] || window.TaxReport.CLASSIFICATIONS.E;
    D.updateElement('taxClassificationLabel', cls.label);
    D.updateElement('taxFlatRate', (cls.flatRate * window.AppConstants.PERCENT).toFixed(0) + '%');

    const eurOrDash = n => (typeof n === 'number' && isFinite(n)) ? fmtEurSigned(n) : '—';
    let eurDetailNote = 'ECB daily rate';
    if (totals.eurRowCount === 0 && totals.count > 0) {
      eurDetailNote += ' · unavailable';
    } else if (totals.eurPartial) {
      eurDetailNote += ' (partial — missing FX)';
    }

    D.updateElement('taxNetUsd', fmtUsdSigned(totals.netUSD));
    D.updateElement('taxNetUsdDetail', totals.count + (totals.count === 1 ? ' trade' : ' trades'));
    D.updateElement('taxNetEur', eurOrDash(totals.netEUR));
    D.updateElement('taxNetEurDetail', eurDetailNote);
    D.updateElement('taxGrossGainsUsd', fmtUsdSigned(totals.grossGainsUSD));
    D.updateElement('taxGrossGainsEur', eurOrDash(totals.grossGainsEUR));
    D.updateElement('taxGrossLossesUsd', fmtUsdSigned(totals.grossLossesUSD));
    D.updateElement('taxGrossLossesEur', eurOrDash(totals.grossLossesEUR));
    // Fees: positive = paid (no leading +), negative = maker rebate
    // (keep `-` sign so totals match the per-row breakdown).
    D.updateElement('taxFeesUsd', fmtFee(totals.feesUSD));
    D.updateElement('taxFeesEur',
        typeof totals.feesEUR === 'number' && isFinite(totals.feesEUR)
            ? fmtFeeEur(totals.feesEUR)
            : '—');
    D.updateElement('taxFundingUsd', fmtUsdSigned(totals.fundingUSD));
    D.updateElement('taxFundingEur', eurOrDash(totals.fundingEUR));
    D.updateElement('taxTradeCount', String(totals.count));
    if (totals.incompleteCount > 0) {
      const reason = incompleteRowsText(totals.incompleteCount);
      D.updateElement('taxTradeBreakdown', '—');
      D.updateElement('taxNetUsdDetail', reason);
      D.updateElement('taxNetEurDetail', reason);
    } else {
      D.updateElement('taxTradeBreakdown',
        totals.winCount + 'W / ' + totals.lossCount + 'L / ' + totals.scratchCount + 'S');
    }
  }

  // Totals without the data a fills-derived total needs: only funding
  // and the trade count are known.
  function renderTotalsWithGap(totals, classification, dataGap) {
    const D = window.AppDom;
    renderTotals(totals, classification);
    ['taxNetUsd', 'taxNetEur', 'taxGrossGainsUsd', 'taxGrossGainsEur', 'taxGrossLossesUsd',
      'taxGrossLossesEur', 'taxFeesUsd', 'taxFeesEur', 'taxFundingEur', 'taxTradeBreakdown']
      .forEach(id => D.updateElement(id, '—'));
    D.updateElement('taxNetUsdDetail', dataGap);
    D.updateElement('taxNetEurDetail', dataGap);
  }

  function renderDataGapStatus(year, rowCount, dataGap) {
    const status = document.getElementById('taxStatus');
    if (status) {
      const positionsNoun = rowCount === 1 ? 'closed position' : 'closed positions';
      status.textContent = ['Year ' + year, rowCount + ' ' + positionsNoun, dataGap].join(' · ');
    }
    const strip = document.getElementById('taxWarningStrip');
    if (strip) {
      strip.style.display = '';
      strip.textContent = dataGap + '. Realized P&L, fees and net P&L come from the fill history matched to the position lists, so they read — and the year totals are unavailable. Only funding is shown. Reload to fetch the data again.';
    }
  }

  function renderStatus(year, warnings, rowCount) {
    const status = document.getElementById('taxStatus');
    if (status) {
      const positionsNoun = rowCount === 1 ? 'closed position' : 'closed positions';
      const parts = ['Year ' + year, rowCount + ' ' + positionsNoun];
      const ambig = warnings.feeAttributionAmbiguousCount;
      if (ambig) parts.push(ambig + (ambig === 1 ? ' row overlaps' : ' rows overlap') + " another position's window");
      const mfx = warnings.missingFxDates.length;
      if (mfx) parts.push(mfx + (mfx === 1 ? ' missing FX date' : ' missing FX dates'));
      const incomplete = warnings.incompleteAttributionCount;
      if (incomplete) parts.push(incompleteRowsText(incomplete));
      status.textContent = parts.join(' · ');
    }
    const strip = document.getElementById('taxWarningStrip');
    if (!strip) return;
    if (warnings.incompleteAttributionCount > 0) {
      strip.style.display = '';
      strip.textContent = incompleteRowsText(warnings.incompleteAttributionCount) + ' (flagged with †): the fill history does not tie to exactly those positions, so their realized P&L, fees and net read —, and every fills-derived year total is unavailable rather than partial. Only funding and the trade count are shown. Hover the date column for each row; reload to fetch the data again.';
    } else if (warnings.feeAttributionAmbiguousCount > 0) {
      strip.style.display = '';
      const n = warnings.feeAttributionAmbiguousCount;
      const noun = n === 1 ? 'row' : 'rows';
      strip.textContent = n + ' ' + noun + ' overlap another closed position\'s window in the same market (the two rows of a reversal always touch at the reversing fill). This is an audit hint: the FIFO walk still assigns each fill\'s realized P&L and fee to exactly one position. Verify against raw fills if individual row attribution matters for your filing.';
    } else {
      strip.style.display = 'none';
      strip.textContent = '';
    }
  }

  async function refresh() {
    if (!window.TaxReport || !window.FxRates) return;
    // Bump the token on every entry: any prior in-flight FX fetch
    // becomes obsolete and its post-await render is suppressed. The
    // lastReport is also cleared upfront so a Download click during
    // the FX window can't emit the previous year's data.
    const token = ++_renderToken;
    _state.lastReport = null;
    const positions = _state.positions;
    const fills = _state.fills;
    populateYearSelect(positions);

    const sel = document.getElementById('taxYear');
    if (!sel || !sel.value) {
      // Respect the user's current classification radio even in the
      // empty state, so a G-selected user does not see the table flip
      // to E labels when they switch to an address with no closed
      // positions.
      const cls = getClassification();
      renderRows([], cls);
      renderTotals(window.TaxReport.summarize([], cls), cls);
      clearWarningStrip();
      const status = document.getElementById('taxStatus');
      // Distinguish "no address loaded yet" from "address loaded but
      // has no closed positions". The previous text keyed only on
      // positions.length and so wrongly told a legitimately-empty
      // address to "Load an address to populate".
      if (status) {
        if (!_state.address) {
          status.textContent = 'Load an address to populate.';
        } else if (_state.dataGap) {
          status.textContent = _state.dataGap + '.';
        } else {
          status.textContent = 'No closed positions for this address.';
        }
      }
      return;
    }
    const year = parseInt(sel.value, 10);
    try { localStorage.setItem('taxSelectedYear', String(year)); } catch (_) {}
    const classification = getClassification();
    try { localStorage.setItem('taxClassification', classification); } catch (_) {}

    // Build the report ONCE without FX, then mutate rows in-place via
    // the idempotent convertRowsToEur after rates arrive. Avoids
    // running FIFO + fee attribution twice per refresh.
    const report = window.TaxReport.buildYearReport(positions, fills, year, null);
    if (_state.dataGap) {
      // Nothing downloadable: an export would carry wrong or empty
      // values in every fills-derived column. EUR is skipped for the
      // same reason.
      renderRows(report.rows, classification, _state.dataGap);
      renderTotalsWithGap(window.TaxReport.summarize(report.rows, classification),
        classification, _state.dataGap);
      renderDataGapStatus(year, report.rows.length, _state.dataGap);
      return;
    }
    const dates = [...new Set(report.rows.map(r => r.closedDateUTC).filter(Boolean))];

    // Paint the USD-only report immediately so prior renders cannot
    // linger on screen during the FX await. lastReport is NOT set yet
    // — a Download click during the "Fetching ECB rates…" window would
    // otherwise export EUR cells as blank/null even though rates may
    // land seconds later. download() falls back to no-op when
    // lastReport is null.
    const totalsUSD = window.TaxReport.summarize(report.rows, classification);
    renderRows(report.rows, classification);
    renderTotals(totalsUSD, classification);
    renderStatus(year, report.warnings, report.rows.length);

    if (dates.length === 0) {
      // No FX to fetch — snapshot the USD-only report as final.
      _state.lastReport = { rows: report.rows, totals: totalsUSD, year, classification };
      return;
    }

    const status = document.getElementById('taxStatus');
    const baseStatus = status ? status.textContent : '';
    if (status) status.textContent = baseStatus + ' · Fetching ECB rates for ' + dates.length + ' date(s)…';

    const { rates } = await window.FxRates.getRates(dates);
    if (token !== _renderToken) return;

    // Re-read the classification radio post-await so a Categoria
    // change made during the FX window is honored. Otherwise the
    // stale captured `classification` would overwrite a fresh
    // reclassify() result.
    const liveCls = getClassification();
    window.TaxReport.convertRowsToEur(report.rows, rates, report.warnings);
    const totals = window.TaxReport.summarize(report.rows, liveCls);
    renderRows(report.rows, liveCls);
    renderTotals(totals, liveCls);
    renderStatus(year, report.warnings, report.rows.length);
    _state.lastReport = { rows: report.rows, totals, year, classification: liveCls };
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
    // currentAddress is a script-scope `let` in index.html's inline
    // script, not a window property, so read the address from panel
    // state, which render(positions, fills, address) sets.
    const addr = String(_state.address || 'wallet').slice(0, 10) || 'wallet';
    const base = 'dydx-tax-' + addr + '-' + snap.year + '-cat' + snap.classification;
    if (format === 'csv') {
      downloadBlob(window.TaxReport.toCsv(snap.rows, snap.classification, snap.year),
        'text/csv', base + '.csv');
    } else {
      downloadBlob(window.TaxReport.toJson(snap.rows, snap.totals, snap.classification, snap.year),
        'application/json', base + '.json');
    }
  }

  // Classification only affects labels + the Holding column. Re-summarize
  // and re-render the cached report instead of paying for a full FIFO
  // rebuild + FX lookup. Falls back to refresh() when no cached report
  // exists (first paint or empty state).
  function reclassify() {
    const classification = getClassification();
    try { localStorage.setItem('taxClassification', classification); } catch (_) {}
    if (_state.lastReport) {
      const totals = window.TaxReport.summarize(_state.lastReport.rows, classification);
      _state.lastReport.classification = classification;
      _state.lastReport.totals = totals;
      renderRows(_state.lastReport.rows, classification);
      renderTotals(totals, classification);
      return;
    }
    refresh();
  }

  function wireEvents() {
    if (_wired) return;
    const sel = document.getElementById('taxYear');
    if (!sel) return;
    _wired = true;
    sel.addEventListener('change', refresh);
    document.querySelectorAll('input[name="taxClass"]').forEach(r => {
      r.addEventListener('change', reclassify);
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

  function render(positions, fills, address, dataGap = '') {
    _state.positions = Array.isArray(positions) ? positions : [];
    _state.fills = Array.isArray(fills) ? fills : [];
    _state.dataGap = dataGap || '';
    _state.address = typeof address === 'string' ? address : (_state.address || '');
    // Stale lastReport from the prior address must not be downloadable.
    _state.lastReport = null;
    // Token bump cancels any in-flight FX render against the old data.
    _renderToken++;
    wireEvents();
    // Only paint + hit ECB when the user is actually looking at the tab.
    // Otherwise just seed state; activateTab('tax') triggers refresh().
    if (isTaxTabActive()) refresh();
  }

  window.AppPanels = window.AppPanels || {};
  window.AppPanels.tax = { render, refresh };
})();
