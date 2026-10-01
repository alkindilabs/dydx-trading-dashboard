const test = require('node:test');
const assert = require('node:assert/strict');
const Format = require('./format-setup');

test('esc handles &, <, >, ", and \' so it is safe in both text and attribute contexts', () => {
  assert.equal(Format.esc('a & b'),            'a &amp; b');
  assert.equal(Format.esc('<script>'),         '&lt;script&gt;');
  assert.equal(Format.esc('say "hi"'),         'say &quot;hi&quot;');
  assert.equal(Format.esc("it's"),             'it&#x27;s');
  assert.equal(Format.esc('"><img onerror>'),  '&quot;&gt;&lt;img onerror&gt;');
});

test('esc preserves entity ordering (& first so subsequent replacements are not double-encoded)', () => {
  assert.equal(Format.esc('&lt;'), '&amp;lt;');
});

test('esc coerces non-string inputs to string', () => {
  assert.equal(Format.esc(42), '42');
  assert.equal(Format.esc(null), 'null');
});

test('formatCurrency rounds to whole dollars and prefixes sign', () => {
  assert.equal(Format.formatCurrency(1234.5),  '+$1235');
  assert.equal(Format.formatCurrency(-99.4),   '-$99');
  assert.equal(Format.formatCurrency(NaN),     '-');
  assert.equal(Format.formatCurrency(null),    '-');
  assert.equal(Format.formatCurrency(undefined),'-');
});

test('fmtRatio distinguishes null vs Infinity vs finite', () => {
  assert.equal(Format.fmtRatio(null),     '—');
  assert.equal(Format.fmtRatio(undefined),'—');
  assert.equal(Format.fmtRatio(Infinity), '∞');
  assert.equal(Format.fmtRatio(-Infinity),'—');
  assert.equal(Format.fmtRatio(NaN),      '—');
  assert.equal(Format.fmtRatio(1.2345),   '1.23');
});

test('formatFundingApr multiplies hourly fraction by HOURS_PER_YEAR (8760)', () => {
  // 0.0001/hr × 8760 hrs × 100% = 87.60%
  assert.equal(Format.formatFundingApr(0.0001), '87.60%');
  assert.equal(Format.formatFundingApr('0'),    '0.00%');
  assert.equal(Format.formatFundingApr(''),     '-');
  assert.equal(Format.formatFundingApr(null),   '-');
});

test('funding APR that displays as 0.00% is unsigned and neutral, whatever the raw hourly sign', () => {
  assert.equal(Format.formatFundingApr(-1e-10), '0.00%');
  assert.equal(Format.fundingAprClass(0),        'zero');
  assert.equal(Format.fundingAprClass('1e-10'),  'zero');
  assert.equal(Format.fundingAprClass(-1e-10),   'zero');
  assert.equal(Format.fundingAprClass(0.0001),   'profit');
  assert.equal(Format.fundingAprClass(-0.0001),  'loss');
  assert.equal(Format.fundingAprClass(''),       '');
});

test('formatPrice keeps 6 significant digits for sub-dollar tokens', () => {
  assert.equal(Format.formatPrice(0.0000012),   '$0.0000012');
  assert.equal(Format.formatPrice(100.4),       '$100');
  assert.equal(Format.formatPrice(0),           '$0');
  assert.equal(Format.formatPrice(NaN),         '-');
});

test('formatCurrency renders an amount that rounds to $0 unsigned, and signs from $1 up', () => {
  assert.equal(Format.formatCurrency(0),      '$0');
  assert.equal(Format.formatCurrency(-0.04),  '$0');
  assert.equal(Format.formatCurrency(0.49),   '$0');
  assert.equal(Format.formatCurrency(0.5),    '+$1');
  assert.equal(Format.formatCurrency(-0.5),   '-$1');
});

test('signClass picks the colour from the value as displayed, so a $0 cell is never green or red', () => {
  assert.equal(Format.signClass(0),       'zero');
  assert.equal(Format.signClass(-0.04),   'zero');
  assert.equal(Format.signClass(0.49),    'zero');
  assert.equal(Format.signClass(0.5),     'profit');
  assert.equal(Format.signClass(-0.5),    'loss');
  assert.equal(Format.signClass(0.004, 2),  'zero');
  assert.equal(Format.signClass(-0.005, 2), 'loss');
  assert.equal(Format.signClass(null),    '');
  assert.equal(Format.signClass(NaN),     '');
});

test('fmtSignedPct leaves a value that rounds to zero unsigned', () => {
  assert.equal(Format.fmtSignedPct(0.004, 2),  '0.00%');
  assert.equal(Format.fmtSignedPct(-0.004, 2), '0.00%');
  assert.equal(Format.fmtSignedPct(0.005, 2),  '+0.01%');
  assert.equal(Format.fmtSignedPct(-1.5, 1),   '−1.5%');
});

test('formatDuration uses days + hours from one day, hours + minutes from one hour, minutes below', () => {
  const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
  assert.equal(Format.formatDuration(0),                        '0m');
  assert.equal(Format.formatDuration(12 * MIN + 59_999),        '12m');
  assert.equal(Format.formatDuration(HOUR - 1),                 '59m');
  assert.equal(Format.formatDuration(HOUR),                     '1h 0m');
  assert.equal(Format.formatDuration(5 * HOUR + 12 * MIN),      '5h 12m');
  assert.equal(Format.formatDuration(DAY - 1),                  '23h 59m');
  assert.equal(Format.formatDuration(DAY),                      '1d 0h');
  assert.equal(Format.formatDuration(96 * DAY + 22 * HOUR + 10 * MIN), '96d 22h');
  assert.equal(Format.formatDuration(-1),   '—');
  assert.equal(Format.formatDuration(NaN),  '—');
});

test('fmtDateTimeUTC renders YYYY-MM-DD HH:MM in UTC whatever the host timezone', () => {
  assert.equal(Format.fmtDateTimeUTC('2025-12-31T23:59:58.900Z'), '2025-12-31 23:59');
  assert.equal(Format.fmtDateTimeUTC('2026-01-01T00:00:00Z'),     '2026-01-01 00:00');
  assert.equal(Format.fmtDateTimeUTC('not a date'), '—');
  assert.equal(Format.fmtDateTimeUTC(undefined),    '—');
});

test('fmtAssetSize keeps full size precision, trims float noise and trailing zeros, and names the base asset', () => {
  assert.equal(Format.fmtAssetSize(250, 'ETH-USD'),                 '250 ETH');
  assert.equal(Format.fmtAssetSize(3.14159, 'BTC-USD'),             '3.14159 BTC');
  assert.equal(Format.fmtAssetSize(0.1 + 0.2, 'BTC-USD'),           '0.3 BTC');
  assert.equal(Format.fmtAssetSize('0.0500', 'BTC-USD'),            '0.05 BTC');
  assert.equal(Format.fmtAssetSize(1250000, 'PEPE-USD'),            '1,250,000 PEPE');
  assert.equal(Format.fmtAssetSize(null, 'BTC-USD'),  '—');
  assert.equal(Format.fmtAssetSize(NaN, 'BTC-USD'),   '—');
});

test('fmtNotional groups thousands and keeps whole dollars', () => {
  assert.equal(Format.fmtNotional(1234567.3), '$1,234,567');
  assert.equal(Format.fmtNotional(-1234.6),   '-$1,235');
  assert.equal(Format.fmtNotional(999),       '$999');
  assert.equal(Format.fmtNotional(NaN),       '—');
});

test('breakevenVerdict reads the win rate against the breakeven rate, profit-toned from the breakeven rate up', () => {
  assert.deepEqual(Format.breakevenVerdict(25, 25),
    { text: 'WR 25.0% vs 25.0% breakeven', toneClass: 'profit' });
  assert.equal(Format.breakevenVerdict(24.9, 25).toneClass, 'loss');
});
