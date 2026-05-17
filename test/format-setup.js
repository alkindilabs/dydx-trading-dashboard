// Shim window onto globalThis so the IIFE in src/format.js can attach
// without modification, then load constants.js first (format depends on
// AppConstants.HOURS_PER_YEAR) before format.js and re-export Format.
globalThis.window = globalThis;
require('../src/constants.js');
require('../src/format.js');
module.exports = globalThis.Format;
