import { BadRequestException, Body, Controller, Get, Put, Query, Req, UseGuards } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AdminGuard, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { MasterGuard } from '../agents/agent.guards';
import { AuditService } from '../platform/audit.service';
import { SicBoService } from './sicbo.service';

@Controller('admin/sicbo')
@UseGuards(JwtAuthGuard, AdminGuard, MasterGuard)
export class AdminSicBoController {
  constructor(private readonly ds: DataSource, private readonly sb: SicBoService, private readonly audit: AuditService) {}

  @Get('settings')
  async settings() {
    const cfg = await this.sb.config();
    const payouts = await this.sb.payouts();
    // Exact chances from the 216 outcomes, for the live edge display.
    const rolls: any[] = [];
    for (let a = 1; a <= 6; a++) for (let b = 1; b <= 6; b++) for (let c = 1; c <= 6; c++) rolls.push({ d1: a, d2: b, d3: c, total: a + b + c });
    const playerRtp = (m: string, s: string, rate: number) => {
      let sum = 0; for (const r of rolls) { const mult = SicBoService.evaluate(m, s, rate, r); if (mult > 0) sum += 1 + mult; } return sum / rolls.length;
    };
    return {
      config: cfg,
      payouts: payouts.map((p: any) => {
        const rtp = playerRtp(p.market, p.selection, Number(p.payout));
        return { ...p, rtpPct: +(rtp * 100).toFixed(1), edgePct: +((1 - rtp) * 100).toFixed(1) };
      }),
    };
  }

  @Put('settings')
  async saveSettings(@Req() req: any, @Body() body: Record<string, string>) {
    const allowed = ['enabled', 'round_seconds', 'min_stake', 'max_stake', 'max_exposure_per_selection'];
    const changed: string[] = [];
    for (const [k, v] of Object.entries(body ?? {})) {
      if (!allowed.includes(k)) continue;
      await this.ds.query(`INSERT INTO sb_config (key_name,value) VALUES (?,?) ON DUPLICATE KEY UPDATE value=VALUES(value)`, [k, String(v ?? '').slice(0, 64)]);
      changed.push(k);
    }
    await this.audit.record({ adminId: req.user.id, action: 'sicbo.settings.update', metadata: { changed } });
    return { changed };
  }

  @Put('payouts')
  async savePayouts(@Req() req: any, @Body() body: { payouts: { market: string; selection: string; payout: string }[] }) {
    if (!Array.isArray(body?.payouts)) throw new BadRequestException({ message: 'Nothing to change.' });
    for (const p of body.payouts) await this.ds.query(`UPDATE sb_payout SET payout=? WHERE market=? AND selection=?`, [p.payout, p.market, p.selection]);
    await this.audit.record({ adminId: req.user.id, action: 'sicbo.payouts.update', metadata: body });
    return { ok: true };
  }

  @Get('rounds')
  async rounds(@Query('limit') limit?: string) {
    const rounds = await this.ds.query(
      `SELECT round_no, status, d1, d2, d3, total, staked, paid, settled_at FROM sb_round ORDER BY round_no DESC LIMIT ?`,
      [Math.min(Math.max(Number(limit ?? 50), 1), 200)]);
    const [t] = await this.ds.query(
      `SELECT COUNT(*) AS rounds, COALESCE(SUM(staked),0) AS staked, COALESCE(SUM(paid),0) AS paid
         FROM sb_round WHERE status='settled' AND settled_at > DATE_SUB(NOW(), INTERVAL 30 DAY)`);
    const staked = Number(t.staked), paid = Number(t.paid);
    return { rounds, last30Days: { rounds: Number(t.rounds), staked: staked.toFixed(2), paid: paid.toFixed(2), margin: (staked - paid).toFixed(2), actualRtpPct: staked > 0 ? +((paid / staked) * 100).toFixed(2) : null } };
  }

  @Get('bets')
  async bets(@Query() q: { market?: string; limit?: string }) {
    const where: string[] = ['1=1']; const args: any[] = [];
    if (q.market) { where.push('b.market=?'); args.push(q.market); }
    const rows = await this.ds.query(
      `SELECT b.*, r.round_no, r.total AS roll_total, u.nickname FROM sb_bet b
         JOIN sb_round r ON r.id=b.round_id LEFT JOIN users u ON u.id=b.user_id
        WHERE ${where.join(' AND ')} ORDER BY b.placed_at DESC LIMIT ?`,
      [...args, Math.min(Math.max(Number(q.limit ?? 100), 1), 500)]);
    return { bets: rows };
  }
}
