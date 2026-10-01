// Display formatters. Pure functions. Single source of truth for every
// numeric / date / currency / percent cell in the dashboard so formatting
// can't drift across panels.
//
// Depends on window.AppConstants (constants.js must load first).

(function () {
  'use strict';

  function _hoursPerYear() {
    return window.AppConstants.HOURS_PER_YEAR;
  }


  function _isDisplayable(value) {
    return typeof value === 'number' && isFinite(value);
  }

  // |value| rounded the way the cell displays it. The sign and the colour
  // of a signed cell are both decided from this, so a value that renders
  // as $0 (or 0.00%) is neither signed nor coloured.
  function _displayedMagnitude(value, fractionDigits) {
    const scale = Math.pow(10, fractionDigits);
    return Math.round(Math.abs(value) * scale) / scale;
  }

  function _displayedSign(value, fractionDigits) {
    if (_displayedMagnitude(value, fractionDigits) === 0) return 0;
    return value > 0 ? 1 : -1;
  }

  const WHOLE_DOLLARS = 0;

  function formatCurrency(value) {
    if (value === null || value === undefined || isNaN(value)) return '-';
    const sign = { 1: '+', 0: '', '-1': '-' }[_displayedSign(value, WHOLE_DOLLARS)];
    return sign + '$' + _displayedMagnitude(value, WHOLE_DOLLARS);
  }

  // Colour class for a signed cell: 'profit' / 'loss', 'zero' when the
  // value displays as zero at `fractionDigits` (whole dollars by default),
  // '' when there is no number to colour.
  function signClass(value, fractionDigits = WHOLE_DOLLARS) {
    if (!_isDisplayable(value)) return '';
    return { 1: 'profit', 0: 'zero', '-1': 'loss' }[_displayedSign(value, fractionDigits)];
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

  const APR_DECIMALS = 2;

  // Annualized funding rate in percent from an hourly fraction, or null.
  // Simple, not compounded (funding rate changes hour-to-hour).
  function _fundingAprPercent(hourlyFraction) {
    if (hourlyFraction === null || hourlyFraction === undefined || hourlyFraction === '') return null;
    const n = typeof hourlyFraction === 'number' ? hourlyFraction : parseFloat(hourlyFraction);
    return isFinite(n) ? n * _hoursPerYear() * window.AppConstants.PERCENT : null;
  }

  function formatFundingApr(hourlyFraction) {
    const apr = _fundingAprPercent(hourlyFraction);
    if (apr === null) return '-';
    const sign = _displayedSign(apr, APR_DECIMALS) < 0 ? '-' : '';
    return sign + _displayedMagnitude(apr, APR_DECIMALS).toFixed(APR_DECIMALS) + '%';
  }

  // signClass of the APR as formatFundingApr displays it.
  function fundingAprClass(hourlyFraction) {
    const apr = _fundingAprPercent(hourlyFraction);
    return apr === null ? '' : signClass(apr, APR_DECIMALS);
  }

  function formatHourlyDetail(rawFraction) {
    if (rawFraction === null || rawFraction === undefined || rawFraction === '') return '—';
    const n = parseFloat(rawFraction);
    if (!isFinite(n)) return '—';
    return `Hourly: ${(n * window.AppConstants.PERCENT).toFixed(5)}%`;
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
    return `${sign}$${Math.round(Math.abs(value)).toLocaleString('en-US')}`;
  }

  function fmtSignedPct(value, decimals) {
    if (value === null || value === undefined || isNaN(value) || !isFinite(value)) return '—';
    const d = (decimals === undefined) ? 2 : decimals;
    const sign = { 1: '+', 0: '', '-1': '−' }[_displayedSign(value, d)];
    return `${sign}${Math.abs(value).toFixed(d)}%`;
  }

  // Hold time: '96d 22h' from one day, '5h 12m' from one hour, '12m'
  // below. Truncates, so a 59m59s hold reads '59m'.
  function formatDuration(ms) {
    if (!_isDisplayable(ms) || ms < 0) return '—';
    const { MS_PER_DAY, MS_PER_HOUR, MS_PER_MIN } = window.AppConstants;
    const days = Math.floor(ms / MS_PER_DAY);
    const hours = Math.floor((ms % MS_PER_DAY) / MS_PER_HOUR);
    const minutes = Math.floor((ms % MS_PER_HOUR) / MS_PER_MIN);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }

  const ISO_DATE_TIME_MINUTES = 16;

  // 'YYYY-MM-DD HH:MM' in UTC, the timezone the Tax tab assigns years in.
  function fmtDateTimeUTC(ts) {
    const d = new Date(ts);
    if (ts === null || ts === undefined || !isFinite(d.getTime())) return '—';
    return d.toISOString().slice(0, ISO_DATE_TIME_MINUTES).replace('T', ' ');
  }

  const MAX_FRACTION_DIGITS = 20;

  // Position size in base-asset units: '250 ETH', '3.14159 BTC'. The unit
  // is the market ticker's base ('BTC-USD' → 'BTC').
  function fmtAssetSize(size, market) {
    const n = typeof size === 'number' ? size : parseFloat(size);
    if (size === null || size === undefined || !isFinite(n)) return '—';
    const shown = Number(n.toPrecision(window.AppConstants.SIZE_SIGNIFICANT_DIGITS))
      .toLocaleString('en-US', { maximumFractionDigits: MAX_FRACTION_DIGITS });
    const base = String(market || '').split('-')[0];
    return base ? `${shown} ${base}` : shown;
  }

  // Payoff verdict caption (classifyClosed's winRate against its
  // breakevenWinRate, both percent): expectancy is non-negative from the
  // breakeven rate up, so that is where the tone turns to 'profit'.
  function breakevenVerdict(winRate, breakevenWinRate) {
    return {
      text: `WR ${winRate.toFixed(1)}% vs ${breakevenWinRate.toFixed(1)}% breakeven`,
      toneClass: winRate >= breakevenWinRate ? 'profit' : 'loss'
    };
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
    fmtDateShort, esc, signClass, formatDuration, fmtDateTimeUTC, fmtAssetSize,
    fundingAprClass, breakevenVerdict
  };
})();
