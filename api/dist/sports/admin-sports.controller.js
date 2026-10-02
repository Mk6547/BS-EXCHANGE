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
exports.AdminSportsController = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("typeorm");
const node_crypto_1 = require("node:crypto");
const jwt_auth_guard_1 = require("../auth/jwt-auth.guard");
const audit_service_1 = require("../platform/audit.service");
const sports_service_1 = require("./sports.service");
const odds_feed_service_1 = require("./odds-feed.service");
const theoddsapi_adapter_1 = require("./theoddsapi.adapter");
const scores_results_service_1 = require("./scores-results.service");
const pulsescore_adapter_1 = require("./pulsescore.adapter");
/**
 * Everything the admin needs for sports: the odds feed configuration, the
 * events and markets themselves, settlement, and the risk view.
 *
 * Kept separate from the casino admin on purpose — sports and InOut share only
 * the wallet.
 */
let AdminSportsController = class AdminSportsController {
    ds;
    sports;
    feed;
    adapter;
    scores;
    pulse;
    audit;
    constructor(ds, sports, feed, adapter, scores, pulse, audit) {
        this.ds = ds;
        this.sports = sports;
        this.feed = feed;
        this.adapter = adapter;
        this.scores = scores;
        this.pulse = pulse;
        this.audit = audit;
    }
    // ----------------------------------------------------------- odds feed
    async providers() {
        const rows = await this.ds.query(`SELECT * FROM odds_provider ORDER BY display_name`);
        const logs = await this.ds.query(`SELECT provider_id, ok, events, markets, runners, message, started_at, ms
         FROM feed_sync_log ORDER BY id DESC LIMIT 20`);
        return {
            providers: rows.map((r) => ({
                ...r,
                // The key is never sent back in full, so a shoulder-surfer or a stale
                // browser tab cannot read it.
                auth_value: r.auth_value ? `••••${String(r.auth_value).slice(-4)}` : null,
                has_key: !!r.auth_value,
                config: (0, odds_feed_service_1.parseJson)(r.config),
            })),
            recentSyncs: logs,
        };
    }
    async createProvider(req, b) {
        const v = providerValues(b);
        if (!v.code || !v.display_name)
            throw new common_1.BadRequestException({ message: 'A code and a name are required.' });
        const id = (0, node_crypto_1.randomUUID)();
        await this.ds.query(`INSERT INTO odds_provider
        (id, code, display_name, kind, base_url, events_path, odds_path, auth_type, auth_name, auth_value,
         config, poll_seconds, enabled)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, v.code, v.display_name, v.kind, v.base_url, v.events_path, v.odds_path, v.auth_type,
            v.auth_name, v.auth_value, JSON.stringify(v.config ?? {}), v.poll_seconds, v.enabled]);
        await this.audit.record({ adminId: req.user.id, action: 'sports.provider.create', target: v.code });
        return { id };
    }
    async updateProvider(req, id, b) {
        const v = providerValues(b);
        // Leaving the key field blank means "keep the key you already have".
        const keepKey = !b.auth_value;
        const res = await this.ds.query(`UPDATE odds_provider SET display_name=?, kind=?, base_url=?, events_path=?, odds_path=?,
         auth_type=?, auth_name=?, auth_value=${keepKey ? 'auth_value' : '?'}, config=?, poll_seconds=?, enabled=?
       WHERE id = ?`, keepKey
            ? [v.display_name, v.kind, v.base_url, v.events_path, v.odds_path, v.auth_type, v.auth_name,
                JSON.stringify(v.config ?? {}), v.poll_seconds, v.enabled, id]
            : [v.display_name, v.kind, v.base_url, v.events_path, v.odds_path, v.auth_type, v.auth_name,
                v.auth_value, JSON.stringify(v.config ?? {}), v.poll_seconds, v.enabled, id]);
        if (!res.affectedRows)
            throw new common_1.BadRequestException({ message: 'No such provider.' });
        await this.audit.record({ adminId: req.user.id, action: 'sports.provider.update', target: id });
        return { id };
    }
    async deleteProvider(req, id) {
        await this.ds.query(`UPDATE odds_provider SET enabled = 0 WHERE id = ?`, [id]);
        await this.audit.record({ adminId: req.user.id, action: 'sports.provider.disable', target: id });
        return { id, enabled: false };
    }
    /** Fetch once and show what came back, without saving anything. */
    async testProvider(id) {
        try {
            const [p] = await this.ds.query(`SELECT adapter FROM odds_provider WHERE id = ?`, [id]);
            if (p?.adapter === 'theoddsapi')
                return await this.adapter.test(id);
            return await this.feed.test(id);
        }
        catch (err) {
            throw new common_1.BadRequestException({ message: err?.message ?? 'The feed could not be reached.' });
        }
    }
    async syncProvider(req, id) {
        try {
            const [p] = await this.ds.query(`SELECT adapter FROM odds_provider WHERE id = ?`, [id]);
            let out;
            if (p?.adapter === 'theoddsapi') {
                const sports = await this.adapter.syncSports(id);
                const odds = await this.adapter.syncEventsAndOdds(id);
                out = { sports, odds };
            }
            else {
                out = await this.feed.sync(id);
            }
            await this.audit.record({ adminId: req.user.id, action: 'sports.feed.sync', target: id, metadata: out });
            return out;
        }
        catch (err) {
            throw new common_1.BadRequestException({ message: err?.message ?? 'Sync failed.' });
        }
    }
    // -------------------------------------------------------------- events
    async syncSports(id) {
        try {
            return await this.adapter.syncSports(id);
        }
        catch (e) {
            throw new common_1.BadRequestException({ message: e.message });
        }
    }
    async syncOdds(id) {
        try {
            return await this.adapter.syncEventsAndOdds(id);
        }
        catch (e) {
            throw new common_1.BadRequestException({ message: e.message });
        }
    }
    async reconcile(id) {
        try {
            return await this.adapter.reconcile(id);
        }
        catch (e) {
            throw new common_1.BadRequestException({ message: e.message });
        }
    }
    async health(id) {
        try {
            return await this.adapter.health(id);
        }
        catch (e) {
            throw new common_1.BadRequestException({ message: e.message });
        }
    }
    async syncResults(id, b) {
        try {
            return await this.scores.syncScoresAndSettle(id, Number(b?.daysFrom ?? 1));
        }
        catch (e) {
            throw new common_1.BadRequestException({ message: e.message });
        }
    }
    /** No-API test: set home_score/away_score on the event, then call this to settle. */
    async settleFromScore(req, eventId, b) {
        try {
            // If scores are supplied, set them first, then settle. No API call either way.
            if (b?.homeScore !== undefined && b?.awayScore !== undefined) {
                await this.ds.query(`UPDATE sport_event SET home_score=?, away_score=? WHERE id=?`, [Number(b.homeScore), Number(b.awayScore), eventId]);
            }
            const out = await this.scores.settleFromDbScore(eventId);
            await this.audit.record({ adminId: req.user.id, action: 'sports.settle.dbscore', target: eventId, metadata: out });
            return out;
        }
        catch (e) {
            throw new common_1.BadRequestException({ message: e.message });
        }
    }
    // ------------------------------------------------------------ pulsescore
    async psSettings() {
        const rows = await this.ds.query(`SELECT key_name, value FROM pulsescore_config`);
        const cfg = {};
        for (const r of rows)
            cfg[r.key_name] = r.value;
        // never send the key back in full
        if (cfg.api_key)
            cfg.api_key_set = '1';
        delete cfg.api_key;
        return { config: cfg };
    }
    async psSave(req, b) {
        const allowed = ['enabled', 'api_key', 'bookmaker', 'sports'];
        const changed = [];
        for (const [k, v] of Object.entries(b ?? {})) {
            if (!allowed.includes(k))
                continue;
            if (k === 'api_key' && (!v || String(v).trim() === ''))
                continue; // blank keeps existing
            await this.ds.query(`INSERT INTO pulsescore_config (key_name,value) VALUES (?,?) ON DUPLICATE KEY UPDATE value=VALUES(value)`, [k, String(v ?? '')]);
            changed.push(k);
        }
        await this.audit.record({ adminId: req.user.id, action: 'pulsescore.settings', metadata: { changed } });
        return { changed };
    }
    async psTest() {
        try {
            return await this.pulse.test();
        }
        catch (e) {
            throw new common_1.BadRequestException({ message: e.message });
        }
    }
    async psSync() {
        // The paced sync (1 req/sec) can run for minutes, longer than the HTTP
        // timeout. Start it in the background and return at once; watch progress in
        // the sync-runs log and the last-ok time.
        this.pulse.sync().catch(() => { });
        return { started: true, message: 'Sync started. It runs in the background (a minute or two). Check Sports events shortly.' };
    }
    async psSyncLive() {
        try {
            return await this.pulse.syncLive();
        }
        catch (e) {
            throw new common_1.BadRequestException({ message: e.message });
        }
    }
    async syncRuns(limit) {
        const rows = await this.ds.query(`SELECT job, started_at, finished_at, ok, created, updated, processed, http_status, message
         FROM sync_run ORDER BY id DESC LIMIT ?`, [Math.min(Math.max(Number(limit ?? 30), 1), 100)]);
        return { runs: rows };
    }
    async bookmakers() {
        const rows = await this.ds.query(`SELECT key_name, title, region, enabled, sort_order, last_update FROM bookmaker ORDER BY sort_order, title`);
        return { bookmakers: rows };
    }
    async updateBookmaker(key, b) {
        const fields = [];
        const args = [];
        if (b?.enabled !== undefined) {
            fields.push('enabled = ?');
            args.push(b.enabled ? 1 : 0);
        }
        if (b?.sortOrder !== undefined) {
            fields.push('sort_order = ?');
            args.push(Number(b.sortOrder) || 0);
        }
        if (!fields.length)
            throw new common_1.BadRequestException({ message: 'Nothing to change.' });
        await this.ds.query(`UPDATE bookmaker SET ${fields.join(', ')} WHERE key_name = ?`, [...args, key]);
        return { key };
    }
    /** Which bookmaker keys the adapter pulls (provider.bookmakers_csv). Empty = all. */
    async getBookmakerFilter(id) {
        const [p] = await this.ds.query(`SELECT bookmakers_csv FROM odds_provider WHERE id = ?`, [id]);
        return { bookmakers: p?.bookmakers_csv ?? '' };
    }
    async setBookmakerFilter(id, b) {
        const csv = String(b?.bookmakers ?? '').trim();
        await this.ds.query(`UPDATE odds_provider SET bookmakers_csv = ? WHERE id = ?`, [csv || null, id]);
        return { bookmakers: csv };
    }
    async sportCatalog() {
        const rows = await this.ds.query(`SELECT sport_key, title, sport_group, active, has_outrights, internal_sport, enabled
         FROM sport_catalog ORDER BY sport_group, title`);
        return { sports: rows };
    }
    async setSportEnabled(key, b) {
        await this.ds.query(`UPDATE sport_catalog SET enabled = ? WHERE sport_key = ?`, [b?.enabled ? 1 : 0, key]);
        return { key, enabled: !!b?.enabled };
    }
    async events(q) {
        const limit = Math.min(Math.max(Number(q.limit ?? 100), 1), 300);
        const where = ['1=1'];
        const args = [];
        if (q.sport) {
            where.push('e.sport_id = ?');
            args.push(q.sport);
        }
        if (q.status) {
            where.push('e.status = ?');
            args.push(q.status);
        }
        if (q.search) {
            where.push('e.name LIKE ?');
            args.push(`%${q.search}%`);
        }
        const rows = await this.ds.query(`SELECT e.*, p.display_name AS provider,
              (SELECT COUNT(*) FROM market m WHERE m.event_id = e.id) AS markets,
              (SELECT COALESCE(SUM(b.liability),0) FROM sport_bet b WHERE b.event_id = e.id AND b.status='open') AS open_liability
         FROM sport_event e LEFT JOIN odds_provider p ON p.id = e.provider_id
        WHERE ${where.join(' AND ')}
        ORDER BY e.inplay DESC, e.start_time
        LIMIT ?`, [...args, limit]);
        return { events: rows };
    }
    /** Create an event by hand — useful before a feed is connected. */
    async createEvent(req, b) {
        const id = (0, node_crypto_1.randomUUID)();
        const name = String(b?.name ?? '').trim() || [b?.home, b?.away].filter(Boolean).join(' v ');
        if (!name)
            throw new common_1.BadRequestException({ message: 'Give the match a name.' });
        if (!b?.startTime)
            throw new common_1.BadRequestException({ message: 'Set the start time.' });
        await this.ds.query(`INSERT INTO sport_event (id, sport_id, competition, name, home, away, start_time, inplay, has_tv)
       VALUES (?,?,?,?,?,?,?,?,?)`, [id, b.sport ?? 'cricket', b.competition ?? null, name, b.home ?? null, b.away ?? null,
            String(b.startTime).replace('T', ' ').slice(0, 19), b.inplay ? 1 : 0, b.hasTV ? 1 : 0]);
        await this.audit.record({ adminId: req.user.id, action: 'sports.event.create', target: id, metadata: { name } });
        return { id };
    }
    async updateEvent(req, id, b) {
        const fields = [];
        const args = [];
        if (b.status) {
            fields.push('status = ?');
            args.push(b.status);
        }
        if (b.inplay !== undefined) {
            fields.push('inplay = ?');
            args.push(b.inplay ? 1 : 0);
        }
        if (b.hasTV !== undefined) {
            fields.push('has_tv = ?');
            args.push(b.hasTV ? 1 : 0);
        }
        if (b.name) {
            fields.push('name = ?');
            args.push(b.name);
        }
        if (b.startTime) {
            fields.push('start_time = ?');
            args.push(String(b.startTime).replace('T', ' ').slice(0, 19));
        }
        if (!fields.length)
            throw new common_1.BadRequestException({ message: 'Nothing to change.' });
        await this.ds.query(`UPDATE sport_event SET ${fields.join(', ')} WHERE id = ?`, [...args, id]);
        await this.audit.record({ adminId: req.user.id, action: 'sports.event.update', target: id, metadata: b });
        return { id };
    }
    /** Suspending an event suspends all of its open markets in one go. */
    async suspendEvent(req, id) {
        await this.ds.query(`UPDATE market SET status='suspended' WHERE event_id = ? AND status='open'`, [id]);
        await this.ds.query(`UPDATE sport_event SET status='suspended' WHERE id = ?`, [id]);
        await this.audit.record({ adminId: req.user.id, action: 'sports.event.suspend', target: id });
        return { id, status: 'suspended' };
    }
    async resumeEvent(req, id) {
        await this.ds.query(`UPDATE market SET status='open' WHERE event_id = ? AND status='suspended'`, [id]);
        await this.ds.query(`UPDATE sport_event SET status='open' WHERE id = ?`, [id]);
        await this.audit.record({ adminId: req.user.id, action: 'sports.event.resume', target: id });
        return { id, status: 'open' };
    }
    // ------------------------------------------------------------- markets
    async markets(eventId) {
        const markets = await this.ds.query(`SELECT m.*, (SELECT COALESCE(SUM(b.liability),0) FROM sport_bet b WHERE b.market_id = m.id AND b.status='open') AS open_liability
         FROM market m WHERE m.event_id = ? ORDER BY m.sort_order, m.name`, [eventId]);
        const runners = markets.length
            ? await this.ds.query(`SELECT * FROM runner WHERE market_id IN (${markets.map(() => '?').join(',')}) ORDER BY sort_order`, markets.map((m) => m.id))
            : [];
        // What the house stands to lose on each runner if it wins.
        const bets = await this.ds.query(`SELECT market_id, runner_id, side, market_type, potential_profit, liability
         FROM sport_bet WHERE event_id = ? AND status = 'open'`, [eventId]);
        return {
            markets: markets.map((m) => ({
                ...m,
                runners: runners.filter((r) => r.market_id === m.id).map((r) => ({
                    ...r,
                    housePosition: housePosition(bets, m.id, r.id),
                })),
            })),
        };
    }
    async createMarket(req, eventId, b) {
        const id = (0, node_crypto_1.randomUUID)();
        const type = ['match_odds', 'bookmaker', 'fancy'].includes(b?.type) ? b.type : 'match_odds';
        if (!b?.name)
            throw new common_1.BadRequestException({ message: 'Give the market a name.' });
        const runners = (b.runners ?? []).map((r) => ({ ...r, line: lineValue(r?.line, r?.name) }));
        if (type === 'fancy') {
            const missing = runners.find((r) => r.line === null);
            if (missing)
                throw new common_1.BadRequestException({ message: `Enter the line (a number, e.g. 52) for "${missing.name}".` });
        }
        await this.ds.query(`INSERT INTO market (id, event_id, type, name, min_stake, max_stake, max_liability, commission_pct, inplay_allowed, sort_order)
       VALUES (?,?,?,?,?,?,?,?,?,?)`, [id, eventId, type, b.name, b.minStake ?? 100, b.maxStake ?? 500000, b.maxLiability ?? null,
            b.commissionPct ?? 0, b.inplayAllowed === false ? 0 : 1, b.sortOrder ?? 0]);
        for (const [i, r] of runners.entries()) {
            await this.ds.query(`INSERT INTO runner (id, market_id, name, line_value, back_price, lay_price, back_rate, lay_rate, sort_order)
         VALUES (?,?,?,?,?,?,?,?,?)`, [(0, node_crypto_1.randomUUID)(), id, r.name, r.line, r.back ?? null, r.lay ?? null,
                r.backRate ?? null, r.layRate ?? null, i]);
        }
        await this.audit.record({ adminId: req.user.id, action: 'sports.market.create', target: id, metadata: { eventId, type } });
        return { id };
    }
    async updateMarket(req, id, b) {
        const fields = [];
        const args = [];
        const set = (col, val) => { fields.push(`${col} = ?`); args.push(val); };
        if (b.status)
            set('status', b.status);
        if (b.name)
            set('name', b.name);
        if (b.minStake !== undefined)
            set('min_stake', b.minStake);
        if (b.maxStake !== undefined)
            set('max_stake', b.maxStake);
        if (b.maxLiability !== undefined)
            set('max_liability', b.maxLiability === '' ? null : b.maxLiability);
        if (b.commissionPct !== undefined)
            set('commission_pct', b.commissionPct);
        if (b.inplayAllowed !== undefined)
            set('inplay_allowed', b.inplayAllowed ? 1 : 0);
        if (!fields.length)
            throw new common_1.BadRequestException({ message: 'Nothing to change.' });
        await this.ds.query(`UPDATE market SET ${fields.join(', ')} WHERE id = ?`, [...args, id]);
        await this.audit.record({ adminId: req.user.id, action: 'sports.market.update', target: id, metadata: b });
        return { id };
    }
    /** Manual prices, for markets the admin runs without a feed. */
    async updateRunner(req, id, b) {
        const line = lineValue(b.line, b.name ?? 'this selection');
        await this.ds.query(`UPDATE runner SET name = COALESCE(?, name), back_price=?, lay_price=?, back_rate=?, lay_rate=?,
         line_value=?, status = COALESCE(?, status) WHERE id = ?`, [b.name ?? null, nz(b.back), nz(b.lay), nz(b.backRate), nz(b.layRate), line, b.status ?? null, id]);
        await this.audit.record({ adminId: req.user.id, action: 'sports.runner.update', target: id, metadata: b });
        return { id };
    }
    async settle(req, id, b) {
        try {
            const out = await this.sports.settleMarket({
                marketId: id, winnerRunnerId: b?.winnerRunnerId, value: b?.value, adminId: req.user.id,
            });
            await this.audit.record({ adminId: req.user.id, action: 'sports.market.settle', target: id, metadata: out });
            return out;
        }
        catch (err) {
            if (err instanceof sports_service_1.BetError)
                throw new common_1.BadRequestException({ message: err.message });
            throw new common_1.BadRequestException({ message: err?.message ?? 'Settlement failed.' });
        }
    }
    async voidMarket(req, id, b) {
        const out = await this.sports.voidMarket({ marketId: id, adminId: req.user.id, reason: b?.reason });
        await this.audit.record({ adminId: req.user.id, action: 'sports.market.void', target: id, metadata: out });
        return out;
    }
    // ----------------------------------------------------------------- bets
    async bets(q) {
        const limit = Math.min(Math.max(Number(q.limit ?? 100), 1), 500);
        const where = ['1=1'];
        const args = [];
        if (q.status) {
            where.push('b.status = ?');
            args.push(q.status);
        }
        if (q.userId) {
            where.push('b.user_id = ?');
            args.push(q.userId);
        }
        if (q.eventId) {
            where.push('b.event_id = ?');
            args.push(q.eventId);
        }
        const rows = await this.ds.query(`SELECT b.*, u.nickname FROM sport_bet b LEFT JOIN users u ON u.id = b.user_id
        WHERE ${where.join(' AND ')} ORDER BY b.placed_at DESC LIMIT ?`, [...args, limit]);
        return { bets: rows };
    }
    async voidBet(req, id, b) {
        try {
            const out = await this.sports.voidBet({ betId: id, adminId: req.user.id, reason: b?.reason });
            await this.audit.record({ adminId: req.user.id, action: 'sports.bet.void', target: id, metadata: out });
            return out;
        }
        catch (err) {
            throw new common_1.BadRequestException({ message: err?.message ?? 'That bet could not be voided.' });
        }
    }
    /** Where the house is carrying risk right now. */
    async risk() {
        const [totals] = await this.ds.query(`SELECT COUNT(*) AS open_bets, COALESCE(SUM(liability),0) AS player_liability,
              COALESCE(SUM(potential_profit),0) AS house_liability
         FROM sport_bet WHERE status = 'open'`);
        const byEvent = await this.ds.query(`SELECT b.event_id, b.event_name, COUNT(*) AS bets,
              COALESCE(SUM(b.liability),0) AS taken,
              COALESCE(SUM(b.potential_profit),0) AS exposure
         FROM sport_bet b WHERE b.status = 'open'
        GROUP BY b.event_id, b.event_name ORDER BY exposure DESC LIMIT 50`);
        const [settled] = await this.ds.query(`SELECT COALESCE(SUM(liability),0) AS staked, COALESCE(SUM(payout),0) AS paid
         FROM sport_bet WHERE status = 'settled' AND settled_at > DATE_SUB(NOW(), INTERVAL 30 DAY)`);
        return {
            open: {
                bets: Number(totals.open_bets),
                takenFromPlayers: Number(totals.player_liability).toFixed(2),
                worstCasePayout: Number(totals.house_liability).toFixed(2),
            },
            last30Days: {
                taken: Number(settled.staked).toFixed(2),
                paid: Number(settled.paid).toFixed(2),
                margin: (Number(settled.staked) - Number(settled.paid)).toFixed(2),
            },
            byEvent,
        };
    }
    // ------------------------------------------------------------- settings
    async settings() {
        const rows = await this.ds.query(`SELECT key_name, value FROM sports_config`);
        const out = {};
        for (const r of rows)
            out[r.key_name] = r.value;
        return out;
    }
    async saveSettings(req, body) {
        const allowed = ['betting_enabled', 'default_min_stake', 'default_max_stake',
            'default_max_liability_per_market', 'default_commission_pct', 'inplay_delay_seconds',
            'max_open_bets_per_player'];
        const changed = [];
        for (const [key, value] of Object.entries(body ?? {})) {
            if (!allowed.includes(key))
                continue;
            await this.ds.query(`INSERT INTO sports_config (key_name, value) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE value = VALUES(value)`, [key, String(value ?? '').slice(0, 255)]);
            changed.push(key);
        }
        await this.audit.record({ adminId: req.user.id, action: 'sports.settings.update', metadata: { changed } });
        return { changed };
    }
};
exports.AdminSportsController = AdminSportsController;
__decorate([
    (0, common_1.Get)('providers'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], AdminSportsController.prototype, "providers", null);
__decorate([
    (0, common_1.Post)('providers'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], AdminSportsController.prototype, "createProvider", null);
__decorate([
    (0, common_1.Put)('providers/:id'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('id')),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", Promise)
], AdminSportsController.prototype, "updateProvider", null);
__decorate([
    (0, common_1.Delete)('providers/:id'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], AdminSportsController.prototype, "deleteProvider", null);
__decorate([
    (0, common_1.Post)('providers/:id/test'),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], AdminSportsController.prototype, "testProvider", null);
__decorate([
    (0, common_1.Post)('providers/:id/sync'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], AdminSportsController.prototype, "syncProvider", null);
__decorate([
    (0, common_1.Post)('providers/:id/sync-sports'),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], AdminSportsController.prototype, "syncSports", null);
__decorate([
    (0, common_1.Post)('providers/:id/sync-odds'),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], AdminSportsController.prototype, "syncOdds", null);
__decorate([
    (0, common_1.Post)('providers/:id/reconcile'),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], AdminSportsController.prototype, "reconcile", null);
__decorate([
    (0, common_1.Get)('providers/:id/health'),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], AdminSportsController.prototype, "health", null);
__decorate([
    (0, common_1.Post)('providers/:id/sync-results'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], AdminSportsController.prototype, "syncResults", null);
__decorate([
    (0, common_1.Post)('events/:eventId/settle-from-score'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('eventId')),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", Promise)
], AdminSportsController.prototype, "settleFromScore", null);
__decorate([
    (0, common_1.Get)('pulsescore/settings'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], AdminSportsController.prototype, "psSettings", null);
__decorate([
    (0, common_1.Put)('pulsescore/settings'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], AdminSportsController.prototype, "psSave", null);
__decorate([
    (0, common_1.Post)('pulsescore/test'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], AdminSportsController.prototype, "psTest", null);
__decorate([
    (0, common_1.Post)('pulsescore/sync'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], AdminSportsController.prototype, "psSync", null);
__decorate([
    (0, common_1.Post)('pulsescore/sync-live'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], AdminSportsController.prototype, "psSyncLive", null);
__decorate([
    (0, common_1.Get)('sync-runs'),
    __param(0, (0, common_1.Query)('limit')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], AdminSportsController.prototype, "syncRuns", null);
__decorate([
    (0, common_1.Get)('bookmakers'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], AdminSportsController.prototype, "bookmakers", null);
__decorate([
    (0, common_1.Put)('bookmakers/:key'),
    __param(0, (0, common_1.Param)('key')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], AdminSportsController.prototype, "updateBookmaker", null);
__decorate([
    (0, common_1.Get)('providers/:id/bookmaker-filter'),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], AdminSportsController.prototype, "getBookmakerFilter", null);
__decorate([
    (0, common_1.Put)('providers/:id/bookmaker-filter'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], AdminSportsController.prototype, "setBookmakerFilter", null);
__decorate([
    (0, common_1.Get)('sport-catalog'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], AdminSportsController.prototype, "sportCatalog", null);
__decorate([
    (0, common_1.Put)('sport-catalog/:key'),
    __param(0, (0, common_1.Param)('key')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], AdminSportsController.prototype, "setSportEnabled", null);
__decorate([
    (0, common_1.Get)('events'),
    __param(0, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], AdminSportsController.prototype, "events", null);
__decorate([
    (0, common_1.Post)('events'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], AdminSportsController.prototype, "createEvent", null);
__decorate([
    (0, common_1.Put)('events/:id'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('id')),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", Promise)
], AdminSportsController.prototype, "updateEvent", null);
__decorate([
    (0, common_1.Post)('events/:id/suspend'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], AdminSportsController.prototype, "suspendEvent", null);
__decorate([
    (0, common_1.Post)('events/:id/resume'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], AdminSportsController.prototype, "resumeEvent", null);
__decorate([
    (0, common_1.Get)('events/:id/markets'),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], AdminSportsController.prototype, "markets", null);
__decorate([
    (0, common_1.Post)('events/:id/markets'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('id')),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", Promise)
], AdminSportsController.prototype, "createMarket", null);
__decorate([
    (0, common_1.Put)('markets/:id'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('id')),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", Promise)
], AdminSportsController.prototype, "updateMarket", null);
__decorate([
    (0, common_1.Put)('runners/:id'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('id')),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", Promise)
], AdminSportsController.prototype, "updateRunner", null);
__decorate([
    (0, common_1.Post)('markets/:id/settle'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('id')),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", Promise)
], AdminSportsController.prototype, "settle", null);
__decorate([
    (0, common_1.Post)('markets/:id/void'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('id')),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", Promise)
], AdminSportsController.prototype, "voidMarket", null);
__decorate([
    (0, common_1.Get)('bets'),
    __param(0, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], AdminSportsController.prototype, "bets", null);
__decorate([
    (0, common_1.Post)('bets/:id/void'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('id')),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", Promise)
], AdminSportsController.prototype, "voidBet", null);
__decorate([
    (0, common_1.Get)('risk'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], AdminSportsController.prototype, "risk", null);
__decorate([
    (0, common_1.Get)('settings'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], AdminSportsController.prototype, "settings", null);
__decorate([
    (0, common_1.Put)('settings'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], AdminSportsController.prototype, "saveSettings", null);
exports.AdminSportsController = AdminSportsController = __decorate([
    (0, common_1.Controller)('admin/sports'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard, jwt_auth_guard_1.AdminGuard),
    __metadata("design:paramtypes", [typeorm_1.DataSource,
        sports_service_1.SportsService,
        odds_feed_service_1.OddsFeedService,
        theoddsapi_adapter_1.TheOddsApiAdapter,
        scores_results_service_1.ScoresResultsService,
        pulsescore_adapter_1.PulseScoreAdapter,
        audit_service_1.AuditService])
], AdminSportsController);
function housePosition(bets, marketId, runnerId) {
    return bets
        .filter((b) => b.market_id === marketId && b.market_type !== 'fancy')
        .reduce((sum, b) => {
        const onThis = b.runner_id === runnerId;
        const profit = Number(b.potential_profit);
        const liability = Number(b.liability);
        // Mirror image of the player's position.
        if (b.side === 'back')
            return sum + (onThis ? -profit : liability);
        return sum + (onThis ? liability : -profit);
    }, 0);
}
function providerValues(b) {
    return {
        code: String(b.code ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, ''),
        display_name: String(b.display_name ?? b.displayName ?? '').slice(0, 96),
        kind: ['generic-json', 'manual'].includes(b.kind) ? b.kind : 'generic-json',
        base_url: b.base_url ?? b.baseUrl ?? null,
        events_path: b.events_path ?? b.eventsPath ?? null,
        odds_path: b.odds_path ?? b.oddsPath ?? null,
        auth_type: ['none', 'header', 'query', 'bearer'].includes(b.auth_type ?? b.authType) ? (b.auth_type ?? b.authType) : 'none',
        auth_name: b.auth_name ?? b.authName ?? null,
        auth_value: b.auth_value ?? b.authValue ?? null,
        config: typeof b.config === 'string' ? safeJson(b.config) : b.config,
        poll_seconds: Math.min(Math.max(Number(b.poll_seconds ?? b.pollSeconds ?? 30), 5), 3600),
        enabled: b.enabled === false || b.enabled === 0 ? 0 : 1,
    };
}
function safeJson(s) {
    try {
        return JSON.parse(s);
    }
    catch {
        throw new common_1.BadRequestException({ message: 'The mapping is not valid JSON.' });
    }
}
function nz(v) {
    return v === '' || v === undefined ? null : v;
}
/** A runner line must be a number; blank means no line. Rejects text typed into the Line box. */
function lineValue(v, name) {
    if (v === '' || v === undefined || v === null)
        return null;
    const n = Number(String(v).trim());
    if (!Number.isFinite(n)) {
        throw new common_1.BadRequestException({ message: `The line for "${name}" must be a number, e.g. 52. Put the market name in the Name box.` });
    }
    return n;
}
