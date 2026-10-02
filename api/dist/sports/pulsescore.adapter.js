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
var PulseScoreAdapter_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.PulseScoreAdapter = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("typeorm");
const node_crypto_1 = require("node:crypto");
const sports_service_1 = require("./sports.service");
/**
 * PulseScore adapter (https://pulsescore.net) — Orbit Exchange source.
 *
 * PulseScore returns a normalized schema per bookmaker. Score/clock fields are
 * provider-dependent, so this adapter keeps OrbitXch as the owner of event/
 * Match Odds state and uses separate live sources only to enrich existing events.
 *
 * We import ONE market per event: MATCH_RESULT / MATCH_WINNER (Home/Draw/Away),
 * mapped to our internal `match_odds`. Everything upserts by the provider's own
 * eventId so nothing duplicates. Auth is the X-Secret header.
 *
 * This runs alongside the Odds API adapter; its events are tagged
 * provider_id='pulsescore' so the two never collide.
 */
let PulseScoreAdapter = PulseScoreAdapter_1 = class PulseScoreAdapter {
    ds;
    sports;
    log = new common_1.Logger(PulseScoreAdapter_1.name);
    base = 'https://api.pulsescore.net/api';
    PROVIDER_ID = 'pulsescore';
    liveSocket = null;
    liveReconnectTimer = null;
    livePollTimer = null;
    orbitCleanupTimer = null;
    lastOrbitLiveSuccessAt = 0;
    liveStarted = false;
    liveSyncInProgress = false;
    SCORE_BOOKMAKER = 'melbet';
    MARKET_BOOKMAKERS = ['cloudbet', 'stake', 'betway'];
    constructor(ds, sports) {
        this.ds = ds;
        this.sports = sports;
    }
    lastCall = 0;
    async throttle() {
        const wait = this.lastCall + 1100 - Date.now();
        if (wait > 0)
            await new Promise((r) => setTimeout(r, wait));
        this.lastCall = Date.now();
    }
    async onModuleInit() {
        setTimeout(() => this.startLiveSocket().catch((e) => this.log.warn(`PulseScore WS start: ${e?.message ?? e}`)), 1500);
        // OrbitXch supplies exchange odds through WS. The other PulseScore sources
        // are polled because they provide the live cricket score / cricket-specific
        // markets that OrbitXch does not expose in its live response.
        setTimeout(() => this.startLiveSources().catch((e) => this.log.warn(`PulseScore live sources: ${e?.message ?? e}`)), 2500);
    }
    async onModuleDestroy() {
        this.liveStarted = false;
        if (this.liveReconnectTimer)
            clearTimeout(this.liveReconnectTimer);
        if (this.livePollTimer)
            clearInterval(this.livePollTimer);
        if (this.orbitCleanupTimer)
            clearInterval(this.orbitCleanupTimer);
        try {
            this.liveSocket?.close?.();
        }
        catch { }
        this.liveSocket = null;
        this.livePollTimer = null;
    }
    async startLiveSocket() {
        const cfg = await this.config();
        if (cfg.enabled !== '1' || (cfg.bookmaker || '').toLowerCase() !== 'orbitxch')
            return;
        if (this.liveStarted && this.liveSocket)
            return;
        this.liveStarted = true;
        const key = cfg.api_key || '';
        if (!key)
            return;
        let WS;
        try {
            WS = require('ws');
        }
        catch {
            this.log.error('PulseScore live WebSocket requires the ws package.');
            return;
        }
        const url = `wss://api.pulsescore.net/api/orbitxch/ws/live?key=${encodeURIComponent(key)}&sport=cricket`;
        const socket = new WS(url);
        this.liveSocket = socket;
        socket.on('open', () => this.log.log('PulseScore Orbit cricket WebSocket connected'));
        socket.on('message', async (raw) => {
            try {
                const frame = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw));
                if (frame?.type === 'connected')
                    return;
                const events = Array.isArray(frame)
                    ? frame
                    : Array.isArray(frame?.data)
                        ? frame.data
                        : frame?.eventId
                            ? [frame]
                            : [];
                for (const ev of events)
                    await this.applyLiveEvent({ ...ev, live: true });
            }
            catch (e) {
                this.log.warn(`PulseScore WS frame: ${e?.message ?? e}`);
            }
        });
        socket.on('error', (e) => this.log.warn(`PulseScore WS: ${e?.message ?? e}`));
        socket.on('close', () => {
            if (this.liveSocket === socket)
                this.liveSocket = null;
            if (!this.liveStarted)
                return;
            if (this.liveReconnectTimer)
                clearTimeout(this.liveReconnectTimer);
            this.liveReconnectTimer = setTimeout(() => {
                this.liveReconnectTimer = null;
                this.liveStarted = false;
                this.startLiveSocket().catch(() => { });
            }, 3000);
        });
    }
    async startLiveSources() {
        if (this.livePollTimer)
            return;
        const cfg = await this.config();
        if (cfg.enabled !== '1')
            return;
        const run = async () => {
            try {
                await this.syncLive();
            }
            catch (e) {
                this.log.warn(`PulseScore live source poll: ${e?.message ?? e}`);
            }
        };
        await run();
        // PRO is limited to 1 request/sec per bookmaker. syncLive() serializes
        // requests, so a 7-second cycle keeps every source safely below that limit.
        this.livePollTimer = setInterval(run, 7000);
        // Event state belongs to OrbitXch. Score/market enrichment sources are
        // never allowed to keep an event artificially live. A separate cleanup
        // pass expires Orbit events that have not received an Orbit update for a
        // grace period. This avoids the old 1 -> 26 stale-live accumulation.
        this.orbitCleanupTimer = setInterval(() => {
            this.expireStaleOrbitEvents().catch((e) => this.log.warn(`PulseScore stale-event cleanup: ${e?.message ?? e}`));
        }, 30000);
    }
    ladder(selection, side) {
        const direct = selection?.[side] ?? selection?.[`${side}Ladder`] ?? selection?.[`${side}Odds`];
        const out = [];
        const push = (x) => {
            if (x == null)
                return;
            const price = Number(x.price ?? x.odds ?? x.decimal ?? x.rate ?? x.p ?? x[0]);
            const size = Number(x.size ?? x.liquidity ?? x.amount ?? x.stake ?? x.volume ?? x.s ?? x[1]);
            if (Number.isFinite(price) && price > 0)
                out.push({ price, size: Number.isFinite(size) ? size : null });
        };
        if (Array.isArray(direct))
            direct.forEach(push);
        else if (direct && typeof direct === 'object')
            push(direct);
        for (let i = 1; i <= 3 && out.length < 3; i++) {
            const price = selection?.[`${side}${i}`] ?? selection?.[`${side}Price${i}`] ?? selection?.[`${side}_price_${i}`];
            const size = selection?.[`${side}Size${i}`] ?? selection?.[`${side}_size_${i}`] ?? selection?.[`${side}${i}Size`];
            if (price != null)
                push({ price, size });
        }
        // Exchange convention: the best BACK is the highest price; the best LAY
        // is the lowest price. Sort the provider ladder so level 1 is always the
        // executable best price even if PulseScore changes array ordering.
        out.sort((a, b) => side === 'back' ? b.price - a.price : a.price - b.price);
        return out.slice(0, 3);
    }
    parseScore(score) {
        if (score == null)
            return { home: null, away: null, text: null };
        if (typeof score === 'object') {
            const home = Number(score.home ?? score.homeScore ?? score.h ?? NaN);
            const away = Number(score.away ?? score.awayScore ?? score.a ?? NaN);
            const text = score.text ?? score.display ?? null;
            return { home: Number.isFinite(home) ? home : null, away: Number.isFinite(away) ? away : null, text: text != null ? String(text) : null };
        }
        const raw = String(score).trim();
        const m = raw.match(/(-?\d+)\s*[-:]\s*(-?\d+)/);
        return { home: m ? Number(m[1]) : null, away: m ? Number(m[2]) : null, text: raw || null };
    }
    liveClock(ev) {
        const c = ev?.matchClock;
        if (c == null)
            return null;
        if (typeof c === 'string' || typeof c === 'number')
            return String(c);
        if (typeof c === 'object') {
            if (c.overs != null)
                return String(c.overs);
            if (c.over != null)
                return String(c.over);
            if (c.currentOver != null)
                return String(c.currentOver);
            if (c.display != null)
                return String(c.display);
            if (c.period != null) {
                const running = c.running === true ? ' | running' : '';
                const second = c.second != null ? ` | ${c.second}s` : '';
                return `${String(c.period)}${running}${second}`;
            }
            for (const k of ['clock', 'value', 'running']) {
                if (c[k] != null && String(c[k]).trim() !== '')
                    return String(c[k]);
            }
        }
        return null;
    }
    async applyLiveEvent(ev) {
        if (!ev?.eventId)
            return;
        const ref = `ps:${ev.eventId}`;
        const sport = this.internalSport(ev.sport || 'cricket');
        const home = String(ev.home ?? '?');
        const away = String(ev.away ?? '?');
        const name = `${home} v ${away}`;
        const competition = String(ev.league || '').split('||').pop() || null;
        const start = ev.startTime ? new Date(ev.startTime) : new Date();
        const score = this.parseScore(ev.score);
        const clock = this.liveClock(ev);
        const periodScores = ev.periodScores != null ? JSON.stringify(ev.periodScores) : null;
        await this.ds.query(`INSERT IGNORE INTO sport (id,name,enabled,sort_order) VALUES (?,?,1,50)`, [sport, sport.charAt(0).toUpperCase() + sport.slice(1)]).catch(() => { });
        let [local] = await this.ds.query(`SELECT id, status, inplay, live_status FROM sport_event WHERE provider_id=? AND provider_ref=?`, [this.PROVIDER_ID, ref]);
        if (!local) {
            const eventId = (0, node_crypto_1.randomUUID)();
            await this.ds.query(`INSERT INTO sport_event (id,sport_id,provider_id,provider_ref,competition,name,home,away,start_time,sport_key,sport_title,status,inplay,is_completed,home_score,away_score,live_status,live_updated_at,last_provider_update) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())`, [eventId, sport, this.PROVIDER_ID, ref, competition, name, home, away, start, sport, competition, 'inplay', 1, 0, score.home, score.away, 'live', new Date()]);
            local = { id: eventId };
        }
        else {
            // This method is called only from the live WebSocket. A live frame is
            // authoritative: never write the event back as prematch/closed.
            await this.ds.query(`UPDATE sport_event SET competition=?,name=?,home=?,away=?,start_time=?,sport_key=?,sport_title=?,status='inplay',inplay=1,home_score=COALESCE(?,home_score),away_score=COALESCE(?,away_score),live_status='live',live_updated_at=NOW(),last_provider_update=NOW() WHERE id=? AND status<>'settled'`, [competition, name, home, away, start, sport, competition, score.home, score.away, local.id]);
        }
        await this.ds.query(`UPDATE sport_event SET live_score=COALESCE(?,live_score),match_clock=COALESCE(?,match_clock),period_scores=COALESCE(?,period_scores),live_status='live',status='inplay',inplay=1,live_updated_at=NOW() WHERE id=? AND status<>'settled'`, [score.text, clock, periodScores, local.id]).catch(() => { });
        // Orbit can expose cricket Match Odds under MATCH_ODDS, MATCH_RESULT,
        // MATCH_WINNER, or a raw label such as "Match Odds". Do not require the
        // old FULL_TIME flag: cricket exchange feeds frequently omit a period.
        const mw = (ev.markets || []).find((m) => this.isMatchOddsMarket(m));
        if (mw) {
            await this.upsertMatchWinner(local.id, home, away, mw, { events: { c: 0, u: 0 }, runners: { c: 0, u: 0 }, settled: 0 }, 'orbitxch');
        }
        // Fancy / session markets live too.
        if (sport === 'cricket') {
            const ft = { events: { c: 0, u: 0 }, runners: { c: 0, u: 0 }, settled: 0 };
            for (const m of (ev.markets || [])) {
                if (this.isFancyMarket(m))
                    await this.upsertFancy(local.id, m, ft, 'orbitxch');
            }
        }
        // OrbitXch can also expose cricket-specific Fancy/Player/Wicket markets.
        // Import those from the same live frame so Fancy does not depend on a
        // secondary bookmaker being available. Match Odds is excluded by the
        // classifier, so Orbit remains the single Match Odds owner.
        await this.upsertCricketMarkets(ev, 'orbitxch', 'orbitxch', {
            events: { c: 0, u: 0 }, runners: { c: 0, u: 0 }, settled: 0,
        }).catch((e) => this.log.warn(`Orbit cricket markets: ${e?.message ?? e}`));
    }
    async config() {
        // pulsescore_config is a key/value table: key_name, value, updated_at.
        const rows = await this.ds.query(`
      SELECT key_name, value
      FROM pulsescore_config
      ORDER BY key_name ASC
    `);
        const out = {};
        for (const row of rows ?? []) {
            if (row?.key_name == null)
                continue;
            out[String(row.key_name)] = row.value == null ? '' : String(row.value);
        }
        return out;
    }
    /** Bet365 uses the /v3/bet365 prefix; every other bookmaker uses /{bookmaker}. */
    prefix(bookmaker) {
        return bookmaker === 'bet365' ? `${this.base}/v3/bet365` : `${this.base}/${bookmaker}`;
    }
    async getBookmaker(cfg, bookmaker, path) {
        const key = cfg.api_key ?? '';
        if (!key)
            throw new Error('No PulseScore API key set.');
        const url = `${this.prefix(bookmaker)}${path}`;
        const doFetch = async () => fetch(url, {
            headers: { 'X-Secret': key, 'Accept-Encoding': 'gzip', Accept: 'application/json' },
            signal: AbortSignal.timeout(25_000),
        });
        await this.throttle();
        let res = await doFetch();
        if (res.status === 429) {
            await new Promise((r) => setTimeout(r, 2500));
            this.lastCall = Date.now();
            res = await doFetch();
        }
        const text = await res.text();
        if (!res.ok) {
            const e = new Error(`PulseScore ${bookmaker} ${res.status}: ${text.slice(0, 160)}`);
            e.status = res.status;
            throw e;
        }
        try {
            return JSON.parse(text);
        }
        catch {
            throw new Error(`PulseScore ${bookmaker} did not return JSON.`);
        }
    }
    async get(cfg, path) {
        return this.getBookmaker(cfg, cfg.bookmaker || 'bet365', path);
    }
    async startRun(job) {
        const r = await this.ds.query(`INSERT INTO sync_run (provider_id, job, started_at) VALUES (?,?,NOW())`, [this.PROVIDER_ID, job]);
        return r.insertId;
    }
    async finishRun(id, ok, created, updated, processed, msg) {
        await this.ds.query(`UPDATE sync_run SET finished_at=NOW(), ok=?, created=?, updated=?, processed=?, message=? WHERE id=?`, [ok ? 1 : 0, created, updated, processed, msg ? msg.slice(0, 250) : null, id]).catch(() => { });
    }
    async setConfigValue(keyName, value) {
        await this.ds.query(`INSERT INTO pulsescore_config (key_name, value) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE value=VALUES(value)`, [keyName, value]).catch(() => { });
    }
    async markOk() {
        await this.setConfigValue('last_ok_at', new Date().toISOString());
        await this.setConfigValue('last_error', '');
    }
    async markFail(msg) {
        await this.setConfigValue('last_fail_at', new Date().toISOString());
        await this.setConfigValue('last_error', msg.slice(0, 250));
    }
    internalSport(sport) {
        const s = (sport || '').toLowerCase().replace(/-/g, '_');
        if (s.startsWith('cricket'))
            return 'cricket';
        if (s.startsWith('soccer') || s === 'football')
            return 'soccer';
        if (s.startsWith('tennis'))
            return 'tennis';
        if (s.startsWith('basketball'))
            return 'basketball';
        return s || 'other';
    }
    /**
     * Identify the exchange Match Odds market across PulseScore's normalized
     * and provider-specific naming. Cricket feeds commonly use MATCH_ODDS or a
     * raw "Match Odds" label, while other sports may use MATCH_RESULT or
     * MATCH_WINNER. Period is deliberately not required for cricket.
     */
    isMatchOddsMarket(m) {
        const canonical = String(m?.canonicalMarket || m?.marketType || m?.type || '').toUpperCase().replace(/[^A-Z0-9_]/g, '_');
        if (['MATCH_ODDS', 'MATCH_RESULT', 'MATCH_WINNER', 'MONEYLINE', 'MONEY_LINE', 'TO_WIN_MATCH'].includes(canonical))
            return true;
        const raw = String(m?.rawName || m?.name || '').trim().toLowerCase();
        return [
            'match odds', 'match result', 'match winner', 'money line',
            'moneyline', 'to win match', 'full time result',
        ].some((x) => raw === x || raw.includes(x));
    }
    isMatchWinner(m) {
        return this.isMatchOddsMarket(m);
    }
    isFullTime(m) {
        const p = String(m?.period || '').toUpperCase();
        return p === '' || p === 'FULL_TIME' || p === 'FULLTIME' || p === 'FT' || p === 'MATCH';
    }
    // ------------------------------------------------------------ sync
    /**
     * Pull upcoming pre-match events for each configured sport, import the match
     * winner market, and settle any event that arrives already finished.
     * One paged sweep per sport. Unlimited requests on PRO, so we page fully.
     */
    async sync() {
        const cfg = await this.config();
        if (cfg.enabled !== '1')
            return { skipped: true };
        const run = await this.startRun('odds');
        const sports = (cfg.sports || 'cricket,soccer,tennis,basketball').split(',').map((s) => s.trim()).filter(Boolean);
        const totals = { events: { c: 0, u: 0 }, runners: { c: 0, u: 0 }, settled: 0, sources: {} };
        const errors = [];
        for (const sport of sports) {
            try {
                // Bet365: soccer is at the root; other sports have a /{sport} prefix.
                const isBet365 = (cfg.bookmaker || 'bet365') === 'bet365';
                const sportPath = sport === 'soccer' && isBet365 ? '' : `/${sport}`;
                let page = 1;
                const limit = 30;
                let pages = 1;
                do {
                    const data = await this.get(cfg, `${sportPath}/events?page=${page}&limit=${limit}`);
                    pages = data.totalPages ?? 1;
                    for (const ev of data.events ?? []) {
                        await this.upsertEvent(sport, ev, totals, cfg.bookmaker || 'bet365');
                    }
                    page++;
                    if (page > 40)
                        break; // hard safety cap on pages per sport
                } while (page <= pages);
            }
            catch (e) {
                errors.push(`${sport}: ${e.message}`);
                if (e.status === 429)
                    break;
            }
        }
        // LIVE sweep MUST run after prematch synchronization. The live feed is the
        // authoritative final state for an event that has started. Running it first
        // lets the subsequent prematch pass downgrade inplay=1 back to inplay=0.
        try {
            const liveTotals = await this.syncLive();
            totals.events.c += Number(liveTotals?.events?.c ?? 0);
            totals.events.u += Number(liveTotals?.events?.u ?? 0);
            totals.runners.c += Number(liveTotals?.runners?.c ?? 0);
            totals.runners.u += Number(liveTotals?.runners?.u ?? 0);
            totals.settled += Number(liveTotals?.settled ?? 0);
            Object.assign(totals.sources, liveTotals?.sources ?? {});
        }
        catch (e) {
            errors.push(`live: ${e.message}`);
        }
        await this.finishRun(run, errors.length === 0, totals.events.c + totals.runners.c, totals.events.u + totals.runners.u, totals.events.c + totals.events.u, errors.slice(0, 3).join(' | ') || null);
        if (errors.length === 0)
            await this.markOk();
        else
            await this.markFail(errors[0]);
        return { ...totals, errors };
    }
    async upsertEvent(sport, ev, totals, bookmaker = 'bet365') {
        const internal = this.internalSport(ev.sport || sport);
        const ref = `ps:${ev.eventId}`;
        const home = ev.home ?? '?';
        const away = ev.away ?? '?';
        const name = `${home} v ${away}`;
        const start = ev.startTime ? new Date(ev.startTime) : new Date();
        // PulseScore league looks like "Country||League" — take the readable part.
        const competition = String(ev.league || '').split('||').pop() || null;
        // ensure the internal sport row exists
        await this.ds.query(`INSERT IGNORE INTO sport (id, name, enabled, sort_order) VALUES (?,?,1,50)`, [internal, internal.charAt(0).toUpperCase() + internal.slice(1)]).catch(() => { });
        const inplay = ev.live === true ? 1 : 0;
        const liveStatus = ev.live === true ? 'live' : (ev.live === false ? 'closed' : null);
        // Score, when the feed carries it (soccer/tennis/basketball; cricket usually not).
        const hs = ev.score && ev.score.home != null ? Number(ev.score.home) : null;
        const as = ev.score && ev.score.away != null ? Number(ev.score.away) : null;
        let [existing] = await this.ds.query(`SELECT id, status, inplay, live_status FROM sport_event WHERE provider_id = ? AND provider_ref = ?`, [this.PROVIDER_ID, ref]);
        // Different PulseScore bookmakers use different event IDs. Before creating
        // a second local event, merge an incoming source event into the existing
        // local event when home/away teams and sport match.
        if (!existing) {
            const [same] = await this.ds.query(`SELECT id, status, inplay, live_status
           FROM sport_event
          WHERE sport_id=?
            AND LOWER(TRIM(home))=LOWER(TRIM(?))
            AND LOWER(TRIM(away))=LOWER(TRIM(?))
            AND start_time BETWEEN DATE_SUB(?, INTERVAL 6 HOUR) AND DATE_ADD(?, INTERVAL 6 HOUR)
          ORDER BY ABS(TIMESTAMPDIFF(SECOND,start_time,?)) ASC
          LIMIT 1`, [internal, home, away, start, start, start]);
            existing = same || null;
        }
        let eventId;
        if (existing) {
            eventId = existing.id;
            // CRITICAL: the prematch feed can continue returning an event after its
            // live version has started (or can omit the live flag entirely). Never
            // downgrade an already-live local event back to prematch/closed.
            const alreadyLive = Number(existing.inplay) === 1 || String(existing.status).toLowerCase() === 'inplay' || String(existing.live_status).toLowerCase() === 'live';
            const effectiveLive = ev.live === true || alreadyLive;
            const effectiveInplay = effectiveLive ? 1 : 0;
            const effectiveStatus = effectiveLive ? 'inplay' : (String(existing.status).toLowerCase() === 'suspended' ? 'suspended' : 'open');
            const effectiveLiveStatus = effectiveLive ? 'live' : (ev.live === false ? 'closed' : null);
            await this.ds.query(`UPDATE sport_event SET competition=?, home=?, away=?, start_time=?, sport_key=?, sport_title=?,
           status=?, inplay=?, home_score=COALESCE(?,home_score), away_score=COALESCE(?,away_score),
           live_status=COALESCE(?,live_status),
           live_updated_at=CASE WHEN ?=1 THEN NOW() ELSE live_updated_at END,
           last_provider_update=CASE WHEN ?=1 THEN NOW() ELSE last_provider_update END
          WHERE id=? AND status<>'settled'`, [competition, home, away, start, sport, competition, effectiveStatus, effectiveInplay, hs, as, effectiveLiveStatus, effectiveLive ? 1 : 0, ev.live === true ? 1 : 0, eventId]);
            totals.events.u++;
        }
        else {
            eventId = (0, node_crypto_1.randomUUID)();
            const initialStatus = ev.live === true ? 'inplay' : 'open';
            await this.ds.query(`INSERT INTO sport_event (id, sport_id, provider_id, provider_ref, competition, name, home, away, start_time, sport_key, sport_title, status, inplay, home_score, away_score, live_status, live_updated_at, last_provider_update)
         VALUES (?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?, ?, CASE WHEN ?=1 THEN NOW() ELSE NULL END, CASE WHEN ?=1 THEN NOW() ELSE NULL END)`, [eventId, internal, this.PROVIDER_ID, ref, competition, name, home, away, start, sport, competition, initialStatus, inplay, hs, as, liveStatus, inplay, ev.live === true ? 1 : 0]);
            totals.events.c++;
        }
        // Match winner market only.
        const mw = (ev.markets ?? []).find((m) => this.isMatchOddsMarket(m) && (this.isFullTime(m) || internal === 'cricket'));
        if (mw)
            await this.upsertMatchWinner(eventId, home, away, mw, totals, bookmaker);
        // Fancy / session markets (cricket): "X Overs Line" over-runs sessions, each
        // with a Total Runs back/lay line. Only present on orbitxch for cricket.
        if (internal === 'cricket') {
            for (const m of (ev.markets ?? [])) {
                if (this.isFancyMarket(m))
                    await this.upsertFancy(eventId, m, totals, bookmaker);
            }
        }
        // If the event arrives already finished with a score, settle it.
        if (ev.score && (ev.live === false) && ev.score.home != null && ev.score.away != null) {
            await this.settleFromScore(eventId, home, away, Number(ev.score.home), Number(ev.score.away), totals).catch(() => { });
        }
    }
    /** A fancy/session market: the "X Overs Line" over-runs sessions. */
    isFancyMarket(m) {
        const raw = String(m?.rawName || '').toLowerCase();
        // e.g. "2nd innings 6 overs line", "1st innings 10 overs line"
        return /overs?\s*line/.test(raw) || /\d+\s*overs?\b/.test(raw) && raw.includes('line');
    }
    /**
     * Import one fancy/session market. Each "Overs Line" market has a single
     * "Total Runs" selection carrying the line (in odds) with back/lay ladders.
     * We store it as its own market (type 'fancy') with one runner so the player
     * UI can show a Fancy section with back/lay. Provider market id keeps it unique.
     */
    async upsertFancy(eventId, m, totals, bookmaker = 'orbitxch') {
        const label = String(m.rawName || 'Session').trim();
        const providerRef = `${bookmaker}:fancy:${m.marketId || label}`;
        const sel = (m.selections || [])[0];
        if (!sel)
            return;
        // market upsert
        const [ex] = await this.ds.query(`SELECT id, status FROM market WHERE event_id=? AND provider_ref=?`, [eventId, providerRef]);
        let marketId;
        const marketSuspended = m.isActive === false || sel.suspended === true || sel.isActive === false;
        if (ex) {
            marketId = ex.id;
            if (ex.status !== 'settled' && ex.status !== 'voided') {
                await this.ds.query(`UPDATE market SET name=?, status=?, last_update=NOW() WHERE id=?`, [label, marketSuspended ? 'suspended' : 'open', marketId]);
            }
        }
        else {
            marketId = (0, node_crypto_1.randomUUID)();
            await this.ds.query(`INSERT INTO market (id, event_id, provider_ref, bookmaker_key, type, name, status, last_update)
         VALUES (?,?,?, ?, 'fancy', ?, ?, NOW())`, [marketId, eventId, providerRef, bookmaker, label, marketSuspended ? 'suspended' : 'open']);
        }
        // one runner: the line (the number players bet over/under)
        const backs = this.ladder(sel, 'back');
        const lays = this.ladder(sel, 'lay');
        const oddsLine = sel.odds != null && sel.odds !== '' ? Number(sel.odds) : NaN;
        const line = Number.isFinite(oddsLine) ? oddsLine : (backs[0]?.price ?? null);
        const status = (sel.suspended === true || sel.isActive === false) ? 'suspended' : 'active';
        const vals = [
            backs[0]?.price ?? null, backs[0]?.size ?? null,
            backs[1]?.price ?? null, backs[1]?.size ?? null,
            backs[2]?.price ?? null, backs[2]?.size ?? null,
            lays[0]?.price ?? null, lays[0]?.size ?? null,
            lays[1]?.price ?? null, lays[1]?.size ?? null,
            lays[2]?.price ?? null, lays[2]?.size ?? null,
            status,
        ];
        const name = 'Total Runs';
        const [r] = await this.ds.query(`SELECT id FROM runner WHERE market_id=? AND name=?`, [marketId, name]);
        if (r) {
            await this.ds.query(`UPDATE runner SET line_value=?, back_price=?,back_size=?,back_price2=?,back_size2=?,back_price3=?,back_size3=?,lay_price=?,lay_size=?,lay_price2=?,lay_size2=?,lay_price3=?,lay_size3=?,status=?,updated_at=NOW() WHERE id=?`, [line, ...vals, r.id]);
            totals.runners.u++;
        }
        else {
            await this.ds.query(`INSERT INTO runner (id,market_id,name,line_value,back_price,back_size,back_price2,back_size2,back_price3,back_size3,lay_price,lay_size,lay_price2,lay_size2,lay_price3,lay_size3,status,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [(0, node_crypto_1.randomUUID)(), marketId, name, line, ...vals, 0]);
            totals.runners.c++;
        }
    }
    async upsertMarket(eventId, bookmaker = 'bet365') {
        const providerRef = `${bookmaker}:match_winner`;
        const [ex] = await this.ds.query(`SELECT id, status FROM market WHERE event_id=? AND provider_ref=?`, [eventId, providerRef]);
        if (ex) {
            if (ex.status !== 'settled' && ex.status !== 'voided') {
                await this.ds.query(`UPDATE market SET last_update=NOW(), status='open' WHERE id=?`, [ex.id]);
            }
            return ex.id;
        }
        const id = (0, node_crypto_1.randomUUID)();
        await this.ds.query(`INSERT INTO market (id, event_id, provider_ref, bookmaker_key, type, name, status, last_update)
       VALUES (?,?,?, ?, 'match_odds', 'Match Odds', 'open', NOW())`, [id, eventId, providerRef, bookmaker]);
        return id;
    }
    async upsertMatchWinner(eventId, home, away, mw, totals, bookmaker = 'bet365') {
        const marketId = await this.upsertMarket(eventId, bookmaker);
        // Market-level suspension: inactive market, or every selection suspended.
        const marketSuspended = mw.isActive === false
            || ((mw.selections || []).length > 0 && (mw.selections || []).every((s) => s.suspended === true || s.isActive === false));
        await this.ds.query(`UPDATE market SET status=?, last_update=NOW() WHERE id=?`, [marketSuspended ? 'suspended' : 'open', marketId]);
        for (const sel of mw.selections ?? []) {
            const co = String(sel.canonicalOutcome || '').toUpperCase();
            let name = sel.name || sel.rawName || '';
            let sort = 1;
            if (co === 'HOME') {
                name = home;
                sort = 0;
            }
            else if (co === 'AWAY') {
                name = away;
                sort = 1;
            }
            else if (co === 'DRAW') {
                name = 'Draw';
                sort = 2;
            }
            else if (/draw/i.test(name)) {
                sort = 2;
                name = 'Draw';
            }
            else if (name === home)
                sort = 0;
            else if (name === away)
                sort = 1;
            if (!name)
                continue;
            // Full back/lay ladders with liquidity (the real Orbit schema:
            // sel.back / sel.lay = [{price, liquidity} x3]). This is the fix — the REST
            // path now writes all six price levels + sizes, not just back_price.
            const backs = this.ladder(sel, 'back');
            const lays = this.ladder(sel, 'lay');
            const price = backs[0]?.price ?? (sel.odds != null ? Number(sel.odds) : (sel.decimal != null ? Number(sel.decimal) : null));
            const status = (sel.suspended === true || sel.isActive === false) ? 'suspended' : 'active';
            const vals = [
                price, backs[0]?.size ?? null,
                backs[1]?.price ?? null, backs[1]?.size ?? null,
                backs[2]?.price ?? null, backs[2]?.size ?? null,
                lays[0]?.price ?? null, lays[0]?.size ?? null,
                lays[1]?.price ?? null, lays[1]?.size ?? null,
                lays[2]?.price ?? null, lays[2]?.size ?? null,
                status,
            ];
            const [er] = await this.ds.query(`SELECT id, back_price,back_size,back_price2,back_size2,back_price3,back_size3,lay_price,lay_size,lay_price2,lay_size2,lay_price3,lay_size3 FROM runner WHERE market_id=? AND name=?`, [marketId, name]);
            if (er) {
                if (price != null && Number(er.back_price) !== Number(price)) {
                    await this.ds.query(`INSERT INTO odds_history (event_id, market_id, runner_id, outcome, old_price, new_price) VALUES (?,?,?,?,?,?)`, [eventId, marketId, er.id, name, er.back_price, price]).catch(() => { });
                }
                // Never erase a valid ladder when a provider sends a heartbeat/event
                // update without prices. Only replace a level when a new value exists.
                const priceFields = ['back_price', 'back_size', 'back_price2', 'back_size2', 'back_price3', 'back_size3', 'lay_price', 'lay_size', 'lay_price2', 'lay_size2', 'lay_price3', 'lay_size3'];
                const mergedPrices = vals.slice(0, 12).map((v, i) => v == null ? er[priceFields[i]] : v);
                const mergedStatus = vals[12] ?? 'active';
                await this.ds.query(`UPDATE runner SET back_price=?,back_size=?,back_price2=?,back_size2=?,back_price3=?,back_size3=?,lay_price=?,lay_size=?,lay_price2=?,lay_size2=?,lay_price3=?,lay_size3=?,status=?,sort_order=?,updated_at=NOW() WHERE id=?`, [...mergedPrices, mergedStatus, sort, er.id]);
                totals.runners.u++;
            }
            else {
                await this.ds.query(`INSERT INTO runner (id,market_id,name,back_price,back_size,back_price2,back_size2,back_price3,back_size3,lay_price,lay_size,lay_price2,lay_size2,lay_price3,lay_size3,status,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [(0, node_crypto_1.randomUUID)(), marketId, name, ...vals, sort]);
                totals.runners.c++;
            }
        }
    }
    /** Settle the match_odds market from a final score (via existing SportsService). */
    async settleFromScore(eventId, home, away, hs, as, totals) {
        const [ev] = await this.ds.query(`SELECT status FROM sport_event WHERE id=?`, [eventId]);
        if (!ev || ev.status === 'settled')
            return;
        let winnerName = null;
        if (hs > as)
            winnerName = home;
        else if (as > hs)
            winnerName = away;
        await this.ds.query(`UPDATE sport_event SET home_score=?, away_score=?, is_completed=1, result_home=?, result_away=?, settled_from_result=1 WHERE id=?`, [hs, as, hs, as, eventId]);
        const markets = await this.ds.query(`SELECT id FROM market WHERE event_id=? AND type='match_odds' AND status IN ('open','suspended','closed')`, [eventId]);
        for (const m of markets) {
            const runners = await this.ds.query(`SELECT id, name FROM runner WHERE market_id=?`, [m.id]);
            let winnerRunnerId = null;
            if (winnerName)
                winnerRunnerId = runners.find((x) => x.name === winnerName)?.id ?? null;
            else
                winnerRunnerId = runners.find((x) => /draw/i.test(x.name))?.id ?? null;
            if (!winnerRunnerId) {
                try {
                    await this.sports.voidMarket({ marketId: m.id, adminId: 'auto:pulsescore', reason: 'No matching result runner' });
                    totals.settled++;
                }
                catch { }
                continue;
            }
            try {
                await this.sports.settleMarket({ marketId: m.id, winnerRunnerId, adminId: 'auto:pulsescore' });
                totals.settled++;
            }
            catch (e) {
                if (!/already settled/i.test(e.message))
                    this.log.warn(`settle ${m.id}: ${e.message}`);
            }
        }
    }
    /**
     * Pull the live feeds from the providers that actually expose the cricket
     * fields we need:
     *   - OrbitXch: exchange Match Odds / Back / Lay
     *   - Melbet: live score + running/innings clock
     *   - Cloudbet/Stake/Betway: cricket-specific Fancy / Player / Wicket markets
     *
     * Provider event IDs are not assumed to be equal. Events are merged by
     * sport + home + away + nearby start time.
     */
    async syncLive() {
        if (this.liveSyncInProgress)
            return { skipped: true, reason: 'live-sync-in-progress' };
        this.liveSyncInProgress = true;
        try {
            const cfg = await this.config();
            if (cfg.enabled !== '1')
                return { skipped: true };
            const totals = {
                events: { c: 0, u: 0 },
                runners: { c: 0, u: 0 },
                settled: 0,
                sources: {},
            };
            // 1) OrbitXch live snapshot keeps the REST side of Match Odds healthy.
            try {
                await this.syncProviderLive(cfg, 'orbitxch', 'odds', totals);
                this.lastOrbitLiveSuccessAt = Date.now();
                // Give the fresh Orbit snapshot a chance to refresh timestamps before
                // expiring anything. Cleanup only uses the Orbit-owned timestamp.
                await this.expireStaleOrbitEvents();
            }
            catch (e) {
                totals.sources.orbitxch = e?.message ?? String(e);
            }
            // 2) Melbet is the dedicated live-score source.
            try {
                await this.syncProviderLive(cfg, this.SCORE_BOOKMAKER, 'score', totals);
            }
            catch (e) {
                totals.sources[this.SCORE_BOOKMAKER] = e?.message ?? String(e);
            }
            // 3) Import cricket-specific markets from sources that actually return them.
            for (const bookmaker of this.MARKET_BOOKMAKERS) {
                try {
                    await this.syncProviderLive(cfg, bookmaker, 'markets', totals);
                }
                catch (e) {
                    totals.sources[bookmaker] = e?.message ?? String(e);
                }
            }
            return totals;
        }
        finally {
            this.liveSyncInProgress = false;
        }
    }
    async syncProviderLive(cfg, bookmaker, mode, totals) {
        // PulseScore /live-events is paginated; max 30 events per page.
        // Fetch every page so Orbit cleanup never mistakes page-2+ live events
        // for disappeared events.
        const limit = 30;
        let page = 1;
        let totalPages = 1;
        let seen = 0;
        do {
            const data = await this.getBookmaker(cfg, bookmaker, `/live-events?sport=cricket&limit=${limit}&page=${page}`);
            const list = Array.isArray(data) ? data : (data?.events ?? data?.data ?? []);
            if (!Array.isArray(list) || list.length === 0)
                break;
            totalPages = Number(data?.totalPages ?? data?.pagination?.totalPages ?? 1);
            if (!Number.isFinite(totalPages) || totalPages < 1)
                totalPages = 1;
            totals.sources[bookmaker] = {
                events: Number(totals.sources[bookmaker]?.events ?? 0) + list.length,
                mode,
                page,
                totalPages,
            };
            for (const ev of list) {
                if (!ev?.eventId)
                    continue;
                seen++;
                if (mode === 'odds') {
                    ev.live = true;
                    await this.upsertEvent('cricket', ev, totals, bookmaker);
                    // Same Orbit snapshot may contain Fancy/Player/Wicket markets.
                    // Keep Match Odds ownership unchanged; classifier skips it.
                    await this.upsertCricketMarkets(ev, bookmaker, bookmaker, totals);
                    continue;
                }
                if (mode === 'score') {
                    await this.upsertScoreOnly(ev, totals);
                    continue;
                }
                if (mode === 'markets') {
                    await this.upsertCricketMarkets(ev, bookmaker, cfg.bookmaker || 'orbitxch', totals);
                }
            }
            page++;
            if (page > totalPages || page > 40)
                break;
        } while (page <= totalPages);
        if (!totals.sources[bookmaker]) {
            totals.sources[bookmaker] = { events: seen, mode, page: 0, totalPages: 0 };
        }
    }
    /**
     * OrbitXch is the sole owner of live event state. `last_provider_update` is
     * written only by Orbit REST/WS. If an event stops appearing in Orbit long
     * enough, close it; secondary score/market sources cannot keep it alive.
     * A 5-minute grace period prevents REST pagination gaps or brief REST/WS
     * reconnects from hiding a genuinely live match.
     */
    async expireStaleOrbitEvents() {
        const cfg = await this.config();
        if (cfg.enabled !== '1' || (cfg.bookmaker || '').toLowerCase() !== 'orbitxch')
            return;
        // Never mass-close the live book during an Orbit API outage. Cleanup is
        // allowed only after a successful live snapshot in the last 45 seconds.
        if (!this.lastOrbitLiveSuccessAt || Date.now() - this.lastOrbitLiveSuccessAt > 45_000)
            return;
        await this.ds.query(`
      UPDATE sport_event
         SET status='closed', inplay=0, live_status='closed', is_completed=CASE WHEN is_completed=1 THEN 1 ELSE 0 END, updated_at=NOW()
       WHERE provider_id=?
         AND sport_key='cricket'
         AND status='inplay'
         AND inplay=1
         AND is_completed=0
         AND last_provider_update IS NOT NULL
         AND last_provider_update < DATE_SUB(NOW(), INTERVAL 5 MINUTE)
    `, [this.PROVIDER_ID]);
    }
    async findLocalEvent(ev, sport = 'cricket') {
        const internal = this.internalSport(ev?.sport || sport);
        const home = String(ev?.home ?? '').trim();
        const away = String(ev?.away ?? '').trim();
        if (!home || !away)
            return null;
        const start = ev?.startTime ? new Date(ev.startTime) : new Date();
        const rows = await this.ds.query(`SELECT id, status, inplay, live_status, home, away, start_time
         FROM sport_event
        WHERE sport_id=?
          AND start_time BETWEEN DATE_SUB(?, INTERVAL 12 HOUR) AND DATE_ADD(?, INTERVAL 12 HOUR)
          AND status IN ('open','inplay','suspended')
        ORDER BY ABS(TIMESTAMPDIFF(SECOND,start_time,?)) ASC
        LIMIT 100`, [internal, start, start, start]);
        const norm = (v) => String(v ?? '')
            .toLowerCase()
            .replace(/\([^)]*\)/g, ' ')
            .replace(/\b(srl|women|woman|w|men|u19|u20|u23|xi)\b/g, ' ')
            .replace(/[^a-z0-9]+/g, '')
            .trim();
        const h = norm(home), a = norm(away);
        const exact = rows.find((r) => norm(r.home) === h && norm(r.away) === a);
        if (exact)
            return exact;
        const reverse = rows.find((r) => norm(r.home) === a && norm(r.away) === h);
        return reverse || null;
    }
    /**
     * Secondary sources are enrichment-only. They are NEVER allowed to create a
     * sport_event row. Creating a shell here was the duplicate/live-count bug:
     * Melbet/Cloudbet/Stake/Betway can have a different provider event ID or team
     * spelling, so a missing match must simply be skipped until OrbitXch creates
     * the canonical local event.
     */
    async findExistingLiveEvent(ev) {
        const local = await this.findLocalEvent(ev, 'cricket');
        if (!local)
            return null;
        const status = String(local.status || '').toLowerCase();
        if (status === 'settled' || Number(local.inplay) !== 1 && status !== 'inplay' && status !== 'suspended') {
            return null;
        }
        return local.id;
    }
    async upsertScoreOnly(ev, totals) {
        const id = await this.findExistingLiveEvent(ev);
        if (!id)
            return;
        const score = this.parseScore(ev.score);
        const clock = this.liveClock(ev);
        const periodScores = ev.periodScores != null ? JSON.stringify(ev.periodScores) : null;
        // Melbet's score is a colon-style team score and its matchClock contains
        // the current innings/period. Preserve all event-state ownership locally.
        await this.ds.query(`UPDATE sport_event SET
         home_score=COALESCE(?,home_score),
         away_score=COALESCE(?,away_score),
         live_score=COALESCE(?,live_score),
         match_clock=COALESCE(?,match_clock),
         period_scores=COALESCE(?,period_scores),
         live_status='live',
         live_updated_at=NOW()
       WHERE id=? AND status<>'settled'`, [score.home, score.away, score.text, clock, periodScores, id]);
        totals.events.u++;
    }
    classifyCricketMarket(m) {
        const canonical = String(m?.canonicalMarket || m?.marketType || '').toUpperCase();
        const raw = String(m?.rawName || m?.name || '').trim();
        const type = String(m?.type || '').toUpperCase();
        const text = `${canonical} ${raw} ${type}`.toUpperCase();
        // Match Odds / winner markets are NEVER Fancy, even when a provider
        // incorrectly labels them as OTHER/FANCY.
        if (text.includes('MATCH_RESULT') ||
            text.includes('MATCH WINNER') ||
            text.includes('MATCH ODDS') ||
            text.includes('WINNER (INCL') ||
            text === 'WINNER' ||
            text.includes('CRICKET.WINNER'))
            return null;
        // Wicket / dismissal markets.
        if (text.includes('WICKET') ||
            text.includes('DISMISSAL') ||
            text.includes('DISMISSED') ||
            text.includes('TO BE DISMISSED') ||
            text.includes('FALL OF') ||
            text.includes('FALL_OF'))
            return 'wicket';
        // Player-specific markets.
        if (text.includes('PLAYER') ||
            text.includes('BATTER') ||
            text.includes('BOWLER') ||
            text.includes('TOP RUN') ||
            text.includes('TOP BAT') ||
            text.includes('TOP BOWL') ||
            text.includes('PLAYER_TOTAL') ||
            text.includes('PLAYER_TO_SCORE') ||
            text.includes('PLAYER_TO_SCORE_MILESTONE') ||
            text.includes('PLAYER TOTAL') ||
            text.includes('TOTAL RUNS - 20 OVERS')) {
            // Betway uses names such as "Rikki Bell Total Runs - 20 Overs".
            // Keep those as Player rather than Fancy.
            if (text.includes('PLAYER') ||
                raw.toUpperCase().match(/^[A-Z][A-Z .'-]+\s+TOTAL RUNS\s*-\s*\d+\s+OVERS/) ||
                text.includes('DISMISSAL METHOD'))
                return 'player';
        }
        // Provider-specific FANCY type is authoritative.
        if (type === 'FANCY' || text.includes('FANCY'))
            return 'fancy';
        // PulseScore/Betway frequently sends cricket betting markets as OTHER.
        // Classify by the actual market name, not by canonicalMarket alone.
        const fancyPatterns = [
            /\bRUNS?\b/,
            /\bTOTAL\s+RUNS?\b/,
            /\bOVER\s+RUNS?\b/,
            /\bOVER\s+TOTAL\b/,
            /\bDELIVERY\b.*\bRUNS?\b/,
            /\bRUN\s+RANGE\b/,
            /\bODD[\/ ]EVEN\b/,
            /\bTEAM\s+TOTAL\b/,
            /\bINNINGS\s+RUNS?\b/,
            /\bINNINGS\s+TEAM\s+TOTAL\b/,
            /\bOVER[_ ]TEAM[_ ]TOTAL\b/,
            /\bFALL\s+OF\s+\d+(?:ST|ND|RD|TH)?\s+WICKET\b/
        ];
        if (fancyPatterns.some((re) => re.test(text)))
            return 'fancy';
        return null;
    }
    async upsertCricketMarkets(ev, sourceBookmaker, displayBookmaker, totals) {
        const eventId = await this.findExistingLiveEvent(ev);
        if (!eventId)
            return;
        for (const m of (ev.markets || [])) {
            // Never import another provider's Match Odds over OrbitXch.
            const kind = this.classifyCricketMarket(m);
            if (!kind)
                continue;
            const providerMarketId = String(m.marketId ?? m.id ?? `${m.canonicalMarket}:${m.rawName}`);
            const providerRef = `${sourceBookmaker}:${providerMarketId}`;
            const marketName = String(m.rawName || m.name || m.canonicalMarket || kind);
            const marketStatus = m.isActive === false ? 'suspended' : 'open';
            let [market] = await this.ds.query(`SELECT id,status FROM market WHERE event_id=? AND provider_ref=?`, [eventId, providerRef]);
            if (!market) {
                const marketId = (0, node_crypto_1.randomUUID)();
                await this.ds.query(`INSERT INTO market
           (id,event_id,provider_ref,bookmaker_key,type,name,status,last_update,inplay_allowed)
           VALUES (?,?,?,?,?,?,?,NOW(),1)`, [marketId, eventId, providerRef, displayBookmaker, kind, marketName, marketStatus]);
                market = { id: marketId, status: marketStatus };
            }
            else {
                await this.ds.query(`UPDATE market SET type=?,name=?,status=?,last_update=NOW(),inplay_allowed=1 WHERE id=?`, [kind, marketName, marketStatus, market.id]);
            }
            for (let i = 0; i < (m.selections || []).length; i++) {
                const sel = m.selections[i];
                const name = String(sel?.name ??
                    sel?.rawName ??
                    sel?.canonicalOutcome ??
                    `Selection ${i + 1}`).trim();
                if (!name)
                    continue;
                const backs = this.ladder(sel, 'back');
                const lays = this.ladder(sel, 'lay');
                const price = backs[0]?.price ??
                    (sel?.odds != null && Number(sel.odds) > 0 ? Number(sel.odds) : null);
                const status = (sel?.suspended === true || sel?.isActive === false) ? 'suspended' : 'active';
                const lineValue = this.extractLineValue(m, sel);
                // Fancy uses a line plus YES/NO rates. PulseScore may expose the rate
                // directly or inside the back/lay ladder, so normalize both forms.
                const backRate = kind === 'fancy' ? this.extractRate(sel, 'back', backs[0]?.price) : null;
                const layRate = kind === 'fancy' ? this.extractRate(sel, 'lay', lays[0]?.price) : null;
                const [runner] = await this.ds.query(`SELECT id FROM runner WHERE market_id=? AND name=?`, [market.id, name]);
                const values = [
                    price, backs[0]?.size ?? null,
                    backs[1]?.price ?? null, backs[1]?.size ?? null,
                    backs[2]?.price ?? null, backs[2]?.size ?? null,
                    lays[0]?.price ?? null, lays[0]?.size ?? null,
                    lays[1]?.price ?? null, lays[1]?.size ?? null,
                    lays[2]?.price ?? null, lays[2]?.size ?? null,
                    lineValue, backRate, layRate, status, i,
                ];
                if (runner) {
                    await this.ds.query(`UPDATE runner SET
               back_price=?,back_size=?,back_price2=?,back_size2=?,back_price3=?,back_size3=?,
               lay_price=?,lay_size=?,lay_price2=?,lay_size2=?,lay_price3=?,lay_size3=?,
               line_value=?,back_rate=?,lay_rate=?,status=?,sort_order=?,updated_at=NOW()
             WHERE id=?`, [...values, runner.id]);
                    totals.runners.u++;
                }
                else {
                    await this.ds.query(`INSERT INTO runner
             (id,market_id,name,back_price,back_size,back_price2,back_size2,back_price3,back_size3,
              lay_price,lay_size,lay_price2,lay_size2,lay_price3,lay_size3,line_value,back_rate,lay_rate,status,sort_order)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [(0, node_crypto_1.randomUUID)(), market.id, name, ...values]);
                    totals.runners.c++;
                }
            }
        }
    }
    extractRate(sel, side, fallback) {
        const direct = side === 'back'
            ? (sel?.backRate ?? sel?.yesRate ?? sel?.yes_rate ?? sel?.back_rate ?? sel?.rate)
            : (sel?.layRate ?? sel?.noRate ?? sel?.no_rate ?? sel?.lay_rate ?? sel?.rate);
        const n = Number(direct);
        if (Number.isFinite(n) && n > 0)
            return n;
        return fallback != null && Number.isFinite(Number(fallback)) ? Number(fallback) : null;
    }
    extractLineValue(m, sel) {
        const direct = sel?.line ?? sel?.lineValue ?? sel?.line_value ?? m?.line ?? m?.lineValue;
        if (direct !== null && direct !== undefined && direct !== '') {
            const n = Number(direct);
            if (Number.isFinite(n))
                return n;
        }
        const text = `${m?.rawName || ''} ${sel?.rawName || ''}`;
        const matches = text.match(/(?:^|[^0-9])(\d+(?:\.\d+)?)(?:[^0-9]|$)/g);
        if (!matches?.length)
            return null;
        const nums = matches.map((x) => Number(x.replace(/[^0-9.]/g, ''))).filter(Number.isFinite);
        return nums.length ? nums[nums.length - 1] : null;
    }
    async test() {
        const cfg = await this.config();
        const data = await this.get(cfg, `/live-events/sports`);
        return { ok: true, bookmaker: cfg.bookmaker || 'bet365', liveSports: Array.isArray(data) ? data : (data.sports ?? []), total: Number(data?.total ?? (Array.isArray(data) ? data.length : 0)) };
    }
};
exports.PulseScoreAdapter = PulseScoreAdapter;
exports.PulseScoreAdapter = PulseScoreAdapter = PulseScoreAdapter_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [typeorm_1.DataSource, sports_service_1.SportsService])
], PulseScoreAdapter);
