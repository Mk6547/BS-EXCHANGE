import {
  BadRequestException, Body, Controller, Delete, Get, Param, Post, Put, Query, Req, UseGuards,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { AdminGuard, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuditService } from '../platform/audit.service';
import { BetError, SportsService } from './sports.service';
import { OddsFeedService, parseJson } from './odds-feed.service';
import { TheOddsApiAdapter } from './theoddsapi.adapter';
import { ScoresResultsService } from './scores-results.service';
import { PulseScoreAdapter } from './pulsescore.adapter';

/**
 * Everything the admin needs for sports: the odds feed configuration, the
 * events and markets themselves, settlement, and the risk view.
 *
 * Kept separate from the casino admin on purpose — sports and InOut share only
 * the wallet.
 */
@Controller('admin/sports')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminSportsController {
  constructor(
    private readonly ds: DataSource,
    private readonly sports: SportsService,
    private readonly feed: OddsFeedService,
    private readonly adapter: TheOddsApiAdapter,
    private readonly scores: ScoresResultsService,
    private readonly pulse: PulseScoreAdapter,
    private readonly audit: AuditService,
  ) {}

  // ----------------------------------------------------------- odds feed

  @Get('providers')
  async providers() {
    const rows = await this.ds.query(`SELECT * FROM odds_provider ORDER BY display_name`);
    const logs = await this.ds.query(
      `SELECT provider_id, ok, events, markets, runners, message, started_at, ms
         FROM feed_sync_log ORDER BY id DESC LIMIT 20`,
    );
    return {
      providers: rows.map((r: any) => ({
        ...r,
        // The key is never sent back in full, so a shoulder-surfer or a stale
        // browser tab cannot read it.
        auth_value: r.auth_value ? `••••${String(r.auth_value).slice(-4)}` : null,
        has_key: !!r.auth_value,
        config: parseJson(r.config),
      })),
      recentSyncs: logs,
    };
  }

  @Post('providers')
  async createProvider(@Req() req: any, @Body() b: any) {
    const v = providerValues(b);
    if (!v.code || !v.display_name) throw new BadRequestException({ message: 'A code and a name are required.' });
    const id = randomUUID();
    await this.ds.query(
      `INSERT INTO odds_provider
        (id, code, display_name, kind, base_url, events_path, odds_path, auth_type, auth_name, auth_value,
         config, poll_seconds, enabled)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, v.code, v.display_name, v.kind, v.base_url, v.events_path, v.odds_path, v.auth_type,
       v.auth_name, v.auth_value, JSON.stringify(v.config ?? {}), v.poll_seconds, v.enabled],
    );
    await this.audit.record({ adminId: req.user.id, action: 'sports.provider.create', target: v.code });
    return { id };
  }

  @Put('providers/:id')
  async updateProvider(@Req() req: any, @Param('id') id: string, @Body() b: any) {
    const v = providerValues(b);
    // Leaving the key field blank means "keep the key you already have".
    const keepKey = !b.auth_value;
    const res = await this.ds.query(
      `UPDATE odds_provider SET display_name=?, kind=?, base_url=?, events_path=?, odds_path=?,
         auth_type=?, auth_name=?, auth_value=${keepKey ? 'auth_value' : '?'}, config=?, poll_seconds=?, enabled=?
       WHERE id = ?`,
      keepKey
        ? [v.display_name, v.kind, v.base_url, v.events_path, v.odds_path, v.auth_type, v.auth_name,
           JSON.stringify(v.config ?? {}), v.poll_seconds, v.enabled, id]
        : [v.display_name, v.kind, v.base_url, v.events_path, v.odds_path, v.auth_type, v.auth_name,
           v.auth_value, JSON.stringify(v.config ?? {}), v.poll_seconds, v.enabled, id],
    );
    if (!res.affectedRows) throw new BadRequestException({ message: 'No such provider.' });
    await this.audit.record({ adminId: req.user.id, action: 'sports.provider.update', target: id });
    return { id };
  }

  @Delete('providers/:id')
  async deleteProvider(@Req() req: any, @Param('id') id: string) {
    await this.ds.query(`UPDATE odds_provider SET enabled = 0 WHERE id = ?`, [id]);
    await this.audit.record({ adminId: req.user.id, action: 'sports.provider.disable', target: id });
    return { id, enabled: false };
  }

  /** Fetch once and show what came back, without saving anything. */
  @Post('providers/:id/test')
  async testProvider(@Param('id') id: string) {
    try {
      const [p] = await this.ds.query(`SELECT adapter FROM odds_provider WHERE id = ?`, [id]);
      if (p?.adapter === 'theoddsapi') return await this.adapter.test(id);
      return await this.feed.test(id);
    } catch (err: any) {
      throw new BadRequestException({ message: err?.message ?? 'The feed could not be reached.' });
    }
  }

  @Post('providers/:id/sync')
  async syncProvider(@Req() req: any, @Param('id') id: string) {
    try {
      const [p] = await this.ds.query(`SELECT adapter FROM odds_provider WHERE id = ?`, [id]);
      let out: any;
      if (p?.adapter === 'theoddsapi') {
        const sports = await this.adapter.syncSports(id);
        const odds = await this.adapter.syncEventsAndOdds(id);
        out = { sports, odds };
      } else {
        out = await this.feed.sync(id);
      }
      await this.audit.record({ adminId: req.user.id, action: 'sports.feed.sync', target: id, metadata: out });
      return out;
    } catch (err: any) {
      throw new BadRequestException({ message: err?.message ?? 'Sync failed.' });
    }
  }

  // -------------------------------------------------------------- events

  @Post('providers/:id/sync-sports')
  async syncSports(@Param('id') id: string) {
    try { return await this.adapter.syncSports(id); }
    catch (e: any) { throw new BadRequestException({ message: e.message }); }
  }

  @Post('providers/:id/sync-odds')
  async syncOdds(@Param('id') id: string) {
    try { return await this.adapter.syncEventsAndOdds(id); }
    catch (e: any) { throw new BadRequestException({ message: e.message }); }
  }

  @Post('providers/:id/reconcile')
  async reconcile(@Param('id') id: string) {
    try { return await this.adapter.reconcile(id); }
    catch (e: any) { throw new BadRequestException({ message: e.message }); }
  }

  @Get('providers/:id/health')
  async health(@Param('id') id: string) {
    try { return await this.adapter.health(id); }
    catch (e: any) { throw new BadRequestException({ message: e.message }); }
  }

  @Post('providers/:id/sync-results')
  async syncResults(@Param('id') id: string, @Body() b: any) {
    try { return await this.scores.syncScoresAndSettle(id, Number(b?.daysFrom ?? 1)); }
    catch (e: any) { throw new BadRequestException({ message: e.message }); }
  }

  /** No-API test: set home_score/away_score on the event, then call this to settle. */
  @Post('events/:eventId/settle-from-score')
  async settleFromScore(@Req() req: any, @Param('eventId') eventId: string, @Body() b: any) {
    try {
      // If scores are supplied, set them first, then settle. No API call either way.
      if (b?.homeScore !== undefined && b?.awayScore !== undefined) {
        await this.ds.query(`UPDATE sport_event SET home_score=?, away_score=? WHERE id=?`,
          [Number(b.homeScore), Number(b.awayScore), eventId]);
      }
      const out = await this.scores.settleFromDbScore(eventId);
      await this.audit.record({ adminId: req.user.id, action: 'sports.settle.dbscore', target: eventId, metadata: out });
      return out;
    } catch (e: any) { throw new BadRequestException({ message: e.message }); }
  }

  // ------------------------------------------------------------ pulsescore

  @Get('pulsescore/settings')
  async psSettings() {
    const rows = await this.ds.query(`SELECT key_name, value FROM pulsescore_config`);
    const cfg: Record<string, string> = {};
    for (const r of rows) cfg[r.key_name] = r.value;
    // never send the key back in full
    if (cfg.api_key) cfg.api_key_set = '1';
    delete cfg.api_key;
    return { config: cfg };
  }

  @Put('pulsescore/settings')
  async psSave(@Req() req: any, @Body() b: any) {
    const allowed = ['enabled', 'api_key', 'bookmaker', 'sports'];
    const changed: string[] = [];
    for (const [k, v] of Object.entries(b ?? {})) {
      if (!allowed.includes(k)) continue;
      if (k === 'api_key' && (!v || String(v).trim() === '')) continue; // blank keeps existing
      await this.ds.query(`INSERT INTO pulsescore_config (key_name,value) VALUES (?,?) ON DUPLICATE KEY UPDATE value=VALUES(value)`, [k, String(v ?? '')]);
      changed.push(k);
    }
    await this.audit.record({ adminId: req.user.id, action: 'pulsescore.settings', metadata: { changed } });
    return { changed };
  }

  @Post('pulsescore/test')
  async psTest() {
    try { return await this.pulse.test(); }
    catch (e: any) { throw new BadRequestException({ message: e.message }); }
  }

  @Post('pulsescore/sync')
  async psSync() {
    // The paced sync (1 req/sec) can run for minutes, longer than the HTTP
    // timeout. Start it in the background and return at once; watch progress in
    // the sync-runs log and the last-ok time.
    this.pulse.sync().catch(() => { /* logged in sync_run + last_error */ });
    return { started: true, message: 'Sync started. It runs in the background (a minute or two). Check Sports events shortly.' };
  }

  @Post('pulsescore/sync-live')
  async psSyncLive() {
    try { return await this.pulse.syncLive(); }
    catch (e: any) { throw new BadRequestException({ message: e.message }); }
  }

  @Get('sync-runs')
  async syncRuns(@Query('limit') limit?: string) {
    const rows = await this.ds.query(
      `SELECT job, started_at, finished_at, ok, created, updated, processed, http_status, message
         FROM sync_run ORDER BY id DESC LIMIT ?`, [Math.min(Math.max(Number(limit ?? 30), 1), 100)]);
    return { runs: rows };
  }

  @Get('bookmakers')
  async bookmakers() {
    const rows = await this.ds.query(
      `SELECT key_name, title, region, enabled, sort_order, last_update FROM bookmaker ORDER BY sort_order, title`);
    return { bookmakers: rows };
  }

  @Put('bookmakers/:key')
  async updateBookmaker(@Param('key') key: string, @Body() b: any) {
    const fields: string[] = []; const args: any[] = [];
    if (b?.enabled !== undefined) { fields.push('enabled = ?'); args.push(b.enabled ? 1 : 0); }
    if (b?.sortOrder !== undefined) { fields.push('sort_order = ?'); args.push(Number(b.sortOrder) || 0); }
    if (!fields.length) throw new BadRequestException({ message: 'Nothing to change.' });
    await this.ds.query(`UPDATE bookmaker SET ${fields.join(', ')} WHERE key_name = ?`, [...args, key]);
    return { key };
  }

  /** Which bookmaker keys the adapter pulls (provider.bookmakers_csv). Empty = all. */
  @Get('providers/:id/bookmaker-filter')
  async getBookmakerFilter(@Param('id') id: string) {
    const [p] = await this.ds.query(`SELECT bookmakers_csv FROM odds_provider WHERE id = ?`, [id]);
    return { bookmakers: p?.bookmakers_csv ?? '' };
  }

  @Put('providers/:id/bookmaker-filter')
  async setBookmakerFilter(@Param('id') id: string, @Body() b: any) {
    const csv = String(b?.bookmakers ?? '').trim();
    await this.ds.query(`UPDATE odds_provider SET bookmakers_csv = ? WHERE id = ?`, [csv || null, id]);
    return { bookmakers: csv };
  }

  @Get('sport-catalog')
  async sportCatalog() {
    const rows = await this.ds.query(
      `SELECT sport_key, title, sport_group, active, has_outrights, internal_sport, enabled
         FROM sport_catalog ORDER BY sport_group, title`);
    return { sports: rows };
  }

  @Put('sport-catalog/:key')
  async setSportEnabled(@Param('key') key: string, @Body() b: any) {
    await this.ds.query(`UPDATE sport_catalog SET enabled = ? WHERE sport_key = ?`, [b?.enabled ? 1 : 0, key]);
    return { key, enabled: !!b?.enabled };
  }

  @Get('events')
  async events(@Query() q: { sport?: string; status?: string; search?: string; limit?: string }) {
    const limit = Math.min(Math.max(Number(q.limit ?? 100), 1), 300);
    const where: string[] = ['1=1'];
    const args: any[] = [];
    if (q.sport) { where.push('e.sport_id = ?'); args.push(q.sport); }
    if (q.status) { where.push('e.status = ?'); args.push(q.status); }
    if (q.search) { where.push('e.name LIKE ?'); args.push(`%${q.search}%`); }

    const rows = await this.ds.query(
      `SELECT e.*, p.display_name AS provider,
              (SELECT COUNT(*) FROM market m WHERE m.event_id = e.id) AS markets,
              (SELECT COALESCE(SUM(b.liability),0) FROM sport_bet b WHERE b.event_id = e.id AND b.status='open') AS open_liability
         FROM sport_event e LEFT JOIN odds_provider p ON p.id = e.provider_id
        WHERE ${where.join(' AND ')}
        ORDER BY e.inplay DESC, e.start_time
        LIMIT ?`,
      [...args, limit],
    );
    return { events: rows };
  }

  /** Create an event by hand — useful before a feed is connected. */
  @Post('events')
  async createEvent(@Req() req: any, @Body() b: any) {
    const id = randomUUID();
    const name = String(b?.name ?? '').trim() || [b?.home, b?.away].filter(Boolean).join(' v ');
    if (!name) throw new BadRequestException({ message: 'Give the match a name.' });
    if (!b?.startTime) throw new BadRequestException({ message: 'Set the start time.' });
    await this.ds.query(
      `INSERT INTO sport_event (id, sport_id, competition, name, home, away, start_time, inplay, has_tv)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, b.sport ?? 'cricket', b.competition ?? null, name, b.home ?? null, b.away ?? null,
       String(b.startTime).replace('T', ' ').slice(0, 19), b.inplay ? 1 : 0, b.hasTV ? 1 : 0],
    );
    await this.audit.record({ adminId: req.user.id, action: 'sports.event.create', target: id, metadata: { name } });
    return { id };
  }

  @Put('events/:id')
  async updateEvent(@Req() req: any, @Param('id') id: string, @Body() b: any) {
    const fields: string[] = [];
    const args: any[] = [];
    if (b.status) { fields.push('status = ?'); args.push(b.status); }
    if (b.inplay !== undefined) { fields.push('inplay = ?'); args.push(b.inplay ? 1 : 0); }
    if (b.hasTV !== undefined) { fields.push('has_tv = ?'); args.push(b.hasTV ? 1 : 0); }
    if (b.name) { fields.push('name = ?'); args.push(b.name); }
    if (b.startTime) { fields.push('start_time = ?'); args.push(String(b.startTime).replace('T', ' ').slice(0, 19)); }
    if (!fields.length) throw new BadRequestException({ message: 'Nothing to change.' });
    await this.ds.query(`UPDATE sport_event SET ${fields.join(', ')} WHERE id = ?`, [...args, id]);
    await this.audit.record({ adminId: req.user.id, action: 'sports.event.update', target: id, metadata: b });
    return { id };
  }

  /** Suspending an event suspends all of its open markets in one go. */
  @Post('events/:id/suspend')
  async suspendEvent(@Req() req: any, @Param('id') id: string) {
    await this.ds.query(`UPDATE market SET status='suspended' WHERE event_id = ? AND status='open'`, [id]);
    await this.ds.query(`UPDATE sport_event SET status='suspended' WHERE id = ?`, [id]);
    await this.audit.record({ adminId: req.user.id, action: 'sports.event.suspend', target: id });
    return { id, status: 'suspended' };
  }

  @Post('events/:id/resume')
  async resumeEvent(@Req() req: any, @Param('id') id: string) {
    await this.ds.query(`UPDATE market SET status='open' WHERE event_id = ? AND status='suspended'`, [id]);
    await this.ds.query(`UPDATE sport_event SET status='open' WHERE id = ?`, [id]);
    await this.audit.record({ adminId: req.user.id, action: 'sports.event.resume', target: id });
    return { id, status: 'open' };
  }

  // ------------------------------------------------------------- markets

  @Get('events/:id/markets')
  async markets(@Param('id') eventId: string) {
    const markets = await this.ds.query(
      `SELECT m.*, (SELECT COALESCE(SUM(b.liability),0) FROM sport_bet b WHERE b.market_id = m.id AND b.status='open') AS open_liability
         FROM market m WHERE m.event_id = ? ORDER BY m.sort_order, m.name`,
      [eventId],
    );
    const runners = markets.length
      ? await this.ds.query(
          `SELECT * FROM runner WHERE market_id IN (${markets.map(() => '?').join(',')}) ORDER BY sort_order`,
          markets.map((m: any) => m.id),
        )
      : [];
    // What the house stands to lose on each runner if it wins.
    const bets = await this.ds.query(
      `SELECT market_id, runner_id, side, market_type, potential_profit, liability
         FROM sport_bet WHERE event_id = ? AND status = 'open'`,
      [eventId],
    );
    return {
      markets: markets.map((m: any) => ({
        ...m,
        runners: runners.filter((r: any) => r.market_id === m.id).map((r: any) => ({
          ...r,
          housePosition: housePosition(bets, m.id, r.id),
        })),
      })),
    };
  }

  @Post('events/:id/markets')
  async createMarket(@Req() req: any, @Param('id') eventId: string, @Body() b: any) {
    const id = randomUUID();
    const type = ['match_odds', 'bookmaker', 'fancy'].includes(b?.type) ? b.type : 'match_odds';
    if (!b?.name) throw new BadRequestException({ message: 'Give the market a name.' });
    await this.ds.query(
      `INSERT INTO market (id, event_id, type, name, min_stake, max_stake, max_liability, commission_pct, inplay_allowed, sort_order)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [id, eventId, type, b.name, b.minStake ?? 100, b.maxStake ?? 500000, b.maxLiability ?? null,
       b.commissionPct ?? 0, b.inplayAllowed === false ? 0 : 1, b.sortOrder ?? 0],
    );
    for (const [i, r] of (b.runners ?? []).entries()) {
      await this.ds.query(
        `INSERT INTO runner (id, market_id, name, line_value, back_price, lay_price, back_rate, lay_rate, sort_order)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [randomUUID(), id, r.name, r.line ?? null, r.back ?? null, r.lay ?? null,
         r.backRate ?? null, r.layRate ?? null, i],
      );
    }
    await this.audit.record({ adminId: req.user.id, action: 'sports.market.create', target: id, metadata: { eventId, type } });
    return { id };
  }

  @Put('markets/:id')
  async updateMarket(@Req() req: any, @Param('id') id: string, @Body() b: any) {
    const fields: string[] = [];
    const args: any[] = [];
    const set = (col: string, val: any) => { fields.push(`${col} = ?`); args.push(val); };
    if (b.status) set('status', b.status);
    if (b.name) set('name', b.name);
    if (b.minStake !== undefined) set('min_stake', b.minStake);
    if (b.maxStake !== undefined) set('max_stake', b.maxStake);
    if (b.maxLiability !== undefined) set('max_liability', b.maxLiability === '' ? null : b.maxLiability);
    if (b.commissionPct !== undefined) set('commission_pct', b.commissionPct);
    if (b.inplayAllowed !== undefined) set('inplay_allowed', b.inplayAllowed ? 1 : 0);
    if (!fields.length) throw new BadRequestException({ message: 'Nothing to change.' });
    await this.ds.query(`UPDATE market SET ${fields.join(', ')} WHERE id = ?`, [...args, id]);
    await this.audit.record({ adminId: req.user.id, action: 'sports.market.update', target: id, metadata: b });
    return { id };
  }

  /** Manual prices, for markets the admin runs without a feed. */
  @Put('runners/:id')
  async updateRunner(@Req() req: any, @Param('id') id: string, @Body() b: any) {
    await this.ds.query(
      `UPDATE runner SET name = COALESCE(?, name), back_price=?, lay_price=?, back_rate=?, lay_rate=?,
         line_value=?, status = COALESCE(?, status) WHERE id = ?`,
      [b.name ?? null, nz(b.back), nz(b.lay), nz(b.backRate), nz(b.layRate), nz(b.line), b.status ?? null, id],
    );
    await this.audit.record({ adminId: req.user.id, action: 'sports.runner.update', target: id, metadata: b });
    return { id };
  }

  @Post('markets/:id/settle')
  async settle(@Req() req: any, @Param('id') id: string, @Body() b: { winnerRunnerId?: string; value?: string }) {
    try {
      const out = await this.sports.settleMarket({
        marketId: id, winnerRunnerId: b?.winnerRunnerId, value: b?.value, adminId: req.user.id,
      });
      await this.audit.record({ adminId: req.user.id, action: 'sports.market.settle', target: id, metadata: out });
      return out;
    } catch (err: any) {
      if (err instanceof BetError) throw new BadRequestException({ message: err.message });
      throw new BadRequestException({ message: err?.message ?? 'Settlement failed.' });
    }
  }

  @Post('markets/:id/void')
  async voidMarket(@Req() req: any, @Param('id') id: string, @Body() b: { reason?: string }) {
    const out = await this.sports.voidMarket({ marketId: id, adminId: req.user.id, reason: b?.reason });
    await this.audit.record({ adminId: req.user.id, action: 'sports.market.void', target: id, metadata: out });
    return out;
  }

  // ----------------------------------------------------------------- bets

  @Get('bets')
  async bets(@Query() q: { status?: string; userId?: string; eventId?: string; limit?: string }) {
    const limit = Math.min(Math.max(Number(q.limit ?? 100), 1), 500);
    const where: string[] = ['1=1'];
    const args: any[] = [];
    if (q.status) { where.push('b.status = ?'); args.push(q.status); }
    if (q.userId) { where.push('b.user_id = ?'); args.push(q.userId); }
    if (q.eventId) { where.push('b.event_id = ?'); args.push(q.eventId); }
    const rows = await this.ds.query(
      `SELECT b.*, u.nickname FROM sport_bet b LEFT JOIN users u ON u.id = b.user_id
        WHERE ${where.join(' AND ')} ORDER BY b.placed_at DESC LIMIT ?`,
      [...args, limit],
    );
    return { bets: rows };
  }

  @Post('bets/:id/void')
  async voidBet(@Req() req: any, @Param('id') id: string, @Body() b: { reason?: string }) {
    try {
      const out = await this.sports.voidBet({ betId: id, adminId: req.user.id, reason: b?.reason });
      await this.audit.record({ adminId: req.user.id, action: 'sports.bet.void', target: id, metadata: out });
      return out;
    } catch (err: any) {
      throw new BadRequestException({ message: err?.message ?? 'That bet could not be voided.' });
    }
  }

  /** Where the house is carrying risk right now. */
  @Get('risk')
  async risk() {
    const [totals] = await this.ds.query(
      `SELECT COUNT(*) AS open_bets, COALESCE(SUM(liability),0) AS player_liability,
              COALESCE(SUM(potential_profit),0) AS house_liability
         FROM sport_bet WHERE status = 'open'`,
    );
    const byEvent = await this.ds.query(
      `SELECT b.event_id, b.event_name, COUNT(*) AS bets,
              COALESCE(SUM(b.liability),0) AS taken,
              COALESCE(SUM(b.potential_profit),0) AS exposure
         FROM sport_bet b WHERE b.status = 'open'
        GROUP BY b.event_id, b.event_name ORDER BY exposure DESC LIMIT 50`,
    );
    const [settled] = await this.ds.query(
      `SELECT COALESCE(SUM(liability),0) AS staked, COALESCE(SUM(payout),0) AS paid
         FROM sport_bet WHERE status = 'settled' AND settled_at > DATE_SUB(NOW(), INTERVAL 30 DAY)`,
    );
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

  @Get('settings')
  async settings() {
    const rows = await this.ds.query(`SELECT key_name, value FROM sports_config`);
    const out: Record<string, string> = {};
    for (const r of rows) out[r.key_name] = r.value;
    return out;
  }

  @Put('settings')
  async saveSettings(@Req() req: any, @Body() body: Record<string, string>) {
    const allowed = ['betting_enabled', 'default_min_stake', 'default_max_stake',
      'default_max_liability_per_market', 'default_commission_pct', 'inplay_delay_seconds',
      'max_open_bets_per_player'];
    const changed: string[] = [];
    for (const [key, value] of Object.entries(body ?? {})) {
      if (!allowed.includes(key)) continue;
      await this.ds.query(
        `INSERT INTO sports_config (key_name, value) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE value = VALUES(value)`,
        [key, String(value ?? '').slice(0, 255)],
      );
      changed.push(key);
    }
    await this.audit.record({ adminId: req.user.id, action: 'sports.settings.update', metadata: { changed } });
    return { changed };
  }
}

function housePosition(bets: any[], marketId: string, runnerId: string): number {
  return bets
    .filter((b) => b.market_id === marketId && b.market_type !== 'fancy')
    .reduce((sum, b) => {
      const onThis = b.runner_id === runnerId;
      const profit = Number(b.potential_profit);
      const liability = Number(b.liability);
      // Mirror image of the player's position.
      if (b.side === 'back') return sum + (onThis ? -profit : liability);
      return sum + (onThis ? liability : -profit);
    }, 0);
}

function providerValues(b: any) {
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

function safeJson(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    throw new BadRequestException({ message: 'The mapping is not valid JSON.' });
  }
}

function nz(v: any) {
  return v === '' || v === undefined ? null : v;
}
