"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var InoutSignatureGuard_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.InoutSignatureGuard = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const node_crypto_1 = require("node:crypto");
const inout_constants_1 = require("../inout.constants");
const inout_exception_filter_1 = require("../filters/inout-exception.filter");
/**
 * Spec 2.2 — X-REQUEST-SIGN is HMAC-SHA256(rawBody, signatureKey), hex.
 *
 * The signature is over the body *in its original form*, so we must hash the
 * exact bytes received. Bootstrap Nest with `{ rawBody: true }` (see main.ts)
 * — hashing JSON.stringify(req.body) will fail on key order and whitespace.
 *
 * The legacy `signature` header exists only for backward compatibility with the
 * provider's older algorithm; we do not accept it.
 */
let InoutSignatureGuard = InoutSignatureGuard_1 = class InoutSignatureGuard {
    log = new common_1.Logger(InoutSignatureGuard_1.name);
    key;
    constructor(config) {
        this.key = config.getOrThrow('INOUT_SIGNATURE_KEY');
    }
    canActivate(ctx) {
        const req = ctx.switchToHttp().getRequest();
        const provided = req.header('X-REQUEST-SIGN');
        const raw = req.rawBody;
        if (!provided || !raw?.length) {
            throw new inout_exception_filter_1.InoutRejection(inout_constants_1.InoutCode.INVALID_TOKEN, 'missing signature or body');
        }
        const expected = (0, node_crypto_1.createHmac)('sha256', this.key).update(raw).digest('hex');
        const a = Buffer.from(expected, 'utf8');
        const b = Buffer.from(provided.trim().toLowerCase(), 'utf8');
        if (a.length !== b.length || !(0, node_crypto_1.timingSafeEqual)(a, b)) {
            this.log.warn('signature mismatch on inout webhook');
            throw new inout_exception_filter_1.InoutRejection(inout_constants_1.InoutCode.INVALID_TOKEN, 'bad signature');
        }
        return true;
    }
};
exports.InoutSignatureGuard = InoutSignatureGuard;
exports.InoutSignatureGuard = InoutSignatureGuard = InoutSignatureGuard_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [config_1.ConfigService])
], InoutSignatureGuard);
