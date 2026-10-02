import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { AdminGuard, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { MasterGuard } from '../agents/agent.guards';
import { AuditService } from '../platform/audit.service';
import { WheelService } from './wheel.service';

/** Wheel administration: items, payout maths, rounds and player bets. */
@Controller('admin/wheel')
@UseGuards(JwtAuthGuard, AdminGuard, MasterGuard)
export class AdminWheelController {
  constructor(
    private readonly ds: DataSource,
    private readonly wheel: WheelService,
    private readonly audit: AuditService,
  ) {}

  /** Items with the odds they actually produce, so the edge is never a guess. */
  @Get('items')
  async items() {
    const items = await this.ds.query(
      `SELECT id, name, icon, color, multiplier, slots, enabled, sort_order
         FROM wheel_item ORDER BY sort_order, name`,
    );
    const live = items.filter((i: any) => i.enabled);
    const maths = WheelService.rtpOf(live);
    const houseEdge = live.length
      ? +(100 - maths.reduce((s, m) => s + m.rtpPct, 0) / live.length).toFixed(2)
      : 0;
    return { items, maths, averageRtpPct: +(100 - houseEdge).toFixed(2), houseEdgePct: houseEdge };
  }

  @Post('items')
  async createItem(@Req() req: any, @Body() b: any) {
    const id = b.id || randomUUID();
    if (!b?.name) throw new BadRequestException({ message: 'Give the item a name.' });
    await this.ds.query(
      `INSERT INTO wheel_item (id, name, icon, color, multiplier, slots, enabled, sort_order)
       VALUES (?,?,?,?,?,?,?,?)`,
      [id, b.name, b.icon ?? null, b.color ?? null, b.multiplier ?? 2, b.slots ?? 1,
       b.enabled === false ? 0 : 1, b.sortOrder ?? 0],
    );
    await this.audit.record({ adminId: req.user.id, action: 'wheel.item.create', target: id, metadata: b });
    return { id };
  }

  @Put('items/:id')
  async updateItem(@Req() req: any, @Param('id') id: string, @Body() b: any) {
    const fields: string[] = [];
    const args: any[] = [];
    const set = (col: string, v: any) => { fields.push(`${col} = ?`); args.push(v); };
    if (b.name !== undefined) set('name', b.name);
    if (b.icon !== undefined) set('icon', b.icon);
    if (b.color !== undefined) set('color', b.color);
    if (b.multiplier !== undefined) set('multiplier', b.multiplier);
    if (b.slots !== undefined) set('slots', Math.max(1, Number(b.slots) || 1));
    if (b.enabled !== undefined) set('enabled', b.enabled ? 1 : 0);
    if (b.sortOrder !== undefined) set('sort_order', b.sortOrder);
    if (!fields.length) throw new BadRequestException({ message: 'Nothing to change.' });
    await this.ds.query(`UPDATE wheel_item SET ${fields.join(', ')} WHERE id = ?`, [...args, id]);
    await this.audit.record({ adminId: req.user.id, action: 'wheel.item.update', target: id, metadata: b });
    return { id };
  }

  @Delete('items/:id')
  async disableItem(@Req() req: any, @Param('id') id: string) {
    await this.ds.query(`UPDATE wheel_item SET enabled = 0 WHERE id = ?`, [id]);
    await this.audit.record({ adminId: req.user.id, action: 'wheel.item.disable', target: id });
    return { id, enabled: false };
  }

  @Get('settings')
  async settings() {
    return this.wheel.config();
  }

  @Put('settings')
  async saveSettings(@Req() req: any, @Body() body: Record<string, string>) {
    const allowed = ['enabled', 'round_seconds', 'min_stake', 'max_stake_per_item', 'max_items_per_round'];
    const changed: string[] = [];
    for (const [key, value] of Object.entries(body ?? {})) {
      if (!allowed.includes(key)) continue;
      await this.ds.query(
        `INSERT INTO wheel_config (key_name, value) VALUES (?,?) ON DUPLICATE KEY UPDATE value = VALUES(value)`,
        [key, String(value ?? '').slice(0, 64)],
      );
      changed.push(key);
    }
    await this.audit.record({ adminId: req.user.id, action: 'wheel.settings.update', metadata: { changed } });
    return { changed };
  }

  /** Rounds with their seeds, so any result can be rechecked. */
  @Get('rounds')
  async rounds(@Query('limit') limit?: string) {
    const rows = await this.ds.query(
      `SELECT r.round_no, r.status, r.staked, r.paid, r.winning_slot, r.total_slots,
              r.server_seed, r.server_seed_hash, r.opened_at, r.settled_at, i.name AS winner
         FROM wheel_round r LEFT JOIN wheel_item i ON i.id = r.winning_item_id
        ORDER BY r.round_no DESC LIMIT ?`,
      [Math.min(Math.max(Number(limit ?? 50), 1), 200)],
    );
    const [totals] = await this.ds.query(
      `SELECT COALESCE(SUM(staked),0) AS staked, COALESCE(SUM(paid),0) AS paid, COUNT(*) AS rounds
         FROM wheel_round WHERE status = 'settled' AND settled_at > DATE_SUB(NOW(), INTERVAL 30 DAY)`,
    );
    const staked = Number(totals.staked);
    const paid = Number(totals.paid);
    return {
      rounds: rows,
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
  async bets(@Query() q: { status?: string; userId?: string; limit?: string }) {
    const where: string[] = ['1=1'];
    const args: any[] = [];
    if (q.status) { where.push('b.status = ?'); args.push(q.status); }
    if (q.userId) { where.push('b.user_id = ?'); args.push(q.userId); }
    const rows = await this.ds.query(
      `SELECT b.*, r.round_no, u.nickname FROM wheel_bet b
         JOIN wheel_round r ON r.id = b.round_id
         LEFT JOIN users u ON u.id = b.user_id
        WHERE ${where.join(' AND ')} ORDER BY b.placed_at DESC LIMIT ?`,
      [...args, Math.min(Math.max(Number(q.limit ?? 100), 1), 500)],
    );
    return { bets: rows };
  }
}
