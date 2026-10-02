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
  // fundingPayments: the /fundingPayments rows, or null when they did not
  // load (fundingGap says why); funding and net then read '—'.
  let _state = {
    positions: [], fills: [], fundingPayments: null, fundingGap: '',
    address: '', dataGap: '', lastReport: null, snapshotAtMs: null
  };

  // CLOSED (UTC), MARKET, SIDE, SIZE (PEAK), ENTRY, EXIT, REALIZED USD,
  // FUNDING USD, FEES PAID USD, NET USD, NET EUR.
  const TABLE_COLUMNS = 11;

  // Unsigned price that keeps cents and finer ticks: Format.formatPrice's
  // significant digits would show a $76,902.55 entry as $76,902.6. The
  // precision is defined in CLAUDE.md (Tax report, SIZE (PEAK)).
  function fmtPricePrecise(value) {
    const n = typeof value === 'number' ? value : parseFloat(value);
    if (value === null || value === undefined || value === '' || !isFinite(n)) return '—';
    const F = window.Format;
    return Math.abs(n) >= 1 ? F.CURRENCY.USD + F.groupDecimalText(window.TaxReport.priceText(Math.abs(n))) : F.formatPrice(n);
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

  function populateYearSelect() {
    const sel = document.getElementById('taxYear');
    if (!sel || !window.TaxReport) return;
    const years = window.TaxReport.availableYears(_state.positions, _state.fills, _state.fundingPayments);
    const prior = sel.value;
    sel.innerHTML = '';
    if (!years.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No fills or funding';
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

  // Money is Format.formatCents: signed, at cents, thousands grouped,
  // coloured with signClass(value, CENTS); '—' for no number.
  function fmtUsdSigned(n) {
    return window.Format.formatCents(n, window.Format.CURRENCY.USD);
  }

  function fmtEurSigned(n) {
    return window.Format.formatCents(n, window.Format.CURRENCY.EUR);
  }

  // Fees paid, in the dYdX convention: positive = paid (a cost), negative
  // = maker rebate (income). A paid fee reads without formatCents' `+`,
  // which would read as income; a rebate keeps its `-`, as in the CSV /
  // JSON exports and the net (which adds rebates back).
  function fmtFeePaid(n, currency) {
    const signed = window.Format.formatCents(n, currency);
    return window.Format.signClass(n, window.Format.CENTS) === 'profit' ? signed.slice(1) : signed;
  }

  // The selected year was still running when the data was read (the UTC
  // year of the snapshot, as every other view dates it), so its figures
  // are year to date.
  const YEAR_TO_DATE = 'year to date';

  function isYearToDate(year) {
    const readAtMs = _state.snapshotAtMs === null ? Date.now() : _state.snapshotAtMs;
    return year === window.TaxReport.yearUTC(new Date(readAtMs).toISOString());
  }

  function yearText(year) {
    return 'Year ' + year + (isYearToDate(year) ? ' (' + YEAR_TO_DATE + ')' : '');
  }

  function rowsText(count) {
    return count + (count === 1 ? ' row' : ' rows');
  }

  function incompleteRowsText(count) {
    return rowsText(count) + ' missing fill data';
  }

  function fundingMissingRowsText(count) {
    return rowsText(count) + ' missing funding';
  }

  function unattributedFillsText(count) {
    return count + (count === 1 ? ' fill' : ' fills') + ' of no listed position';
  }

  function unattributedFundingText(count) {
    return count + (count === 1 ? ' funding payment' : ' funding payments') + ' of no listed position';
  }

  function positionsText(count, noun) {
    return count + ' ' + noun + (count === 1 ? ' position' : ' positions');
  }

  // Why the net-derived totals and the W / L / S split read '—'; empty
  // when they are known.
  function unknownNetReasons(totals) {
    const reasons = [];
    if (totals.incompleteCount > 0) reasons.push(incompleteRowsText(totals.incompleteCount));
    if (totals.unattributedFillCount > 0) reasons.push(unattributedFillsText(totals.unattributedFillCount));
    if (totals.fundingMissingCount > 0) reasons.push(fundingMissingRowsText(totals.fundingMissingCount));
    if (totals.unattributedFundingCount > 0) reasons.push(unattributedFundingText(totals.unattributedFundingCount));
    return reasons;
  }

  const UNPARSEABLE_PAYMENT_REASON = 'A funding payment of this position in the year has no parseable amount';

  // Why a row's funding is unknown: the payments did not load, a payment
  // the row could hold cannot be placed (the row's own reason), or one of
  // its payments carries no parseable amount.
  function fundingMissingReason(row) {
    return _state.fundingGap || row._fundingMissingReason || UNPARSEABLE_PAYMENT_REASON;
  }

  function fundingMissingNote(row) {
    return fundingMissingReason(row) + ' — funding and net cannot be computed.';
  }

  // Audit hint for a row whose position has events in more than one UTC
  // year: its SIZE (PEAK), ENTRY, EXIT and CLOSED are the whole
  // position's, while its amounts are the selected year's. '' otherwise.
  function yearSpanHint(row, year) {
    const span = row._eventYears;
    if (!span || span.first === span.last) return '';
    return `Position spans ${span.first}–${span.last}: SIZE (PEAK), ENTRY, EXIT and CLOSED are the whole position's; `
      + `REALIZED, FEES and FUNDING hold only ${year}'s events.`;
  }

  // `year` is the selected year the rows belong to.
  function renderRows(rows, dataGap = '', year) {
    const F = window.Format;
    const D = window.AppDom;
    const body = document.getElementById('taxRowsBody');
    if (!body) return;
    body.innerHTML = '';

    if (!rows.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = TABLE_COLUMNS;
      td.textContent = 'No fills or funding payments in the selected year.';
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
        warnings.push('The fill history does not tie to exactly this position (fills missing, unparseable or without a fee, or shared with a position absent from the list), so realized P&L, fees and net cannot be computed.');
      }
      if (row._fundingMissing) warnings.push(fundingMissingNote(row));
      if (!dataGap && row._hasInvalidFill) {
        warnings.push('At least one fill in this window carries an invalid price / size / side, which the FIFO walk cannot use.');
      }
      if (row._fxMissing) {
        const unquoted = row.eventsByDate.filter(e => e.usdPerEur === undefined).map(e => e.date);
        warnings.push('ECB rate unavailable for ' + unquoted.join(', ') + ', so the row has no EUR figures.');
      }
      const hints = [];
      if (row._feeAttributionWarning) hints.push('Another position in this market, open or closed, overlaps this window; the two rows of a reversal always touch at the reversing fill (audit hint). The FIFO walk still assigns each fill\'s realized P&L and fee to exactly one position.');
      const spanHint = yearSpanHint(row, year);
      if (spanHint) hints.push(spanHint);

      const dateText = row.status === window.TaxReport.ROW_STATUS.OPEN
        ? window.TaxReport.ROW_STATUS.OPEN
        : (row.closedDateUTC || '—');
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
      D.appendCell(tr, fmtUsdSigned(signed(row.realizedPnlUSD)), ['mono', F.signClass(signed(row.realizedPnlUSD), F.CENTS)]);
      D.appendCell(tr, fmtUsdSigned(row.netFundingUSD), ['mono', F.signClass(row.netFundingUSD, F.CENTS)]);
      D.appendCell(tr, fmtFeePaid(signed(row.feesUSD), F.CURRENCY.USD), ['mono']);
      D.appendCell(tr, fmtUsdSigned(signed(row.netUSD)), ['mono', F.signClass(signed(row.netUSD), F.CENTS)]);
      D.appendCell(tr, fmtEurSigned(signed(row.netEUR)), ['mono', F.signClass(signed(row.netEUR), F.CENTS)]);
      body.appendChild(tr);
    });
    D.tagCells('taxRowsBody');
  }

  // The flat rate reads in whole percent (28%).
  const FLAT_RATE_DECIMALS = 0;

  // The one classification (TaxReport.CLASSIFICATION), its rate and the
  // note to confirm it with an accountant.
  function renderClassification() {
    const D = window.AppDom;
    const cls = window.TaxReport.CLASSIFICATION;
    D.updateElement('taxClassificationLabel', cls.label);
    D.updateElement('taxFlatRate', `${window.Format.fmtFixed(cls.flatRate * window.AppConstants.PERCENT, FLAT_RATE_DECIMALS)}%`);
    D.updateElement('taxClassificationNote', 'Flat rate (PT) · ' + cls.note);
  }

  // `year` is the selected year, absent before one is chosen.
  function renderTotals(totals, year) {
    const D = window.AppDom;
    const F = window.Format;
    renderClassification();

    const yearToDate = year !== undefined && isYearToDate(year) ? ' · ' + YEAR_TO_DATE : '';
    // Every EUR total is undefined (summarize) unless every row converted
    // (totals.eurComplete); the note says why.
    let eurDetailNote = 'ECB daily rate of each event\'s date';
    if (totals.eurPartial) {
      eurDetailNote += ' · unavailable: ' + rowsText(totals.eurMissingCount) + ' missing FX';
    } else if (!totals.eurComplete && totals.count > 0) {
      eurDetailNote += ' · unavailable';
    }

    // The signed cards are coloured from the sign they show (signClass at
    // cents), like the rows; Fees paid is a cost, so it stays neutral.
    const signedCard = (id, value, format) => D.updateMetric(id, format(value), F.signClass(value, F.CENTS));
    signedCard('taxNetUsd', totals.netUSD, fmtUsdSigned);
    D.updateElement('taxNetUsdDetail', rowsText(totals.count) + (totals.openCount ? ' · ' + totals.openCount + ' open' : '') + yearToDate);
    signedCard('taxNetEur', totals.netEUR, fmtEurSigned);
    D.updateElement('taxNetEurDetail', eurDetailNote + yearToDate);
    signedCard('taxGrossGainsUsd', totals.grossGainsUSD, fmtUsdSigned);
    D.updateElement('taxGrossGainsEur', fmtEurSigned(totals.grossGainsEUR));
    signedCard('taxGrossLossesUsd', totals.grossLossesUSD, fmtUsdSigned);
    D.updateElement('taxGrossLossesEur', fmtEurSigned(totals.grossLossesEUR));
    D.updateElement('taxFeesUsd', fmtFeePaid(totals.feesUSD, F.CURRENCY.USD));
    D.updateElement('taxFeesEur', fmtFeePaid(totals.feesEUR, F.CURRENCY.EUR));
    signedCard('taxFundingUsd', totals.fundingUSD, fmtUsdSigned);
    D.updateElement('taxFundingEur', fmtEurSigned(totals.fundingEUR));
    D.updateElement('taxTradeCount', String(totals.count));
    const reasons = unknownNetReasons(totals);
    if (reasons.length) {
      const reason = reasons.join(' · ');
      D.updateElement('taxTradeBreakdown', '—');
      D.updateElement('taxNetUsdDetail', reason);
      D.updateElement('taxNetEurDetail', reason);
    } else {
      // Bucketed by the row's NET USD (realized − fees + funding), so a
      // trade whose funding flips its sign counts differently here than
      // in the dashboard's win rate, which excludes funding.
      D.updateElement('taxTradeBreakdown',
        totals.winCount + 'W / ' + totals.lossCount + 'L / ' + totals.scratchCount + 'S by net incl. funding');
    }
  }

  // Totals without the data a fills-derived total needs: only funding
  // and the trade count are known.
  function renderTotalsWithGap(totals, dataGap, year) {
    const D = window.AppDom;
    renderTotals(totals, year);
    ['taxNetUsd', 'taxNetEur', 'taxGrossGainsUsd', 'taxGrossLossesUsd']
      .forEach(id => D.updateMetric(id, '—'));
    ['taxGrossGainsEur', 'taxGrossLossesEur', 'taxFeesUsd', 'taxFeesEur', 'taxFundingEur', 'taxTradeBreakdown']
      .forEach(id => D.updateElement(id, '—'));
    D.updateElement('taxNetUsdDetail', dataGap);
    D.updateElement('taxNetEurDetail', dataGap);
  }

  // 'Year Y · N closed positions', with '· K open position(s)' when the
  // year holds open ones.
  function yearCountParts(year, totals) {
    const parts = [yearText(year), positionsText(totals.count - totals.openCount, 'closed')];
    if (totals.openCount) parts.push(positionsText(totals.openCount, 'open'));
    return parts;
  }

  // Without a position list the open / closed split is itself unknown,
  // so the line counts rows.
  function renderDataGapStatus(year, totals, dataGap) {
    const status = document.getElementById('taxStatus');
    if (status) status.textContent = [yearText(year), rowsText(totals.count), dataGap].join(' · ');
    const strip = document.getElementById('taxWarningStrip');
    if (strip) {
      strip.style.display = '';
      strip.textContent = dataGap + '. Realized P&L, fees and net P&L come from the fill history matched to the position lists, so they read — and the year totals are unavailable. Only funding is shown. Reload to fetch the data again.';
    }
  }

  function renderStatus(year, warnings, totals, rows) {
    const fundingMissingCount = totals.fundingMissingCount;
    const status = document.getElementById('taxStatus');
    if (status) {
      const parts = yearCountParts(year, totals);
      const ambig = warnings.feeAttributionAmbiguousCount;
      if (ambig) parts.push(ambig + (ambig === 1 ? ' row overlaps' : ' rows overlap') + " another position's window");
      const mfx = warnings.missingFxDates.length;
      if (mfx) parts.push(mfx + (mfx === 1 ? ' missing FX date' : ' missing FX dates'));
      const incomplete = warnings.incompleteAttributionCount;
      if (incomplete) parts.push(incompleteRowsText(incomplete));
      if (warnings.unattributedFillCount) parts.push(unattributedFillsText(warnings.unattributedFillCount));
      if (fundingMissingCount) parts.push(fundingMissingRowsText(fundingMissingCount));
      if (warnings.unattributedFundingCount) parts.push(unattributedFundingText(warnings.unattributedFundingCount));
      status.textContent = parts.join(' · ');
    }
    const strip = document.getElementById('taxWarningStrip');
    if (!strip) return;
    if (warnings.incompleteAttributionCount > 0) {
      strip.style.display = '';
      strip.textContent = incompleteRowsText(warnings.incompleteAttributionCount) + ' (flagged with †): the fill history does not tie to exactly those positions, so their realized P&L, fees and net read —, and every fills-derived year total is unavailable rather than partial. Only funding and the trade count are shown. Hover the date column for each row; reload to fetch the data again.';
    } else if (warnings.unattributedFillCount > 0) {
      strip.style.display = '';
      strip.textContent = unattributedFillsText(warnings.unattributedFillCount) + ': fills dated in this year (or undated) that no listed position holds, so the realized P&L and fees the year holds are not all in the rows, and every fills-derived year total is unavailable rather than partial. Reload to fetch the data again.';
    } else if (fundingMissingCount > 0) {
      strip.style.display = '';
      const reasons = [...new Set(rows.filter(r => r._fundingMissing).map(fundingMissingReason))].join('; ');
      strip.textContent = fundingMissingRowsText(fundingMissingCount) + ' (flagged with †): ' + reasons + ', so their funding and net read —, and the funding, net and gross year totals are unavailable rather than partial. Reload to fetch the data again.';
    } else if (warnings.unattributedFundingCount > 0) {
      strip.style.display = '';
      strip.textContent = unattributedFundingText(warnings.unattributedFundingCount) + ': funding payments dated in this year (or undated) that no listed position held, so the funding, net and gross year totals are unavailable rather than partial. Reload to fetch the data again.';
    } else if (warnings.feeAttributionAmbiguousCount > 0) {
      strip.style.display = '';
      const n = warnings.feeAttributionAmbiguousCount;
      const noun = n === 1 ? 'row' : 'rows';
      strip.textContent = n + ' ' + noun + ' overlap another position\'s window in the same market, open or closed (the two rows of a reversal always touch at the reversing fill). This is an audit hint: the FIFO walk still assigns each fill\'s realized P&L and fee to exactly one position. Verify against raw fills if individual row attribution matters for your filing.';
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
    populateYearSelect();

    const sel = document.getElementById('taxYear');
    if (!sel || !sel.value) {
      renderRows([]);
      renderTotals(window.TaxReport.summarize([]));
      clearWarningStrip();
      const status = document.getElementById('taxStatus');
      // Distinguish "no address loaded yet" from "address loaded but
      // has no fills or funding". The previous text keyed only on
      // positions.length and so wrongly told a legitimately-empty
      // address to "Load an address to populate".
      if (status) {
        if (!_state.address) {
          status.textContent = 'Load an address to populate.';
        } else if (_state.dataGap) {
          status.textContent = _state.dataGap + '.';
        } else {
          status.textContent = 'No fills or funding payments for this address.';
        }
      }
      return;
    }
    const year = parseInt(sel.value, 10);
    try { localStorage.setItem('taxSelectedYear', String(year)); } catch (_) {}

    // Build the report ONCE without FX, then mutate rows in-place via
    // the idempotent convertRowsToEur after rates arrive. Avoids
    // running FIFO + fee attribution twice per refresh.
    const report = window.TaxReport.buildYearReport(
      _state.positions, _state.fills, _state.fundingPayments, year, null);
    const totalsUSD = window.TaxReport.summarize(report.rows, report.warnings);
    if (_state.dataGap) {
      // Nothing downloadable: an export would carry wrong or empty
      // values in every fills-derived column. EUR is skipped for the
      // same reason.
      renderRows(report.rows, _state.dataGap, year);
      renderTotalsWithGap(totalsUSD, _state.dataGap, year);
      renderDataGapStatus(year, totalsUSD, _state.dataGap);
      return;
    }
    const dates = window.TaxReport.fxDates(report.rows);

    // Paint the USD-only report immediately so prior renders cannot
    // linger on screen during the FX await. lastReport is NOT set yet
    // — a Download click during the "Fetching ECB rates…" window would
    // otherwise export EUR cells as blank/null even though rates may
    // land seconds later. download() falls back to no-op when
    // lastReport is null.
    renderRows(report.rows, '', year);
    renderTotals(totalsUSD, year);
    renderStatus(year, report.warnings, totalsUSD, report.rows);

    if (dates.length === 0) {
      // No FX to fetch — snapshot the USD-only report as final.
      _state.lastReport = { rows: report.rows, totals: totalsUSD, year };
      return;
    }

    const status = document.getElementById('taxStatus');
    const baseStatus = status ? status.textContent : '';
    if (status) status.textContent = baseStatus + ' · Fetching ECB rates for ' + dates.length + ' date(s)…';

    const { rates } = await window.FxRates.getRates(dates);
    if (token !== _renderToken) return;

    window.TaxReport.convertRowsToEur(report.rows, rates, report.warnings);
    const totals = window.TaxReport.summarize(report.rows, report.warnings);
    renderRows(report.rows, '', year);
    renderTotals(totals, year);
    renderStatus(year, report.warnings, totals, report.rows);
    _state.lastReport = { rows: report.rows, totals, year };
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
    // The year and category name the file, the only place the CSV (which
    // carries no meta line) states them; the JSON also has them in meta.
    const addr = String(_state.address || 'wallet').slice(0, 10) || 'wallet';
    const base = `dydx-tax-${addr}-${snap.year}-cat${window.TaxReport.CLASSIFICATION.id}`;
    if (format === 'csv') {
      downloadBlob(window.TaxReport.toCsv(snap.rows), 'text/csv', base + '.csv');
    } else {
      downloadBlob(window.TaxReport.toJson(snap.rows, snap.totals, snap.year, _state.snapshotAtMs),
        'application/json', base + '.json');
    }
  }

  function wireEvents() {
    if (_wired) return;
    const sel = document.getElementById('taxYear');
    if (!sel) return;
    _wired = true;
    sel.addEventListener('change', refresh);
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

  // `inputs`: { dataGap, fundingPayments, fundingGap, snapshotAtMs } —
  // dataGap is the fills / position lists' missing-input reason,
  // fundingPayments the /fundingPayments rows or null when they did not
  // load, with fundingGap saying why, and snapshotAtMs when the data was
  // read (processData's), which judges 'year to date' and dates the JSON
  // export's meta.asOf; the render time without one.
  function render(positions, fills, address, inputs = {}) {
    _state.snapshotAtMs = Number.isFinite(inputs.snapshotAtMs) ? inputs.snapshotAtMs : Date.now();
    _state.positions = Array.isArray(positions) ? positions : [];
    _state.fills = Array.isArray(fills) ? fills : [];
    _state.dataGap = inputs.dataGap || '';
    _state.fundingPayments = Array.isArray(inputs.fundingPayments) ? inputs.fundingPayments : null;
    _state.fundingGap = _state.fundingPayments ? '' : (inputs.fundingGap || 'Funding payments unavailable');
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

  renderClassification();

  window.AppPanels = window.AppPanels || {};
  window.AppPanels.tax = { render, refresh };
})();
