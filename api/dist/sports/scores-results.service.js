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
var ScoresResultsService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.ScoresResultsService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("typeorm");
const sports_service_1 = require("./sports.service");
/**
 * Stage 2 — scores, completed results, and automatic settlement.
 *
 * Pulls GET /v4/sports/{key}/scores (with daysFrom for recently finished games),
 * updates each event's live/score/completed state by provider event id, and when
 * a match is completed, resolves the winning runner and settles its match_odds
 * market through the EXISTING SportsService.settleMarket — so payouts use the
 * same proven maths as manual settlement.
 *
 * Idempotent: a match_odds market already 'settled' is skipped, and the
 * settlement table's unique(bet_id) prevents any double pay even if the job runs
 * twice. Nothing here ever deletes bets or reopens a settled market.
 */
let ScoresResultsService = ScoresResultsService_1 = class ScoresResultsService {
    ds;
    sports;
    log = new common_1.Logger(ScoresResultsService_1.name);
    base = 'https://api.the-odds-api.com/v4';
    constructor(ds, sports) {
        this.ds = ds;
        this.sports = sports;
    }
    async provider(providerId) {
        const [p] = await this.ds.query(`SELECT * FROM odds_provider WHERE id = ?`, [providerId]);
        if (!p)
            throw new Error('Provider not found.');
        return p;
    }
    async get(provider, path, params = {}) {
        const qs = new URLSearchParams({ apiKey: provider.auth_value ?? '', ...params }).toString();
        const url = `${this.base}/${path.replace(/^\//, '')}?${qs}`;
        const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
        const remaining = res.headers.get('x-requests-remaining');
        const used = res.headers.get('x-requests-used');
        if (remaining !== null || used !== null) {
            await this.ds.query(`UPDATE odds_provider SET quota_remaining=?, quota_used=? WHERE id=?`, [remaining ? Number(remaining) : null, used ? Number(used) : null, provider.id]).catch(() => { });
        }
        const text = await res.text();
        if (!res.ok) {
            const e = new Error(`Scores ${res.status}: ${text.slice(0, 160)}`);
            e.status = res.status;
            throw e;
        }
        try {
            return JSON.parse(text);
        }
        catch {
            throw new Error('Scores endpoint did not return JSON.');
        }
    }
    async startRun(providerId, job) {
        const r = await this.ds.query(`INSERT INTO sync_run (provider_id, job, started_at) VALUES (?,?,NOW())`, [providerId, job]);
        return r.insertId;
    }
    async finishRun(id, ok, updated, processed, msg) {
        await this.ds.query(`UPDATE sync_run SET finished_at=NOW(), ok=?, updated=?, processed=?, message=? WHERE id=?`, [ok ? 1 : 0, updated, processed, msg ? msg.slice(0, 250) : null, id]).catch(() => { });
    }
    /**
     * JOB 4+5 — sync scores and completed results, then settle finished matches.
     * daysFrom asks the API for games completed in the last N days too.
     */
    async syncScoresAndSettle(providerId, daysFrom = 1) {
        const run = await this.startRun(providerId, 'scores');
        const provider = await this.provider(providerId);
        // Which sports to poll for scores: the enabled, non-outright ones that have
        // at least one event not yet settled.
        const sports = await this.ds.query(`SELECT DISTINCT c.sport_key FROM sport_catalog c
         JOIN sport_event e ON e.sport_key = c.sport_key
        WHERE c.enabled = 1 AND c.has_outrights = 0 AND e.status <> 'settled'`);
        let updated = 0, settledMarkets = 0, processed = 0;
        const errors = [];
        for (const s of sports) {
            try {
                const data = await this.get(provider, `sports/${s.sport_key}/scores`, { daysFrom: String(daysFrom) });
                for (const g of Array.isArray(data) ? data : []) {
                    processed++;
                    const changed = await this.applyScore(providerId, g);
                    if (changed.updated)
                        updated++;
                    if (changed.settled)
                        settledMarkets += changed.settled;
                }
            }
            catch (e) {
                errors.push(`${s.sport_key}: ${e.message}`);
                if (e.status === 429)
                    break;
            }
        }
        await this.finishRun(run, errors.length === 0, updated, processed, errors.slice(0, 3).join(' | ') || null);
        return { eventsUpdated: updated, marketsSettled: settledMarkets, processed, errors };
    }
    /**
     * No-API test path. Reads the scores you set directly on the event row in the
     * DB and settles its match_odds market — same logic as a real result, but with
     * zero API calls. For testing settlement without spending quota.
     */
    async settleFromDbScore(eventId) {
        const [ev] = await this.ds.query(`SELECT id, home, away, status, home_score, away_score FROM sport_event WHERE id = ?`, [eventId]);
        if (!ev)
            throw new Error('No such event.');
        if (ev.home_score == null || ev.away_score == null) {
            throw new Error('Set home_score and away_score on the event first.');
        }
        // Reuse applyScore by shaping a fake "completed" score record.
        const fake = {
            id: null,
            completed: true,
            scores: [
                { name: ev.home, score: String(ev.home_score) },
                { name: ev.away, score: String(ev.away_score) },
            ],
        };
        // applyScore matches by provider_ref, so call the settlement part directly.
        const result = await this.settleEventFromScores(ev, Number(ev.home_score), Number(ev.away_score));
        return { eventId, ...result };
    }
    /** The settlement half of applyScore, callable with explicit scores. */
    async settleEventFromScores(ev, homeScore, awayScore) {
        let winnerName = null;
        if (homeScore > awayScore)
            winnerName = ev.home;
        else if (awayScore > homeScore)
            winnerName = ev.away;
        await this.ds.query(`UPDATE sport_event SET result_home=?, result_away=?, is_completed=1, settled_from_result=1 WHERE id=?`, [homeScore, awayScore, ev.id]);
        const markets = await this.ds.query(`SELECT id FROM market WHERE event_id=? AND type='match_odds' AND status IN ('open','suspended','closed')`, [ev.id]);
        let settled = 0;
        for (const m of markets) {
            const runners = await this.ds.query(`SELECT id, name FROM runner WHERE market_id=?`, [m.id]);
            let winnerRunnerId = null;
            if (winnerName)
                winnerRunnerId = runners.find((x) => x.name === winnerName)?.id ?? null;
            else
                winnerRunnerId = runners.find((x) => /draw/i.test(x.name))?.id ?? null;
            if (!winnerRunnerId) {
                try {
                    await this.sports.voidMarket({ marketId: m.id, adminId: 'manual:dbscore', reason: 'No matching result runner' });
                    settled++;
                }
                catch { }
                continue;
            }
            try {
                await this.sports.settleMarket({ marketId: m.id, winnerRunnerId, adminId: 'manual:dbscore' });
                settled++;
            }
            catch (e) {
                if (!/already settled/i.test(e.message))
                    this.log.warn(`settle ${m.id}: ${e.message}`);
            }
        }
        return { winner: winnerName ?? 'draw/void', marketsSettled: settled };
    }
    /**
     * Apply one score record to its event (matched by provider event id), and
     * settle when the game is completed. Returns what changed.
     */
    async applyScore(providerId, g) {
        const [ev] = await this.ds.query(`SELECT id, home, away, status FROM sport_event WHERE provider_id = ? AND provider_ref = ?`, [providerId, g.id]);
        if (!ev)
            return { updated: false, settled: 0 }; // never match by team name
        // Pull home/away scores from the provider's scores array.
        let homeScore = null, awayScore = null;
        for (const sc of g.scores ?? []) {
            const n = sc.score != null ? Number(sc.score) : null;
            if (sc.name && ev.home && sc.name === ev.home)
                homeScore = n;
            else if (sc.name && ev.away && sc.name === ev.away)
                awayScore = n;
        }
        const completed = !!g.completed;
        const inplay = !completed && (g.scores != null); // scores present but not done => live
        await this.ds.query(`UPDATE sport_event
          SET home_score=?, away_score=?, inplay=?, is_completed=?, last_provider_update=NOW()
        WHERE id=? AND status <> 'settled'`, [homeScore, awayScore, inplay ? 1 : 0, completed ? 1 : 0, ev.id]);
        if (!completed || ev.status === 'settled')
            return { updated: true, settled: 0 };
        // Completed: settle via the shared path (also used by the no-API test).
        if (homeScore == null || awayScore == null)
            return { updated: true, settled: 0 };
        const r = await this.settleEventFromScores(ev, homeScore, awayScore);
        return { updated: true, settled: r.marketsSettled };
    }
};
exports.ScoresResultsService = ScoresResultsService;
exports.ScoresResultsService = ScoresResultsService = ScoresResultsService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [typeorm_1.DataSource,
        sports_service_1.SportsService])
], ScoresResultsService);
