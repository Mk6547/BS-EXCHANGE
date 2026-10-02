import Decimal from 'decimal.js';
import { INOUT_CRYPTO_CURRENCIES } from '../inout.constants';

/**
 * Spec 4 (frontend): fiat values are rounded to 2 decimal places, crypto to 9.
 * Store full precision; round only when rendering a response.
 */
const CRYPTO = new Set(INOUT_CRYPTO_CURRENCIES);

export function decimalsFor(currency: string): number {
  return CRYPTO.has(currency.toUpperCase()) ? 9 : 2;
}

/** Parse an amount string from the provider. Throws on anything non-numeric or negative. */
export function parseAmount(raw: unknown, currency: string): Decimal {
  if (raw === null || raw === undefined) return new Decimal(0);
  const s = String(raw).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new BadAmountError(`amount "${s}" is not a non-negative decimal`);
  }
  const d = new Decimal(s);
  if (d.decimalPlaces() > decimalsFor(currency)) {
    throw new BadAmountError(`amount "${s}" exceeds ${decimalsFor(currency)}dp for ${currency}`);
  }
  return d;
}

/** Render a balance exactly as the provider expects: fixed-point string. */
export function formatAmount(value: Decimal | string, currency: string): string {
  return new Decimal(value).toFixed(decimalsFor(currency), Decimal.ROUND_DOWN);
}

export class BadAmountError extends Error {}
