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
  assert.equal(Format.formatCurrency(0),       '+$0');
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

test('formatPrice keeps 6 significant digits for sub-dollar tokens', () => {
  assert.equal(Format.formatPrice(0.0000012),   '$0.0000012');
  assert.equal(Format.formatPrice(100.4),       '$100');
  assert.equal(Format.formatPrice(0),           '$0');
  assert.equal(Format.formatPrice(NaN),         '-');
});
