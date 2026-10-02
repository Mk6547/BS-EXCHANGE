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
var TheOddsApiAdapter_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.TheOddsApiAdapter = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("typeorm");
const node_crypto_1 = require("node:crypto");
/**
 * Dedicated adapter for The Odds API v4 (https://api.the-odds-api.com/v4).
 *
 * Unlike the generic field-mapper, this understands the real nested shape:
 *   events[] -> bookmakers[] -> markets[] -> outcomes[]
 * and the separate /sports and /scores endpoints. It upserts by the provider's
 * own IDs so nothing is ever duplicated, records odds history, tracks quota from
 * the response headers, and writes a sync_run row per job.
 *
 * The API key lives on the provider row (server-side only) and is sent as the
 * apiKey query param, exactly as the API expects. It is never returned to the
 * browser.
 */
let TheOddsApiAdapter = TheOddsApiAdapter_1 = class TheOddsApiAdapter {
    ds;
    log = new common_1.Logger(TheOddsApiAdapter_1.name);
    base = 'https://api.the-odds-api.com/v4';
    constructor(ds) {
        this.ds = ds;
    }
    async provider(providerId) {
        const [p] = await this.ds.query(`SELECT * FROM odds_provider WHERE id = ?`, [providerId]);
        if (!p)
            throw new Error('Provider not found.');
        return p;
    }
    key(provider) {
        // The adapter stores the key in auth_value regardless of auth_type.
        const k = provider.auth_value ?? '';
        if (!k)
            throw new Error('No API key set for this provider.');
        return k;
    }
    /** GET with apiKey param; captures quota headers; never throws away good data. */
    async get(provider, path, params = {}) {
        const qs = new URLSearchParams({ apiKey: this.key(provider), ...params }).toString();
        const url = `${this.base}/${path.replace(/^\//, '')}${path.includes('?') ? '&' : '?'}${qs}`;
        const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
        // Quota headers, saved for the admin panel.
        const remaining = res.headers.get('x-requests-remaining');
        const used = res.headers.get('x-requests-used');
        if (remaining !== null || used !== null) {
            await this.ds.query(`UPDATE odds_provider SET quota_remaining = ?, quota_used = ? WHERE id = ?`, [remaining ? Number(remaining) : null, used ? Number(used) : null, provider.id]).catch(() => { });
        }
        const text = await res.text();
        if (!res.ok) {
            const err = new Error(`The Odds API ${res.status}: ${text.slice(0, 180)}`);
            err.status = res.status;
            throw err;
        }
        try {
            return { data: JSON.parse(text), status: res.status };
        }
        catch {
            throw new Error('The Odds API did not return JSON.');
        }
    }
    // --------------------------------------------------------------- sports
    /** JOB 1 — discover sports from /v4/sports and upsert the catalog. */
    async syncSports(providerId) {
        const run = await this.startRun(providerId, 'sports');
        try {
            const provider = await this.provider(providerId);
            const { data, status } = await this.get(provider, 'sports', { all: 'true' });
            let created = 0, updated = 0;
            for (const s of Array.isArray(data) ? data : []) {
                const internal = this.internalSport(s.key, s.group);
                // New sports arrive disabled so 75 sports don't all get polled at once
                // (each enabled sport costs one /odds call per sync). Admin enables the
                // ones they want. Re-discovery never flips an admin's choice.
                const autoEnable = String(s.key ?? '').toLowerCase().startsWith('cricket_') ? 1 : 0;
                const res = await this.ds.query(`INSERT INTO sport_catalog (sport_key, title, sport_group, description, active, has_outrights, internal_sport, enabled)
           VALUES (?,?,?,?,?,?,?,?)
           ON DUPLICATE KEY UPDATE title=VALUES(title), sport_group=VALUES(sport_group),
             description=VALUES(description), active=VALUES(active), has_outrights=VALUES(has_outrights),
             internal_sport=COALESCE(internal_sport, VALUES(internal_sport)),
             enabled=CASE WHEN sport_key LIKE 'cricket_%' THEN 1 ELSE enabled END`, [s.key, s.title ?? s.key, s.group ?? null, s.description ?? null,
                    s.active ? 1 : 0, s.has_outrights ? 1 : 0, internal, autoEnable]);
                if (res.affectedRows === 1)
                    created++;
                else
                    updated++;
                // Make sure the internal sport row exists so events can attach.
                if (internal) {
                    await this.ds.query(`INSERT IGNORE INTO sport (id, name, enabled, sort_order) VALUES (?,?,1,50)`, [internal, this.titleCase(internal)]).catch(() => { });
                }
            }
            await this.finishRun(run, true, created, updated, (Array.isArray(data) ? data.length : 0), status, null);
            return { created, updated, total: Array.isArray(data) ? data.length : 0 };
        }
        catch (e) {
            await this.finishRun(run, false, 0, 0, 0, e.status ?? null, e.message);
            await this.markFail(providerId, e.message);
            throw e;
        }
    }
    /** The sports the admin has enabled AND the API currently lists as active. */
    async activeSportKeys(providerId) {
        const provider = await this.provider(providerId);
        // If the admin pinned specific sport keys in bookmakers_csv-style config, honour it;
        // otherwise use every enabled+active catalog sport.
        // Skip outright/futures sports (e.g. *_championship_winner): they have no
        // h2h match markets and 422 on the odds endpoint.
        const rows = await this.ds.query(`SELECT sport_key FROM sport_catalog
        WHERE has_outrights = 0
          AND sport_key NOT LIKE '%_winner' AND sport_key NOT LIKE '%outright%'
          AND enabled = 1
          AND (active = 1 OR sport_key LIKE 'cricket_%')`);
        return rows.map((r) => r.sport_key);
    }
    // --------------------------------------------------------------- events + odds
    /**
     * JOB 2+3 — for each enabled sport, fetch /odds (events with nested
     * bookmakers/markets/outcomes) and upsert everything. One call per sport.
     */
    async syncEventsAndOdds(providerId) {
        const run = await this.startRun(providerId, 'odds');
        const provider = await this.provider(providerId);
        const regions = provider.regions || 'uk';
        const markets = provider.markets_csv || 'h2h';
        const totals = { events: { c: 0, u: 0 }, markets: { c: 0, u: 0 }, outcomes: { c: 0, u: 0 }, books: { c: 0, u: 0 } };
        const errors = [];
        let sports;
        try {
            sports = await this.activeSportKeys(providerId);
        }
        catch (e) {
            await this.finishRun(run, false, 0, 0, 0, null, e.message);
            throw e;
        }
        for (const sportKey of sports) {
            try {
                const params = { regions, markets, oddsFormat: 'decimal' };
                if (provider.bookmakers_csv)
                    params.bookmakers = provider.bookmakers_csv;
                const { data } = await this.get(provider, `sports/${sportKey}/odds`, params);
                for (const ev of Array.isArray(data) ? data : []) {
                    await this.upsertEvent(provider.id, ev, totals);
                }
            }
            catch (e) {
                // One sport failing must not wipe others or throw away good data.
                errors.push(`${sportKey}: ${e.message}`);
                if (e.status === 429)
                    break; // quota hit — stop early, keep what we have
            }
        }
        const created = totals.events.c + totals.markets.c + totals.outcomes.c;
        const updated = totals.events.u + totals.markets.u + totals.outcomes.u;
        await this.finishRun(run, errors.length === 0, created, updated, totals.events.c + totals.events.u, null, errors.slice(0, 3).join(' | ') || null);
        if (errors.length === 0)
            await this.markOk(providerId);
        return { ...totals, errors };
    }
    async upsertEvent(providerId, ev, totals) {
        const internal = this.internalSport(ev.sport_key, null) ?? 'other';
        const name = `${ev.home_team ?? '?'} v ${ev.away_team ?? '?'}`;
        const start = ev.commence_time ? new Date(ev.commence_time) : new Date();
        const [existing] = await this.ds.query(`SELECT id FROM sport_event WHERE provider_id = ? AND provider_ref = ?`, [providerId, ev.id]);
        let eventId;
        if (existing) {
            eventId = existing.id;
            // Never reopen a settled event; just refresh provider fields.
            await this.ds.query(`UPDATE sport_event SET competition=?, home=?, away=?, start_time=?, sport_key=?, sport_title=?,
           last_provider_update=NOW()
         WHERE id = ? AND status <> 'settled'`, [ev.sport_title ?? null, ev.home_team ?? null, ev.away_team ?? null, start,
                ev.sport_key ?? null, ev.sport_title ?? null, eventId]);
            totals.events.u++;
        }
        else {
            eventId = (0, node_crypto_1.randomUUID)();
            await this.ds.query(`INSERT INTO sport_event (id, sport_id, provider_id, provider_ref, competition, name, home, away,
           start_time, sport_key, sport_title, status, last_provider_update)
         VALUES (?,?,?,?,?,?,?,?,?,?,?, 'open', NOW())`, [eventId, internal, providerId, ev.id, ev.sport_title ?? null, name,
                ev.home_team ?? null, ev.away_team ?? null, start, ev.sport_key ?? null, ev.sport_title ?? null]);
            totals.events.c++;
        }
        // bookmakers -> markets -> outcomes. Each bookmaker's markets are stored
        // separately (provider_ref = bookmakerKey:marketKey), so the player site can
        // show multiple bookmakers' prices side by side. Disabled bookmakers are
        // still imported but hidden at display time.
        for (const bk of ev.bookmakers ?? []) {
            await this.upsertBookmaker(bk, totals);
            for (const mk of bk.markets ?? []) {
                await this.upsertMarket(eventId, bk.key, mk, ev, totals);
            }
        }
    }
    async upsertBookmaker(bk, totals) {
        const res = await this.ds.query(`INSERT INTO bookmaker (key_name, title, last_update) VALUES (?,?,?)
       ON DUPLICATE KEY UPDATE title=VALUES(title), last_update=VALUES(last_update)`, [bk.key, bk.title ?? bk.key, bk.last_update ? new Date(bk.last_update) : null]).catch(() => null);
        if (res && res.affectedRows === 1)
            totals.books.c++;
        else
            totals.books.u++;
    }
    async upsertMarket(eventId, bookmakerKey, mk, ev, totals) {
        const providerRef = `${bookmakerKey}:${mk.key}`;
        const internalType = mk.key === 'h2h_lay' ? 'match_odds' : mk.key === 'h2h' ? 'match_odds' : mk.key;
        const name = this.marketName(mk.key);
        const [existing] = await this.ds.query(`SELECT id, status FROM market WHERE event_id = ? AND provider_ref = ?`, [eventId, providerRef]);
        let marketId;
        if (existing) {
            marketId = existing.id;
            if (existing.status !== 'settled' && existing.status !== 'voided') {
                await this.ds.query(`UPDATE market SET last_update=?, bookmaker_key=? WHERE id = ?`, [mk.last_update ? new Date(mk.last_update) : null, bookmakerKey, marketId]);
            }
            totals.markets.u++;
        }
        else {
            marketId = (0, node_crypto_1.randomUUID)();
            await this.ds.query(`INSERT INTO market (id, event_id, provider_ref, bookmaker_key, type, name, status, last_update)
         VALUES (?,?,?,?,?,?, 'open', ?)`, [marketId, eventId, providerRef, bookmakerKey, internalType, name,
                mk.last_update ? new Date(mk.last_update) : null]);
            totals.markets.c++;
        }
        for (const oc of mk.outcomes ?? []) {
            await this.upsertOutcome(eventId, marketId, oc, totals, ev);
        }
    }
    /** Upsert a runner/outcome and record any price change in odds_history. */
    async upsertOutcome(eventId, marketId, oc, totals, ev) {
        // Order outcomes so the list maps to 1 / X / 2: home=0, away=1, draw=2.
        const nm = String(oc.name ?? '');
        let sort = 1;
        if (ev && nm === ev.home_team)
            sort = 0;
        else if (ev && nm === ev.away_team)
            sort = 1;
        else if (/draw/i.test(nm))
            sort = 2;
        const [existing] = await this.ds.query(`SELECT id, back_price FROM runner WHERE market_id = ? AND name = ?`, [marketId, oc.name]);
        const price = oc.price != null ? Number(oc.price) : null;
        if (existing) {
            const old = existing.back_price != null ? Number(existing.back_price) : null;
            if (price != null && old !== price) {
                await this.ds.query(`INSERT INTO odds_history (event_id, market_id, runner_id, outcome, old_price, new_price)
           VALUES (?,?,?,?,?,?)`, [eventId, marketId, existing.id, oc.name, old, price]);
                await this.ds.query(`UPDATE runner SET back_price = ?, sort_order = ? WHERE id = ?`, [price, sort, existing.id]);
            }
            totals.outcomes.u++;
        }
        else {
            const id = (0, node_crypto_1.randomUUID)();
            await this.ds.query(`INSERT INTO runner (id, market_id, name, back_price, lay_price, sort_order) VALUES (?,?,?,?,?,?)`, [id, marketId, oc.name, price, null, sort]);
            if (price != null) {
                await this.ds.query(`INSERT INTO odds_history (event_id, market_id, runner_id, outcome, old_price, new_price)
           VALUES (?,?,?,?,?,?)`, [eventId, marketId, id, oc.name, null, price]);
            }
            totals.outcomes.c++;
        }
    }
    // --------------------------------------------------------------- helpers
    internalSport(sportKey, group) {
        if (!sportKey && !group)
            return null;
        const k = (sportKey ?? '').toLowerCase();
        const g = (group ?? '').toLowerCase();
        if (k.startsWith('cricket') || g === 'cricket')
            return 'cricket';
        if (k.startsWith('soccer') || g === 'soccer')
            return 'soccer';
        if (k.startsWith('tennis') || g === 'tennis')
            return 'tennis';
        if (k.startsWith('basketball') || g.includes('basketball'))
            return 'basketball';
        if (k.includes('americanfootball') || g.includes('american football'))
            return 'nfl';
        if (k.startsWith('baseball'))
            return 'baseball';
        if (k.startsWith('icehockey'))
            return 'hockey';
        if (k.startsWith('mma') || k.startsWith('boxing'))
            return 'combat';
        return 'other';
    }
    marketName(key) {
        const map = {
            h2h: 'Match Odds', h2h_lay: 'Match Odds (Lay)', spreads: 'Handicap',
            totals: 'Over/Under', outrights: 'Outright',
        };
        return map[key] ?? key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    }
    titleCase(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
    // --------------------------------------------------------------- run log
    async startRun(providerId, job) {
        const res = await this.ds.query(`INSERT INTO sync_run (provider_id, job, started_at) VALUES (?,?, NOW())`, [providerId, job]);
        return res.insertId;
    }
    async finishRun(id, ok, created, updated, processed, httpStatus, message) {
        await this.ds.query(`UPDATE sync_run SET finished_at=NOW(), ok=?, created=?, updated=?, processed=?, http_status=?, message=? WHERE id=?`, [ok ? 1 : 0, created, updated, processed, httpStatus, message ? message.slice(0, 250) : null, id]).catch(() => { });
    }
    async markOk(providerId) {
        await this.ds.query(`UPDATE odds_provider SET last_ok_at=NOW(), last_error=NULL WHERE id=?`, [providerId]).catch(() => { });
    }
    async markFail(providerId, msg) {
        await this.ds.query(`UPDATE odds_provider SET last_fail_at=NOW(), last_error=? WHERE id=?`, [msg.slice(0, 250), providerId]).catch(() => { });
    }
    /**
     * JOB 6 — reconciliation. Compares DB state to what's sane and repairs safely,
     * never deleting bets or settled markets:
     *  - events long past start with no recent provider update -> mark suspended
     *  - markets with no update in a while -> suspended (not deleted)
     *  - completed events still 'open' -> flag for the results job
     * Returns a summary for the admin.
     */
    async reconcile(providerId) {
        const run = await this.startRun(providerId, 'reconcile');
        try {
            // Events that started over 6h ago, not settled, not updated in 2h: suspend.
            const staleEvents = await this.ds.query(`UPDATE sport_event
            SET status='suspended'
          WHERE provider_id = ? AND status='open'
            AND start_time < DATE_SUB(NOW(), INTERVAL 6 HOUR)
            AND (last_provider_update IS NULL OR last_provider_update < DATE_SUB(NOW(), INTERVAL 2 HOUR))`, [providerId]);
            // Suspend a market only when its event has already started AND its odds
            // have gone stale (>2h). Upcoming matches keep their prices even if the
            // feed pauses, so betting stays open on them until kick-off. This stops
            // markets closing during testing when the cron isn't running.
            const staleMarkets = await this.ds.query(`UPDATE market m JOIN sport_event e ON e.id = m.event_id
            SET m.status='suspended'
          WHERE e.provider_id = ? AND m.status='open'
            AND e.start_time < NOW()
            AND (m.last_update IS NULL OR m.last_update < DATE_SUB(NOW(), INTERVAL 2 HOUR))`, [providerId]);
            // Completed events still open: count them so the admin knows results are due.
            const [pending] = await this.ds.query(`SELECT COUNT(*) AS n FROM sport_event WHERE provider_id = ? AND is_completed = 1 AND status <> 'settled'`, [providerId]);
            const summary = {
                eventsSuspended: staleEvents.affectedRows ?? 0,
                marketsSuspended: staleMarkets.affectedRows ?? 0,
                completedAwaitingSettlement: Number(pending?.n ?? 0),
            };
            await this.finishRun(run, true, 0, summary.eventsSuspended + summary.marketsSuspended, 0, null, JSON.stringify(summary));
            return summary;
        }
        catch (e) {
            await this.finishRun(run, false, 0, 0, 0, null, e.message);
            throw e;
        }
    }
    /** Health snapshot for the admin panel. */
    async health(providerId) {
        const [p] = await this.ds.query(`SELECT quota_remaining, quota_used, last_ok_at, last_fail_at, last_error FROM odds_provider WHERE id = ?`, [providerId]);
        const [ev] = await this.ds.query(`SELECT
         COUNT(*) AS total,
         SUM(status='open') AS open,
         SUM(inplay=1) AS live,
         SUM(is_completed=1 AND status<>'settled') AS awaiting,
         SUM(status='settled') AS settled
       FROM sport_event WHERE provider_id = ?`, [providerId]);
        const [bk] = await this.ds.query(`SELECT COUNT(*) AS n FROM bookmaker`);
        const [mk] = await this.ds.query(`SELECT COUNT(*) AS n FROM market m JOIN sport_event e ON e.id=m.event_id WHERE e.provider_id=?`, [providerId]);
        const runs = await this.ds.query(`SELECT job, ok, created, updated, message, started_at, finished_at
         FROM sync_run WHERE provider_id=? ORDER BY id DESC LIMIT 8`, [providerId]);
        return {
            quotaRemaining: p?.quota_remaining ?? null,
            quotaUsed: p?.quota_used ?? null,
            lastOkAt: p?.last_ok_at ?? null,
            lastFailAt: p?.last_fail_at ?? null,
            lastError: p?.last_error ?? null,
            events: {
                total: Number(ev?.total ?? 0), open: Number(ev?.open ?? 0), live: Number(ev?.live ?? 0),
                awaitingSettlement: Number(ev?.awaiting ?? 0), settled: Number(ev?.settled ?? 0),
            },
            bookmakers: Number(bk?.n ?? 0),
            markets: Number(mk?.n ?? 0),
            recentRuns: runs,
        };
    }
    /** Test connection: hit /sports, return a small sample + quota. */
    async test(providerId) {
        const provider = await this.provider(providerId);
        const { data } = await this.get(provider, 'sports', { all: 'true' });
        const [fresh] = await this.ds.query(`SELECT quota_remaining, quota_used FROM odds_provider WHERE id=?`, [providerId]);
        return {
            ok: true,
            sportsAvailable: Array.isArray(data) ? data.length : 0,
            sample: Array.isArray(data) ? data.slice(0, 5).map((s) => ({ key: s.key, title: s.title, group: s.group, active: s.active })) : [],
            quotaRemaining: fresh?.quota_remaining ?? null,
            quotaUsed: fresh?.quota_used ?? null,
        };
    }
};
exports.TheOddsApiAdapter = TheOddsApiAdapter;
exports.TheOddsApiAdapter = TheOddsApiAdapter = TheOddsApiAdapter_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [typeorm_1.DataSource])
], TheOddsApiAdapter);
