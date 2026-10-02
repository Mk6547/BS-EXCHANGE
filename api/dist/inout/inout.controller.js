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
exports.InoutController = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("typeorm");
const inout_webhook_service_1 = require("./inout-webhook.service");
const inout_launch_service_1 = require("./inout-launch.service");
const inout_bonus_service_1 = require("./inout-bonus.service");
const inout_ip_guard_1 = require("./guards/inout-ip.guard");
const inout_signature_guard_1 = require("./guards/inout-signature.guard");
const inout_exception_filter_1 = require("./filters/inout-exception.filter");
const inout_constants_1 = require("./inout.constants");
const jwt_auth_guard_1 = require("../auth/jwt-auth.guard");
let InoutController = class InoutController {
    webhooks;
    launch;
    bonuses;
    ds;
    constructor(webhooks, launch, bonuses, ds) {
        this.webhooks = webhooks;
        this.launch = launch;
        this.bonuses = bonuses;
        this.ds = ds;
    }
    /**
     * Liveness check. Safe to expose and to poll: it reveals no configuration and
     * touches the database, so a green answer means the app is genuinely able to
     * serve a webhook rather than merely running.
     *
     * Also the right target for the cPanel keep-alive cron — cheaper than /games,
     * which reaches out to the provider.
     */
    async health() {
        let database = 'down';
        try {
            await this.ds.query('SELECT 1');
            database = 'up';
        }
        catch {
            database = 'down';
        }
        return {
            status: database === 'up' ? 'ok' : 'degraded',
            database,
            webhook: 'POST /integrations/inout/webhook',
            time: new Date().toISOString(),
        };
    }
    /**
     * The single URL given to InOut:
     *   https://api.bsexchange.live/integrations/inout/webhook
     * Handles init, bet, withdraw, rollback and both bonus settlements.
     * Always answers 200 — see InoutExceptionFilter.
     */
    async webhook(body) {
        // Temporary: proves whether a webhook reached us at all. Remove with the
        // debug controller once the integration is signed off.
        console.error(`[inout] IN action=${body?.action ?? '-'}`);
        // The provider gives us 10s. We cut ourselves off earlier so a stuck query
        // returns a clean TEMPORARY_ERROR instead of letting their client time out,
        // which for a bet would trigger an automatic rollback (backend spec 2.51).
        return Promise.race([
            this.webhooks.handle(body),
            new Promise((_, reject) => setTimeout(() => reject(new inout_exception_filter_1.InoutRejection(inout_constants_1.InoutCode.TEMPORARY_ERROR, 'handler budget exceeded')), inout_constants_1.INOUT_HANDLER_BUDGET_MS).unref()),
        ]);
    }
    // ------------------------------------------------------------------
    // Platform-side endpoints. Protect these with your normal player JWT
    // guard; the bonus routes need an admin guard on top.
    // ------------------------------------------------------------------
    games() {
        return this.launch.listGames();
    }
    /** Games that accept FREEBET grants — for the bonus admin screen. */
    freebetGames() {
        return this.launch.freebetGames();
    }
    /**
     * Frontend spec 7.2 — the client asks us, we ask the provider, the client
     * gets only the final launchUrl. It then renders:
     *   <iframe scrolling="yes" allow="autoplay" allowfullscreen="" src="${launchUrl}">
     */
    async createLaunch(req, q) {
        try {
            return { launchUrl: await this.launchFor(req, q) };
        }
        catch (err) {
            // The provider's own wording is more useful than "Internal server error".
            throw new common_1.BadGatewayException({
                message: err?.message ?? 'The game could not be started.',
            });
        }
    }
    async launchFor(req, q) {
        const { launchUrl } = await this.launch.createLaunchUrl({
            // From the verified token, never from the query string — otherwise any
            // signed-in player could open a session as someone else.
            userId: req.user.id,
            gameMode: q.gameMode,
            currency: q.currency,
            lang: q.lang,
            isDemoPlay: q.isDemoPlay === 'true',
            userCountryCode: resolveCountry(req, q.country),
        });
        return launchUrl;
    }
    createBonus(body) {
        const { hideFromStat, ...input } = body;
        return this.bonuses.create(input, { hideFromStat });
    }
    listBonuses(q) {
        return this.bonuses.list(q);
    }
    viewBonus(bonusId) {
        return this.bonuses.view(bonusId);
    }
    cancelBonus(bonusId) {
        return this.bonuses.cancel(bonusId);
    }
};
exports.InoutController = InoutController;
__decorate([
    (0, common_1.Get)('health'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], InoutController.prototype, "health", null);
__decorate([
    (0, common_1.Post)('webhook'),
    (0, common_1.HttpCode)(200),
    (0, common_1.UseGuards)(inout_ip_guard_1.InoutIpGuard, inout_signature_guard_1.InoutSignatureGuard),
    (0, common_1.UseFilters)(inout_exception_filter_1.InoutExceptionFilter),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], InoutController.prototype, "webhook", null);
__decorate([
    (0, common_1.Get)('games'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], InoutController.prototype, "games", null);
__decorate([
    (0, common_1.Get)('games/freebet'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], InoutController.prototype, "freebetGames", null);
__decorate([
    (0, common_1.Get)('launch'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], InoutController.prototype, "createLaunch", null);
__decorate([
    (0, common_1.Post)('bonuses'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard, jwt_auth_guard_1.AdminGuard),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], InoutController.prototype, "createBonus", null);
__decorate([
    (0, common_1.Get)('bonuses'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard, jwt_auth_guard_1.AdminGuard),
    __param(0, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], InoutController.prototype, "listBonuses", null);
__decorate([
    (0, common_1.Get)('bonuses/:bonusId'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard, jwt_auth_guard_1.AdminGuard),
    __param(0, (0, common_1.Param)('bonusId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], InoutController.prototype, "viewBonus", null);
__decorate([
    (0, common_1.Delete)('bonuses/:bonusId'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard, jwt_auth_guard_1.AdminGuard),
    __param(0, (0, common_1.Param)('bonusId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], InoutController.prototype, "cancelBonus", null);
exports.InoutController = InoutController = __decorate([
    (0, common_1.Controller)('integrations/inout'),
    __metadata("design:paramtypes", [inout_webhook_service_1.InoutWebhookService,
        inout_launch_service_1.InoutLaunchService,
        inout_bonus_service_1.InoutBonusService,
        typeorm_1.DataSource])
], InoutController);
/**
 * Frontend spec 7.3 — userCountryCode must be where the player actually is.
 *
 * Sources in order of trustworthiness: Cloudflare's edge header if the site is
 * proxied, then the country recorded on the account, then whatever the client
 * claimed, then a configured default.
 *
 * The client-supplied value is last because a player can set it to anything;
 * it exists so launches still work before a geo source is wired up. Once
 * bsexchange sits behind Cloudflare, or a MaxMind lookup is added, drop the
 * query fallback — an accurate country is what keeps the provider serving a
 * domain that is actually reachable for that player.
 */
function resolveCountry(req, claimed) {
    const header = req.headers?.['cf-ipcountry'];
    const candidate = (typeof header === 'string' && header !== 'XX' ? header : null) ??
        req.user?.countryCode ??
        claimed ??
        process.env.DEFAULT_COUNTRY ??
        'PK';
    return String(candidate).trim().toUpperCase();
}
