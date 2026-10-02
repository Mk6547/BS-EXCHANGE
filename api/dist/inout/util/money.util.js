"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BadAmountError = void 0;
exports.decimalsFor = decimalsFor;
exports.parseAmount = parseAmount;
exports.formatAmount = formatAmount;
const decimal_js_1 = __importDefault(require("decimal.js"));
const inout_constants_1 = require("../inout.constants");
/**
 * Spec 4 (frontend): fiat values are rounded to 2 decimal places, crypto to 9.
 * Store full precision; round only when rendering a response.
 */
const CRYPTO = new Set(inout_constants_1.INOUT_CRYPTO_CURRENCIES);
function decimalsFor(currency) {
    return CRYPTO.has(currency.toUpperCase()) ? 9 : 2;
}
/** Parse an amount string from the provider. Throws on anything non-numeric or negative. */
function parseAmount(raw, currency) {
    if (raw === null || raw === undefined)
        return new decimal_js_1.default(0);
    const s = String(raw).trim();
    if (!/^\d+(\.\d+)?$/.test(s)) {
        throw new BadAmountError(`amount "${s}" is not a non-negative decimal`);
    }
    const d = new decimal_js_1.default(s);
    if (d.decimalPlaces() > decimalsFor(currency)) {
        throw new BadAmountError(`amount "${s}" exceeds ${decimalsFor(currency)}dp for ${currency}`);
    }
    return d;
}
/** Render a balance exactly as the provider expects: fixed-point string. */
function formatAmount(value, currency) {
    return new decimal_js_1.default(value).toFixed(decimalsFor(currency), decimal_js_1.default.ROUND_DOWN);
}
class BadAmountError extends Error {
}
exports.BadAmountError = BadAmountError;
