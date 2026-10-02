import {
  BadRequestException, Body, Controller, Delete, Get, Param, Post, Put, Query, Req, UseGuards,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import Decimal from 'decimal.js';
import { AdminGuard, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { LedgerService } from './ledger.service';
import { AuditService } from './audit.service';
import { parseJson } from './content.controller';

/**
 * Admin API. Authorization is enforced here on the server, not by hiding a
 * route in the browser: JwtAuthGuard verifies the token, AdminGuard checks the
 * role claim, and every write records who did it.
 */
@Controller('admin')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminController {
  constructor(
    private readonly ds: DataSource,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------- dashboard

  @Get('dashboard')
  async dashboard() {
    const [players] = await this.ds.query(
      `SELECT COUNT(*) AS total,
              SUM(status = 'active') AS active,
              SUM(created_at > DATE_SUB(NOW(), INTERVAL 7 DAY)) AS new_week
         FROM users`,
    );
    const [funds] = await this.ds.query(`SELECT COALESCE(SUM(balance),0) AS held FROM wallet`);
    const [dep] = await this.ds.query(
      `SELECT SUM(status='pending') AS pending,
              COALESCE(SUM(CASE WHEN status='approved' THEN credited END),0) AS approved_total
         FROM deposit`,
    );
    const [wdr] = await this.ds.query(
      `SELECT SUM(status='pending') AS pending,
              COALESCE(SUM(CASE WHEN status='approved' THEN payable END),0) AS approved_total
         FROM withdrawal`,
    );
    const [play] = await this.ds.query(
      `SELECT COUNT(*) AS rounds,
              COALESCE(SUM(CASE WHEN action='bet' AND applied=1 THEN amount END),0) AS staked,
              COALESCE(SUM(CASE WHEN action='withdraw' AND applied=1 THEN result END),0) AS returned
         FROM inout_transaction WHERE created_at > DATE_SUB(NOW(), INTERVAL 30 DAY)`,
    );

    return {
      players: {
        total: Number(players.total), active: Number(players.active ?? 0), newThisWeek: Number(players.new_week ?? 0),
      },
      funds: { heldForPlayers: Number(funds.held).toFixed(2) },
      deposits: { pending: Number(dep.pending ?? 0), approvedTotal: Number(dep.approved_total).toFixed(2) },
      withdrawals: { pending: Number(wdr.pending ?? 0), approvedTotal: Number(wdr.approved_total).toFixed(2) },
      // Staked minus returned over 30 days. Positive means the house is ahead;
      // it is not profit, because provider fees are settled separately.
      play: {
        rounds: Number(play.rounds), staked: Number(play.staked).toFixed(2),
        returned: Number(play.returned).toFixed(2),
        margin: (Number(play.staked) - Number(play.returned)).toFixed(2),
      },
    };
  }

  // --------------------------------------------------------------- players

  @Get('players')
  async players(@Req() req: any, @Query() q: { search?: string; status?: string; page?: string; limit?: string }) {
    const limit = Math.min(Math.max(Number(q.limit ?? 25), 1), 100);
    const offset = (Math.max(Number(q.page ?? 1), 1) - 1) * limit;
    const where: string[] = ["u.role = 'player'"];
    const args: any[] = [];
    if (req.user?.role === 'admin') { where.push('u.owner_id = ?'); args.push(req.user.id); }

    if (q.search) {
      where.push('(u.id = ? OR u.nickname LIKE ? OR u.email LIKE ? OR u.phone LIKE ?)');
      args.push(q.search, `%${q.search}%`, `%${q.search}%`, `%${q.search}%`);
    }
    if (q.status) { where.push('u.status = ?'); args.push(q.status); }

    const rows = await this.ds.query(
      `SELECT u.id, u.nickname, u.email, u.phone, u.status, u.role, u.currency,
              u.created_at, u.last_login_at, COALESCE(w.balance,0) AS balance
         FROM users u LEFT JOIN wallet w ON w.user_id = u.id AND w.currency = u.currency
        WHERE ${where.join(' AND ')}
        ORDER BY u.created_at DESC LIMIT ? OFFSET ?`,
      [...args, limit, offset],
    );
    const [count] = await this.ds.query(
      `SELECT COUNT(*) AS n FROM users u WHERE ${where.join(' AND ')}`, args,
    );
    return { total: Number(count.n), players: rows };
  }

  @Get('players/:id')
  async player(@Param('id') id: string) {
    const [user] = await this.ds.query(
      `SELECT u.id, u.nickname, u.email, u.phone, u.status, u.role, u.currency,
              u.created_at, u.last_login_at, COALESCE(w.balance,0) AS balance
         FROM users u LEFT JOIN wallet w ON w.user_id = u.id AND w.currency = u.currency
        WHERE u.id = ?`, [id],
    );
    if (!user) throw new BadRequestException({ message: 'No such player.' });

    const [ledger, deposits, withdrawals, rounds, adjustments] = await Promise.all([
      this.ds.query(`SELECT delta, balance_after, reference, created_at FROM wallet_ledger
                      WHERE user_id = ? ORDER BY id DESC LIMIT 25`, [id]),
      this.ds.query(`SELECT reference, amount, status, created_at FROM deposit
                      WHERE user_id = ? ORDER BY created_at DESC LIMIT 25`, [id]),
      this.ds.query(`SELECT reference, amount, payable, status, created_at FROM withdrawal
                      WHERE user_id = ? ORDER BY created_at DESC LIMIT 25`, [id]),
      this.ds.query(`SELECT game_mode, action, amount, result, created_at FROM inout_transaction
                      WHERE user_id = ? ORDER BY id DESC LIMIT 25`, [id]),
      this.ds.query(`SELECT delta, balance_before, balance_after, reason, admin_id, created_at
                       FROM balance_adjustment WHERE user_id = ? ORDER BY created_at DESC LIMIT 25`, [id]),
    ]);
    return { user, ledger, deposits, withdrawals, rounds, adjustments };
  }

  @Post('players/:id/status')
  async setStatus(@Req() req: any, @Param('id') id: string, @Body() body: { status: string }) {
    const status = body?.status;
    if (!['active', 'suspended'].includes(status)) {
      throw new BadRequestException({ message: 'Status must be active or suspended.' });
    }
    await this.ds.query(`UPDATE users SET status = ? WHERE id = ?`, [status, id]);
    await this.ds.query(`UPDATE wallet SET status = ? WHERE user_id = ?`,
      [status === 'active' ? 'active' : 'locked', id]);
    await this.audit.record({ adminId: req.user.id, action: 'player.status', target: id,
      metadata: { status }, ip: ip(req) });
    return { id, status };
  }

  /**
   * Manual balance adjustment. Runs server-side only, records the before and
   * after balance, the reason and the admin, and writes to the same ledger the
   * games use — so a manual credit is auditable next to every other movement.
   */
  @Post('players/:id/balance')
  async adjustBalance(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { delta: string; reason: string },
  ) {
    const reason = String(body?.reason ?? '').trim();
    if (reason.length < 3) throw new BadRequestException({ message: 'Give a reason for the adjustment.' });

    const raw = String(body?.delta ?? '').trim();
    if (!/^-?\d+(\.\d{1,2})?$/.test(raw) || Number(raw) === 0) {
      throw new BadRequestException({ message: 'Enter an amount, positive to add or negative to deduct.' });
    }
    const delta = new Decimal(raw);

    const [user] = await this.ds.query(`SELECT currency FROM users WHERE id = ?`, [id]);
    if (!user) throw new BadRequestException({ message: 'No such player.' });

    const adjustmentId = randomUUID();
    let before: Decimal, after: Decimal;
    try {
      ({ before, after } = await this.ledger.inTx(async (qr) => {
        const moved = await this.ledger.move(qr, {
          userId: id, currency: user.currency, delta,
          reference: `adj:${adjustmentId}`,
          meta: { reason, adminId: req.user.id },
        });
        await qr.query(
          `INSERT INTO balance_adjustment
             (id, user_id, currency, delta, balance_before, balance_after, reason, admin_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [adjustmentId, id, user.currency, delta.toFixed(2),
           moved.before.toFixed(2), moved.after.toFixed(2), reason, req.user.id],
        );
        return moved;
      }));
    } catch (err: any) {
      throw new BadRequestException({ message: err?.message ?? 'Adjustment failed.' });
    }

    await this.audit.record({ adminId: req.user.id, action: 'player.balance', target: id,
      metadata: { delta: delta.toFixed(2), before: before.toFixed(2), after: after.toFixed(2), reason },
      ip: ip(req) });

    return { id, before: before.toFixed(2), after: after.toFixed(2), delta: delta.toFixed(2) };
  }

  // -------------------------------------------------------------- deposits

  @Get('deposits')
  async deposits(@Query() q: { status?: string; limit?: string }) {
    const limit = Math.min(Math.max(Number(q.limit ?? 50), 1), 200);
    const args: any[] = [];
    let where = '1=1';
    if (q.status) { where = 'd.status = ?'; args.push(q.status); }
    const rows = await this.ds.query(
      `SELECT d.id, d.reference, d.amount, d.credited, d.currency, d.status, d.player_note,
              d.proof_url, d.admin_note, d.processed_by, d.processed_at, d.created_at,
              u.nickname, u.id AS user_id, m.display_name AS method
         FROM deposit d JOIN users u ON u.id = d.user_id
         JOIN payment_method m ON m.id = d.method_id
        WHERE ${where} ORDER BY d.created_at DESC LIMIT ?`,
      [...args, limit],
    );
    return { deposits: rows };
  }

  @Post('deposits/:id/approve')
  async approveDeposit(
    @Req() req: any, @Param('id') id: string,
    @Body() body: { credited?: string; note?: string },
  ) {
    const [dep] = await this.ds.query(`SELECT * FROM deposit WHERE id = ?`, [id]);
    if (!dep) throw new BadRequestException({ message: 'No such deposit.' });
    if (dep.status !== 'pending') throw new BadRequestException({ message: `Already ${dep.status}.` });

    // Admin may credit a different figure from the one declared — players
    // mistype amounts, and the bank statement is the truth.
    const credited = new Decimal(body?.credited ?? dep.amount);
    if (credited.lte(0)) throw new BadRequestException({ message: 'Credited amount must be positive.' });

    try {
      await this.ledger.inTx(async (qr) => {
        const [locked] = await qr.query(`SELECT status FROM deposit WHERE id = ? FOR UPDATE`, [id]);
        if (locked.status !== 'pending') throw new Error(`Already ${locked.status}.`);

        await this.ledger.move(qr, {
          userId: dep.user_id, currency: dep.currency, delta: credited,
          reference: `dp:${dep.reference}`, meta: { depositId: id, adminId: req.user.id },
        });
        await qr.query(
          `UPDATE deposit SET status='approved', credited=?, admin_note=?, processed_by=?, processed_at=NOW()
            WHERE id = ?`,
          [credited.toFixed(2), body?.note?.slice(0, 255) ?? null, req.user.id, id],
        );
      });
    } catch (err: any) {
      throw new BadRequestException({ message: err?.message ?? 'Approval failed.' });
    }

    await this.audit.record({ adminId: req.user.id, action: 'deposit.approve', target: dep.reference,
      metadata: { userId: dep.user_id, credited: credited.toFixed(2) }, ip: ip(req) });
    return { id, status: 'approved', credited: credited.toFixed(2) };
  }

  @Post('deposits/:id/reject')
  async rejectDeposit(@Req() req: any, @Param('id') id: string, @Body() body: { note: string }) {
    const note = String(body?.note ?? '').trim();
    if (!note) throw new BadRequestException({ message: 'Give a reason for the rejection.' });
    const res = await this.ds.query(
      `UPDATE deposit SET status='rejected', admin_note=?, processed_by=?, processed_at=NOW()
        WHERE id = ? AND status = 'pending'`,
      [note.slice(0, 255), req.user.id, id],
    );
    if (!res.affectedRows) throw new BadRequestException({ message: 'That deposit is no longer pending.' });
    await this.audit.record({ adminId: req.user.id, action: 'deposit.reject', target: id,
      metadata: { note }, ip: ip(req) });
    return { id, status: 'rejected' };
  }

  // ----------------------------------------------------------- withdrawals

  @Get('withdrawals')
  async withdrawals(@Query() q: { status?: string; limit?: string }) {
    const limit = Math.min(Math.max(Number(q.limit ?? 50), 1), 200);
    const args: any[] = [];
    let where = '1=1';
    if (q.status) { where = 'w.status = ?'; args.push(q.status); }
    const rows = await this.ds.query(
      `SELECT w.id, w.reference, w.amount, w.fee, w.payable, w.currency, w.status, w.details,
              w.admin_note, w.processed_by, w.processed_at, w.created_at,
              u.nickname, u.id AS user_id, m.display_name AS method
         FROM withdrawal w JOIN users u ON u.id = w.user_id
         JOIN payment_method m ON m.id = w.method_id
        WHERE ${where} ORDER BY w.created_at DESC LIMIT ?`,
      [...args, limit],
    );
    return { withdrawals: rows.map((r: any) => ({ ...r, details: parseJson(r.details) })) };
  }

  @Post('withdrawals/:id/approve')
  async approveWithdrawal(@Req() req: any, @Param('id') id: string, @Body() body: { note?: string }) {
    // The money already left the balance when the player requested it, so
    // approving only records that the payout was actually sent.
    const res = await this.ds.query(
      `UPDATE withdrawal SET status='approved', admin_note=?, processed_by=?, processed_at=NOW()
        WHERE id = ? AND status = 'pending'`,
      [body?.note?.slice(0, 255) ?? null, req.user.id, id],
    );
    if (!res.affectedRows) throw new BadRequestException({ message: 'That withdrawal is no longer pending.' });
    await this.audit.record({ adminId: req.user.id, action: 'withdrawal.approve', target: id, ip: ip(req) });
    return { id, status: 'approved' };
  }

  @Post('withdrawals/:id/reject')
  async rejectWithdrawal(@Req() req: any, @Param('id') id: string, @Body() body: { note: string }) {
    const note = String(body?.note ?? '').trim();
    if (!note) throw new BadRequestException({ message: 'Give a reason for the rejection.' });

    const [wd] = await this.ds.query(`SELECT * FROM withdrawal WHERE id = ?`, [id]);
    if (!wd) throw new BadRequestException({ message: 'No such withdrawal.' });

    try {
      await this.ledger.inTx(async (qr) => {
        const [locked] = await qr.query(`SELECT status FROM withdrawal WHERE id = ? FOR UPDATE`, [id]);
        if (locked.status !== 'pending') throw new Error('That withdrawal is no longer pending.');
        // Rejecting returns the full requested amount, fee included — the fee
        // was never earned because no payout was made.
        await this.ledger.move(qr, {
          userId: wd.user_id, currency: wd.currency, delta: new Decimal(wd.amount),
          reference: `wdr:${wd.reference}`, meta: { withdrawalId: id, adminId: req.user.id, note },
        });
        await qr.query(
          `UPDATE withdrawal SET status='rejected', admin_note=?, processed_by=?, processed_at=NOW() WHERE id = ?`,
          [note.slice(0, 255), req.user.id, id],
        );
      });
    } catch (err: any) {
      throw new BadRequestException({ message: err?.message ?? 'Rejection failed.' });
    }

    await this.audit.record({ adminId: req.user.id, action: 'withdrawal.reject', target: wd.reference,
      metadata: { note, refunded: Number(wd.amount).toFixed(2) }, ip: ip(req) });
    return { id, status: 'rejected', refunded: Number(wd.amount).toFixed(2) };
  }

  // ------------------------------------------------------------ audit log

  @Get('audit')
  async auditLog(@Query() q: { limit?: string; action?: string }) {
    const limit = Math.min(Math.max(Number(q.limit ?? 100), 1), 500);
    const args: any[] = [];
    let where = '1=1';
    if (q.action) { where = 'a.action = ?'; args.push(q.action); }
    const rows = await this.ds.query(
      `SELECT a.id, a.admin_id, a.action, a.target, a.metadata, a.ip, a.created_at, u.nickname AS admin_name
         FROM admin_audit_log a LEFT JOIN users u ON u.id = a.admin_id
        WHERE ${where} ORDER BY a.id DESC LIMIT ?`,
      [...args, limit],
    );
    return { entries: rows.map((r: any) => ({ ...r, metadata: parseJson(r.metadata) })) };
  }
}

function ip(req: any): string {
  return String(req.ip ?? req.socket?.remoteAddress ?? '').replace(/^::ffff:/, '');
}
