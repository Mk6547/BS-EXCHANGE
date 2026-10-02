import { BadRequestException, Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { BetError, SportsService } from './sports.service';

/**
 * What the player app reads and writes. Prices and limits come from the
 * database, never from the client: the browser may ask for a price, but the
 * server only accepts it if it still matches what is stored.
 */
@Controller('sports')
export class SportsController {
  constructor(
    private readonly ds: DataSource,
    private readonly sports: SportsService,
  ) {}

  /** Sports with how many events are listed and how many are in play. */
  @Get()
  async sportsList() {
    const rows = await this.ds.query(
      `SELECT s.id, s.name, s.sort_order,
              COUNT(e.id) AS events,
              COALESCE(SUM(e.inplay), 0) AS inplay
         FROM sport s
         LEFT JOIN sport_event e ON e.sport_id = s.id AND e.status IN ('open','inplay')
        WHERE s.enabled = 1
        GROUP BY s.id, s.name, s.sort_order
        ORDER BY s.sort_order`,
    );
    return {
      sports: rows.map((r: any) => ({
        id: r.id, name: r.name, events: Number(r.events), inplay: Number(r.inplay),
      })),
    };
  }

  @Get('events')
  async events(@Query() q: { sport?: string; inplay?: string; limit?: string }) {
    const [psCfg] = await this.ds.query(`SELECT value FROM pulsescore_config WHERE key_name='bookmaker' LIMIT 1`).catch(() => []);
    const primaryBookmaker = String(psCfg?.value || 'orbitxch');
    const limit = Math.min(Math.max(Number(q.limit ?? 100), 1), 200);
    const where = [`e.status IN ('open','inplay')`];
    const args: any[] = [];
    if (q.sport) { where.push('e.sport_id = ?'); args.push(q.sport); }
    if (q.inplay === '1') where.push('e.inplay = 1');

    const events = await this.ds.query(
      `SELECT e.id, e.sport_id, e.name, e.home, e.away, e.competition, e.start_time,
              e.inplay, e.has_tv, e.matched, e.status, e.home_score, e.away_score, e.live_score, e.match_clock, e.period_scores, e.live_status
         FROM sport_event e
        WHERE ${where.join(' AND ')}
        ORDER BY e.inplay DESC, e.start_time
        LIMIT ?`,
      [...args, limit],
    );
    if (!events.length) return { events: [] };

    // Best back and lay per runner of the main market, so the list can show
    // prices without a second round trip per event.
    const ids = events.map((e: any) => e.id);
    // One match_odds market per event for the list (the first shown bookmaker).
    // Events now have one market per bookmaker; pick a single primary market each
    // rather than merging every bookmaker's runners. Portable across MySQL/MariaDB
    // versions (no window functions): fetch ordered candidates, pick first per event.
    const candidates = await this.ds.query(
      `SELECT m.event_id, m.id AS market_id, COALESCE(b.sort_order,0) AS bk_order, b.title AS bk_title
         FROM market m
         LEFT JOIN bookmaker b ON b.key_name = m.bookmaker_key
        WHERE m.event_id IN (${ids.map(() => '?').join(',')}) AND m.type = 'match_odds' AND m.bookmaker_key = ?
          AND m.status IN ('open','suspended','closed')
          AND (m.bookmaker_key IS NULL OR b.enabled IS NULL OR b.enabled = 1)
        ORDER BY m.event_id, bk_order, bk_title, m.id`,
      [...ids, primaryBookmaker],
    );
    const marketByEvent = new Map<string, string>();
    for (const c of candidates) if (!marketByEvent.has(c.event_id)) marketByEvent.set(c.event_id, c.market_id);
    const marketIds = [...marketByEvent.values()];
    const runners = marketIds.length ? await this.ds.query(
      `SELECT m.event_id, m.id AS market_id, m.type, m.status AS market_status,
              r.id, r.name, r.back_price, r.back_size, r.back_price2, r.back_size2, r.back_price3, r.back_size3, r.lay_price, r.lay_size, r.lay_price2, r.lay_size2, r.lay_price3, r.lay_size3, r.sort_order
         FROM market m JOIN runner r ON r.market_id = m.id
        WHERE m.id IN (${marketIds.map(() => '?').join(',')})
        ORDER BY r.sort_order, r.name`,
      marketIds,
    ) : [];

    return {
      events: events.map((e: any) => ({
        ...shapeEvent(e),
        runners: runners.filter((r: any) => r.event_id === e.id).map(shapeRunner),
      })),
    };
  }

  /** One event with every market and price. */
  @Get('events/:id')
  async event(@Param('id') id: string) {
    const [psCfg] = await this.ds.query(`SELECT value FROM pulsescore_config WHERE key_name='bookmaker' LIMIT 1`).catch(() => []);
    const primaryBookmaker = String(psCfg?.value || 'orbitxch');
    const [event] = await this.ds.query(
      `SELECT id, sport_id, name, home, away, competition, start_time, inplay, has_tv, matched, status, home_score, away_score, live_score, match_clock, period_scores, live_status
         FROM sport_event WHERE id = ?`,
      [id],
    );
    if (!event) throw new BadRequestException({ message: 'That match is not available.' });

    // Return the primary Match Odds market plus ALL Fancy markets.
    // Fancy markets may come from any imported bookmaker. We deliberately do
    // not join the bookmaker table here so this endpoint stays compatible with
    // the production MariaDB schema.
    const marketsRaw = await this.ds.query(
      `SELECT m.id, m.type, m.name, m.status, m.min_stake, m.max_stake,
              m.inplay_allowed, m.sort_order, m.bookmaker_key
         FROM market m
        WHERE m.event_id = ?
          AND (m.bookmaker_key = ? OR m.type = 'fancy')
          AND m.status IN ('open','suspended','closed')
        ORDER BY CASE WHEN m.type = 'match_odds' THEN 0 ELSE 1 END, m.sort_order, m.name`,
      [id, primaryBookmaker],
    );
    // Keep only one Match Odds market if duplicate rows exist; preserve all other market types.
    const seenMatchOdds = new Set<string>();
    const markets = marketsRaw.filter((m: any) => {
      if (m.type !== 'match_odds') return true;
      const key = String(m.type);
      if (seenMatchOdds.has(key)) return false;
      seenMatchOdds.add(key);
      return true;
    });
    const runners = markets.length
      ? await this.ds.query(
          `SELECT id, market_id, name, line_value, back_price, back_size, back_price2, back_size2, back_price3, back_size3,
                  lay_price, lay_size, lay_price2, lay_size2, lay_price3, lay_size3,
                  back_rate, lay_rate, status, sort_order
             FROM runner WHERE market_id IN (${markets.map(() => '?').join(',')})
            ORDER BY sort_order`,
          markets.map((m: any) => m.id),
        )
      : [];

    return {
      event: shapeEvent(event),
      markets: markets.map((m: any) => ({
        id: m.id, type: m.type, name: m.name, status: m.status,
        minStake: Number(m.min_stake).toFixed(0), maxStake: Number(m.max_stake).toFixed(0),
        inplayAllowed: !!m.inplay_allowed,
        runners: runners.filter((r: any) => r.market_id === m.id).map(shapeRunner),
      })),
    };
  }

  @Post('bets')
  @UseGuards(JwtAuthGuard)
  async place(@Req() req: any, @Body() body: { marketId: string; runnerId: string; side: any; odds: string; stake: string }) {
    const [user] = await this.ds.query(`SELECT currency FROM users WHERE id = ?`, [req.user.id]);
    try {
      return await this.sports.placeBet({
        userId: req.user.id,
        currency: user?.currency ?? 'PKR',
        marketId: body?.marketId,
        runnerId: body?.runnerId,
        side: body?.side,
        odds: String(body?.odds ?? ''),
        stake: String(body?.stake ?? ''),
        ip: String(req.ip ?? '').replace(/^::ffff:/, ''),
      });
    } catch (err: any) {
      // BetError messages are written for players; anything else is a bug.
      if (err instanceof BetError) throw new BadRequestException({ message: err.message });
      throw new BadRequestException({ message: err?.message ?? 'The bet could not be placed.' });
    }
  }

  @Get('bets')
  @UseGuards(JwtAuthGuard)
  async myBets(@Req() req: any, @Query() q: { status?: string; limit?: string }) {
    const limit = Math.min(Math.max(Number(q.limit ?? 50), 1), 200);
    const args: any[] = [req.user.id];
    let where = 'user_id = ?';
    if (q.status === 'open') where += ` AND status = 'open'`;
    if (q.status === 'settled') where += ` AND status <> 'open'`;

    const rows = await this.ds.query(
      `SELECT id, reference, event_name, market_name, runner_name, market_type, side, odds, rate,
              stake, potential_profit, liability, status, result, payout, placed_at, settled_at
         FROM sport_bet WHERE ${where} ORDER BY placed_at DESC LIMIT ?`,
      [...args, limit],
    );
    return { bets: rows.map(shapeBet) };
  }

  /** Position per runner on one market, so the app can show green and red figures. */
  @Get('events/:id/positions')
  @UseGuards(JwtAuthGuard)
  async positions(@Req() req: any, @Param('id') eventId: string) {
    const bets = await this.ds.query(
      `SELECT market_id, runner_id, market_type, side, stake, potential_profit, liability
         FROM sport_bet WHERE user_id = ? AND event_id = ? AND status = 'open'`,
      [req.user.id, eventId],
    );
    const runners = await this.ds.query(
      `SELECT r.id, r.market_id FROM runner r JOIN market m ON m.id = r.market_id WHERE m.event_id = ?`,
      [eventId],
    );

    const positions: Record<string, number> = {};
    for (const r of runners) {
      positions[r.id] = bets
        .filter((b: any) => b.market_id === r.market_id && b.market_type !== 'fancy')
        .reduce((sum: number, b: any) => {
          const onThis = b.runner_id === r.id;
          const profit = Number(b.potential_profit);
          const liability = Number(b.liability);
          if (b.side === 'back') return sum + (onThis ? profit : -liability);
          return sum + (onThis ? -liability : profit);
        }, 0);
    }
    return { positions, exposure: await this.sports.exposureOf(req.user.id) };
  }

  @Get('exposure')
  @UseGuards(JwtAuthGuard)
  exposure(@Req() req: any) {
    return this.sports.exposureOf(req.user.id);
  }
}

function shapeEvent(e: any) {
  return {
    id: e.id, sport: e.sport_id, name: e.name, home: e.home, away: e.away,
    competition: e.competition, startTime: e.start_time, inplay: !!e.inplay,
    homeScore: e.home_score === null || e.home_score === undefined ? null : Number(e.home_score),
    awayScore: e.away_score === null || e.away_score === undefined ? null : Number(e.away_score),
    liveScore: e.live_score ?? null, matchClock: e.match_clock ?? null,
    periodScores: e.period_scores ? (typeof e.period_scores === 'string' ? (() => { try { return JSON.parse(e.period_scores); } catch { return null; } })() : e.period_scores) : null,
    liveStatus: e.live_status ?? null,
    hasTV: !!e.has_tv, matched: Number(e.matched ?? 0).toFixed(2), status: e.status,
  };
}

function shapeRunner(r: any) {
  return {
    id: r.id, name: r.name,
    line: r.line_value === null || r.line_value === undefined ? null : Number(r.line_value),
    back: r.back_price === null ? null : Number(r.back_price),
    backSize: r.back_size === null || r.back_size === undefined ? null : Number(r.back_size),
    lay: r.lay_price === null ? null : Number(r.lay_price),
    laySize: r.lay_size === null || r.lay_size === undefined ? null : Number(r.lay_size),
    backRate: r.back_rate === null || r.back_rate === undefined ? null : Number(r.back_rate),
    layRate: r.lay_rate === null || r.lay_rate === undefined ? null : Number(r.lay_rate),
    back2: r.back_price2 === null || r.back_price2 === undefined ? null : Number(r.back_price2),
    backSize2: r.back_size2 === null || r.back_size2 === undefined ? null : Number(r.back_size2),
    back3: r.back_price3 === null || r.back_price3 === undefined ? null : Number(r.back_price3),
    backSize3: r.back_size3 === null || r.back_size3 === undefined ? null : Number(r.back_size3),
    lay2: r.lay_price2 === null || r.lay_price2 === undefined ? null : Number(r.lay_price2),
    laySize2: r.lay_size2 === null || r.lay_size2 === undefined ? null : Number(r.lay_size2),
    lay3: r.lay_price3 === null || r.lay_price3 === undefined ? null : Number(r.lay_price3),
    laySize3: r.lay_size3 === null || r.lay_size3 === undefined ? null : Number(r.lay_size3),
    backLadder: buildLadder(r.back_price, r.back_size, r.back_price2, r.back_size2, r.back_price3, r.back_size3),
    layLadder: buildLadder(r.lay_price, r.lay_size, r.lay_price2, r.lay_size2, r.lay_price3, r.lay_size3),
    status: r.status,
  };
}

function buildLadder(...values: any[]) {
  const out: any[] = [];
  for (let i = 0; i < values.length; i += 2) {
    const price = Number(values[i]);
    const liquidity = Number(values[i + 1]);
    if (Number.isFinite(price) && Number.isFinite(liquidity)) out.push({ price, liquidity });
  }
  return out;
}

function shapeBet(b: any) {
  return {
    id: b.id, reference: b.reference, event: b.event_name, market: b.market_name,
    selection: b.runner_name, marketType: b.market_type, side: b.side,
    odds: Number(b.odds).toFixed(2), rate: b.rate === null ? null : Number(b.rate).toFixed(2),
    stake: Number(b.stake).toFixed(2), profit: Number(b.potential_profit).toFixed(2),
    liability: Number(b.liability).toFixed(2), status: b.status, result: b.result,
    payout: b.payout === null ? null : Number(b.payout).toFixed(2),
    placedAt: b.placed_at, settledAt: b.settled_at,
  };
}
