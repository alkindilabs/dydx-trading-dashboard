// Display formatters. Pure functions. Single source of truth for every
// numeric / date / currency / percent cell in the dashboard so formatting
// can't drift across panels.
//
// Depends on window.AppConstants (constants.js must load first).

(function () {
  'use strict';

  function _hoursPerYear() {
    return (window.AppConstants && window.AppConstants.HOURS_PER_YEAR) || 8760;
  }

  function formatCurrency(value) {
    if (value === null || value === undefined || isNaN(value)) return '-';
    const sign = value >= 0 ? '+' : '-';
    return sign + '$' + Math.round(Math.abs(value));
  }

  function formatPercent(value) {
    if (value === null || value === undefined || isNaN(value)) return '-';
    return value.toFixed(1) + '%';
  }

  // Universal numeric formatter. Bare integer for |value| >= 1; up to 4
  // decimals below so tiny sizes (0.0001 BTC) don't collapse to 0.
  function fmtNum(value) {
    if (value === null || value === undefined || value === '') return '-';
    const n = parseFloat(value);
    if (!isFinite(n)) return '-';
    const a = Math.abs(n);
    const sign = n < 0 ? '-' : '';
    if (a >= 1) return sign + Math.round(a);
    return sign + a.toFixed(4).replace(/\.?0+$/, '');
  }

  // Annualized funding rate from an hourly fraction. Simple, not compounded
  // (funding rate changes hour-to-hour).
  function formatFundingApr(hourlyFraction) {
    if (hourlyFraction === null || hourlyFraction === undefined || hourlyFraction === '') return '-';
    const n = typeof hourlyFraction === 'number' ? hourlyFraction : parseFloat(hourlyFraction);
    if (!isFinite(n)) return '-';
    const apr = n * _hoursPerYear() * 100;
    return apr.toFixed(2) + '%';
  }

  function formatHourlyDetail(rawFraction) {
    if (rawFraction === null || rawFraction === undefined || rawFraction === '') return '—';
    const n = parseFloat(rawFraction);
    if (!isFinite(n)) return '—';
    return `Hourly: ${(n * 100).toFixed(5)}%`;
  }

  // Unsigned dollar formatter for prices. Sub-dollar tokens keep 6 sig digits
  // so micro-priced perps don't round to $0.
  function formatPrice(value) {
    if (value === null || value === undefined || value === '') return '-';
    const n = typeof value === 'number' ? value : parseFloat(value);
    if (!isFinite(n)) return '-';
    const a = Math.abs(n);
    if (a >= 1) return '$' + Math.round(a);
    return '$' + Number(a.toPrecision(6)).toString();
  }

  // 2-decimal ratio with consistent null/Infinity handling.
  function fmtRatio(v) {
    if (v === null || v === undefined) return '—';
    if (v === Infinity) return '∞';
    if (typeof v !== 'number' || !isFinite(v)) return '—';
    return v.toFixed(2);
  }

  function formatShortNumber(n) {
    if (!isFinite(n)) return '∞';
    const a = Math.abs(n);
    const sign = n < 0 ? '-' : '';
    if (a >= 1e6) return sign + (a / 1e6).toFixed(2) + 'M';
    if (a >= 1e3) return sign + (a / 1e3).toFixed(2) + 'K';
    return sign + a.toFixed(2);
  }

  function fmtNotional(value) {
    if (value === null || value === undefined || isNaN(value) || !isFinite(value)) return '—';
    const sign = value < 0 ? '-' : '';
    return `${sign}$${Math.round(Math.abs(value))}`;
  }

  function fmtSignedPct(value, decimals) {
    if (value === null || value === undefined || isNaN(value) || !isFinite(value)) return '—';
    const d = (decimals === undefined) ? 2 : decimals;
    const sign = value > 0 ? '+' : value < 0 ? '−' : '';
    return `${sign}${Math.abs(value).toFixed(d)}%`;
  }

  function fmtDateShort(ts) {
    return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  // HTML escape. Safe for both text and attribute contexts now that " and '
  // are escaped (defensive — caller may interpolate this into attr="...").
  function esc(s) {
    return String(s)
      .replace(/&/g,  '&amp;')
      .replace(/</g,  '&lt;')
      .replace(/>/g,  '&gt;')
      .replace(/"/g,  '&quot;')
      .replace(/'/g,  '&#x27;');
  }

  window.Format = {
    formatCurrency, formatPercent, fmtNum, formatFundingApr, formatHourlyDetail,
    formatPrice, fmtRatio, formatShortNumber, fmtNotional, fmtSignedPct,
    fmtDateShort, esc
  };
})();
