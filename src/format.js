// Display formatters. Pure functions. Single source of truth for every
// numeric / date / currency / percent cell in the dashboard so formatting
// can't drift across panels.
//
// Depends on window.AppConstants (constants.js must load first) and, at
// call time, window.RiskMetrics.decimalNumberOf (the funding-rate readers).

(function () {
  'use strict';

  function _hoursPerYear() {
    return window.AppConstants.HOURS_PER_YEAR;
  }


  function _isDisplayable(value) {
    return typeof value === 'number' && isFinite(value);
  }

  // The decimal a value stands for, past the binary noise of the
  // arithmetic that made it (AppConstants).
  const { NOISE_FREE_SIGNIFICANT_DIGITS } = window.AppConstants;

  // |value| rounded the way the cell displays it: the one rounding rule of
  // every number on screen. Half away from zero, on the decimal the value
  // stands for (NOISE_FREE_SIGNIFICANT_DIGITS), so 1.005 reads 1.01 and
  // 0.15% reads 0.2%. The shift to the rounding digit is done in the
  // exponent of the decimal text, never by a binary multiplication. The
  // sign and the colour of a signed cell are both decided from this, so a
  // value that renders as $0 (or 0.00%) is neither signed nor coloured.
  function _displayedMagnitude(value, fractionDigits) {
    const magnitude = Math.abs(value);
    if (!isFinite(magnitude)) return magnitude;
    const { digits, exponent } = _noiseFreeDecimal(magnitude);
    const scaled = Number(`${digits}e${exponent + fractionDigits}`);
    if (scaled > Number.MAX_SAFE_INTEGER) return magnitude;
    return Number(`${Math.round(scaled)}e-${fractionDigits}`);
  }

  // A finite magnitude as the decimal it stands for: its digits at
  // NOISE_FREE_SIGNIFICANT_DIGITS ('6.40122500000000') and its power of
  // ten.
  function _noiseFreeDecimal(magnitude) {
    const [digits, exponent] = magnitude.toExponential(NOISE_FREE_SIGNIFICANT_DIGITS - 1).split('e');
    return { digits, exponent: Number(exponent) };
  }

  // |value| at `significantDigits` significant digits, rounded by the same
  // rule as _displayedMagnitude, as plain decimal text (never exponent
  // form) with trailing zeros dropped: '64012.3', '0.000000000731959',
  // and '1000000' for 999999.5, whose rounding carries into the next
  // power of ten. The digits are placed as text, so no binary arithmetic
  // touches the rounded decimal.
  function _significantText(value, significantDigits) {
    const magnitude = Math.abs(value);
    if (magnitude === 0) return '0';
    const { digits, exponent } = _noiseFreeDecimal(magnitude);
    const rounded = String(Math.round(Number(`${digits}e${significantDigits - 1}`)));
    const shift = exponent - (significantDigits - 1);
    if (shift >= 0) return rounded + '0'.repeat(shift);
    const fractionLength = -shift;
    const padded = rounded.padStart(fractionLength + 1, '0');
    const whole = padded.slice(0, -fractionLength);
    const fraction = padded.slice(-fractionLength).replace(/0+$/, '');
    return fraction ? `${whole}.${fraction}` : whole;
  }

  function _displayedSign(value, fractionDigits) {
    if (_displayedMagnitude(value, fractionDigits) === 0) return 0;
    return value > 0 ? 1 : -1;
  }

  // The number a cell at `fractionDigits` shows (0, never -0), for a
  // verdict, tier or tie test that must agree with the digits beside it;
  // a non-number passes through.
  function asDisplayed(value, fractionDigits) {
    if (!_isDisplayable(value)) return value;
    return _displayedSign(value, fractionDigits) * _displayedMagnitude(value, fractionDigits);
  }

  // The decimal a value stands for (_noiseFreeDecimal), for a comparison
  // that must not turn on the binary noise of the arithmetic that made it:
  // 1.2 × 2194.59 (2633.5080000000003) is 2633.508. A non-number passes
  // through.
  function asDecimal(value) {
    if (!_isDisplayable(value) || value === 0) return value;
    const { digits, exponent } = _noiseFreeDecimal(Math.abs(value));
    return Math.sign(value) * Number(`${digits}e${exponent}`);
  }

  // The one minus glyph every signed number in the dashboard is written
  // with, whatever its unit.
  const MINUS = '-';
  const SIGN_PREFIX = Object.freeze({ 1: '+', 0: '', '-1': MINUS });

  // '+', '' or MINUS for a cell that signs both ways.
  function _signPrefix(value, fractionDigits) {
    return SIGN_PREFIX[_displayedSign(value, fractionDigits)];
  }

  // MINUS or '' for a cell that leaves a positive value unsigned.
  function _minusPrefix(value, fractionDigits) {
    return _displayedSign(value, fractionDigits) < 0 ? MINUS : '';
  }

  // The thousands grouping of every dollar amount on screen ('1,234').
  const GROUPING_LOCALE = 'en-US';

  // |value| as displayed, at exactly `fractionDigits`, thousands grouped.
  function _groupedMagnitude(value, fractionDigits) {
    return _displayedMagnitude(value, fractionDigits)
      .toLocaleString(GROUPING_LOCALE, { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits });
  }

  // An unsigned plain decimal already rounded elsewhere ('64012.1235'),
  // with its integer digits grouped and its fraction untouched
  // ('64,012.1235').
  function groupDecimalText(text) {
    const [whole, fraction] = String(text).split('.');
    const grouped = Number(whole).toLocaleString(GROUPING_LOCALE);
    return fraction === undefined ? grouped : `${grouped}.${fraction}`;
  }

  const WHOLE_DOLLARS = 0;

  const CENTS = window.AppConstants.CENT_DIGITS;

  const CURRENCY = Object.freeze({ USD: '$', EUR: '€' });

  // Signed whole dollars with thousands separators ('+$1,235',
  // '-$72,410', '$0'), '-' when there is no number.
  function formatCurrency(value) {
    if (value === null || value === undefined || isNaN(value)) return '-';
    return _signPrefix(value, WHOLE_DOLLARS) + CURRENCY.USD + _groupedMagnitude(value, WHOLE_DOLLARS);
  }

  // Signed money at cents with thousands separators ('+$1,234.56',
  // '-$18,452.63', '$0.00', '-€1,234.56' with CURRENCY.EUR), '—' when
  // there is no number. The Total Profit ledger, the Performance-by-Asset
  // money columns and the Tax tab, whose rows add up to their totals as
  // displayed (RiskMetrics.profitLedger, TaxReport). Colour with
  // signClass(value, CENTS).
  function formatCents(value, currency = CURRENCY.USD) {
    if (!_isDisplayable(value)) return '—';
    return _signPrefix(value, CENTS) + currency + _groupedMagnitude(value, CENTS);
  }

  // Colour class for a signed cell: 'profit' / 'loss', 'zero' when the
  // value displays as zero at `fractionDigits` (whole dollars by default),
  // '' when there is no number to colour.
  function signClass(value, fractionDigits = WHOLE_DOLLARS) {
    if (!_isDisplayable(value)) return '';
    return { 1: 'profit', 0: 'zero', '-1': 'loss' }[_displayedSign(value, fractionDigits)];
  }

  // True when a dollar loss (a positive drawdown) displays as a non-zero
  // loss at whole dollars (formatCurrency of −loss). The one test of
  // whether a drawdown shows: one that renders as $0 is no drawdown in
  // every drawdown view, so it is never coloured or captioned as a loss.
  function displaysAsLoss(loss) {
    return signClass(-loss) === 'loss';
  }

  // A drawdown from `peak` to `trough` (levels on a cumulative curve) as
  // its cells show it: the displayed peak less the displayed trough at
  // whole dollars, so a depth beside its peak and trough foots as
  // displayed, the rule the Monthly PROFIT column telescopes by. Whether
  // it shows at all is displaysAsLoss of this value.
  function drawdownAsDisplayed(peak, trough) {
    return asDisplayed(peak, WHOLE_DOLLARS) - asDisplayed(trough, WHOLE_DOLLARS);
  }

  const PERCENT_DECIMALS = 1;

  // The value as displayed at exactly `fractionDigits`, minus-signed only
  // when it displays non-zero ('0.2', '-1.23', '0.0').
  function _fixedText(value, fractionDigits) {
    return _minusPrefix(value, fractionDigits) + _displayedMagnitude(value, fractionDigits).toFixed(fractionDigits);
  }

  // A plain number at `fractionDigits` ('0.2', '-3.5', '42'), '—'
  // without a finite number: a count, a span or a share written into a
  // caption or a tooltip, rounded like every other number on screen.
  function fmtFixed(value, fractionDigits) {
    return _isDisplayable(value) ? _fixedText(value, fractionDigits) : '—';
  }

  // A plain decimal at `significantDigits` significant digits, rounded by
  // the one display rule (_significantText), ungrouped, trailing zeros
  // dropped: the Tax exports' sizes and prices. '—' without a number.
  function fmtSignificant(value, significantDigits) {
    if (!_isDisplayable(value)) return '—';
    return (value < 0 ? MINUS : '') + _significantText(value, significantDigits);
  }

  // A percent at PERCENT_DECIMALS ('0.2%', '-3.5%'), '-' without a number.
  // The one win-rate text: the Win Rate card, the Strategy Edge readout,
  // the Payoff captions (breakevenVerdict), Win Rate Trend, the Monthly and
  // Performance-by-Asset WIN RATE and the Behavior patterns' SUCCESS RATE.
  function formatPercent(value) {
    if (value === null || value === undefined || isNaN(value)) return '-';
    return _fixedText(value, PERCENT_DECIMALS) + '%';
  }

  const WHOLE_NUMBER = 0;
  // A sampling's periods per year, whole, in the Sharpe / Sortino and
  // VaR tooltips.
  const PERIODS_PER_YEAR_DECIMALS = WHOLE_NUMBER;
  const SMALL_NUMBER_DECIMALS = 4;

  // Universal numeric formatter. Bare integer for |value| >= 1; up to
  // SMALL_NUMBER_DECIMALS below so tiny sizes (0.0001 BTC) don't collapse
  // to 0.
  function fmtNum(value) {
    if (value === null || value === undefined || value === '') return '-';
    const n = parseFloat(value);
    if (!isFinite(n)) return '-';
    const whole = Math.abs(n) >= 1;
    const digits = whole ? WHOLE_NUMBER : SMALL_NUMBER_DECIMALS;
    const shown = _displayedMagnitude(n, digits);
    const text = whole ? String(shown) : shown.toFixed(digits).replace(/\.?0+$/, '');
    return _minusPrefix(n, digits) + text;
  }

  const APR_DECIMALS = 2;

  // Annualized funding rate in percent from an hourly fraction, or null
  // when it is not wholly numeric (RiskMetrics.decimalNumberOf).
  // Simple, not compounded (funding rate changes hour-to-hour). The one
  // annualization of a funding rate: the CURRENT / PREDICTED cells and
  // the funding chart's tooltip.
  function fundingAprPercent(hourlyFraction) {
    const n = window.RiskMetrics.decimalNumberOf(hourlyFraction);
    return n === null ? null : n * _hoursPerYear() * window.AppConstants.PERCENT;
  }

  function formatFundingApr(hourlyFraction) {
    const apr = fundingAprPercent(hourlyFraction);
    if (apr === null) return '-';
    return _fixedText(apr, APR_DECIMALS) + '%';
  }

  // signClass of the APR as formatFundingApr displays it.
  function fundingAprClass(hourlyFraction) {
    const apr = fundingAprPercent(hourlyFraction);
    return apr === null ? '' : signClass(apr, APR_DECIMALS);
  }

  // dYdX hourly funding rates step in 1.25e-7, 0.0000125% in percent: a
  // multiple of the step has at most HOURLY_RATE_STEP_DECIMALS decimals.
  const HOURLY_RATE_STEP_DECIMALS = 7;
  // A rate below the step (a predicted rate, an average) keeps at least
  // this many significant digits, so it never reads 0%.
  const HOURLY_RATE_SIGNIFICANT_DIGITS = 3;
  const HOURLY_RATE_ZERO_LABEL = '0%';

  // An hourly funding rate in percent, trailing zeros trimmed: at least
  // HOURLY_RATE_STEP_DECIMALS decimals, so every multiple of the step
  // prints exactly ('+0.0001125%', '-0.0007625%'), and at least
  // HOURLY_RATE_SIGNIFICANT_DIGITS significant digits ('+0.00000818%').
  // '0%' for zero. Every hourly rate on the Market tab (chart tooltip,
  // rate-cell tooltips, the hero's Implied hourly).
  function formatHourlyRate(percent) {
    if (percent === 0) return HOURLY_RATE_ZERO_LABEL;
    const magnitude = Math.abs(percent);
    const significantDecimals = HOURLY_RATE_SIGNIFICANT_DIGITS - 1 - Math.floor(Math.log10(magnitude));
    const decimals = Math.max(HOURLY_RATE_STEP_DECIMALS, significantDecimals);
    const digits = _fixedText(magnitude, decimals).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
    return `${percent > 0 ? '+' : MINUS}${digits}%`;
  }

  function formatHourlyDetail(rawFraction) {
    const n = window.RiskMetrics.decimalNumberOf(rawFraction);
    if (n === null) return '—';
    return `Hourly: ${formatHourlyRate(n * window.AppConstants.PERCENT)}`;
  }

  const PRICE_SIGNIFICANT_DIGITS = 6;

  // Unsigned dollar formatter for prices, at PRICE_SIGNIFICANT_DIGITS
  // significant digits whatever the magnitude, so neither a micro-priced
  // perp ($0.000000000406473) nor a $1-$1000 market ($3.4) loses its moves
  // to rounding. Rounded by the one display rule (a float VWAP just below
  // the decimal tie 64012.25 reads $64,012.3), always a plain decimal
  // (never exponent form), thousands grouped, trailing zeros dropped
  // ($52,345).
  function formatPrice(value) {
    if (value === null || value === undefined || value === '') return '-';
    const n = typeof value === 'number' ? value : parseFloat(value);
    if (!isFinite(n)) return '-';
    return CURRENCY.USD + groupDecimalText(_significantText(n, PRICE_SIGNIFICANT_DIGITS));
  }

  const RATIO_DECIMALS = 2;

  // 2-decimal ratio with consistent null/Infinity handling. Unsigned when
  // positive; signed from the value as displayed, so a ratio that renders
  // as 0.00 never reads '-0.00'.
  function fmtRatio(v) {
    if (v === null || v === undefined) return '—';
    if (v === Infinity) return '∞';
    if (typeof v !== 'number' || !isFinite(v)) return '—';
    return _fixedText(v, RATIO_DECIMALS);
  }

  const PAYOFF_SUFFIX = ' : 1';

  // Payoff ratio (avg win ÷ avg loss) as '0.57 : 1', '—' without a
  // number. The one payoff text: the Overview hero, Trading Statistics,
  // the phase diagram and the Performance card, each of which keeps its
  // own placeholder for an unavailable payoff.
  function fmtPayoff(payoff) {
    if (!_isDisplayable(payoff)) return '—';
    return fmtRatio(payoff) + PAYOFF_SUFFIX;
  }

  const SHORT_NUMBER_DECIMALS = 2;
  const SHORT_NUMBER_UNIT_STEP = 1e3;
  const SHORT_NUMBER_UNITS = Object.freeze([
    { scale: 1, suffix: '' },
    { scale: SHORT_NUMBER_UNIT_STEP, suffix: 'K' },
    { scale: SHORT_NUMBER_UNIT_STEP * SHORT_NUMBER_UNIT_STEP, suffix: 'M' }
  ]);

  // The unit formatShortNumber prints `n` in: the smallest one whose value,
  // as displayed, stays below the next step, so 999999.5 reads '1.00M'
  // rather than '1000.00K'.
  function _shortNumberUnit(n) {
    const staysBelowStep = (unit) =>
      _displayedMagnitude(n / unit.scale, SHORT_NUMBER_DECIMALS) < SHORT_NUMBER_UNIT_STEP;
    return SHORT_NUMBER_UNITS.find(staysBelowStep) || SHORT_NUMBER_UNITS[SHORT_NUMBER_UNITS.length - 1];
  }

  // '999.99', '1.50K', '2.50M'.
  function formatShortNumber(n) {
    if (!isFinite(n)) return '∞';
    const unit = _shortNumberUnit(n);
    return _fixedText(n / unit.scale, SHORT_NUMBER_DECIMALS) + unit.suffix;
  }

  // The number formatShortNumber prints, back in the units of `n` (1799 →
  // 1800, as '1.80K'), for a bin that must hold a value where its label
  // reads; a non-finite value passes through.
  function displayedShortNumber(n) {
    if (!isFinite(n)) return n;
    const unit = _shortNumberUnit(n);
    return asDecimal(asDisplayed(n / unit.scale, SHORT_NUMBER_DECIMALS) * unit.scale);
  }

  function fmtNotional(value) {
    if (value === null || value === undefined || isNaN(value) || !isFinite(value)) return '—';
    return _minusPrefix(value, WHOLE_DOLLARS) + CURRENCY.USD + _groupedMagnitude(value, WHOLE_DOLLARS);
  }

  const SIGNED_PERCENT_DECIMALS = 2;
  // A per-trade return in percent: the Positions board's PROFIT %, and the
  // value the Win/Loss Distribution bins each trade on.
  const TRADE_RETURN_DECIMALS = SIGNED_PERCENT_DECIMALS;

  function fmtSignedPct(value, decimals = SIGNED_PERCENT_DECIMALS) {
    if (value === null || value === undefined || isNaN(value) || !isFinite(value)) return '—';
    return `${_signPrefix(value, decimals)}${_displayedMagnitude(value, decimals).toFixed(decimals)}%`;
  }

  // The span formatDuration shows, in ms: whole minutes below a day, whole
  // hours from one, each rounded once from the milliseconds by the one
  // display rule (asDisplayed), so 59m 59.9s is one hour and 23h 59.7m one
  // day; null for a negative or non-number span. A bucket of hold times
  // bins on it, so a trade lands where its DURATION reads.
  function displayedDurationMs(ms) {
    if (!_isDisplayable(ms) || ms < 0) return null;
    const { MS_PER_HOUR, MS_PER_MIN, MS_PER_DAY } = window.AppConstants;
    const minutesMs = asDisplayed(ms / MS_PER_MIN, WHOLE_NUMBER) * MS_PER_MIN;
    return minutesMs < MS_PER_DAY ? minutesMs : asDisplayed(ms / MS_PER_HOUR, WHOLE_NUMBER) * MS_PER_HOUR;
  }

  // A span: '96d 22h' from one day, '5h 12m' from one hour, '12m' below,
  // of the span as displayed (displayedDurationMs), so its smallest unit
  // carries into the larger one: 59m 59.9s reads '1h 0m' and 23h 59.7m
  // reads '1d 0h'.
  function formatDuration(ms) {
    const shown = displayedDurationMs(ms);
    if (shown === null) return '—';
    const { MS_PER_HOUR, MS_PER_MIN, MINUTES_PER_HOUR, HOURS_PER_DAY } = window.AppConstants;
    const minutes = shown / MS_PER_MIN;
    if (minutes < MINUTES_PER_HOUR) return `${minutes}m`;
    if (minutes < HOURS_PER_DAY * MINUTES_PER_HOUR) {
      return `${Math.floor(minutes / MINUTES_PER_HOUR)}h ${minutes % MINUTES_PER_HOUR}m`;
    }
    const hours = shown / MS_PER_HOUR;
    return `${Math.floor(hours / HOURS_PER_DAY)}d ${hours % HOURS_PER_DAY}h`;
  }

  const DATA_AGE_JUST_NOW_MAX_MS = 45 * window.AppConstants.MS_PER_SEC;
  const DATA_AGE_ONE_MINUTE_MAX_MS = 90 * window.AppConstants.MS_PER_SEC;

  // How old the rendered snapshot is ('Updated just now', 'Updated 12m
  // ago', 'Updated 3h ago', 'Updated 2d ago'), the masthead caption. Each
  // unit is rounded once from the milliseconds, so 89.6 minutes reads 1h.
  function formatDataAge(ms) {
    const { MS_PER_MIN, MS_PER_HOUR, MS_PER_DAY, MINUTES_PER_HOUR, HOURS_PER_DAY } = window.AppConstants;
    if (ms < DATA_AGE_JUST_NOW_MAX_MS) return 'Updated just now';
    if (ms < DATA_AGE_ONE_MINUTE_MAX_MS) return 'Updated 1m ago';
    const mins = asDisplayed(ms / MS_PER_MIN, WHOLE_NUMBER);
    if (mins < MINUTES_PER_HOUR) return `Updated ${mins}m ago`;
    const hrs = asDisplayed(ms / MS_PER_HOUR, WHOLE_NUMBER);
    if (hrs < HOURS_PER_DAY) return `Updated ${hrs}h ago`;
    return `Updated ${asDisplayed(ms / MS_PER_DAY, WHOLE_NUMBER)}d ago`;
  }

  const ISO_DATE_TIME_MINUTES = 16;

  // 'YYYY-MM-DD HH:MM' in UTC, the timezone the Tax tab assigns years in.
  function fmtDateTimeUTC(ts) {
    const d = new Date(ts);
    if (ts === null || ts === undefined || !isFinite(d.getTime())) return '—';
    return d.toISOString().slice(0, ISO_DATE_TIME_MINUTES).replace('T', ' ');
  }

  // Position size in base-asset units: '250 ETH', '3.14159 BTC',
  // '1,250,000 PEPE'. At SIZE_SIGNIFICANT_DIGITS, rounded by the one
  // display rule as formatPrice is (a size stored just below a decimal tie
  // rounds up), grouped like every amount. The unit is the market ticker's
  // base ('BTC-USD' → 'BTC').
  function fmtAssetSize(size, market) {
    const n = typeof size === 'number' ? size : parseFloat(size);
    if (size === null || size === undefined || !isFinite(n)) return '—';
    const sign = n < 0 ? MINUS : '';
    const shown = sign + groupDecimalText(_significantText(n, window.AppConstants.SIZE_SIGNIFICANT_DIGITS));
    const base = String(market || '').split('-')[0];
    return base ? `${shown} ${base}` : shown;
  }

  // Payoff verdict caption (classifyClosed's winRate against its
  // breakevenWinRate, both percent, both through formatPercent like every
  // win rate): 'profit' above the breakeven rate and 'loss' below it,
  // compared as displayed. Rates that display alike cannot say which side
  // the trades fell on, so the tone is the expectancy's at whole dollars
  // (signClass; 'zero' at $0), never contradicting the expectancy shown.
  function breakevenVerdict(winRate, breakevenWinRate, expectancy) {
    const shownWinRate = asDisplayed(winRate, PERCENT_DECIMALS);
    const shownBreakeven = asDisplayed(breakevenWinRate, PERCENT_DECIMALS);
    const toneClass = shownWinRate === shownBreakeven ? signClass(expectancy)
      : shownWinRate > shownBreakeven ? 'profit' : 'loss';
    return {
      text: `WR ${formatPercent(winRate)} vs ${formatPercent(breakevenWinRate)} breakeven`,
      toneClass
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
    formatCurrency, WHOLE_DOLLARS, formatCents, CENTS, CURRENCY, formatPercent, PERCENT_DECIMALS, asDisplayed, asDecimal, fmtFixed, fmtSignificant, fmtNum,
    formatFundingApr, fundingAprPercent, APR_DECIMALS, formatHourlyDetail,
    formatHourlyRate, HOURLY_RATE_ZERO_LABEL,
    formatPrice, groupDecimalText, fmtRatio, RATIO_DECIMALS, fmtPayoff, formatShortNumber, displayedShortNumber, fmtNotional, fmtSignedPct,
    TRADE_RETURN_DECIMALS,
    fmtDateShort, esc, signClass, formatDuration, displayedDurationMs, fmtDateTimeUTC, fmtAssetSize,
    fundingAprClass, breakevenVerdict, displaysAsLoss, drawdownAsDisplayed, formatDataAge, PERIODS_PER_YEAR_DECIMALS
  };
})();
