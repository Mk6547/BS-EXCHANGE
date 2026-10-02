import { BadRequestException, Body, Controller, Get, Put, Query, Req, UseGuards } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AdminGuard, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { MasterGuard } from '../agents/agent.guards';
import { AuditService } from '../platform/audit.service';
import { TeenPattiService } from './teenpatti.service';

/**
 * Teen Patti administration: odds, Pair Plus payouts, rounds and bets.
 *
 * The odds figure is where the margin lives. Both hands are equally likely, so
 * a fair price would be 2.00; anything below it is your edge.
 */
@Controller('admin/teenpatti')
@UseGuards(JwtAuthGuard, AdminGuard, MasterGuard)
export class AdminTeenPattiController {
  constructor(
    private readonly ds: DataSource,
    private readonly tp: TeenPattiService,
    private readonly audit: AuditService,
  ) {}

  @Get('settings')
  async settings() {
    const cfg = await this.tp.config();
    const payouts = await this.tp.payouts();
    const backOdds = Number(cfg.match_back_odds ?? 1.95);

    // Chance of each hand in three cards, from the 22,100 possible combinations.
    const chances: Record<string, number> = {
      pair: 16.94, flush: 4.96, straight: 3.26, trail: 0.24, straightflush: 0.22,
    };
    const pairPlusRtp = payouts.reduce(
      (sum: number, p: any) => sum + ((chances[p.hand_rank] ?? 0) / 100) * (1 + Number(p.payout)), 0,
    );

    return {
      config: cfg,
      payouts,
      maths: {
        // Ties are rare and refunded, so match odds are close to an even bet.
        matchRtpPct: +(backOdds / 2 * 100).toFixed(2),
        matchEdgePct: +(100 - (backOdds / 2 * 100)).toFixed(2),
        pairPlusRtpPct: +(pairPlusRtp * 100).toFixed(2),
        pairPlusEdgePct: +(100 - pairPlusRtp * 100).toFixed(2),
        chances,
      },
    };
  }

  @Put('settings')
  async saveSettings(@Req() req: any, @Body() body: Record<string, string>) {
    const allowed = ['enabled', 'round_seconds', 'min_stake', 'max_stake',
      'match_back_odds', 'match_lay_odds', 'pairplus_enabled'];
    const changed: string[] = [];
    for (const [key, value] of Object.entries(body ?? {})) {
      if (!allowed.includes(key)) continue;
      await this.ds.query(
        `INSERT INTO tp_config (key_name, value) VALUES (?,?) ON DUPLICATE KEY UPDATE value = VALUES(value)`,
        [key, String(value ?? '').slice(0, 64)],
      );
      changed.push(key);
    }
    await this.audit.record({ adminId: req.user.id, action: 'teenpatti.settings.update', metadata: { changed } });
    return { changed };
  }

  @Put('payouts')
  async savePayouts(@Req() req: any, @Body() body: { payouts: { rank: string; payout: string }[] }) {
    if (!Array.isArray(body?.payouts)) throw new BadRequestException({ message: 'Nothing to change.' });
    for (const p of body.payouts) {
      await this.ds.query(`UPDATE tp_payout SET payout = ? WHERE hand_rank = ?`, [p.payout, p.rank]);
    }
    await this.audit.record({ adminId: req.user.id, action: 'teenpatti.payouts.update', metadata: body });
    return { ok: true };
  }

  @Get('rounds')
  async rounds(@Query('limit') limit?: string) {
    const rounds = await this.ds.query(
      `SELECT round_no, status, hand_a, hand_b, rank_a, rank_b, winner, staked, paid,
              server_seed, server_seed_hash, opened_at, settled_at
         FROM tp_round ORDER BY round_no DESC LIMIT ?`,
      [Math.min(Math.max(Number(limit ?? 50), 1), 200)],
    );
    const [totals] = await this.ds.query(
      `SELECT COUNT(*) AS rounds, COALESCE(SUM(staked),0) AS staked, COALESCE(SUM(paid),0) AS paid
         FROM tp_round WHERE status='settled' AND settled_at > DATE_SUB(NOW(), INTERVAL 30 DAY)`,
    );
    const staked = Number(totals.staked);
    const paid = Number(totals.paid);
    return {
      rounds,
      last30Days: {
        rounds: Number(totals.rounds),
        staked: staked.toFixed(2),
        paid: paid.toFixed(2),
        margin: (staked - paid).toFixed(2),
        actualRtpPct: staked > 0 ? +((paid / staked) * 100).toFixed(2) : null,
      },
    };
  }

  @Get('bets')
  async bets(@Query() q: { market?: string; result?: string; limit?: string }) {
    const where: string[] = ['1=1'];
    const args: any[] = [];
    if (q.market) { where.push('b.market = ?'); args.push(q.market); }
    if (q.result) { where.push('b.result = ?'); args.push(q.result); }
    const rows = await this.ds.query(
      `SELECT b.*, r.round_no, r.winner, u.nickname FROM tp_bet b
         JOIN tp_round r ON r.id = b.round_id
         LEFT JOIN users u ON u.id = b.user_id
        WHERE ${where.join(' AND ')} ORDER BY b.placed_at DESC LIMIT ?`,
      [...args, Math.min(Math.max(Number(q.limit ?? 100), 1), 500)],
    );
    return { bets: rows };
  }
}
