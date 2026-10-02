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
var InoutIpGuard_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.InoutIpGuard = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const inout_constants_1 = require("../inout.constants");
const inout_exception_filter_1 = require("../filters/inout-exception.filter");
const inout_constants_2 = require("../inout.constants");
/**
 * Only the provider's published egress IPs may reach the webhook.
 *
 * IMPORTANT: this reads the socket IP, or the *left-most untrusted* hop from
 * X-Forwarded-For. Set `app.set('trust proxy', <n>)` to the exact number of
 * proxies in front of Nest (Cloudflare + nginx = 2). Getting this wrong
 * either blocks the provider or lets anyone spoof the header.
 */
let InoutIpGuard = InoutIpGuard_1 = class InoutIpGuard {
    log = new common_1.Logger(InoutIpGuard_1.name);
    allowed;
    constructor(config) {
        const env = config.get('INOUT_ENV', 'prod');
        const extra = (config.get('INOUT_EXTRA_IPS') ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        this.allowed = new Set([...(inout_constants_1.INOUT_IP_ALLOWLIST[env] ?? []), ...extra]);
    }
    canActivate(ctx) {
        const req = ctx.switchToHttp().getRequest();
        const ip = normalise(req.ip ?? req.socket?.remoteAddress ?? '');
        if (!this.allowed.has(ip)) {
            this.log.warn(`rejected webhook from ${ip}`);
            throw new inout_exception_filter_1.InoutRejection(inout_constants_2.InoutCode.INVALID_TOKEN, 'source not allowlisted');
        }
        return true;
    }
};
exports.InoutIpGuard = InoutIpGuard;
exports.InoutIpGuard = InoutIpGuard = InoutIpGuard_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [config_1.ConfigService])
], InoutIpGuard);
function normalise(ip) {
    return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}
