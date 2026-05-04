// risk-metrics.js targets the browser via `window.RiskMetrics = {...}`.
// Shim window onto globalThis so the IIFE can attach without modification,
// then re-export the result for tests.
globalThis.window = globalThis;
require('../risk-metrics.js');
module.exports = globalThis.RiskMetrics;
