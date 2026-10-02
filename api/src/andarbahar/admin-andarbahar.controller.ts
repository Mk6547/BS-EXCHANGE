import { BadRequestException, Body, Controller, Get, Put, Query, Req, UseGuards } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AdminGuard, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { MasterGuard } from '../agents/agent.guards';
import { AuditService } from '../platform/audit.service';
import { AndarBaharService } from './andarbahar.service';

/**
 * Andar Bahar admin. Payouts set the house edge; the chances are fixed by the
 * cards, so the screen shows the resulting return per bet as you edit.
 */
@Controller('admin/andarbahar')
@UseGuards(JwtAuthGuard, AdminGuard, MasterGuard)
export class AdminAndarBaharController {
  constructor(
    private readonly ds: DataSource,
    private readonly ab: AndarBaharService,
    private readonly audit: AuditService,
  ) {}

  @Get('settings')
  async settings() {
    const cfg = await this.ab.config();
    const payouts = await this.ab.payouts();
    // Approx hit rates (from simulation) so the admin sees the real edge live.
    const chance: Record<string, number> = {
      'side:andar': 48.8, 'side:bahar': 51.2,
      'count:1-5': 27.1, 'count:6-10': 21.6, 'count:11-15': 16.9, 'count:16+': 34.3,
      'suit:S': 24.9, 'suit:H': 24.9, 'suit:D': 24.9, 'suit:C': 24.9,
    };
    return {
      config: cfg,
      payouts: payouts.map((p: any) => {
        const c = chance[`${p.market}:${p.selection}`] ?? 0;
        const rtp = +((c / 100) * (1 + Number(p.payout)) * 100).toFixed(1);
        return { ...p, chancePct: c, rtpPct: rtp, edgePct: +(100 - rtp).toFixed(1) };
      }),
    };
  }

  @Put('settings')
  async saveSettings(@Req() req: any, @Body() body: Record<string, string>) {
    const allowed = ['enabled', 'round_seconds', 'min_stake', 'max_stake', 'side_enabled', 'count_enabled', 'suit_enabled', 'max_exposure_per_side'];
    const changed: string[] = [];
    for (const [k, v] of Object.entries(body ?? {})) {
      if (!allowed.includes(k)) continue;
      await this.ds.query(`INSERT INTO ab_config (key_name,value) VALUES (?,?) ON DUPLICATE KEY UPDATE value=VALUES(value)`,
        [k, String(v ?? '').slice(0, 64)]);
      changed.push(k);
    }
    await this.audit.record({ adminId: req.user.id, action: 'ab.settings.update', metadata: { changed } });
    return { changed };
  }

  @Put('payouts')
  async savePayouts(@Req() req: any, @Body() body: { payouts: { market: string; selection: string; payout: string }[] }) {
    if (!Array.isArray(body?.payouts)) throw new BadRequestException({ message: 'Nothing to change.' });
    for (const p of body.payouts) {
      await this.ds.query(`UPDATE ab_payout SET payout=? WHERE market=? AND selection=?`, [p.payout, p.market, p.selection]);
    }
    await this.audit.record({ adminId: req.user.id, action: 'ab.payouts.update', metadata: body });
    return { ok: true };
  }

  @Get('rounds')
  async rounds(@Query('limit') limit?: string) {
    const rounds = await this.ds.query(
      `SELECT round_no, status, joker, winning_side, cards_dealt, staked, paid, settled_at
         FROM ab_round ORDER BY round_no DESC LIMIT ?`, [Math.min(Math.max(Number(limit ?? 50), 1), 200)]);
    const [t] = await this.ds.query(
      `SELECT COUNT(*) AS rounds, COALESCE(SUM(staked),0) AS staked, COALESCE(SUM(paid),0) AS paid
         FROM ab_round WHERE status='settled' AND settled_at > DATE_SUB(NOW(), INTERVAL 30 DAY)`);
    const staked = Number(t.staked), paid = Number(t.paid);
    return {
      rounds,
      last30Days: {
        rounds: Number(t.rounds), staked: staked.toFixed(2), paid: paid.toFixed(2),
        margin: (staked - paid).toFixed(2), actualRtpPct: staked > 0 ? +((paid / staked) * 100).toFixed(2) : null,
      },
    };
  }

  @Get('bets')
  async bets(@Query() q: { market?: string; limit?: string }) {
    const where: string[] = ['1=1']; const args: any[] = [];
    if (q.market) { where.push('b.market = ?'); args.push(q.market); }
    const rows = await this.ds.query(
      `SELECT b.*, r.round_no, r.winning_side, u.nickname FROM ab_bet b
         JOIN ab_round r ON r.id = b.round_id LEFT JOIN users u ON u.id = b.user_id
        WHERE ${where.join(' AND ')} ORDER BY b.placed_at DESC LIMIT ?`,
      [...args, Math.min(Math.max(Number(q.limit ?? 100), 1), 500)]);
    return { bets: rows };
  }
}
