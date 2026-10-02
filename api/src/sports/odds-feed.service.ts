import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';

/**
 * Odds feed integration — nothing here touches InOut; sports and casino are
 * separate systems that only share the wallet.
 *
 * Providers differ in every detail, and you have not bought one yet, so the
 * mapping is data rather than code: the admin stores the URL, the key and a
 * JSON description of where each field sits in the provider's response. Adding
 * a new provider is then a form to fill in, not a deploy.
 *
 * config JSON shape (all paths are dotted, [0] works for array positions):
 * {
 *   "eventsRoot":  "data",
 *   "event":   { "ref":"id", "name":"name", "sport":"sport_key", "competition":"league",
 *                "home":"home_team", "away":"away_team", "start":"commence_time", "inplay":"live" },
 *   "sportMap": { "soccer_epl":"soccer", "cricket_t20":"cricket" },
 *   "marketsRoot": "markets",
 *   "market":  { "ref":"key", "name":"name", "type":"match_odds" },
 *   "runnersRoot": "outcomes",
 *   "runner":  { "ref":"id", "name":"name", "back":"price", "backSize":"size",
 *                "lay":"layPrice", "laySize":"laySize", "line":"point" }
 * }
 * A "type" value that is not a path is used literally, so "match_odds" stays
 * "match_odds" for feeds that do not label their markets.
 *
 * Some feeds (Highlightly, for one) keep prices in a second endpoint keyed by
 * match id. Set the provider's odds path and add an "odds" block; the sync then
 * fetches both and joins them:
 *   "odds": { "root": "data", "matchRef": "matchId" }
 * With a join, marketsRoot and runnersRoot are read from the odds entry.
 *
 * Optional filters, useful when a feed returns every market from every
 * bookmaker: "bookmakerName": "22Bet" and "marketInclude": ["Match Winner"].
 * "homeAwayLabels": true swaps selection values Home/Away/Draw for the real
 * team names.
 */
@Injectable()
export class OddsFeedService implements OnModuleInit {
  private readonly log = new Logger(OddsFeedService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = new Set<string>();

  constructor(private readonly ds: DataSource) {}

  onModuleInit() {
    // Passenger may idle the process out on shared hosting, so this loop is a
    // convenience, not a guarantee. The cron endpoint is the reliable path.
    this.timer = setInterval(() => this.tick().catch(() => {}), 15_000);
    this.timer.unref?.();
  }

  private async tick() {
    const due = await this.ds.query(
      `SELECT id FROM odds_provider
        WHERE enabled = 1 AND kind <> 'manual'
          AND (last_sync_at IS NULL OR last_sync_at < DATE_SUB(NOW(), INTERVAL poll_seconds SECOND))`,
    );
    for (const p of due) await this.sync(p.id).catch((e) => this.log.warn(`sync ${p.id}: ${e.message}`));
  }

  /** Pull once from one provider and write what came back into our tables. */
  async sync(providerId: string) {
    if (this.running.has(providerId)) return { skipped: 'already running' };
    this.running.add(providerId);
    const started = Date.now();
    let events = 0, markets = 0, runners = 0;

    try {
      const [provider] = await this.ds.query(`SELECT * FROM odds_provider WHERE id = ?`, [providerId]);
      if (!provider) throw new Error('No such provider.');
      if (provider.kind === 'manual') throw new Error('This provider is manual — there is nothing to fetch.');
      if (!provider.base_url || !provider.events_path) throw new Error('Set the base URL and the events path first.');

      const cfg = parseJson(provider.config) ?? {};
      const payload = await this.fetchJson(provider, provider.events_path);
      const list = asArray(pick(payload, cfg.eventsRoot));
      if (!list.length) throw new Error('The feed returned no events. Check eventsRoot in the mapping.');

      // Second endpoint holding the prices, keyed by match id.
      const oddsBy = new Map<string, any>();
      if (provider.odds_path) {
        const oddsCfg = cfg.odds ?? {};
        const oddsPayload = await this.fetchJson(provider, provider.odds_path);
        for (const entry of asArray(pick(oddsPayload, oddsCfg.root))) {
          const key = String(field(entry, oddsCfg.matchRef ?? 'matchId', '') ?? '');
          if (key) oddsBy.set(key, entry);
        }
        if (!oddsBy.size) throw new Error('The odds endpoint returned nothing. Check odds.root and odds.matchRef.');
      }

      for (const raw of list) {
        const mapped = mapEvent(raw, cfg);
        if (!mapped.ref || !mapped.name || !mapped.start) continue;
        const eventId = await this.upsertEvent(provider.id, mapped);
        events++;

        // Prices come from the joined entry when there is one, else from the event.
        const priceSource = provider.odds_path ? oddsBy.get(mapped.ref) : raw;
        if (!priceSource) continue;

        const marketList = asArray(pick(priceSource, cfg.marketsRoot)).filter((m) => keepMarket(m, cfg));
        for (const rawMarket of marketList) {
          const m = mapMarket(rawMarket, cfg);
          if (!m.ref) continue;
          const marketId = await this.upsertMarket(eventId, m);
          markets++;

          for (const rawRunner of asArray(pick(rawMarket, cfg.runnersRoot))) {
            const r = mapRunner(rawRunner, cfg);
            if (!r.ref || !r.name) continue;
            if (cfg.homeAwayLabels) r.name = teamLabel(r.name, mapped);
            await this.upsertRunner(marketId, r);
            runners++;
          }
        }
      }

      await this.ds.query(
        `UPDATE odds_provider SET last_sync_at = NOW(), last_status = 'ok', last_error = NULL WHERE id = ?`,
        [providerId],
      );
      await this.logSync(providerId, Date.now() - started, true, events, markets, runners, null);
      return { ok: true, events, markets, runners };
    } catch (err: any) {
      const message = String(err?.message ?? err).slice(0, 500);
      await this.ds.query(
        `UPDATE odds_provider SET last_sync_at = NOW(), last_status = 'error', last_error = ? WHERE id = ?`,
        [message, providerId],
      );
      await this.logSync(providerId, Date.now() - started, false, events, markets, runners, message);
      throw err;
    } finally {
      this.running.delete(providerId);
    }
  }

  /** Fetch without writing anything — the "Test connection" button. */
  async test(providerId: string) {
    const [provider] = await this.ds.query(`SELECT * FROM odds_provider WHERE id = ?`, [providerId]);
    if (!provider) throw new Error('No such provider.');
    if (!provider.base_url || !provider.events_path) throw new Error('Set the base URL and the events path first.');
    const cfg = parseJson(provider.config) ?? {};
    const payload = await this.fetchJson(provider, provider.events_path);
    const list = asArray(pick(payload, cfg.eventsRoot));
    return {
      reachable: true,
      itemsFound: list.length,
      // A sample helps write the mapping: you can see the provider's own field
      // names next to the form.
      sample: list[0] ?? payload,
      mappedSample: list[0] ? mapEvent(list[0], cfg) : null,
    };
  }

  private async fetchJson(provider: any, path: string, vars: Record<string, string> = {}) {
    let url = provider.base_url.replace(/\/$/, '') + '/' + String(path).replace(/^\//, '');
    for (const [k, v] of Object.entries(vars)) url = url.replace(`{${k}}`, encodeURIComponent(v));

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (provider.auth_type === 'header' && provider.auth_name) headers[provider.auth_name] = provider.auth_value ?? '';
    if (provider.auth_type === 'bearer') headers.Authorization = `Bearer ${provider.auth_value ?? ''}`;
    if (provider.auth_type === 'query' && provider.auth_name) {
      url += (url.includes('?') ? '&' : '?') + `${provider.auth_name}=${encodeURIComponent(provider.auth_value ?? '')}`;
    }

    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    const text = await res.text();
    if (!res.ok) throw new Error(`Feed returned ${res.status}: ${text.slice(0, 160)}`);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('The feed did not return JSON.');
    }
  }

  // ------------------------------------------------------------- upserts

  private async upsertEvent(providerId: string, e: any): Promise<string> {
    const [existing] = await this.ds.query(
      `SELECT id FROM sport_event WHERE provider_id = ? AND provider_ref = ?`, [providerId, e.ref],
    );
    if (existing) {
      // Status is deliberately not touched: if an admin suspended an event,
      // the next sync must not reopen it.
      await this.ds.query(
        `UPDATE sport_event SET name=?, home=?, away=?, competition=?, start_time=?, inplay=?, sport_id=?
          WHERE id = ?`,
        [e.name, e.home, e.away, e.competition, e.start, e.inplay ? 1 : 0, e.sport, existing.id],
      );
      return existing.id;
    }
    const id = randomUUID();
    await this.ds.query(
      `INSERT INTO sport_event (id, sport_id, provider_id, provider_ref, competition, name, home, away, start_time, inplay)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [id, e.sport, providerId, e.ref, e.competition, e.name, e.home, e.away, e.start, e.inplay ? 1 : 0],
    );
    return id;
  }

  private async upsertMarket(eventId: string, m: any): Promise<string> {
    const [existing] = await this.ds.query(
      `SELECT id FROM market WHERE event_id = ? AND provider_ref = ?`, [eventId, m.ref],
    );
    if (existing) {
      await this.ds.query(`UPDATE market SET name = ?, type = ? WHERE id = ?`, [m.name, m.type, existing.id]);
      return existing.id;
    }
    const id = randomUUID();
    const cfg = await this.ds.query(`SELECT key_name, value FROM sports_config`);
    const get = (k: string, d: string) => cfg.find((c: any) => c.key_name === k)?.value ?? d;
    await this.ds.query(
      `INSERT INTO market (id, event_id, provider_ref, type, name, min_stake, max_stake, commission_pct)
       VALUES (?,?,?,?,?,?,?,?)`,
      [id, eventId, m.ref, m.type, m.name,
       get('default_min_stake', '100'), get('default_max_stake', '500000'), get('default_commission_pct', '0')],
    );
    return id;
  }

  private async upsertRunner(marketId: string, r: any) {
    const [existing] = await this.ds.query(
      `SELECT id FROM runner WHERE market_id = ? AND provider_ref = ?`, [marketId, r.ref],
    );
    if (existing) {
      await this.ds.query(
        `UPDATE runner SET name=?, back_price=?, back_size=?, lay_price=?, lay_size=?, line_value=? WHERE id = ?`,
        [r.name, r.back, r.backSize, r.lay, r.laySize, r.line, existing.id],
      );
      return;
    }
    await this.ds.query(
      `INSERT INTO runner (id, market_id, provider_ref, name, back_price, back_size, lay_price, lay_size, line_value)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [randomUUID(), marketId, r.ref, r.name, r.back, r.backSize, r.lay, r.laySize, r.line],
    );
  }

  private async logSync(providerId: string, ms: number, ok: boolean, events: number, markets: number, runners: number, message: string | null) {
    await this.ds.query(
      `INSERT INTO feed_sync_log (provider_id, ms, ok, events, markets, runners, message) VALUES (?,?,?,?,?,?,?)`,
      [providerId, ms, ok ? 1 : 0, events, markets, runners, message],
    ).catch(() => {});
  }
}

// ------------------------------------------------------------------ mapping

export function pick(obj: any, path?: string): any {
  if (!path) return obj;
  return String(path).split('.').reduce((acc: any, key: string) => {
    if (acc === null || acc === undefined) return undefined;
    const m = key.match(/^(.*?)\[(\d+)\]$/);
    if (m) {
      const base = m[1] ? acc[m[1]] : acc;
      return Array.isArray(base) ? base[Number(m[2])] : undefined;
    }
    return acc[key];
  }, obj);
}

/** A mapping value is a path into the data, unless it is marked literal with "=". */
function field(raw: any, spec: any, fallback: any = null) {
  if (spec === undefined || spec === null) return fallback;
  if (typeof spec === 'string' && spec.startsWith('=')) return spec.slice(1);
  const v = pick(raw, spec);
  return v === undefined ? fallback : v;
}

function asArray(v: any): any[] {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') return Object.values(v).filter((x) => x && typeof x === 'object');
  return [];
}

function mapEvent(raw: any, cfg: any) {
  const map = cfg.event ?? {};
  const sportRaw = String(field(raw, map.sport, '') ?? '');
  const home = field(raw, map.home);
  const away = field(raw, map.away);
  return {
    ref: String(field(raw, map.ref, '') ?? ''),
    name: String(field(raw, map.name, home && away ? `${home} v ${away}` : '') ?? ''),
    sport: (cfg.sportMap && cfg.sportMap[sportRaw]) || sportRaw || 'cricket',
    competition: field(raw, map.competition),
    home, away,
    start: toMysqlDate(field(raw, map.start)),
    inplay: truthy(field(raw, map.inplay, false)),
  };
}

function mapMarket(raw: any, cfg: any) {
  const map = cfg.market ?? {};
  const type = String(field(raw, map.type, 'match_odds') ?? 'match_odds');
  return {
    ref: String(field(raw, map.ref, '') ?? ''),
    name: String(field(raw, map.name, 'Match Odds') ?? 'Match Odds'),
    type: ['match_odds', 'bookmaker', 'fancy'].includes(type) ? type : 'match_odds',
  };
}

function mapRunner(raw: any, cfg: any) {
  const map = cfg.runner ?? {};
  return {
    ref: String(field(raw, map.ref, '') ?? ''),
    name: String(field(raw, map.name, '') ?? ''),
    back: num(field(raw, map.back)),
    backSize: num(field(raw, map.backSize)),
    lay: num(field(raw, map.lay)),
    laySize: num(field(raw, map.laySize)),
    line: num(field(raw, map.line)),
  };
}

/** Drop markets from other bookmakers, or market types you did not ask for. */
function keepMarket(rawMarket: any, cfg: any): boolean {
  if (cfg.bookmakerName) {
    const b = String(field(rawMarket, cfg.bookmakerField ?? 'bookmakerName', '') ?? '');
    if (b.toLowerCase() !== String(cfg.bookmakerName).toLowerCase()) return false;
  }
  if (Array.isArray(cfg.marketInclude) && cfg.marketInclude.length) {
    const name = String(field(rawMarket, cfg.marketNameField ?? 'market', '') ?? '').toLowerCase();
    if (!cfg.marketInclude.some((x: string) => String(x).toLowerCase() === name)) return false;
  }
  return true;
}

/** "Home" and "Away" mean nothing to a player; show the team instead. */
function teamLabel(value: string, ev: any): string {
  const v = value.trim().toLowerCase();
  if ((v === 'home' || v === '1') && ev.home) return ev.home;
  if ((v === 'away' || v === '2') && ev.away) return ev.away;
  if (v === 'draw' || v === 'x') return 'The Draw';
  return value;
}

function num(v: any): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function truthy(v: any): boolean {
  return v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true' || String(v).toLowerCase() === 'live';
}

/** Feeds send ISO strings or unix seconds; MySQL wants 'YYYY-MM-DD HH:MM:SS'. */
function toMysqlDate(v: any): string {
  if (v === null || v === undefined || v === '') return new Date().toISOString().slice(0, 19).replace('T', ' ');
  const d = typeof v === 'number' || /^\d{10}$/.test(String(v))
    ? new Date(Number(v) * 1000)
    : new Date(v);
  const safe = isNaN(d.getTime()) ? new Date() : d;
  return safe.toISOString().slice(0, 19).replace('T', ' ');
}

export function parseJson(v: any) {
  if (!v) return null;
  if (typeof v === 'object') return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}
