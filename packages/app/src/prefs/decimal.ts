/**
 * Plain decimal: sign, digits, optional fraction, optional exponent. The
 * integer part is `\d+(?:\.\d*)?` and not `\d+\.?\d*` on purpose: that
 * spelling is ambiguous, and a long run of digits followed by one bad
 * character backtracks quadratically — a denial of service from one field.
 *
 * The one grammar for numbers the user supplies: design files and CSVs
 * (`parseDecimal`, services/xmlUtil.ts) and typed fields (`readDecimal`,
 * prefs/units.ts). A leaf module, so units.ts keeps importing no services.
 */
export const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
