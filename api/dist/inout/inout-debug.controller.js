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
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.InoutDebugController = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const node_crypto_1 = require("node:crypto");
const inout_constants_1 = require("./inout.constants");
const typeorm_1 = require("typeorm");
const inout_launch_service_1 = require("./inout-launch.service");
const inout_ids_util_1 = require("./util/inout-ids.util");
/**
 * TEMPORARY DIAGNOSTICS — DELETE BEFORE GOING LIVE.
 *
 * The real guards deliberately answer every failure with the same INVALID_TOKEN
 * so a prober learns nothing. That is right in production and useless while
 * setting up, so these two endpoints show what the guards actually saw.
 *
 * They are unauthenticated and they echo back signature material, so they must
 * not exist on a server handling real money.
 */
let InoutDebugController = class InoutDebugController {
    config;
    launch;
    ds;
    constructor(config, launch, ds) {
        this.config = config;
        this.launch = launch;
        this.ds = ds;
    }
    /** Balance for the lobby header. Replace with an authenticated route. */
    async balance(q) {
        const rows = await this.ds.query(`SELECT w.balance, w.currency, u.nickname
         FROM wallet w JOIN users u ON u.id = w.user_id
        WHERE w.user_id = ? AND w.currency = ?`, [q.userId ?? '1', q.currency ?? 'USD']);
        if (!rows.length)
            return { found: false };
        return {
            found: true,
            nickname: rows[0].nickname,
            currency: rows[0].currency,
            balance: Number(rows[0].balance).toFixed(2),
        };
    }
    /**
     * Launch a game as any user, with no authentication.
     *
     * This exists only because bsexchange has no login yet, so the real /launch
     * route has nothing to read req.user.id from. It is also how the subId gets
     * registered with the provider, which happens on the first successful launch.
     *
     *   /debug/launch?userId=1&gameMode=chicken-road&currency=USD&country=PK
     */
    async debugLaunch(q) {
        try {
            const out = await this.launch.createLaunchUrl({
                userId: q.userId ?? '1',
                gameMode: q.gameMode ?? 'chicken-road',
                currency: q.currency ?? process.env.DEFAULT_CURRENCY ?? 'PKR',
                userCountryCode: q.country ?? 'PK',
                lang: 'en',
            });
            return { ok: true, ...out };
        }
        catch (err) {
            // The provider's rejection text is far more useful than a 500 here.
            return { ok: false, error: err?.message ?? String(err) };
        }
    }
    /**
     * Mint a launch token without calling the provider — what InOut ask for when
     * they want to drive an init/bet/withdraw cycle themselves.
     *
     *   /debug/token?gameMode=plinko&currency=PKR
     *
     * Single use, and it expires in 5 minutes, so mint it when they are ready.
     */
    async mintToken(q) {
        const currency = q.currency ?? process.env.DEFAULT_CURRENCY ?? 'PKR';
        const out = await this.launch.mintAuthToken({
            userId: q.userId ?? '1',
            gameMode: q.gameMode ?? 'plinko',
            currency,
        });
        return { ...out, currency, expiresInMinutes: 5 };
    }
    /** Confirms which subId and derived subOperatorId the app is actually using. */
    identity() {
        const aggregatorId = this.config.getOrThrow('INOUT_AGGREGATOR_ID');
        const subId = this.config.getOrThrow('INOUT_SUB_ID');
        const key = this.config.getOrThrow('INOUT_SIGNATURE_KEY');
        return {
            aggregatorId,
            subId,
            subOperatorId: this.config.get('INOUT_SUB_OPERATOR_ID') ?? (0, inout_ids_util_1.subOperatorId)(aggregatorId, subId),
            subIdToken: (0, inout_ids_util_1.subIdToken)(aggregatorId, subId, key),
            note: 'subOperatorId is the :operatorId path segment on every bonus API call',
        };
    }
    /** What IP does the app think you are, and is it allowed? */
    whoami(req) {
        const env = this.config.get('INOUT_ENV', 'prod');
        const extra = (this.config.get('INOUT_EXTRA_IPS') ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        const allowed = [...(inout_constants_1.INOUT_IP_ALLOWLIST[env] ?? []), ...extra];
        const seen = (req.ip ?? '').replace(/^::ffff:/, '');
        return {
            detectedIp: seen,
            isAllowed: allowed.includes(seen),
            allowed,
            env,
            socketIp: req.socket?.remoteAddress,
            xForwardedFor: req.headers['x-forwarded-for'] ?? null,
            trustProxyHops: process.env.TRUST_PROXY_HOPS ?? '(unset)',
        };
    }
    /**
     * Post the same body and X-REQUEST-SIGN you would send to the webhook.
     * This bypasses both guards and reports what each would have concluded.
     */
    signature(req, _body) {
        const key = this.config.get('INOUT_SIGNATURE_KEY') ?? '';
        const raw = req.rawBody;
        const provided = req.header('X-REQUEST-SIGN') ?? null;
        const expected = raw ? (0, node_crypto_1.createHmac)('sha256', key).update(raw).digest('hex') : null;
        return {
            rawBodyReceived: Boolean(raw?.length),
            rawBodyLength: raw?.length ?? 0,
            keyLength: key.length,
            provided,
            expected,
            matches: provided != null && provided.trim().toLowerCase() === expected,
        };
    }
};
exports.InoutDebugController = InoutDebugController;
__decorate([
    (0, common_1.Get)('balance'),
    __param(0, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], InoutDebugController.prototype, "balance", null);
__decorate([
    (0, common_1.Get)('launch'),
    __param(0, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], InoutDebugController.prototype, "debugLaunch", null);
__decorate([
    (0, common_1.Get)('token'),
    __param(0, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], InoutDebugController.prototype, "mintToken", null);
__decorate([
    (0, common_1.Get)('identity'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], InoutDebugController.prototype, "identity", null);
__decorate([
    (0, common_1.Get)('whoami'),
    __param(0, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], InoutDebugController.prototype, "whoami", null);
__decorate([
    (0, common_1.Post)('signature'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], InoutDebugController.prototype, "signature", null);
exports.InoutDebugController = InoutDebugController = __decorate([
    (0, common_1.Controller)('integrations/inout/debug'),
    __metadata("design:paramtypes", [config_1.ConfigService,
        inout_launch_service_1.InoutLaunchService,
        typeorm_1.DataSource])
], InoutDebugController);
