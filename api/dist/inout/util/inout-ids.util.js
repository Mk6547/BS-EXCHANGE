"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.subOperatorId = subOperatorId;
exports.subIdToken = subIdToken;
exports.operatorApiSignature = operatorApiSignature;
const node_crypto_1 = require("node:crypto");
const uuid_1 = require("uuid");
/**
 * Three different identifiers are in play and they are easy to confuse:
 *
 *   aggregatorId    — our Platform ID in the provider's system (given at integration)
 *   subId           — our brand ID, e.g. "bsexchange"
 *   subOperatorId   — derived from the two above; this is the :operatorId path
 *                     segment on every /api/operator/v1/bonuses call
 */
/** Bonus spec 7 — UUIDv4 seeded with md5(`${aggregatorId}:${subId}`). */
function subOperatorId(aggregatorId, subId) {
    const seed = (0, node_crypto_1.createHash)('md5').update(`${aggregatorId}:${subId}`).digest();
    return (0, uuid_1.v4)({ random: seed });
}
/** Frontend spec 6 — proves the subId in the launch URL is really ours. */
function subIdToken(aggregatorId, subId, secretKey) {
    return (0, node_crypto_1.createHmac)('sha256', secretKey).update(`${aggregatorId}:${subId}`, 'utf8').digest('hex');
}
/**
 * Bonus spec 1 — the operator API signs the *operator id*, not the request body.
 * This is NOT the same signature as the incoming webhooks (which sign raw body).
 * Mixing the two up produces auth failures that look like bad credentials.
 */
function operatorApiSignature(operatorId, secretKey) {
    return (0, node_crypto_1.createHmac)('sha256', secretKey).update(operatorId, 'utf8').digest('hex');
}
