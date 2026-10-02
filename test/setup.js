// risk-metrics.js targets the browser via `window.RiskMetrics = {...}`.
// Shim window onto globalThis so the IIFE can attach without modification,
// load constants.js first (risk-metrics reads AppConstants.PERCENT) and
// format.js (the drawdown scanner ranks by Format.drawdownAsDisplayed at
// call time), then re-export the result for tests.
globalThis.window = globalThis;
require('../src/constants.js');
require('../risk-metrics.js');
require('../src/format.js');
module.exports = globalThis.RiskMetrics;
