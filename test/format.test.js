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
  assert.equal(Format.formatCurrency(1234.5),  '+$1,235');
  assert.equal(Format.formatCurrency(-99.4),   '-$99');
  assert.equal(Format.formatCurrency(NaN),     '-');
  assert.equal(Format.formatCurrency(null),    '-');
  assert.equal(Format.formatCurrency(undefined),'-');
});

test('formatCents shows cents with thousands separators, signed and coloured from the cent up', () => {
  assert.equal(Format.formatCents(-18452.63),     '-$18,452.63');
  assert.equal(Format.formatCents(1234567.891),   '+$1,234,567.89');
  assert.equal(Format.formatCents(999.999),       '+$1,000.00');
  assert.equal(Format.formatCents(0.006),         '+$0.01');
  assert.equal(Format.formatCents(-0.004),        '$0.00');
  assert.equal(Format.signClass(-0.004, Format.CENTS), 'zero');
  assert.equal(Format.signClass(0.006, Format.CENTS),  'profit');
  assert.equal(Format.formatCents(null),          '—');
  assert.equal(Format.formatCents(NaN),           '—');
});

test('formatCents takes a currency symbol, so EUR amounts group and sign the same way', () => {
  assert.equal(Format.formatCents(-12345.67, Format.CURRENCY.EUR), '-€12,345.67');
  assert.equal(Format.formatCents(1234567.8, Format.CURRENCY.EUR),  '+€1,234,567.80');
  assert.equal(Format.formatCents(-0.004, Format.CURRENCY.EUR),     '€0.00');
  assert.equal(Format.formatCents(12345.67, Format.CURRENCY.USD),   '+$12,345.67');
  assert.equal(Format.formatCents(null, Format.CURRENCY.EUR),       '—');
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

test('formatHourlyRate keeps three significant digits, so the smallest hourly funding steps print nonzero', () => {
  // Percent values: dYdX rates step in 1.25e-7 (0.0000125%).
  assert.equal(Format.formatHourlyRate(0.000025), '+0.000025%');
  assert.equal(Format.formatHourlyRate(-0.0000125), '-0.0000125%');
  assert.equal(Format.formatHourlyRate(0.000008180), '+0.00000818%');
  assert.equal(Format.formatHourlyRate(0.0125), '+0.0125%');
  assert.equal(Format.formatHourlyRate(0), '0%');
});

test('formatHourlyRate rounds a rate between funding steps half away from zero, as fmtFixed does', () => {
  // 0.00001015% at three significant digits is a tie; its float sits
  // just below it.
  assert.equal(Format.formatHourlyRate(0.00001015), '+0.0000102%');
  assert.equal(Format.formatHourlyRate(-0.00001015), '-0.0000102%');
  assert.equal(Format.formatHourlyRate(0.00001015), `+${Format.fmtFixed(0.00001015, 7)}%`);
});

test('formatDataAge rounds the snapshot age once, from its milliseconds, in the unit it shows', () => {
  const { MS_PER_SEC, MS_PER_MIN, MS_PER_HOUR } = window.AppConstants;
  assert.equal(Format.formatDataAge(30 * MS_PER_SEC), 'Updated just now');
  assert.equal(Format.formatDataAge(60 * MS_PER_SEC), 'Updated 1m ago');
  assert.equal(Format.formatDataAge(150 * MS_PER_SEC), 'Updated 3m ago');
  // 89.6 minutes is 1.49 hours, and 35.6 hours 1.48 days: never rounded
  // twice into 2h (via 90 minutes) or 2d (via 36 hours).
  assert.equal(Format.formatDataAge(89.6 * MS_PER_MIN), 'Updated 1h ago');
  assert.equal(Format.formatDataAge(35.6 * MS_PER_HOUR), 'Updated 1d ago');
});

test('formatHourlyRate prints every multiple of the 1.25e-7 funding step exactly, however many digits it needs', () => {
  const STEP_PERCENT = 0.0000125;
  // 9, 61 and 123 steps need four or more significant digits.
  assert.equal(Format.formatHourlyRate(9 * STEP_PERCENT), '+0.0001125%');
  assert.equal(Format.formatHourlyRate(-61 * STEP_PERCENT), '-0.0007625%');
  assert.equal(Format.formatHourlyRate(123 * STEP_PERCENT), '+0.0015375%');
  // The printed rate × 8760 h is the annualized value printed beside it.
  assert.equal(Format.fmtSignedPct(-0.0007625 * window.AppConstants.HOURS_PER_YEAR, 2), '-6.68%');
});

test('formatHourlyDetail reads an hourly fraction at the same significant digits as formatHourlyRate', () => {
  assert.equal(Format.formatHourlyDetail('0.000000125'), 'Hourly: +0.0000125%');
  assert.equal(Format.formatHourlyDetail('-0.00000045833333333333'), 'Hourly: -0.0000458%');
  assert.equal(Format.formatHourlyDetail('4e-10'), 'Hourly: +0.00000004%');
  assert.equal(Format.formatHourlyDetail('0'), 'Hourly: 0%');
  assert.equal(Format.formatHourlyDetail(''), '—');
});

test('a funding rate that is not wholly numeric has no APR and no hourly detail, never its leading digits', () => {
  for (const rate of ['0.0000125xyz', 'abc']) {
    assert.equal(Format.fundingAprPercent(rate), null, rate);
    assert.equal(Format.fundingAprClass(rate), '', rate);
    assert.equal(Format.formatHourlyDetail(rate), '—', rate);
  }
  const { HOURS_PER_YEAR, PERCENT } = window.AppConstants;
  assert.equal(Format.fundingAprPercent('0.0000125'), 0.0000125 * HOURS_PER_YEAR * PERCENT);
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

test('formatPrice keeps 6 significant digits at every magnitude, unsigned', () => {
  // A $1-$1000 market is not rounded to whole dollars: 3.0 and 3.3 differ.
  assert.equal(Format.formatPrice(0.0000012),   '$0.0000012');
  assert.equal(Format.formatPrice(1.45),        '$1.45');
  assert.equal(Format.formatPrice(3.4),         '$3.4');
  assert.equal(Format.formatPrice(100.4),       '$100.4');
  assert.equal(Format.formatPrice(2543.2712),   '$2,543.27');
  assert.equal(Format.formatPrice(52345.04),    '$52,345');
  assert.equal(Format.formatPrice(-1.5),        '$1.5');
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
  assert.equal(Format.fmtSignedPct(-1.5, 1),   '-1.5%');
});

test('formatDuration uses days + hours from one day, hours + minutes from one hour, minutes below', () => {
  const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
  assert.equal(Format.formatDuration(0),                        '0m');
  assert.equal(Format.formatDuration(12 * MIN + 20_000),        '12m');
  assert.equal(Format.formatDuration(HOUR),                     '1h 0m');
  assert.equal(Format.formatDuration(5 * HOUR + 12 * MIN),      '5h 12m');
  assert.equal(Format.formatDuration(DAY),                      '1d 0h');
  assert.equal(Format.formatDuration(96 * DAY + 22 * HOUR + 10 * MIN), '96d 22h');
  assert.equal(Format.formatDuration(-1),   '—');
  assert.equal(Format.formatDuration(NaN),  '—');
});

test('formatDuration rounds its smallest unit half away from zero from the milliseconds, carrying into the larger unit', () => {
  const SEC = 1_000, MIN = 60 * SEC, HOUR = 60 * MIN, DAY = 24 * HOUR;
  assert.equal(Format.formatDuration(29_999),                         '0m');
  assert.equal(Format.formatDuration(30 * SEC),                       '1m');
  assert.equal(Format.formatDuration(12 * MIN + 30 * SEC - 1),        '12m');
  assert.equal(Format.formatDuration(12 * MIN + 30 * SEC),            '13m');
  assert.equal(Format.formatDuration(5 * HOUR + 12 * MIN + 30 * SEC), '5h 13m');
  assert.equal(Format.formatDuration(7 * DAY + 17.7 * HOUR),          '7d 18h');
  assert.equal(Format.formatDuration(1 * DAY + 23 * HOUR + 29 * MIN), '1d 23h');
  assert.equal(Format.formatDuration(1 * DAY + 23 * HOUR + 30 * MIN), '2d 0h');
  // 59m 59.9s reads one hour, and 23h 59.7m one day, not '59m' / '23h 59m'.
  assert.equal(Format.formatDuration(HOUR - 100),                     '1h 0m');
  assert.equal(Format.formatDuration(DAY - 0.3 * MIN),                '1d 0h');
  assert.equal(Format.formatDuration(DAY - 31 * SEC),                 '23h 59m');
});

test('displayedDurationMs is the span formatDuration shows, in ms: whole minutes below a day, whole hours from one', () => {
  const SEC = 1_000, MIN = 60 * SEC, HOUR = 60 * MIN, DAY = 24 * HOUR;
  assert.equal(Format.displayedDurationMs(HOUR - 300),               HOUR);
  assert.equal(Format.displayedDurationMs(4 * HOUR - 200),           4 * HOUR);
  assert.equal(Format.displayedDurationMs(12 * MIN + 30 * SEC - 1),  12 * MIN);
  assert.equal(Format.displayedDurationMs(DAY - 300),                DAY);
  assert.equal(Format.displayedDurationMs(71 * HOUR + 40 * MIN),     3 * DAY);
  assert.equal(Format.displayedDurationMs(167 * HOUR + 40 * MIN),    7 * DAY);
  assert.equal(Format.displayedDurationMs(-1),  null);
  assert.equal(Format.displayedDurationMs(NaN), null);
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

test('fmtAssetSize rounds at its significant digits by the one display rule, half away from zero on the decimal', () => {
  // 0.1234567890125 is stored just below the decimal tie; binary
  // toPrecision rounded it down to ...012.
  assert.equal(Format.fmtAssetSize(0.1234567890125, 'X-USD'),  '0.123456789013 X');
  assert.equal(Format.fmtAssetSize(-0.1234567890125, 'X-USD'), '-0.123456789013 X');
  assert.equal(Format.fmtAssetSize(1234567.89012345, 'X-USD'), '1,234,567.89012 X');
});

test('fmtNotional groups thousands and keeps whole dollars', () => {
  assert.equal(Format.fmtNotional(1234567.3), '$1,234,567');
  assert.equal(Format.fmtNotional(-1234.6),   '-$1,235');
  assert.equal(Format.fmtNotional(999),       '$999');
  assert.equal(Format.fmtNotional(NaN),       '—');
});

test('breakevenVerdict reads the win rate against the breakeven rate, profit-toned above it and loss-toned below', () => {
  assert.deepEqual(Format.breakevenVerdict(25.1, 25, 1),
    { text: 'WR 25.1% vs 25.0% breakeven', toneClass: 'profit' });
  assert.equal(Format.breakevenVerdict(24.9, 25, -1).toneClass, 'loss');
});

test('breakevenVerdict tones rates that display alike by the expectancy as displayed, zero neutral', () => {
  // 4 wins of +$7,496 and 12 losses of -$2,504: WR 25%, breakeven 25.04%,
  // expectancy -$4. Both rates read 25.0%; the loss is in the expectancy.
  const WIN = 7496, LOSS = 2504, WINS = 4, LOSSES = 12;
  const winRate = (WINS / (WINS + LOSSES)) * 100;
  const breakeven = 100 / (1 + WIN / LOSS);
  const expectancy = (WINS * WIN - LOSSES * LOSS) / (WINS + LOSSES);
  assert.deepEqual(Format.breakevenVerdict(winRate, breakeven, expectancy),
    { text: 'WR 25.0% vs 25.0% breakeven', toneClass: 'loss' });
  assert.equal(Format.breakevenVerdict(25, 25, 0).toneClass, 'zero');
  assert.equal(Format.breakevenVerdict(25, 25, 0.4).toneClass, 'zero', 'an expectancy that displays as $0');
  assert.equal(Format.breakevenVerdict(25.04, 25, 4).toneClass, 'profit');
});

test('breakevenVerdict prints both rates as the Win Rate card does and tones them as displayed', () => {
  // 3 wins of 2000 decisive trades: 0.15%, which formatPercent reads 0.2%.
  const winRate = (3 / 2000) * 100;
  assert.equal(Format.breakevenVerdict(winRate, 50, -1).text,
    `WR ${Format.formatPercent(winRate)} vs 50.0% breakeven`);
  assert.equal(Format.breakevenVerdict(winRate, 50, -1).text, 'WR 0.2% vs 50.0% breakeven');
  // 24.96% reads 25.0%, level with the breakeven rate: the expectancy decides.
  assert.deepEqual(Format.breakevenVerdict(24.96, 25, 1),
    { text: 'WR 25.0% vs 25.0% breakeven', toneClass: 'profit' });
});

test('asDisplayed is the number a cell at those decimals shows, with formatPercent\'s rounding and no negative zero', () => {
  for (let wins = 0; wins <= 2000; wins++) {
    const winRate = (wins / 2000) * 100;
    assert.equal(`${Format.asDisplayed(winRate, Format.PERCENT_DECIMALS).toFixed(Format.PERCENT_DECIMALS)}%`,
      Format.formatPercent(winRate), `${wins}/2000`);
  }
  assert.ok(Object.is(Format.asDisplayed(-0.04, Format.PERCENT_DECIMALS), 0));
  assert.equal(Format.asDisplayed(-0.06, Format.PERCENT_DECIMALS), -0.1);
  assert.equal(Format.asDisplayed(1.9996, 2), 2);
  assert.equal(Format.asDisplayed(null, 2), null);
});

test('fmtRatio never prints a negative zero, and keeps the sign of a ratio that displays non-zero', () => {
  assert.equal(Format.fmtRatio(-0.001), '0.00');
  assert.equal(Format.fmtRatio(-0.004), '0.00');
  assert.equal(Format.fmtRatio(-1.2345), '-1.23');
  assert.equal(Format.fmtRatio(-0.006), '-0.01');
});

test('displaysAsLoss: a drawdown shows only when it displays as a non-zero dollar loss', () => {
  assert.equal(Format.displaysAsLoss(0.3), false);
  assert.equal(Format.displaysAsLoss(0), false);
  assert.equal(Format.displaysAsLoss(0.6), true);
  assert.equal(Format.displaysAsLoss(NaN), false);
});

test('every signed formatter writes a negative with the same hyphen-minus, never U+2212', () => {
  const negatives = [
    Format.formatCurrency(-12), Format.formatCents(-12), Format.fmtNotional(-12),
    Format.fmtSignedPct(-12, 2), Format.formatHourlyRate(-0.0000125), Format.formatFundingApr(-0.0001),
    Format.fmtRatio(-1.2), Format.formatPercent(-12), Format.fmtNum(-12), Format.formatShortNumber(-1200)
  ];
  for (const text of negatives) {
    assert.equal(text[0], '-', `${text} starts with the hyphen-minus`);
    assert.ok(!text.includes('\u2212'), `${text} has no U+2212`);
  }
});

test('formatCurrency groups thousands like formatCents and fmtNotional', () => {
  assert.equal(Format.formatCurrency(-72410.2),   '-$72,410');
  assert.equal(Format.formatCurrency(1234567.5),  '+$1,234,568');
  assert.equal(Format.formatCurrency(999.5),      '+$1,000');
  assert.equal(Format.formatCurrency(999.4),      '+$999');
});

test('no formatter prints a negative zero: the sign comes from the value as displayed', () => {
  assert.equal(Format.formatPercent(-0.04),   '0.0%');
  assert.equal(Format.formatPercent(-0.06),   '-0.1%');
  assert.equal(Format.fmtNum(-0.00004),       '0');
  assert.equal(Format.fmtNum(-0.00006),       '-0.0001');
  assert.equal(Format.fmtNum(-1.4),           '-1');
  assert.equal(Format.fmtNotional(-0.4),      '$0');
  assert.equal(Format.fmtNotional(-0.6),      '-$1');
  assert.equal(Format.formatShortNumber(-0.004), '0.00');
});

test('fmtPayoff is the one payoff text: two decimals against one', () => {
  assert.equal(Format.fmtPayoff(0.5678), '0.57 : 1');
  assert.equal(Format.fmtPayoff(2),      '2.00 : 1');
  assert.equal(Format.fmtPayoff(null),   '—');
  assert.equal(Format.fmtPayoff(NaN),    '—');
});

test('formatPrice prints a micro price as a plain decimal at 6 significant digits, never in exponent form', () => {
  assert.equal(Format.formatPrice(1.2e-7),          '$0.00000012');
  assert.equal(Format.formatPrice(7.31958527e-10),  '$0.000000000731959');
  assert.equal(Format.formatPrice(-5.208872619e-7), '$0.000000520887');
  assert.equal(Format.formatPrice(1234567.89),      '$1,234,570');
});

test('formatPrice rounds a float VWAP at a decimal tie half away from zero, like every number on screen', () => {
  // The exact VWAPs are 64012.25 and 2543.275; their floats lie just below.
  assert.equal(Format.formatPrice((0.003 * 64012 + 0.001 * 64013) / 0.004), '$64,012.3');
  assert.equal(Format.formatPrice((0.3 * 2543.2 + 0.1 * 2543.5) / 0.4),     '$2,543.28');
  assert.equal(Format.formatPrice(999999.5),   '$1,000,000');
  assert.equal(Format.formatPrice(0.09999995), '$0.1');
  assert.equal(Format.formatPrice(9.999994),   '$9.99999');
});

test('formatShortNumber picks its unit after rounding, so a value that rounds up to the next unit reads in it', () => {
  assert.equal(Format.formatShortNumber(999999.5), '1.00M');
  assert.equal(Format.formatShortNumber(-999999.5), '-1.00M');
  assert.equal(Format.formatShortNumber(999.995),  '1.00K');
  assert.equal(Format.formatShortNumber(999.99),   '999.99');
  assert.equal(Format.formatShortNumber(999994),   '999.99K');
  assert.equal(Format.formatShortNumber(1500),     '1.50K');
  assert.equal(Format.formatShortNumber(2.5e6),    '2.50M');
});

test('groupDecimalText groups the integer digits and leaves an already-rounded fraction alone', () => {
  assert.equal(Format.groupDecimalText('64012.1235'), '64,012.1235');
  assert.equal(Format.groupDecimalText('65000'),      '65,000');
  assert.equal(Format.groupDecimalText('1.5'),        '1.5');
});

// Decimal ties whose binary value sits just below the tie (1.005 is stored
// as 1.00499999999999989…): every displayed number rounds the decimal it
// is, half away from zero, on both signs.
test('every formatter rounds a decimal tie half away from zero, not by its binary noise', () => {
  assert.equal(Format.formatCents(1.005),                 '+$1.01');
  assert.equal(Format.formatCents(-1.005),                '-$1.01');
  assert.equal(Format.formatCents(0.015),                 '+$0.02');
  assert.equal(Format.formatCurrency(101.49999999999999), '+$102');
  assert.equal(Format.formatPercent((3 / 2000) * 100),    '0.2%');
  assert.equal(Format.formatPercent(-0.15),               '-0.2%');
  assert.equal(Format.fmtRatio(1990 / 2000),              '1.00');
  assert.equal(Format.fmtRatio(2230 / 2000),              '1.12');
  assert.equal(Format.fmtRatio(2.675),                    '2.68');
  assert.equal(Format.fmtPayoff(1.115),                   '1.12 : 1');
  assert.equal(Format.fmtSignedPct(1.005),                '+1.01%');
  assert.equal(Format.asDisplayed(1.115, 2),              1.12);
  assert.equal(Format.asDisplayed(-1.115, 2),             -1.12);
  assert.equal(Format.signClass(0.005, Format.CENTS),     'profit');
});

test('the tie correction only drops binary noise: a value below the tie still rounds down', () => {
  assert.equal(Format.formatCents(1.0049999999),  '+$1.00');
  assert.equal(Format.fmtRatio(1.1149999999),     '1.11');
  assert.equal(Format.formatPercent(0.1499999999), '0.1%');
  assert.equal(Format.formatCents(1e-20),          '$0.00');
});

test('fmtFixed is the plain signed decimal at the given digits, through the same rounding', () => {
  assert.equal(Format.fmtFixed(0.15, 1),     '0.2');
  assert.equal(Format.fmtFixed(-0.15, 1),    '-0.2');
  assert.equal(Format.fmtFixed(-0.04, 1),    '0.0');
  assert.equal(Format.fmtFixed(2.5, 0),      '3');
  assert.equal(Format.fmtFixed(null, 1),     '—');
  assert.equal(Format.fmtFixed(Infinity, 1), '—');
});

// dYdX hourly rates step in 1.25e-7; at these steps the annualized
// percent (rate × 8760 × 100) ends in an exact 5 at the third decimal.
test('funding APR at a tie rate rounds the exact decimal, half away from zero, in the cell and its tone', () => {
  assert.equal(Format.formatFundingApr(0.00001875),  '16.43%');
  assert.equal(Format.formatFundingApr(-0.00001625), '-14.24%');
  assert.equal(Format.formatFundingApr(0.00000875),  '7.67%');
  assert.equal(Format.formatFundingApr(-0.00000875), '-7.67%');
  assert.equal(Format.formatFundingApr(0.00004375),  '38.33%');
  assert.equal(Format.fundingAprPercent(0.00000875) > 0, true);
});

test('asDecimal is the decimal a value stands for, free of the binary noise of the arithmetic that made it', () => {
  assert.equal(Format.asDecimal(1.2 * 2194.59), 2633.508);
  assert.notEqual(1.2 * 2194.59, 2633.508);
  assert.equal(Format.asDecimal(-(0.1 + 0.2)), -0.3);
  assert.equal(Format.asDecimal(0.0084 * 100.00000000000001), 0.84);
  assert.equal(Format.asDecimal(0), 0);
  assert.equal(Format.asDecimal(null), null);
});
