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
var InoutLaunchService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.InoutLaunchService = void 0;
exports.normaliseCountry = normaliseCountry;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const inout_session_service_1 = require("./inout-session.service");
const inout_ids_util_1 = require("./util/inout-ids.util");
const inout_constants_1 = require("./inout.constants");
let InoutLaunchService = InoutLaunchService_1 = class InoutLaunchService {
    sessions;
    config;
    log = new common_1.Logger(InoutLaunchService_1.name);
    cache;
    aggregatorId;
    subId;
    secretKey;
    brandName;
    lobbyUrl;
    apiBase;
    constructor(sessions, config) {
        this.sessions = sessions;
        this.config = config;
        this.aggregatorId = config.getOrThrow('INOUT_AGGREGATOR_ID');
        this.subId = config.getOrThrow('INOUT_SUB_ID');
        this.secretKey = config.getOrThrow('INOUT_SIGNATURE_KEY');
        this.brandName = config.get('INOUT_BRAND_NAME', 'BS Exchange');
        this.lobbyUrl = config.get('INOUT_LOBBY_URL', 'https://bsexchange.live/casino');
        this.apiBase = (config.get('INOUT_API_BASE') ?? inout_constants_1.INOUT_API_BASE_DEFAULT).replace(/\/$/, '');
    }
    /** Games that accept FREEBET grants. Filter the bonus admin UI with this. */
    async freebetGames() {
        const games = await this.listGames();
        return games.filter((g) => g.bonusTypes?.includes('FREEBET'));
    }
    /** Backend spec 1 — GET /api/gameModesList?operatorId=... Cached for 10 minutes. */
    async listGames(force = false) {
        if (!force && this.cache && Date.now() - this.cache.at < 600_000) {
            return this.cache.games;
        }
        const url = `${this.apiBase}${inout_constants_1.INOUT_GAME_LIST_PATH}?operatorId=${encodeURIComponent(this.aggregatorId)}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) {
            this.log.error(`gameModesList failed: ${res.status}`);
            if (this.cache)
                return this.cache.games; // serve stale rather than an empty lobby
            throw new Error(`gameModesList returned ${res.status}`);
        }
        const games = (await res.json());
        this.cache = { at: Date.now(), games };
        return games;
    }
    /** A launch token on its own, for the provider's own test runs. */
    async mintAuthToken(p) {
        const games = await this.listGames();
        if (!games.some((g) => g.gameMode === p.gameMode)) {
            throw new Error(`unknown gameMode ${p.gameMode}`);
        }
        return this.sessions.createLaunchToken(p);
    }
    /**
     * Frontend spec 7.2 — the launch call is server-to-server.
     *
     * The browser must never hit api.inout.games directly: if that domain is
     * blocked in the player's country the game simply fails to load. We call it
     * from our backend, the provider picks a domain that works for that country,
     * and only the resulting launchUrl goes to the client.
     */
    async createLaunchUrl(p) {
        const games = await this.listGames();
        if (!games.some((g) => g.gameMode === p.gameMode)) {
            throw new Error(`unknown gameMode ${p.gameMode}`);
        }
        const country = normaliseCountry(p.userCountryCode);
        const lang = p.lang && inout_constants_1.INOUT_LANGUAGES.has(p.lang) ? p.lang : 'en';
        const { authToken, sessionId } = await this.sessions.createLaunchToken({
            userId: p.userId,
            gameMode: p.gameMode,
            currency: p.currency,
        });
        const qs = new URLSearchParams({
            aggregatorId: this.aggregatorId,
            subId: this.subId,
            gameMode: p.gameMode,
            currency: p.isDemoPlay ? 'USD' : p.currency,
            authToken,
            lang,
            strategy: 'redirect',
            adaptive: 'true',
            isDemoPlay: String(Boolean(p.isDemoPlay)),
            token: (0, inout_ids_util_1.subIdToken)(this.aggregatorId, this.subId, this.secretKey),
            userCountryCode: country,
            lobbyUrl: this.lobbyUrl,
            brandName: this.brandName,
        });
        // redirect: 'manual' is the important part. With strategy=redirect the
        // provider answers 302 and puts the region-specific game URL in Location;
        // following it would just fetch the game's HTML server-side, which is both
        // useless and the thing we are trying to avoid doing from the browser.
        const res = await fetch(`${this.apiBase}${inout_constants_1.INOUT_LAUNCH_PATH}?${qs}`, {
            redirect: 'manual',
            signal: AbortSignal.timeout(10_000),
        });
        if (res.status >= 300 && res.status < 400) {
            const location = res.headers.get('location');
            if (location)
                return { launchUrl: location, sessionId };
            throw new Error(`launch redirected with no Location header (${res.status})`);
        }
        const text = await res.text();
        if (!res.ok) {
            throw new Error(`launch returned ${res.status}: ${readableError(text)}`);
        }
        // Some deployments answer with the documented JSON instead of a redirect.
        try {
            const body = JSON.parse(text);
            if (body.launchUrl)
                return { launchUrl: body.launchUrl, sessionId };
        }
        catch {
            // Not JSON — fall through so the error carries what actually came back.
        }
        throw new Error(`launch failed: ${readableError(text)}`);
    }
};
exports.InoutLaunchService = InoutLaunchService;
exports.InoutLaunchService = InoutLaunchService = InoutLaunchService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [inout_session_service_1.InoutSessionService,
        config_1.ConfigService])
], InoutLaunchService);
/**
 * The provider reports launch failures as a styled HTML page, so the actual
 * message is buried in markup. Pull out the readable text.
 */
function readableError(html) {
    const stripped = html
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&[a-z]+;/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return stripped.slice(0, 600) || html.slice(0, 600);
}
/**
 * Frontend spec 7.3 — must be a real two-letter ISO 3166-1 alpha-2 code, uppercase.
 * Dummy values are explicitly rejected by the provider, so we fail loudly here
 * rather than shipping XX and having launches break in one region only.
 */
function normaliseCountry(raw) {
    const c = (raw ?? '').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(c) || c === 'XX') {
        throw new Error(`userCountryCode "${raw}" is not a valid ISO 3166-1 alpha-2 code`);
    }
    return c;
}
