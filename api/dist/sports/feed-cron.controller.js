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
exports.FeedCronController = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const typeorm_1 = require("typeorm");
const odds_feed_service_1 = require("./odds-feed.service");
const theoddsapi_adapter_1 = require("./theoddsapi.adapter");
const scores_results_service_1 = require("./scores-results.service");
const pulsescore_adapter_1 = require("./pulsescore.adapter");
/**
 * Cron entry point for the odds feed.
 *
 * On shared cPanel hosting Passenger puts the Node process to sleep when no
 * request arrives, which stops any in-process timer. A cPanel cron job hitting
 * this URL keeps the feed moving whether or not the process was awake:
 *
 *   * * * * * curl -s "https://api.bsexchange.live/sports-cron/sync?token=YOUR_TOKEN" >/dev/null
 *
 * Put the same value in .env as SPORTS_CRON_TOKEN. Without it the route is off.
 */
let FeedCronController = class FeedCronController {
    ds;
    feed;
    adapter;
    scores;
    pulse;
    config;
    constructor(ds, feed, adapter, scores, pulse, config) {
        this.ds = ds;
        this.feed = feed;
        this.adapter = adapter;
        this.scores = scores;
        this.pulse = pulse;
        this.config = config;
    }
    async sync(token) {
        const expected = this.config.get('SPORTS_CRON_TOKEN');
        if (!expected)
            throw new common_1.BadRequestException({ message: 'SPORTS_CRON_TOKEN is not set.' });
        if (token !== expected)
            throw new common_1.UnauthorizedException('Bad token.');
        const providers = await this.ds.query(`SELECT id, code, adapter FROM odds_provider WHERE enabled = 1 AND kind <> 'manual'`);
        const results = [];
        // PulseScore runs once per cron (it manages its own sports internally).
        try {
            results.push({ code: 'pulsescore', ok: true, ...(await this.pulse.sync()) });
        }
        catch (e) {
            results.push({ code: 'pulsescore', ok: false, error: String(e?.message ?? e).slice(0, 200) });
        }
        for (const p of providers) {
            try {
                if (p.adapter === 'theoddsapi') {
                    // The dedicated pipeline: discover sports, then events + odds.
                    const sports = await this.adapter.syncSports(p.id);
                    const odds = await this.adapter.syncEventsAndOdds(p.id);
                    const scores = await this.scores.syncScoresAndSettle(p.id, 1);
                    const reconcile = await this.adapter.reconcile(p.id);
                    results.push({ code: p.code, ok: true, sports, odds, scores, reconcile });
                }
                else {
                    results.push({ code: p.code, ...(await this.feed.sync(p.id)) });
                }
            }
            catch (err) {
                results.push({ code: p.code, ok: false, error: String(err?.message ?? err).slice(0, 200) });
            }
        }
        return { ran: results.length, results };
    }
};
exports.FeedCronController = FeedCronController;
__decorate([
    (0, common_1.Get)('sync'),
    __param(0, (0, common_1.Query)('token')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], FeedCronController.prototype, "sync", null);
exports.FeedCronController = FeedCronController = __decorate([
    (0, common_1.Controller)('sports-cron'),
    __metadata("design:paramtypes", [typeorm_1.DataSource,
        odds_feed_service_1.OddsFeedService,
        theoddsapi_adapter_1.TheOddsApiAdapter,
        scores_results_service_1.ScoresResultsService,
        pulsescore_adapter_1.PulseScoreAdapter,
        config_1.ConfigService])
], FeedCronController);
