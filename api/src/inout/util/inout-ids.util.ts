import { createHash, createHmac } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';

/**
 * Three different identifiers are in play and they are easy to confuse:
 *
 *   aggregatorId    — our Platform ID in the provider's system (given at integration)
 *   subId           — our brand ID, e.g. "bsexchange"
 *   subOperatorId   — derived from the two above; this is the :operatorId path
 *                     segment on every /api/operator/v1/bonuses call
 */

/** Bonus spec 7 — UUIDv4 seeded with md5(`${aggregatorId}:${subId}`). */
export function subOperatorId(aggregatorId: string, subId: string): string {
  const seed = createHash('md5').update(`${aggregatorId}:${subId}`).digest();
  return uuidv4({ random: seed });
}

/** Frontend spec 6 — proves the subId in the launch URL is really ours. */
export function subIdToken(aggregatorId: string, subId: string, secretKey: string): string {
  return createHmac('sha256', secretKey).update(`${aggregatorId}:${subId}`, 'utf8').digest('hex');
}

/**
 * Bonus spec 1 — the operator API signs the *operator id*, not the request body.
 * This is NOT the same signature as the incoming webhooks (which sign raw body).
 * Mixing the two up produces auth failures that look like bad credentials.
 */
export function operatorApiSignature(operatorId: string, secretKey: string): string {
  return createHmac('sha256', secretKey).update(operatorId, 'utf8').digest('hex');
}
